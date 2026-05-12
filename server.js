import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import pg from 'pg';

const execPromise = promisify(exec);

import { initSchema, query }                        from './src/database/postgres.js';
import { processExcelFiles }                       from './src/services/excelProcessor.js';
import {
    addContactsToQueue, countPending, createCycle,
    getDashboardStats, clearQueue, resetCampaign, getInterruptedCycle, updateCycleStats, clearDashboardData,
} from './src/services/queueService.js';
import { runCampaignLoop, requestStop }            from './src/services/orchestrator.js';
import { startWarmup, stopWarmup, startScheduledWarmup, isWarmupRunning, getWarmupState, clearOwnerCacheFor } from './src/services/chipWarmup.js';
import { checkAllDevicesStatus, setupAllAdbForwards, getProxyConfigForAccount, getStaticProxyForAccount } from './src/services/networkController.js';
import { generateCampaignReport }                  from './src/services/reportGenerator.js';
import { notifyAck }                              from './src/services/ackWaiter.js';
import * as evolution                              from './src/evolution/client.js';
import {
    getAllLists, readListPhones, writeListPhones,
    addPhoneToList, removePhoneFromList,
    mergeLists, splitIntoN,
    setListActive, deleteList as deleteListFile, readActiveState,
} from './src/services/listManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);


// ── Aggregador de respostas ───────────────────────────────────────────────────

const IGNORE_FILE = path.join(__dirname, 'ignore_numbers.txt');

const loadIgnoreNumbers = () => {
    try {
        if (!fs.existsSync(IGNORE_FILE)) return new Set();
        return new Set(
            fs.readFileSync(IGNORE_FILE, 'utf8')
                .split('\n')
                .map(l => l.trim().replace(/\D/g, ''))
                .filter(l => l.length > 4 && !l.startsWith('#') && l !== '')
        );
    } catch (_) { return new Set(); }
};

// Instâncias atualmente abertas — atualizado pelo webhook CONNECTION_UPDATE
// Usado para auto-selecionar o zap remetente quando REPLIES_INSTANCE não está definido
const _connectedInstances = new Set();

// Números dos próprios zaps — auto-preenchido no startup e atualizável
let _ownNumbers      = new Set();
const refreshOwnNumbers = async () => {
    try {
        const instances = await evolution.fetchInstances();
        _ownNumbers = new Set(
            instances
                .map(i => String(i?.ownerJid || i?.instance?.owner || i?.owner || '').replace(/\D/g, ''))
                .filter(n => n.length > 4)
        );
        if (_ownNumbers.size) console.log(`[REPLIES] ${_ownNumbers.size} número(s) próprio(s) carregado(s) para auto-ignore.`);
    } catch (_) {}
};

// Config do aggregador — persiste em disco, carregada no startup
const REPLIES_CONFIG_FILE = path.join(__dirname, 'replies_config.json');
let _repliesGroupJid = process.env.REPLIES_GROUP_JID || '';
let _repliesInstance = process.env.REPLIES_INSTANCE  || '';

const _loadRepliesConfig = () => {
    try {
        if (!_repliesGroupJid && fs.existsSync(REPLIES_CONFIG_FILE)) {
            const cfg = JSON.parse(fs.readFileSync(REPLIES_CONFIG_FILE, 'utf8'));
            if (cfg.groupJid) _repliesGroupJid = cfg.groupJid;
            if (cfg.instance) _repliesInstance = cfg.instance;
        }
    } catch (_) {}
};
const _saveRepliesConfig = () => {
    try { fs.writeFileSync(REPLIES_CONFIG_FILE, JSON.stringify({ groupJid: _repliesGroupJid, instance: _repliesInstance }), 'utf8'); } catch (_) {}
};
_loadRepliesConfig();

const extractText = (msg) => {
    if (!msg) return null;
    return msg.conversation
        || msg.extendedTextMessage?.text
        || msg.imageMessage?.caption
        || msg.videoMessage?.caption
        || msg.documentMessage?.caption
        || null;
};

