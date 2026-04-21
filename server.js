import express from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { fileURLToPath } from 'url';

import db from './src/database/db.js';
import { processExcelFiles } from './src/services/excelProcessor.js';
import { addContactsToQueue, countPending, createCycle, getDashboardStats, clearQueue, resetCampaign } from './src/services/queueService.js';
import { initializeAccount, initializeAccountsBulk, getClientInstance, getClientStatus, getAllClientsStatus, hasSessionCache } from './src/whatsapp/manager.js';
import { runCampaignLoop, requestStop } from './src/services/orchestrator.js';
import { startWarmup, stopWarmup } from './src/services/chipWarmup.js';
import { checkAllDevicesStatus, setupAllAdbForwards } from './src/services/networkController.js';
import { generateCycleReport, generateFailureList } from './src/services/reportGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const uploadExcel = multer({ storage: multer.memoryStorage() });
const mediaStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const tempDir = path.resolve(__dirname, 'temp_media');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        cb(null, tempDir);
    },
    filename: (req, file, cb) => {
        cb(null, 'original_' + Date.now() + path.extname(file.originalname));
    }
});
const uploadMedia = multer({ storage: mediaStorage });

// ==========================================
// RESILIÊNCIA E RECUPERAÇÃO
// ==========================================

const handleCrash = async (error) => {
    console.error('\n🚨 [CRITICAL] O sistema encontrou um erro fatal:', error);
    
    try {
        // Tenta salvar o estado atual no banco antes de fechar
        const stats = await getDashboardStats();
        const crashLog = {
            timestamp: new Date().toISOString(),
            error: error.message,
            stack: error.stack,
            lastStats: stats
        };
        
        const crashDir = path.resolve(__dirname, 'reports/crashes');
        if (!fs.existsSync(crashDir)) fs.mkdirSync(crashDir, { recursive: true });
        
        const fileName = `crash_${Date.now()}.json`;
        fs.writeFileSync(path.join(crashDir, fileName), JSON.stringify(crashLog, null, 2));
        
        console.log(`💾 [CRITICAL] Log de erro salvo em: ${path.join(crashDir, fileName)}`);
    } catch (e) {
        console.error('❌ Erro ao salvar log de crash:', e.message);
    }
    
    process.exit(1);
};

process.on('uncaughtException', handleCrash);
process.on('unhandledRejection', handleCrash);

(async () => {
    console.log('\n🚀 [STARTUP] Iniciando Medusa...\n');
    try {
        console.log('🔗 [STARTUP] Configurando conexões ADB e ZTE...');
        await setupAllAdbForwards();
        
        // Verifica se há campanhas interrompidas
        db.get("SELECT id FROM dispatch_cycles WHERE status = 'em_andamento' ORDER BY id DESC LIMIT 1", (err, row) => {
            if (row) {
                console.log(`⚠️ [STARTUP] Detectada campanha interrompida (ID: ${row.id}). Pronto para retomar.`);
            }
        });
        
        console.log('✅ [STARTUP] Sistema pronto e persistente!\n');
    } catch (error) {
        console.warn('⚠️ [STARTUP] Alerta na configuração inicial:', error.message);
    }
})();

// ==========================================
// ROTAS DA API
// ==========================================

app.get('/api/status', (req, res) => {
    res.json({ status: 'Medusa Ativo', porta: PORT, persistencia: 'Habilitada' });
});

app.get('/api/dashboard-stats', async (req, res) => {
    try {
        const stats = await getDashboardStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao obter estatísticas.' });
    }
});

app.get('/api/zaps-status', async (req, res) => {
    try {
        const status = await getAllClientsStatus();
        // Inclui hasCache para a UI distinguir zaps com sessão salva dos sem cache
        const statusWithCache = status.map(({ accountId, connected }) => ({
            accountId,
            connected,
            hasCache: hasSessionCache(accountId)
        }));
        res.json(statusWithCache);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao obter status dos Zaps.' });
    }
});

app.post('/api/upload-lists', uploadExcel.array('excelFiles'), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0)
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        const result = processExcelFiles(req.files);
        if (result.totalUnicos === 0)
            return res.status(400).json({ error: 'Nenhum número válido encontrado.' });
        await addContactsToQueue(result.numeros);
        res.json({
            message: 'Listas processadas e salvas no banco!',
            totalRecebidos: result.totalRecebidos,
            totalUnicos: result.totalUnicos
        });
    } catch (error) {
        res.status(500).json({ error: 'Erro interno ao processar arquivos.' });
    }
});

