import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as evolution from '../evolution/client.js';
import { humanDelay, processSpintax } from './antiSpam.js';
import { rotateMobileIPsStaggered, getActiveZteIds } from './networkController.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const WARMUP_TEXT_PATH  = path.resolve(__dirname, '../../textAquecimento.txt');
const WARMUP_IMAGES_DIR = path.resolve(__dirname, '../../warmup_media/imagens');
const WARMUP_AUDIOS_DIR = path.resolve(__dirname, '../../warmup_media/audios');
const MEDIA_HOST        = process.env.MEDIA_HOST || `http://host.docker.internal:${process.env.PORT || 3000}`;

// ── Configuração por nível ────────────────────────────────────────────────────
const LEVEL_CONFIG = {
    1:  { groupSize: 2, minDelayS: 180, maxDelayS: 300, imageChance: 0.00, audioChance: 0.00 },
    2:  { groupSize: 2, minDelayS: 120, maxDelayS: 180, imageChance: 0.00, audioChance: 0.00 },
    3:  { groupSize: 3, minDelayS:  90, maxDelayS: 120, imageChance: 0.05, audioChance: 0.00 },
    4:  { groupSize: 3, minDelayS:  60, maxDelayS:  90, imageChance: 0.10, audioChance: 0.00 },
    5:  { groupSize: 4, minDelayS:  45, maxDelayS:  60, imageChance: 0.20, audioChance: 0.00 },
    6:  { groupSize: 4, minDelayS:  30, maxDelayS:  45, imageChance: 0.25, audioChance: 0.10 },
    7:  { groupSize: 4, minDelayS:  20, maxDelayS:  30, imageChance: 0.30, audioChance: 0.15 },
    8:  { groupSize: 6, minDelayS:  15, maxDelayS:  20, imageChance: 0.40, audioChance: 0.20 },
    9:  { groupSize: 6, minDelayS:  10, maxDelayS:  15, imageChance: 0.50, audioChance: 0.25 },
    10: { groupSize: 8, minDelayS:   8, maxDelayS:  12, imageChance: 0.60, audioChance: 0.30 },
};

// Estado do aquecimento manual — exposto para a UI via /api/warmup-status
let _manualRunning = false;
let _warmupState   = { running: false, level: 0, zapCount: 0, rotateMins: 0, startedAt: null };

export const isWarmupRunning = () => _manualRunning;
export const getWarmupState  = () => ({ ..._warmupState });

// ── Cache de recursos ─────────────────────────────────────────────────────────
const _cache = { texts: null, images: null, audios: null };

const loadTexts = () => {
    if (_cache.texts) return _cache.texts;
    try {
        if (!fs.existsSync(WARMUP_TEXT_PATH)) {
            const defaults = [
                'Olá, tudo bem?', 'Como vai você?', 'Bom dia!', 'Boa tarde!', 'Boa noite!',
                'Tudo bem por aí?', 'Você viu as notícias?', 'O que acha disso?',
                'Sim, concordo.', 'Não tenho certeza.', 'Vou verificar.', 'Ok, combinado.',
                'Haha isso é verdade!', 'Que interessante!', 'Pode ser...', 'Com certeza!',
            ];
            fs.writeFileSync(WARMUP_TEXT_PATH, defaults.join('\n'), 'utf8');
            _cache.texts = defaults;
        } else {
            _cache.texts = fs.readFileSync(WARMUP_TEXT_PATH, 'utf8')
                .split('\n').map(l => l.trim()).filter(l => l.length > 0);
        }
    } catch (_) {
        _cache.texts = ['Oi', 'Tudo bem?', 'Sim', 'Ok'];
    }
    return _cache.texts;
};

const readDir = (dir) => {
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => !f.startsWith('.')).map(f => path.join(dir, f));
    } catch (_) { return []; }
};

const getImages = () => { _cache.images ??= readDir(WARMUP_IMAGES_DIR); return _cache.images; };
const getAudios = () => { _cache.audios ??= readDir(WARMUP_AUDIOS_DIR); return _cache.audios; };

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

const toMediaUrl = (filePath) => {
    const rel = path.relative(path.resolve(__dirname, '../../'), filePath).replace(/\\/g, '/');
    return `${MEDIA_HOST}/${rel}`;
};