const classifyMessage = (msg) => {
    if (!msg) return { type: 'unknown', label: '❓ Mensagem desconhecida' };
    if (msg.conversation || msg.extendedTextMessage)  return { type: 'text' };
    if (msg.reactionMessage)  return { type: 'reaction',  emoji: msg.reactionMessage.text || '👍' };
    if (msg.imageMessage)     return { type: 'image',     label: '🖼️ Imagem' };
    if (msg.audioMessage)     return { type: 'audio',     label: '🎙️ Áudio de voz' };
    if (msg.videoMessage)     return { type: 'video',     label: '🎬 Vídeo (não encaminhado)' };
    if (msg.stickerMessage)   return { type: 'sticker',   label: '🎭 Figurinha (não encaminhada)' };
    if (msg.documentMessage)  return { type: 'document',  label: '📄 Documento' };
    return { type: 'unknown', label: '❓ Mensagem não identificada' };
};

const handleIncomingReply = async (event) => {
    if (!_repliesGroupJid) return;

    // Se não há instância fixa configurada, auto-seleciona qualquer zap conectado
    // (preferindo um diferente do que recebeu a mensagem, para não usar o mesmo chip)
    const senderInstance = _repliesInstance
        || [..._connectedInstances].find(i => i !== event.instance)
        || [..._connectedInstances][0]
        || null;

    if (!senderInstance) {
        console.log('[REPLIES] Nenhum zap conectado disponível para encaminhar — mensagem ignorada');
        return;
    }

    const messages = Array.isArray(event.data) ? event.data : [event.data];
    const NOW_S    = Date.now() / 1000;
    for (const msg of messages) {
        if (!msg?.key) continue;
        if (msg.key.fromMe) continue;                              // mensagem nossa — ignora
        if (!msg.message)   continue;                              // stub/notificação sem conteúdo

        // Descarta mensagens de protocolo (editar, apagar)
        if (msg.message.protocolMessage) continue;

        // Descarta se não há conteúdo reconhecível para o usuário
        // (messageContextInfo sozinho = metadata de dispositivo, não mensagem real)
        const hasContent = msg.message.conversation
            || msg.message.extendedTextMessage
            || msg.message.imageMessage
            || msg.message.audioMessage
            || msg.message.videoMessage
            || msg.message.reactionMessage
            || msg.message.stickerMessage
            || msg.message.documentMessage;
        if (!hasContent) continue;

        // Descarta mensagens antigas do histórico (mais de 5 min) — evita flood no startup
        const ts = Number(msg.messageTimestamp || 0);
        if (ts && (NOW_S - ts) > 300) continue;

        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid.endsWith('@g.us')) continue;                 // msg de grupo — ignora

        const senderNumber = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
        if (_ownNumbers.has(senderNumber)) continue;               // próprio zap (warmup) — ignora
        if (loadIgnoreNumbers().has(senderNumber)) continue;       // lista manual — ignora

        const instance  = event.instance || '?';
        const pushName  = msg.pushName || '';
        const msgObj    = msg.message || {};
        const kind      = classifyMessage(msgObj);
        const text      = extractText(msgObj);

        const header = `📩 *Resposta recebida*\n*Via:* ${instance}\n*Número:* +${senderNumber}\n*Nome:* ${pushName || '—'}\n──────────────`;

        const GRP_TIMEOUT = 120000;
        // Evolution API rejeita @g.us no campo number — passa só o ID numérico
        const grpNumber = _repliesGroupJid.replace('@g.us', '').replace('@s.whatsapp.net', '');

        if (kind.type === 'reaction') {
            await evolution.sendText(senderInstance, grpNumber,
                `${header}\n${kind.emoji} reagiu à sua mensagem`, GRP_TIMEOUT).catch(() => {});

        } else if (kind.type === 'text') {
            await evolution.sendText(senderInstance, grpNumber,
                `${header}\n${text}`, GRP_TIMEOUT).catch(() => {});

        } else if (kind.type === 'image') {
            const caption = text ? `\n${text}` : '';
            await evolution.sendText(senderInstance, grpNumber,
                `${header}\n${kind.label}${caption}`, GRP_TIMEOUT).catch(() => {});
            evolution.getMediaBase64(instance, msg).then(base64 => {
                if (base64) return evolution.sendMedia(senderInstance, grpNumber,
                    base64, 'image', text || '');
            }).catch(() => {});

        } else if (kind.type === 'audio') {
            await evolution.sendText(senderInstance, grpNumber,
                `${header}\n${kind.label}`, GRP_TIMEOUT).catch(() => {});
            evolution.getMediaBase64(instance, msg).then(base64 => {
                if (base64) return evolution.sendAudio(senderInstance, grpNumber, base64);
            }).catch(() => {});

        } else {
            await evolution.sendText(senderInstance, grpNumber,
                `${header}\n${kind.label}`, GRP_TIMEOUT).catch(() => {});
        }

        console.log(`[REPLIES] ${instance} ← ${pushName || senderNumber} (${kind.type}) → encaminhado`);
    }
};