app.post('/api/clear-queue', async (req, res) => {
    try {
        await clearQueue();
        res.json({ message: '✅ Fila de mensagens pendentes limpa com sucesso!' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao limpar fila: ' + error.message });
    }
});

// Verifica se há campanha interrompida (status em_andamento sem processo ativo)
app.get('/api/check-interrupted', (req, res) => {
    db.get(
        `SELECT id, total_messages, sent_count, fail_count FROM dispatch_cycles WHERE status = 'em_andamento' ORDER BY id DESC LIMIT 1`,
        (err, cycle) => {
            if (!cycle) return res.json({ interrupted: null });
            db.get(`SELECT COUNT(*) as pending FROM messages_queue WHERE status = 'pendente'`, (_e, row) => {
                res.json({ interrupted: { ...cycle, pending: row?.pending || 0 } });
            });
        }
    );
});

// Suspende a campanha interrompida: gera relatório final, marca como interrompido e zera a fila
app.post('/api/suspend-campaign', async (req, res) => {
    try {
        db.get(
            `SELECT id FROM dispatch_cycles WHERE status = 'em_andamento' ORDER BY id DESC LIMIT 1`,
            async (err, cycle) => {
                if (cycle) {
                    try { await generateCycleReport(cycle.id); } catch (_) {}
                    await resetCampaign(cycle.id);
                } else {
                    await clearQueue();
                }
                res.json({ message: '🗑️ Campanha suspensa e dados zerados com sucesso.' });
            }
        );
    } catch (error) {
        res.status(500).json({ error: 'Erro ao suspender campanha: ' + error.message });
    }
});

app.post('/api/whatsapp/start', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'ID da conta não fornecido.' });

    // isClientReady é a verificação completa (página + wid). Se passar, realmente já está ativo.
    // getClientStatus apenas verifica o mapa — pode ser um cliente zumbi (página morta ou sem wid).
    // Nesse caso, destrói o zumbi e reinicia.
    const { isClientReady: checkReady } = await import('./src/whatsapp/manager.js');
    if (checkReady(accountId)) {
        return res.json({ message: `A conta ${accountId} já está ativa e conectada.` });
    }
    if (getClientStatus(accountId)) {
        console.log(`[${accountId}] Cliente zumbi detectado. Destruindo antes de reiniciar...`);
        try { await getClientInstance(accountId)?.destroy(); } catch (_) {}
    }

    res.json({ message: `Iniciando ${accountId}. Verifique o terminal para o QR Code!` });
    await initializeAccount(accountId);
});

// Remove o cache de sessão de um Zap específico e desconecta se estiver ativo.
app.delete('/api/whatsapp/:accountId', async (req, res) => {
    const { accountId } = req.params;
    if (!accountId || !/^WA-\d{2}$/.test(accountId))
        return res.status(400).json({ error: 'ID de conta inválido.' });

    // Destrói o cliente se estiver ativo
    const client = getClientInstance(accountId);
    if (client) {
        try { await client.destroy(); } catch (_) {}
    }

    // Remove a pasta de sessão do LocalAuth
    const sessionPath = path.resolve(__dirname, `.wwebjs_auth/session-${accountId}`);
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(`🗑️ [${accountId}] Cache de sessão removido: ${sessionPath}`);
        return res.json({ message: `Cache do ${accountId} removido com sucesso.` });
    } else {
        return res.json({ message: `${accountId} não tinha cache salvo.` });
    }
});

// Apaga o cache de sessão de TODOS os Zaps e desconecta os ativos.
app.post('/api/clear-cache', async (req, res) => {
    // Destrói todos os clientes ativos
    const allStatus = await getAllClientsStatus();
    for (const { accountId } of allStatus) {
        const client = getClientInstance(accountId);
        if (client) {
            try { await client.destroy(); } catch (_) {}
        }
    }

    // Remove toda a pasta .wwebjs_auth
    const authDir = path.resolve(__dirname, '.wwebjs_auth');
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log('🧹 [CACHE] Todos os caches de sessão foram removidos.');
        return res.json({ message: '✅ Cache de todos os Zaps removido. Eles precisarão escanear o QR Code novamente.' });
    }

    res.json({ message: 'Nenhum cache encontrado para remover.' });
});

// Inicia múltiplas contas com delay escalonado (5s entre cada uma)
// para evitar pico de memória ao subir todos os Chromiums juntos.
app.post('/api/whatsapp/start-bulk', async (req, res) => {
    const { accounts } = req.body;
    if (!accounts || !Array.isArray(accounts) || accounts.length === 0)
        return res.status(400).json({ error: 'Lista de contas não fornecida.' });

    res.json({
        message: `Iniciando ${accounts.length} conta(s) de forma escalonada (5s entre cada). Acompanhe pelo terminal!`,
        accounts
    });

    // Roda em background para não bloquear a resposta
    initializeAccountsBulk(accounts).catch(err => {
        console.error('[start-bulk] Erro inesperado:', err.message);
    });
});