// ── Verificação de instâncias ─────────────────────────────────────────────────
const isReady = async (accountId) => {
    try { return (await evolution.getConnectionState(accountId)) === 'open'; }
    catch (_) { return false; }
};

const _ownerCache = new Map();

const getOwnerNumber = async (accountId) => {
    if (_ownerCache.has(accountId)) return _ownerCache.get(accountId);
    try {
        const instances = await evolution.fetchInstances();
        for (const inst of instances) {
            const name  = inst.instanceName || inst.name;
            const owner = inst?.instance?.owner || inst?.owner || null;
            if (name && owner) _ownerCache.set(name, String(owner).replace(/\D/g, ''));
        }
        return _ownerCache.get(accountId) || null;
    } catch (_) { return null; }
};

// ── Envio de mensagem de aquecimento ─────────────────────────────────────────
const sendWarmupMessage = async (fromId, toNumber, level) => {
    const cfg  = LEVEL_CONFIG[level] || LEVEL_CONFIG[5];
    const text = processSpintax(pickRandom(loadTexts()));
    const images = getImages();
    const audios = getAudios();

    const sendImage = images.length > 0 && Math.random() < cfg.imageChance;
    const sendAudio = !sendImage && audios.length > 0 && Math.random() < cfg.audioChance;

    try {
        if (sendImage) {
            await evolution.sendMedia(fromId, toNumber, toMediaUrl(pickRandom(images)), 'image', text);
        } else if (sendAudio) {
            await evolution.sendMedia(fromId, toNumber, toMediaUrl(pickRandom(audios)), 'audio', '');
            if (text) await evolution.sendText(fromId, toNumber, text);
        } else {
            await evolution.sendText(fromId, toNumber, text);
        }
    } catch (err) {
        console.warn(`⚠️ [AQUECIMENTO] Falha ao enviar ${fromId}→${toNumber}: ${err.message}`);
    }
};

// ── Conversa em grupo ─────────────────────────────────────────────────────────
/**
 * Executa uma rodada de conversa em grupo.
 * @param {string[]} group - IDs dos zaps participantes
 * @param {number}   level - nível de aquecimento
 * @param {()=>boolean} shouldContinue - callback que indica se deve continuar
 *        Separa o controle de parada do manual (flag) vs. orquestrador (tempo).
 */
const runGroupConversation = async (group, level, shouldContinue) => {
    const cfg     = LEVEL_CONFIG[level] || LEVEL_CONFIG[5];
    const numbers = await Promise.all(group.map(id => getOwnerNumber(id)));

    for (let i = 0; i < group.length; i++) {
        if (!shouldContinue()) return;

        const fromId = group[i];
        const toIdx  = (i + 1) % group.length;
        const toNum  = numbers[toIdx];

        if (!toNum) continue;

        await sendWarmupMessage(fromId, toNum, level);
        await humanDelay(cfg.minDelayS, cfg.maxDelayS);

        if (group.length <= 3 && shouldContinue()) {
            const replyFrom = group[toIdx];
            const replyTo   = numbers[i];
            if (replyTo) {
                await sendWarmupMessage(replyFrom, replyTo, level);
                await humanDelay(cfg.minDelayS * 0.5, cfg.maxDelayS * 0.7);
            }
        }
    }
};

// ── Utilitários ───────────────────────────────────────────────────────────────
const filterReady = async (accounts) => {
    const checks = await Promise.all(accounts.map(async id => ({ id, ok: await isReady(id) })));
    return checks.filter(c => {
        if (!c.ok) console.warn(`⚠️ [AQUECIMENTO] ${c.id} offline. Removendo.`);
        return c.ok;
    }).map(c => c.id);
};

const buildGroups = (accounts, groupSize) => {
    const shuffled = [...accounts].sort(() => 0.5 - Math.random());
    const groups   = [];
    for (let i = 0; i < shuffled.length; i += groupSize) {
        const g = shuffled.slice(i, i + groupSize);
        if (g.length >= 2) groups.push(g);
    }
    return groups;
};

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Aquecimento por tempo determinado — usado pelo orquestrador entre ondas.
 * Completamente independente do flag manual: stopWarmup() não o afeta.
 */
