import express from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { initSchema, query }                        from './src/database/postgres.js';
import { processExcelFiles }                       from './src/services/excelProcessor.js';
import {
    addContactsToQueue, countPending, createCycle,
    getDashboardStats, clearQueue, resetCampaign, getInterruptedCycle,
} from './src/services/queueService.js';
import { runCampaignLoop, requestStop }            from './src/services/orchestrator.js';
import { startWarmup, stopWarmup, isWarmupRunning, getWarmupState } from './src/services/chipWarmup.js';
import { checkAllDevicesStatus, setupAllAdbForwards, getProxyConfigForAccount } from './src/services/networkController.js';
import { generateCampaignReport }                  from './src/services/reportGenerator.js';
import * as evolution                              from './src/evolution/client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

// URL base que a Evolution API (container Docker) usa para baixar mídias
const MEDIA_HOST = process.env.MEDIA_HOST || `http://host.docker.internal:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads',      express.static(path.join(__dirname, 'uploads')));
app.use('/warmup_media', express.static(path.join(__dirname, 'warmup_media')));

const uploadExcel = multer({ storage: multer.memoryStorage() });

const LISTAS_DIR = path.join(__dirname, 'listas');
fs.mkdirSync(LISTAS_DIR, { recursive: true });

const uploadLista = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, LISTAS_DIR),
        filename:    (_req, file, cb) => cb(null, file.originalname),
    }),
    fileFilter: (_req, file, cb) => {
        const ok = /\.(xlsx|xls)$/i.test(file.originalname);
        cb(null, ok);
    },
});

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

// ── Startup ───────────────────────────────────────────────────────────────────

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

process.on('uncaughtException',  (err) => console.error('🚨 uncaughtException:', err.message));
process.on('unhandledRejection', (err) => console.error('🚨 unhandledRejection:', err?.message || err));

// ── Geral ─────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
    res.json({ status: 'Medusa Evolution Ativo', versao: '2.0', porta: PORT });
});

app.get('/api/dashboard-stats', async (req, res) => {
    try { res.json(await getDashboardStats()); }
    catch (err) { res.status(500).json({ error: 'Erro ao obter estatísticas.' }); }
});

// ── Zaps — Evolution API ──────────────────────────────────────────────────────

app.get('/api/zaps-status', async (req, res) => {
    try {
        const instances    = await evolution.fetchInstances();
        const instanceMap  = {};
        instances.forEach(inst => {
            const name  = inst.instanceName || inst.name;
            const state = inst.connectionStatus || inst.instance?.state || inst.state || 'close';
            if (name) instanceMap[name] = state;
        });

        const status = [];
        for (let i = 1; i <= 48; i++) {
            const accountId   = `WA-${String(i).padStart(2, '0')}`;
            const hasInstance = accountId in instanceMap;
            const state       = hasInstance ? instanceMap[accountId] : 'close';
            status.push({ accountId, connected: state === 'open', state, hasInstance });
        }
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao consultar Evolution API: ' + err.message });
    }
});

app.post('/api/whatsapp/start', async (req, res) => {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId obrigatório.' });

    try {
        // Descobre qual proxy 4G usar (ou null para Wi-Fi)
        const proxyConfig = await getProxyConfigForAccount(accountId);
        await evolution.createInstance(accountId, proxyConfig);

        const state = await evolution.getConnectionState(accountId);
        if (state === 'open') {
            return res.json({ connected: true, message: `${accountId} já está conectado.` });
        }

        const qrcode = await evolution.getQRCode(accountId);
        res.json({ connected: false, qrcode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

app.post('/webhook/evolution', (req, res) => {
    const event = req.body;
    if (event?.event === 'CONNECTION_UPDATE') {
        const { instance, state } = event.data || {};
        console.log(`[WEBHOOK] ${instance}: ${state}`);
    }
    res.sendStatus(200);
});

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

app.post('/api/whatsapp/start-bulk', async (req, res) => {
    const { accounts } = req.body;
    if (!accounts?.length) return res.status(400).json({ error: 'Lista de contas vazia.' });

    res.json({ message: `Iniciando ${accounts.length} conta(s). Acompanhe pelo painel.`, accounts });

    (async () => {
        for (let i = 0; i < accounts.length; i++) {
            try {
                const proxyConfig = await getProxyConfigForAccount(accounts[i]);
                await evolution.createInstance(accounts[i], proxyConfig);
                console.log(`[BULK] ${accounts[i]} (${i + 1}/${accounts.length}) iniciado.`);
            } catch (err) {
                console.error(`[BULK] Erro em ${accounts[i]}:`, err.message);
            }
            if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 3_000));
        }
        console.log('[BULK] Reconexão em massa concluída.');
    })();
});

// ── Gerenciador de listas ─────────────────────────────────────────────────────

app.get('/api/listas', (_req, res) => {
    try {
        const files = fs.readdirSync(LISTAS_DIR)
            .filter(f => /\.(xlsx|xls)$/i.test(f) && !f.startsWith('.'))
            .map(f => ({ name: f, size: fs.statSync(path.join(LISTAS_DIR, f)).size }));
        res.json(files);
    } catch (_) { res.json([]); }
});

app.post('/api/listas/upload', uploadLista.array('files'), (req, res) => {
    if (!req.files?.length) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    res.json({ message: `${req.files.length} arquivo(s) adicionado(s).`, files: req.files.map(f => f.originalname) });
});

app.delete('/api/listas/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    const filepath = path.join(LISTAS_DIR, filename);
    try {
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
        res.json({ message: `${filename} removido.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/listas/process', async (req, res) => {
    const { filenames } = req.body;
    if (!filenames?.length) return res.status(400).json({ error: 'Nenhum arquivo selecionado.' });
    try {
        const fakeFiles = filenames.map(name => ({
            originalname: name,
            buffer:       fs.readFileSync(path.join(LISTAS_DIR, path.basename(name))),
        }));
        const result = processExcelFiles(fakeFiles);
        if (result.totalUnicos === 0) return res.status(400).json({ error: 'Nenhum número válido encontrado.' });
        await addContactsToQueue(result.numeros);
        res.json({ message: 'Listas processadas!', totalRecebidos: result.totalRecebidos, totalUnicos: result.totalUnicos });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fila e campanha ───────────────────────────────────────────────────────────

app.post('/api/upload-lists', uploadExcel.array('excelFiles'), async (req, res) => {
    try {
        if (!req.files?.length) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        const result = processExcelFiles(req.files);
        if (result.totalUnicos === 0) return res.status(400).json({ error: 'Nenhum número válido encontrado.' });
        await addContactsToQueue(result.numeros);
        res.json({
            message: 'Listas processadas!',
            totalRecebidos: result.totalRecebidos,
            totalUnicos:    result.totalUnicos,
        });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao processar arquivos.' });
    }
});

app.post('/api/clear-queue', async (req, res) => {
    try {
        await clearQueue();
        res.json({ message: '✅ Fila limpa com sucesso!' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/check-interrupted', async (req, res) => {
    try {
        const cycle = await getInterruptedCycle();
        if (!cycle) return res.json({ interrupted: null });
        const { rows } = await query(
            `SELECT COUNT(*) AS pending FROM messages_queue WHERE status = 'pendente'`
        );
        res.json({ interrupted: { ...cycle, pending: parseInt(rows[0].pending, 10) } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/suspend-campaign', async (req, res) => {
    try {
        const cycle = await getInterruptedCycle();
        await resetCampaign(cycle?.id || null);
        res.json({ message: '🗑️ Campanha suspensa e dados zerados.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/start-campaign
 * Body (multipart/form-data):
 *   accounts       — JSON array de accountIds ativos
 *   messageText    — template com suporte a spintax
 *   mediaMode      — "caption" | "separate"
 *   startTime      — "HH:MM" (opcional)
 *   endTime        — "HH:MM" (opcional)
 *   dispatchLevel  — 1 | 2 | 3
 *   warmupLevel    — 1–10
 *   mediaFile      — arquivo de mídia (opcional)
 */
app.post('/api/start-campaign', uploadMedia.single('mediaFile'), async (req, res) => {
    try {
        const {
            accounts, messageText, mediaMode,
            endDatetime,
            windowStart   = '08:00',
            windowEnd     = '19:45',
            dispatchLevel = '2',
            warmupLevel   = '5',
        } = req.body;

        const activeAccountsList = JSON.parse(accounts);
        if (activeAccountsList.length === 0)
            return res.status(400).json({ error: 'Nenhuma conta selecionada.' });

        const totalPending = await countPending();
        if (totalPending === 0)
            return res.status(400).json({ error: 'Fila vazia. Processe uma lista primeiro.' });

        const cycleId = await createCycle(totalPending);

        const mediaUrl  = req.file ? `${MEDIA_HOST}/uploads/${req.file.filename}` : null;
        const mediaExt  = req.file ? path.extname(req.file.filename).toLowerCase().slice(1) : null;
        const mediaType = ['mp4', 'mov', 'avi', 'mkv'].includes(mediaExt) ? 'video' : 'image';

        res.json({
            message: '🚀 Campanha iniciada!',
            cycleId,
            info: {
                totalContatos:    totalPending,
                zapsSelecionados: activeAccountsList.length,
                dispatchLevel:    parseInt(dispatchLevel),
                warmupLevel:      parseInt(warmupLevel),
                janela:           `${windowStart}–${windowEnd}`,
                fim:              endDatetime || 'sem limite',
            },
        });

        const campaignConfig = {
            messageTemplate: messageText  || '',
            mediaUrl,
            mediaType,
            mediaMode:     mediaMode      || 'caption',
            endDatetime:   endDatetime    || null,
            windowStart,
            windowEnd,
            dispatchLevel: parseInt(dispatchLevel),
            warmupLevel:   parseInt(warmupLevel),
        };

        (async () => {
            try {
                await runCampaignLoop(activeAccountsList, campaignConfig, cycleId);
            } finally {
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

// ── Teste de envio ────────────────────────────────────────────────────────────

app.post('/api/test-send', uploadMedia.single('mediaFile'), async (req, res) => {
    try {
        const { accountId, phone, messageText, mediaMode } = req.body;
        if (!accountId || !phone) return res.status(400).json({ error: 'accountId e phone obrigatórios.' });

        const normalizedPhone = String(phone).replace(/\D/g, '');
        const state = await evolution.getConnectionState(accountId);
        if (state !== 'open') return res.status(400).json({ error: `${accountId} não está conectado.` });

        if (!req.file) {
            await evolution.sendText(accountId, normalizedPhone, messageText || '');
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

            const fp = path.join(__dirname, 'uploads', req.file.filename);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        }

        res.json({ message: `✅ Mensagem enviada para ${phone}!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Aquecimento manual ────────────────────────────────────────────────────────

app.get('/api/warmup-status', (_req, res) => {
    res.json(getWarmupState());
});

app.post('/api/warmup-chips/start', async (req, res) => {
    try {
        const { accounts, level = 5, rotateMins = 0 } = req.body;
        if (!Array.isArray(accounts) || accounts.length < 2)
            return res.status(400).json({ error: 'Mínimo 2 contas.' });
        res.json({ message: `🔥 Aquecimento nível ${level} iniciado!` });
        startWarmup(accounts, parseInt(level), parseInt(rotateMins));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/warmup-chips/stop', (req, res) => {
    stopWarmup();
    res.json({ message: '🛑 Aquecimento parado.' });
});

// ── Relatórios ────────────────────────────────────────────────────────────────

// Gera/regenera e faz download dos relatórios da última campanha
app.get('/api/report/enviados',  (req, res) => serveReport(res, 'enviados.txt'));
app.get('/api/report/invalidos', (req, res) => serveReport(res, 'invalidos.txt'));
app.get('/api/report/falhas',    (req, res) => serveReport(res, 'falhas.txt'));

const serveReport = (res, filename) => {
    const filePath = path.join(__dirname, 'reports', filename);
    if (!fs.existsSync(filePath))
        return res.status(404).json({ error: 'Relatório ainda não gerado.' });
    res.download(filePath);
};

// Dispara regeneração manual do relatório de um cycle
app.post('/api/report/generate/:cycleId', async (req, res) => {
    try {
        await generateCampaignReport(parseInt(req.params.cycleId));
        res.json({ message: '✅ Relatórios gerados em reports/' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Manutenção ────────────────────────────────────────────────────────────────

app.get('/api/devices-status', async (req, res) => {
    try { res.json(await checkAllDevicesStatus()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Inicialização ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n🚀 Medusa Evolution rodando em: http://localhost:${PORT}\n`);
});
