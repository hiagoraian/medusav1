import express from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { initSchema } from './src/database/postgres.js';
import { processExcelFiles } from './src/services/excelProcessor.js';
import { addContactsToQueue, countPending, createCycle, getDashboardStats, clearQueue, resetCampaign, getInterruptedCycle } from './src/services/queueService.js';
import { runCampaignLoop, requestStop } from './src/services/orchestrator.js';
import { startWarmup, stopWarmup } from './src/services/chipWarmup.js';
import { checkAllDevicesStatus, setupAllAdbForwards } from './src/services/networkController.js';
import { generateCycleReport, generateFailureList } from './src/services/reportGenerator.js';
import * as evolution from './src/evolution/client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

// URL base que a Evolution API (container Docker) usa para baixar mídias servidas pelo Node.js
const MEDIA_HOST = process.env.MEDIA_HOST || `http://host.docker.internal:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadExcel = multer({ storage: multer.memoryStorage() });
const uploadMedia = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.resolve(__dirname, 'uploads');
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => cb(null, `media_${Date.now()}${path.extname(file.originalname)}`),
    }),
});

// ==========================================
// STARTUP
// ==========================================

(async () => {
    console.log('\n🚀 [STARTUP] Iniciando Medusa Evolution...\n');
    try {
        await initSchema();
        console.log('🔗 [STARTUP] Configurando ADB...');
        await setupAllAdbForwards();
        const cycle = await getInterruptedCycle();
        if (cycle) console.log(`⚠️ [STARTUP] Campanha interrompida detectada (ID: ${cycle.id}).`);
        console.log('✅ [STARTUP] Sistema pronto!\n');
    } catch (err) {
        console.warn('⚠️ [STARTUP] Alerta na inicialização:', err.message);
    }
})();

process.on('uncaughtException',   (err) => console.error('🚨 uncaughtException:', err.message));
process.on('unhandledRejection',  (err) => console.error('🚨 unhandledRejection:', err?.message || err));

// ==========================================
// ROTAS GERAIS
// ==========================================

app.get('/api/status', (req, res) => {
    res.json({ status: 'Medusa Evolution Ativo', versao: '2.0', porta: PORT });
});

app.get('/api/dashboard-stats', async (req, res) => {
    try {
        res.json(await getDashboardStats());
    } catch (err) {
        res.status(500).json({ error: 'Erro ao obter estatísticas.' });
    }
});

// ==========================================
// ZAPS — Evolution API
// ==========================================

/**
 * Retorna o status de todos os 24 zaps consultando a Evolution API.
 */
app.get('/api/zaps-status', async (req, res) => {
    try {
        const instances = await evolution.fetchInstances();
        const instanceMap = {};
        instances.forEach(inst => {
            const name  = inst.instanceName || inst.name;
            const state = inst.connectionStatus || inst.instance?.state || inst.state || 'close';
            instanceMap[name] = state;
        });

        const status = [];
        for (let i = 1; i <= 24; i++) {
            const accountId = `WA-${String(i).padStart(2, '0')}`;
            const state     = instanceMap[accountId] || 'close';
            status.push({ accountId, connected: state === 'open', state });
        }
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao consultar Evolution API: ' + err.message });
    }
});

/**
 * Cria ou reconecta uma instância. Se ainda não conectada, retorna o QR code (base64).
 */
app.post('/api/whatsapp/start', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId obrigatório.' });

    try {
        await evolution.createInstance(accountId);
        const state = await evolution.getConnectionState(accountId);

        if (state === 'open') {
            return res.json({ connected: true, message: `${accountId} já está conectado.` });
        }

        // Instância criada mas não conectada — retorna QR code para exibir no browser
        const qrcode = await evolution.getQRCode(accountId);
        res.json({ connected: false, qrcode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Retorna o QR code atual (polling do frontend).
 * Retorna { state, qrcode } onde qrcode é null se já conectado.
 */
app.get('/api/whatsapp/qrcode/:accountId', async (req, res) => {
    const { accountId } = req.params;
    try {
        const state  = await evolution.getConnectionState(accountId);
        const qrcode = state === 'open' ? null : await evolution.getQRCode(accountId);
        res.json({ state, qrcode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Webhook recebido da Evolution API para atualização de estado/entrega.
 */
app.post('/webhook/evolution', (req, res) => {
    const event = req.body;
    if (event?.event === 'CONNECTION_UPDATE') {
        const { instance, state } = event.data || {};
        console.log(`[WEBHOOK] ${instance}: ${state}`);
    }
    res.sendStatus(200);
});

/**
 * Desconecta e remove a sessão de um zap (logout na Evolution API).
 */
app.delete('/api/whatsapp/:accountId', async (req, res) => {
    const { accountId } = req.params;
    if (!accountId || !/^WA-\d{2}$/.test(accountId))
        return res.status(400).json({ error: 'ID inválido.' });

    try {
        await evolution.logoutInstance(accountId);
        await evolution.deleteInstance(accountId);
        console.log(`🗑️ [${accountId}] Instância removida da Evolution API.`);
        res.json({ message: `${accountId} desconectado e removido com sucesso.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Inicia múltiplas instâncias com delay escalonado.
 */