const app  = express();
const PORT = process.env.PORT || 3000;

// URL base que a Evolution API (container Docker) usa para baixar mídias
const MEDIA_HOST    = process.env.MEDIA_HOST    || `http://host.docker.internal:${PORT}`;
// URL base que a Evolution API usa para enviar webhooks de volta ao servidor
const WEBHOOK_BASE  = process.env.WEBHOOK_BASE  || `http://host.docker.internal:${PORT}`;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
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
        await refreshOwnNumbers();
        // Popula instâncias conectadas para auto-seleção do remetente de replies
        try {
            const insts = await evolution.fetchInstances();
            insts.filter(i => (i.connectionStatus || i.instance?.state || i.state) === 'open')
                 .forEach(i => _connectedInstances.add(i.instanceName || i.name));
            if (_connectedInstances.size) console.log(`[REPLIES] ${_connectedInstances.size} zap(s) conectados detectados.`);
        } catch (_) {}
        const cycle = await getInterruptedCycle();
        if (cycle) console.log(`⚠️ [STARTUP] Campanha interrompida detectada (ID: ${cycle.id}).`);
        console.log('✅ [STARTUP] Sistema pronto!\n');
    } catch (err) {
        console.warn('⚠️ [STARTUP] Alerta na inicialização:', err.message);
    }
})();

// cycleId da campanha ativa — usado pelo crash handler para salvar relatório
let _activeCycleId  = null;
let _campaignActive = false;

const crashHandler = async (type, err) => {
    console.error(`🚨 [CRASH] ${type}:`, err?.message || err);
    if (_activeCycleId) {
        console.error(`🚨 [CRASH] Salvando relatório da campanha ${_activeCycleId}...`);
        try {
            await updateCycleStats(_activeCycleId, 0, 0, 'interrompido');
            await generateCampaignReport(_activeCycleId);
            console.error('🚨 [CRASH] Relatório salvo.');
        } catch (e) {
            console.error('🚨 [CRASH] Falha ao salvar relatório:', e.message);
        }
    }
    process.exit(1);
};

