import express from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { fileURLToPath } from 'url';

import db from './src/database/db.js';
import { processExcelFiles } from './src/services/excelProcessor.js';
import { addContactsToQueue, countPending, createCycle, getDashboardStats, clearQueue, resetCampaign } from './src/services/queueService.js';
import { initializeAccount, getClientStatus, getAllClientsStatus } from './src/whatsapp/manager.js';
import { runCampaignLoop } from './src/services/orchestrator.js';
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
// RESILIÊNCIA E RECUPERAÇÃO (v4.0)
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
    console.log('\n🚀 [STARTUP] Iniciando Medusa v4.0 (Resiliente)...\n');
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
    res.json({ status: 'Medusa v4.0 Ativo', porta: PORT, persistencia: 'Habilitada' });
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
        res.json(status);
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
    if (getClientStatus(accountId)) return res.json({ message: `A conta ${accountId} já está ativa.` });
    res.json({ message: `Iniciando ${accountId}. Verifique o terminal para o QR Code!` });
    await initializeAccount(accountId);
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

app.listen(PORT, () => {
    console.log(`\n🚀 Medusa v4.0 rodando em: http://localhost:${PORT}\n`);
});