app.post('/api/whatsapp/start-bulk', async (req, res) => {
    const { accounts } = req.body;
    if (!accounts?.length) return res.status(400).json({ error: 'Lista de contas vazia.' });

    res.json({ message: `Iniciando ${accounts.length} conta(s). Acompanhe pelo painel.`, accounts });

    (async () => {
        for (let i = 0; i < accounts.length; i++) {
            try {
                await evolution.createInstance(accounts[i]);
                console.log(`[BULK] ${accounts[i]} (${i + 1}/${accounts.length}) iniciado.`);
            } catch (err) {
                console.error(`[BULK] Erro em ${accounts[i]}:`, err.message);
            }
            if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 3000));
        }
        console.log('[BULK] Reconexão em massa concluída.');
    })();
});

// ==========================================
// FILA E CAMPANHA
// ==========================================

app.post('/api/upload-lists', uploadExcel.array('excelFiles'), async (req, res) => {
    try {
        if (!req.files?.length) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        const result = processExcelFiles(req.files);
        if (result.totalUnicos === 0) return res.status(400).json({ error: 'Nenhum número válido encontrado.' });
        await addContactsToQueue(result.numeros);
        res.json({ message: 'Listas processadas!', totalRecebidos: result.totalRecebidos, totalUnicos: result.totalUnicos });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao processar arquivos.' });
    }
});