process.on('uncaughtException',  (err) => crashHandler('uncaughtException',  err));
process.on('unhandledRejection', (err) => {
    // Loga mas NÃO derruba o servidor — rejeições isoladas não devem matar a campanha
    console.error('⚠️ [WARN] unhandledRejection (ignorado):', err?.message || err);
});

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
        const instances = await evolution.fetchInstances();
        const instanceMap = {};
        instances.forEach(inst => {
            const name  = inst.instanceName || inst.name;
            const state = inst.connectionStatus || inst.instance?.state || inst.state || 'close';
            if (name) instanceMap[name] = state;
        });

        const ADMIN_ZAP_ID = process.env.ADMIN_ZAP || 'WA-49';
        const status = [];
        for (let i = 1; i <= 49; i++) {
            const accountId   = i <= 48 ? `WA-${String(i).padStart(2, '0')}` : ADMIN_ZAP_ID;
            const hasInstance = accountId in instanceMap;
            const state       = hasInstance ? instanceMap[accountId] : 'close';
            const isAdmin     = accountId === ADMIN_ZAP_ID;
            status.push({ accountId, connected: state === 'open', state, hasInstance, isAdmin });
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
        const proxyConfig = await getProxyConfigForAccount(accountId);

        let instanceExisted = false;
        try {
            await evolution.createInstance(accountId, proxyConfig);
        } catch (createErr) {
            const status = createErr.response?.status;
            if (status !== 400 && status !== 403) throw createErr;
            instanceExisted = true; // 400/403 = já existe
        }

        evolution.setWebhook(accountId, `${WEBHOOK_BASE}/webhook/evolution`)
            .catch(() => {});

        const state = await evolution.getConnectionState(accountId);
        if (state === 'open') {
            return res.json({ connected: true, message: `${accountId} já está conectado.` });
        }

        // Instância desconectada: limpa sessão expirada para forçar novo QR
        // Baileys fica em 'close' após reconnect falho — logout reseta o estado
        if (instanceExisted && state === 'close') {
            try { await evolution.logoutInstance(accountId); } catch (_) {}
            await new Promise(r => setTimeout(r, 2000));
        }

        // QR pode levar alguns segundos para ser gerado pelo Baileys
        let qrcode = await evolution.getQRCode(accountId);
        if (!qrcode) await new Promise(r => setTimeout(r, 3000));
        qrcode = qrcode || await evolution.getQRCode(accountId);

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

// Endpoint leve — só estado, sem chamar /instance/connect (que regenera QR)
app.get('/api/whatsapp/state/:accountId', async (req, res) => {
    try {
        const state = await evolution.getConnectionState(req.params.accountId);
        res.json({ state });
    } catch (_) {
        res.json({ state: 'close' });
    }
});

app.post('/webhook/evolution', (req, res) => {
    res.sendStatus(200); // responde imediatamente — nunca atrasa a Evolution API
    const event = req.body;
    if (!event?.event) return;

    if (event.event === 'CONNECTION_UPDATE') {
        const instance = event.instance || event.data?.instance;
        const state    = (event.data || {}).state;
        console.log(`[WEBHOOK] ${instance}: ${state}`);
        if (instance) {
            clearOwnerCacheFor(instance);
            if (state === 'open') {
                _connectedInstances.add(instance);
                refreshOwnNumbers().catch(() => {});
            }
            if (state === 'close') {
                _connectedInstances.delete(instance);
            }
        }
        return;
    }

    // Confirma ACKs para o preflight check (SERVER_ACK ou superior)
    if (event.event === 'messages.update' || event.event === 'MESSAGES_UPDATE') {
        const updates = Array.isArray(event.data) ? event.data : [event.data];
        for (const upd of updates) {
            const fromMe = upd?.key?.fromMe ?? upd?.fromMe;
            const keyId  = upd?.key?.id     || upd?.keyId;
            const status = upd?.update?.status ?? upd?.status;
            const isAcked = status >= 2 || status === 'SERVER_ACK' || status === 'DELIVERY_ACK' || status === 'READ';
            if (fromMe && keyId && isAcked) {
                notifyAck(keyId);
            }
        }
    }

    if (event.event === 'MESSAGES_UPSERT' || event.event === 'messages.upsert') {
        handleIncomingReply(event).catch(err =>
            console.warn('[REPLIES] Erro no handler:', err?.message || err)
        );
    }

});

app.delete('/api/whatsapp/:accountId', async (req, res) => {
    const { accountId } = req.params;
    if (!accountId || !/^WA-\d{2}$/.test(accountId))
        return res.status(400).json({ error: 'ID inválido.' });

    try {
        const stateNow = await evolution.getConnectionState(accountId).catch(() => 'close');

        // Passo 1: deleta diretamente do banco da Evolution API (localhost:5432/evolution)
        // O container usa hostname interno 'postgres', mas a porta 5432 está mapeada no host.
        const evoDbUrl = `postgresql://medusa:${process.env.POSTGRES_PASSWORD || 'medusa'}@localhost:5432/evolution`;
        try {
            const client = new pg.Client({ connectionString: evoDbUrl, connectionTimeoutMillis: 5000 });
            await client.connect();
            try {
                const r = await client.query(`DELETE FROM "Instance" WHERE name = $1`, [accountId]);
                console.log(`[DELETE] Evolution DB: ${r.rowCount} registro(s) de ${accountId} removido(s).`);
            } finally {
                await client.end().catch(() => {});
            }
        } catch (dbErr) {
            console.warn(`[DELETE] DB direto falhou: ${dbErr.message}`);
        }

        // Passo 2: reinicia o socket Baileys para que perca a sessão em memória
        if (stateNow === 'open' || stateNow === 'connecting') {
            try { await evolution.restartInstance(accountId); } catch (_) {}
            // Aguarda estado sair de 'open' (Baileys tenta reconectar mas DB está vazio)
            for (let i = 0; i < 6; i++) {
                const s = await evolution.getConnectionState(accountId).catch(() => 'close');
                if (s !== 'open') break;
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // Passo 3: tenta deletar a instância via API (deve funcionar agora que o DB está limpo)
        try {
            await evolution.deleteInstance(accountId);
            console.log(`[DELETE] API removeu ${accountId}.`);
        } catch (e) {
            console.warn(`[DELETE] API falhou (${e.response?.status}) após limpeza do DB.`);
        }

        exec(`docker exec medusa_evolution rm -rf /evolution/instances/${accountId}`, () => {});
        _connectedInstances.delete(accountId);
        console.log(`🗑️ [${accountId}] Removido.`);
        res.json({ message: `${accountId} removido com sucesso.` });
    } catch (err) {
        console.error(`❌ [DELETE] ${accountId}:`, err.message);
        res.status(500).json({ error: `Erro inesperado ao remover ${accountId}: ${err.message}` });
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
                try {
                    await evolution.createInstance(accounts[i], proxyConfig);
                } catch (createErr) {
                    if (createErr.response?.status !== 400) throw createErr;
                    // 400 = já existe — continua normalmente
                }
                console.log(`[BULK] ${accounts[i]} (${i + 1}/${accounts.length}) iniciado.`);
            } catch (err) {
                console.error(`[BULK] Erro em ${accounts[i]}:`, err.message);
            }
            if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 3_000));
        }
        console.log('[BULK] Reconexão em massa concluída.');
    })();
});