app.post('/api/start-campaign', uploadMedia.single('mediaFile'), async (req, res) => {
    try {
        const { accounts, messageText, mediaMode, msgsPerCycle, selectedTimes } = req.body;
        const activeAccountsList = JSON.parse(accounts);
        const mediaPath          = req.file ? req.file.path : null;
        const msgsPerCycleValue  = parseInt(msgsPerCycle) || (activeAccountsList.length * 16);
        const selectedTimesList  = selectedTimes ? JSON.parse(selectedTimes) : null;

        if (activeAccountsList.length === 0)
            return res.status(400).json({ error: 'Nenhuma conta selecionada.' });

        const totalPending = await countPending();
        if (totalPending === 0)
            return res.status(400).json({ error: 'Fila vazia. Faça upload de uma lista primeiro.' });

        const cycleId = await createCycle(totalPending);

        res.json({
            message: '🚀 Campanha Iniciada com Persistência!',
            cycleId,
            info: {
                totalContatos: totalPending,
                zapsSelecionados: activeAccountsList.length,
                msgsPorCiclo: msgsPerCycleValue,
                cicloDuracao: '30 minutos'
            }
        });

        // Roda em background
        (async () => {
            try {
                await runCampaignLoop(
                    activeAccountsList, messageText, mediaPath, mediaMode,
                    msgsPerCycleValue, cycleId, selectedTimesList
                );
            } finally {
                if (mediaPath && fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath);
            }
        })();

    } catch (error) {
        console.error('[/api/start-campaign] Erro:', error);
        res.status(500).json({ error: 'Erro ao iniciar campanha: ' + error.message });
    }
});

app.post('/api/stop-campaign', (req, res) => {
    requestStop();
    console.log('🛑 [API] Parada de campanha solicitada pelo usuário.');
    res.json({ message: '🛑 Sinal de parada enviado. O orquestrador vai parar após o envio atual.' });
});

app.post('/api/test-send', uploadMedia.single('mediaFile'), async (req, res) => {
    try {
        const { accountId, phone, messageText, mediaMode } = req.body;
        if (!accountId || !phone)
            return res.status(400).json({ error: 'accountId e phone são obrigatórios.' });

        const client = getClientInstance(accountId);
        if (!client)
            return res.status(400).json({ error: `${accountId} não está conectado.` });

        const mediaPath = req.file ? req.file.path : null;
        const { executeSend } = await import('./src/whatsapp/sender.js');
        const result = await executeSend(client, phone, messageText || '', mediaPath, mediaMode || 'caption');

        if (mediaPath && fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath);

        if (result.status === 'enviado') {
            res.json({ message: `✅ Mensagem enviada com sucesso para ${phone}!` });
        } else if (result.status === 'invalido') {
            res.json({ message: `🚫 O número ${phone} não possui WhatsApp.` });
        } else {
            res.status(500).json({ error: `❌ Falha ao enviar: ${result.error}` });
        }
    } catch (error) {
        res.status(500).json({ error: 'Erro interno: ' + error.message });
    }
});

app.post('/api/warmup-chips/start', async (req, res) => {
    try {
        const { accounts } = req.body;
        const activeAccountsList = JSON.parse(accounts);
        if (activeAccountsList.length < 2)
            return res.status(400).json({ error: 'Precisa de pelo menos 2 contas.' });
        
        res.json({ message: '🔥 Aquecimento Iniciado!' });
        await startWarmup(activeAccountsList);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao iniciar aquecimento.' });
    }
});

app.post('/api/warmup-chips/stop', (req, res) => {
    stopWarmup();
    res.json({ message: '🛑 Aquecimento parado.' });
});

app.get('/api/devices-status', async (req, res) => {
    try {
        const status = await checkAllDevicesStatus();
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao verificar dispositivos.' });
    }
});

app.get('/api/report/:cycleId', async (req, res) => {
    try {
        const filePath = await generateCycleReport(req.params.cycleId);
        res.download(filePath);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao gerar relatório.' });
    }
});

app.get('/api/failure-list/:cycleId', async (req, res) => {
    try {
        const filePath = await generateFailureList(req.params.cycleId);
        res.download(filePath);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao gerar lista de falhas.' });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 Medusa rodando em: http://localhost:${PORT}\n`);
});