app.post('/api/clear-queue', async (req, res) => {
    try {
        await clearQueue();
        res.json({ message: '✅ Fila limpa com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/check-interrupted', async (req, res) => {
    try {
        const cycle = await getInterruptedCycle();
        if (!cycle) return res.json({ interrupted: null });
        const { rows } = await (await import('./src/database/postgres.js')).default.query(
            `SELECT COUNT(*) AS pending FROM messages_queue WHERE status = 'pendente'`
        );
        res.json({ interrupted: { ...cycle, pending: parseInt(rows[0].pending, 10) } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/suspend-campaign', async (req, res) => {
    try {
        const cycle = await getInterruptedCycle();
        await resetCampaign(cycle?.id || null);
        res.json({ message: '🗑️ Campanha suspensa e dados zerados.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/start-campaign', uploadMedia.single('mediaFile'), async (req, res) => {
    try {
        const { accounts, messageText, mediaMode, msgsPerCycle, selectedTimes } = req.body;
        const activeAccountsList = JSON.parse(accounts);
        if (activeAccountsList.length === 0) return res.status(400).json({ error: 'Nenhuma conta selecionada.' });

        const totalPending = await countPending();
        if (totalPending === 0) return res.status(400).json({ error: 'Fila vazia. Faça upload de uma lista primeiro.' });

        const cycleId         = await createCycle(totalPending);
        const msgsPerCycleVal = parseInt(msgsPerCycle) || (activeAccountsList.length * 16);
        const selectedList    = selectedTimes ? JSON.parse(selectedTimes) : null;

        // Converte o arquivo local em URL acessível pela Evolution API (Docker)
        const mediaUrl  = req.file ? `${MEDIA_HOST}/uploads/${req.file.filename}` : null;
        const mediaExt  = req.file ? path.extname(req.file.filename).toLowerCase().slice(1) : null;
        const mediaType = ['mp4', 'mov', 'avi', 'mkv'].includes(mediaExt) ? 'video' : 'image';

        res.json({
            message: '🚀 Campanha iniciada!',
            cycleId,
            info: { totalContatos: totalPending, zapsSelecionados: activeAccountsList.length, msgsPorCiclo: msgsPerCycleVal },
        });

        const campaignConfig = {
            messageTemplate: messageText || '',
            mediaUrl,
            mediaType,
            mediaMode:    mediaMode    || 'caption',
            msgsPerCycle: msgsPerCycleVal,
        };

        (async () => {
            try {
                await runCampaignLoop(activeAccountsList, campaignConfig, cycleId, selectedList);
            } finally {
                // Remove mídia temporária após campanha concluída
                if (req.file) {
                    const filePath = path.join(__dirname, 'uploads', req.file.filename);
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                }
            }
        })();
    } catch (err) {
        console.error('[/api/start-campaign]', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/stop-campaign', (req, res) => {
    requestStop();
    res.json({ message: '🛑 Sinal de parada enviado.' });
});

// ==========================================
// TESTE DE ENVIO
// ==========================================

app.post('/api/test-send', uploadMedia.single('mediaFile'), async (req, res) => {
    try {
        const { accountId, phone, messageText, mediaMode } = req.body;
        if (!accountId || !phone) return res.status(400).json({ error: 'accountId e phone obrigatórios.' });

        const normalizedPhone = String(phone).replace(/\D/g, '');
        const state = await evolution.getConnectionState(accountId);
        if (state !== 'open') return res.status(400).json({ error: `${accountId} não está conectado.` });

        let result;
        if (!req.file) {
            await evolution.sendText(accountId, normalizedPhone, messageText || '');
            result = 'enviado';
        } else {
            const mediaUrl  = `${MEDIA_HOST}/uploads/${req.file.filename}`;
            const mediaExt  = path.extname(req.file.filename).toLowerCase().slice(1);
            const mediaType = ['mp4', 'mov', 'avi'].includes(mediaExt) ? 'video' : 'image';

            if (mediaMode === 'caption') {
                await evolution.sendMedia(accountId, normalizedPhone, mediaUrl, mediaType, messageText || '');
            } else {
                if (messageText) await evolution.sendText(accountId, normalizedPhone, messageText);
                await evolution.sendMedia(accountId, normalizedPhone, mediaUrl, mediaType, '');
            }
            result = 'enviado';
            const fp = path.join(__dirname, 'uploads', req.file.filename);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        }

        res.json({ message: `✅ Mensagem enviada para ${phone}!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// AQUECIMENTO
// ==========================================

app.post('/api/warmup-chips/start', async (req, res) => {
    try {
        const { accounts } = req.body;
        const list = JSON.parse(accounts);
        if (list.length < 2) return res.status(400).json({ error: 'Mínimo 2 contas.' });
        res.json({ message: '🔥 Aquecimento iniciado!' });
        startWarmup(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/warmup-chips/stop', (req, res) => {
    stopWarmup();
    res.json({ message: '🛑 Aquecimento parado.' });
});

// ==========================================
// MANUTENÇÃO
// ==========================================

app.get('/api/devices-status', async (req, res) => {
    try {
        res.json(await checkAllDevicesStatus());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/report/:cycleId', async (req, res) => {
    try {
        res.download(await generateCycleReport(req.params.cycleId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/failure-list/:cycleId', async (req, res) => {
    try {
        res.download(await generateFailureList(req.params.cycleId));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 Medusa Evolution rodando em: http://localhost:${PORT}\n`);
});