app.post('/api/whatsapp/reset-all', async (req, res) => {
    try {
        const evoDbUrl = `postgresql://medusa:${process.env.POSTGRES_PASSWORD || 'medusa'}@localhost:5432/evolution`;
        const client = new pg.Client({ connectionString: evoDbUrl, connectionTimeoutMillis: 5000 });
        await client.connect();
        let count = 0;
        try {
            const r = await client.query('DELETE FROM "Instance"');
            count = r.rowCount;
            console.log(`[RESET-ALL] ${count} instância(s) removida(s) do banco Evolution.`);
        } finally {
            await client.end().catch(() => {});
        }
        exec('docker compose restart evolution', { cwd: process.cwd() }, (err) => {
            if (err) console.warn('[RESET-ALL] docker compose restart falhou:', err.message);
            else console.log('[RESET-ALL] Evolution API reiniciando.');
        });
        _connectedInstances.clear();
        res.json({ message: `✅ ${count} sessão(ões) apagada(s). Evolution API reiniciando — aguarde ~30s antes de conectar.` });
    } catch (err) {
        console.error('[RESET-ALL] Erro:', err.message);
        res.status(500).json({ error: `Erro ao limpar sessões: ${err.message}` });
    }
});

// ── Gerenciador de listas ─────────────────────────────────────────────────────