export const runWarmupFor = async (activeAccounts, level = 5, durationSeconds = 300) => {
    const cfg       = LEVEL_CONFIG[level] || LEVEL_CONFIG[5];
    const endTime   = Date.now() + durationSeconds * 1000;
    const shouldContinue = () => Date.now() < endTime;

    let ready = await filterReady(activeAccounts);
    if (ready.length < 2) {
        console.log('[AQUECIMENTO] Menos de 2 zaps disponíveis. Pausa sem aquecimento.');
        await new Promise(r => setTimeout(r, durationSeconds * 1000));
        return;
    }

    console.log(`🔥 [AQUECIMENTO] Sessão de ${Math.round(durationSeconds / 60)}min — nível ${level} — ${ready.length} zaps`);

    while (shouldContinue()) {
        ready = await filterReady(ready);
        if (ready.length < 2) break;

        const groups = buildGroups(ready, cfg.groupSize);
        console.log(`🔥 [AQUECIMENTO] ${groups.length} grupo(s) — ${Math.round((endTime - Date.now()) / 1000)}s restantes`);

        await Promise.allSettled(groups.map(g => runGroupConversation(g, level, shouldContinue)));

        if (shouldContinue()) await humanDelay(15, 30);
    }

    console.log('✅ [AQUECIMENTO] Sessão encerrada.');
};

/**
 * Aquecimento contínuo — iniciado manualmente pela página de Aquecimento.
 * Controlado por _manualRunning; stopWarmup() encerra apenas este modo.
 *
 * @param {string[]} accountsList - zaps selecionados
 * @param {number}   level        - nível 1–10
 * @param {number}   rotateMins   - intervalo em minutos para rotação de IP (0 = desativado)
 */
export const startWarmup = async (accountsList, level = 5, rotateMins = 0) => {
    if (_manualRunning) {
        console.warn('⚠️ [AQUECIMENTO] Já está rodando. Ignorando nova chamada.');
        return;
    }

    let active = await filterReady(accountsList);
    if (active.length < 2) {
        console.warn('⚠️ [AQUECIMENTO] Menos de 2 contas conectadas. Abortando.');
        return;
    }

    _manualRunning = true;
    _warmupState   = { running: true, level, zapCount: active.length, rotateMins, startedAt: Date.now() };

    const shouldContinue  = () => _manualRunning;
    const rotateIntervalMs = rotateMins > 0 ? rotateMins * 60_000 : 0;
    let   nextRotateAt     = rotateIntervalMs > 0 ? Date.now() + rotateIntervalMs : Infinity;

    console.log(`\n🔥 [AQUECIMENTO] Iniciado — ${active.length} zaps | nível ${level}${rotateMins > 0 ? ` | rotação a cada ${rotateMins} min` : ''}`);

    while (_manualRunning) {
        // ── Rotação de IP agendada ────────────────────────────────────────────
        if (Date.now() >= nextRotateAt) {
            console.log('🔄 [AQUECIMENTO] Rotacionando IPs (escalonado)...');
            await rotateMobileIPsStaggered(getActiveZteIds());
            nextRotateAt = Date.now() + rotateIntervalMs;
            // Reavalia quem está online após a reconexão 4G
            active = await filterReady(accountsList);
        }

        active = await filterReady(active);
        if (active.length < 2) { _manualRunning = false; break; }

        _warmupState.zapCount = active.length;

        const cfg    = LEVEL_CONFIG[level] || LEVEL_CONFIG[5];
        const groups = buildGroups(active, cfg.groupSize);

        await Promise.allSettled(groups.map(g => runGroupConversation(g, level, shouldContinue)));
        if (_manualRunning) await humanDelay(15, 30);
    }

    _manualRunning = false;
    _warmupState   = { running: false, level: 0, zapCount: 0, rotateMins: 0, startedAt: null };
    console.log('🛑 [AQUECIMENTO] Contínuo parado.');
};

export const stopWarmup = () => { _manualRunning = false; };

// Exportado para testes unitários
export { buildGroups };

export default { startWarmup, stopWarmup, runWarmupFor, isWarmupRunning, getWarmupState };