app.get('/api/listas', (_req, res) => {
    try {
        const active = readActiveState();
        const files  = fs.readdirSync(LISTAS_DIR)
            .filter(f => /\.(xlsx|xls)$/i.test(f) && !f.startsWith('.'))
            .map(f => ({
                name:   f,
                size:   fs.statSync(path.join(LISTAS_DIR, f)).size,
                active: active[f] !== false,
            }));
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
        const { added, skipped } = await addContactsToQueue(result.numeros);
        const msg = skipped > 0
            ? `${added} adicionados. ${skipped} já estavam na fila e foram ignorados.`
            : `${added} números adicionados à fila.`;
        res.json({ message: msg, totalRecebidos: result.totalRecebidos, totalUnicos: result.totalUnicos, added, skipped });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Gestão de listas ─────────────────────────────────────────────────────────

/** GET /api/list-mgmt — todas as listas com metadata (count, active, isTemp) */
app.get('/api/list-mgmt', (_req, res) => {
    try { res.json(getAllLists()); } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/list-mgmt/:filename/contacts?page=1&pageSize=100&q= */
app.get('/api/list-mgmt/:filename/contacts', (req, res) => {
    try {
        const page     = Math.max(1, parseInt(req.query.page || '1', 10));
        const pageSize = Math.min(500, parseInt(req.query.pageSize || '100', 10));
        const q        = (req.query.q || '').trim();
        const phones   = readListPhones(req.params.filename);
        const filtered = q ? phones.filter(p => p.includes(q)) : phones;
        const start    = (page - 1) * pageSize;
        res.json({ total: filtered.length, page, pageSize, phones: filtered.slice(start, start + pageSize) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/list-mgmt/:filename/contacts — adiciona um número */
app.post('/api/list-mgmt/:filename/contacts', (req, res) => {
    try {
        const phone = addPhoneToList(req.params.filename, req.body.phone);
        res.json({ message: `${phone} adicionado.`, phone });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

/** DELETE /api/list-mgmt/:filename/contacts/:phone — remove um número */
app.delete('/api/list-mgmt/:filename/contacts/:phone', (req, res) => {
    try {
        removePhoneFromList(req.params.filename, req.params.phone);
        res.json({ message: `${req.params.phone} removido.` });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

/** PATCH /api/list-mgmt/:filename/active — habilita/desabilita para painel */
app.patch('/api/list-mgmt/:filename/active', (req, res) => {
    try {
        setListActive(req.params.filename, !!req.body.active);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** DELETE /api/list-mgmt/:filename — exclui lista */
app.delete('/api/list-mgmt/:filename', (req, res) => {
    try {
        deleteListFile(req.params.filename);
        res.json({ message: `${req.params.filename} removido.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/list-mgmt/merge — mescla listas com dedup */
app.post('/api/list-mgmt/merge', (req, res) => {
    try {
        const { filenames, outputName } = req.body;
        if (!filenames || filenames.length < 2)
            return res.status(400).json({ error: 'Selecione pelo menos 2 listas.' });
        const phones = mergeLists(filenames);
        if (!phones.length) return res.status(400).json({ error: 'Nenhum número válido nas listas.' });
        const base     = (outputName || 'Mesclagem').replace(/[^a-zA-Z0-9_\-]/g, '_');
        const filename = `${base}_${Date.now()}.xlsx`;
        writeListPhones(filename, phones);
        res.json({ message: `Mesclagem concluída: ${phones.length} números únicos.`, filename, count: phones.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/list-mgmt/create — cria lista vazia */
app.post('/api/list-mgmt/create', (req, res) => {
    try {
        const { filename } = req.body;
        if (!filename) return res.status(400).json({ error: 'filename é obrigatório.' });
        const name = path.basename(filename.endsWith('.xlsx') ? filename : filename + '.xlsx');
        writeListPhones(name, []);
        res.json({ message: `${name} criado.`, filename: name });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/list-mgmt/split — divide lista em N partes */
app.post('/api/list-mgmt/split', (req, res) => {
    try {
        const { filename, n } = req.body;
        const nParts = parseInt(n, 10);
        if (!filename || !nParts || nParts < 2)
            return res.status(400).json({ error: 'filename e n (≥2) são obrigatórios.' });
        const phones = readListPhones(filename);
        if (!phones.length) return res.status(400).json({ error: 'Lista vazia.' });
        const base  = path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9_\-]/g, '_');
        const parts = splitIntoN(phones, nParts, base);
        res.json({ message: `${parts.length} parte(s) criada(s).`, parts });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fila e campanha ───────────────────────────────────────────────────────────

app.post('/api/upload-lists', uploadExcel.array('excelFiles'), async (req, res) => {
    try {
        if (!req.files?.length) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        const result = processExcelFiles(req.files);
        if (result.totalUnicos === 0) return res.status(400).json({ error: 'Nenhum número válido encontrado.' });
        const { added, skipped } = await addContactsToQueue(result.numeros);
        const msg = skipped > 0
            ? `${added} adicionados. ${skipped} já estavam na fila e foram ignorados.`
            : `${added} números adicionados à fila.`;
        res.json({ message: msg, totalRecebidos: result.totalRecebidos, totalUnicos: result.totalUnicos, added, skipped });
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

app.post('/api/clear-dashboard', async (req, res) => {
    try {
        requestStop();
        await clearDashboardData();
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/start-campaign
 * Body (multipart/form-data):
 *   accounts       — JSON array de accountIds ativos
 *   messageText    — template com suporte a spintax
 *   mediaMode      — "caption" | "separate"
 *   startDatetime  — ISO datetime local — quando iniciar (null = imediato)
 *   endDatetime    — ISO datetime local — prazo final absoluto
 *   warmupLevel    — 1 | 2 | 3
 *   mediaFile      — arquivo de mídia (opcional)
 */
app.post('/api/start-campaign', uploadMedia.single('mediaFile'), async (req, res) => {
    try {
        const {
            accounts, messageText, mediaMode,
            startDatetime,
            endDatetime,
            warmupLevel = '2',
            testMode    = 'false',
        } = req.body;

        const activeAccountsList = JSON.parse(accounts);
        if (activeAccountsList.length === 0)
            return res.status(400).json({ error: 'Nenhuma conta selecionada.' });

        if (_campaignActive)
            return res.status(409).json({ error: 'Já existe uma campanha em andamento. Aguarde ou pare antes de iniciar outra.' });

        const totalPending = await countPending();
        if (totalPending === 0)
            return res.status(400).json({ error: 'Fila vazia. Processe uma lista primeiro.' });

        const cycleId = await createCycle(totalPending);

        const mediaExt      = req.file ? path.extname(req.file.filename).toLowerCase().slice(1) : null;
        const mediaType     = ['mp4', 'mov', 'avi', 'mkv'].includes(mediaExt) ? 'video' : 'image';
        const mediaUrl      = req.file ? `${MEDIA_HOST}/uploads/${req.file.filename}` : null;
        const mediaFilename = req.file ? req.file.filename : null;

        res.json({
            message: '🚀 Campanha iniciada!',
            cycleId,
            info: {
                totalContatos:    totalPending,
                zapsSelecionados: activeAccountsList.length,
                warmupLevel:      parseInt(warmupLevel),
                janela:           testMode === 'true' ? 'Sem trava de horário' : '08:00–19:45',
                inicio:           startDatetime || 'imediato',
                fim:              endDatetime   || 'sem limite',
            },
        });

        const campaignConfig = {
            messageTemplate: messageText   || '',
            mediaUrl,
            mediaFilename,
            mediaType,
            mediaMode:      mediaMode      || 'caption',
            startDatetime:  startDatetime  || null,
            endDatetime:    endDatetime    || null,
            warmupLevel: parseInt(warmupLevel),
            testMode:       testMode === 'true',
        };

        (async () => {
            _activeCycleId  = cycleId;
            _campaignActive = true;
            try {
                await runCampaignLoop(activeAccountsList, campaignConfig, cycleId);
            } catch (err) {
                console.error('[CAMPAIGN] Erro não tratado no loop da campanha:', err);
            } finally {
                _activeCycleId  = null;
                _campaignActive = false;
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

app.post('/api/warmup-chips/scheduled', async (req, res) => {
    try {
        const { accounts, level = 2, startDatetime, endDatetime, windowStart = '08:00', windowEnd = '19:00' } = req.body;
        if (!Array.isArray(accounts) || accounts.length < 2)
            return res.status(400).json({ error: 'Mínimo 2 contas.' });
        if (!endDatetime)
            return res.status(400).json({ error: 'endDatetime obrigatório.' });
        if (isWarmupRunning())
            return res.status(400).json({ error: 'Aquecimento já está em andamento.' });

        res.json({ message: `🔥 Aquecimento agendado — janela ${windowStart}–${windowEnd} — até ${new Date(endDatetime).toLocaleString('pt-BR')}` });
        startScheduledWarmup(accounts, parseInt(level), startDatetime || null, endDatetime, windowStart, windowEnd);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Configura proxy 4G em todos os zaps conectados baseado no ZTE correspondente
app.post('/api/setup-proxies', async (req, res) => {
    try {
        const instances = await evolution.fetchInstances();
        const connected = instances.filter(i => (i.connectionStatus || i.instance?.state || i.state) === 'open');

        let ok = 0, semZte = 0, falhas = 0;
        const resultados = [];

        for (const inst of connected) {
            const name  = inst.name || inst.instanceName;
            const proxy = getStaticProxyForAccount(name);
            if (!proxy) {
                semZte++;
                resultados.push(`⚠️ ${name}: sem ZTE mapeado`);
                continue;
            }
            try {
                await evolution.setProxy(name, proxy);
                ok++;
                resultados.push(`✅ ${name}: 4G via porta ${proxy.port}`);
                console.log(`[PROXY] ${name} → host.docker.internal:${proxy.port}`);
            } catch (err) {
                falhas++;
                resultados.push(`❌ ${name}: ${err.response?.data?.message || err.message}`);
                console.error(`[PROXY] Falha em ${name}:`, err.message);
            }
        }

        res.json({
            message: `${ok} zap(s) configurados com 4G, ${semZte} sem ZTE mapeado, ${falhas} falha(s).`,
            detalhes: resultados,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Aggregador de respostas — endpoints ──────────────────────────────────────

// Lista grupos de uma instância conectada
app.get('/api/groups', async (req, res) => {
    const { instance } = req.query;
    if (!instance) return res.status(400).json({ error: 'instance obrigatório' });
    try {
        const groups = await evolution.fetchGroups(instance);
        res.json(groups.map(g => ({
            jid:  g.id,
            name: g.subject || g.name || g.id,
            size: g.size || g.participants?.length || 0,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Lê config atual
app.get('/api/config/replies', (req, res) => {
    res.json({ groupJid: _repliesGroupJid, instance: _repliesInstance });
});

// Salva config (persiste em memória; reiniciar lê do .env se preenchido)
app.post('/api/config/replies', async (req, res) => {
    const { groupJid, instance } = req.body;
    if (!groupJid || !instance)
        return res.status(400).json({ error: 'groupJid e instance obrigatórios' });
    _repliesGroupJid = groupJid;
    _repliesInstance = instance;
    _saveRepliesConfig();
    await refreshOwnNumbers(); // atualiza auto-ignore com estado atual dos zaps
    console.log(`[REPLIES] Configurado: ${instance} → grupo ${groupJid}`);
    res.json({ ok: true, groupJid, instance });
});

// Força atualização da lista de números próprios (auto-ignore warmup)
app.post('/api/config/replies/refresh-ignore', async (req, res) => {
    await refreshOwnNumbers();
    res.json({ ok: true, ownNumbers: [..._ownNumbers].length });
});

// Desativa aggregador em memória sem apagar o arquivo de config
app.post('/api/config/replies/disable', (req, res) => {
    _repliesGroupJid = '';
    _repliesInstance = '';
    console.log('[REPLIES] Aggregador desativado temporariamente.');
    res.json({ ok: true });
});

// Reativa aggregador carregando do arquivo salvo
app.post('/api/config/replies/enable', (req, res) => {
    _loadRepliesConfig();
    console.log(`[REPLIES] Aggregador reativado: ${_repliesInstance} → ${_repliesGroupJid}`);
    if (!_repliesGroupJid) return res.status(400).json({ error: 'Nenhuma configuração salva. Configure e salve primeiro.' });
    res.json({ ok: true, instance: _repliesInstance, groupJid: _repliesGroupJid });
});

// Testa se o sistema consegue enviar para o grupo configurado
app.post('/api/config/replies/test', async (req, res) => {
    if (!_repliesGroupJid)
        return res.status(400).json({ error: 'REPLIES_GROUP_JID não configurado.' });

    const testInstance = _repliesInstance || [..._connectedInstances][0] || null;
    if (!testInstance)
        return res.status(400).json({ error: 'Nenhum zap conectado disponível para o teste.' });

    let groupFound = false;
    try {
        const groups = await evolution.fetchGroups(testInstance);
        groupFound = groups.some(g => g.id === _repliesGroupJid);
        if (!groupFound) {
            return res.status(400).json({
                error: `${testInstance} não é membro do grupo ${_repliesGroupJid}. Adicione o zap ao grupo no WhatsApp primeiro.`,
            });
        }
    } catch (_) {}

    const numberParam = _repliesGroupJid.replace('@g.us', '').replace('@s.whatsapp.net', '');
    try {
        await evolution.sendText(testInstance, numberParam,
            '✅ *Medusa — Teste de Aggregador*\nSe você recebeu esta mensagem, o encaminhamento está funcionando!', 120000);
        res.json({ ok: true, instance: testInstance, groupJid: _repliesGroupJid, numberUsed: numberParam });
    } catch (err) {
        res.status(500).json({
            error: err.message,
            detalhe: err.response?.data,
            numberUsed: numberParam,
            groupJid: _repliesGroupJid,
        });
    }
});

// Reconfigura webhooks em todos os zaps conectados (útil após reinicialização)
app.post('/api/setup-webhooks', async (req, res) => {
    try {
        const instances = await evolution.fetchInstances();
        const connected = instances.filter(i =>
            (i?.instance?.state || i?.state) === 'open'
        );
        const url = `${WEBHOOK_BASE}/webhook/evolution`;
        await Promise.allSettled(
            connected.map(i => evolution.setWebhook(i.instanceName || i.name, url))
        );
        res.json({ message: `✅ Webhooks configurados em ${connected.length} zap(s).` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
