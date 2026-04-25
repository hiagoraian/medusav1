import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as evolution from '../evolution/client.js';
import { humanDelay, processSpintax } from './antiSpam.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const WARMUP_TEXT_PATH   = path.resolve(__dirname, '../../textAquecimento.txt');
const WARMUP_IMAGES_DIR  = path.resolve(__dirname, '../../warmup_media/imagens');
const WARMUP_AUDIOS_DIR  = path.resolve(__dirname, '../../warmup_media/audios');
const MEDIA_HOST         = process.env.MEDIA_HOST || `http://host.docker.internal:${process.env.PORT || 3000}`;

// ── Configuração por nível ────────────────────────────────────────────────────
// groupSize: quantos zaps por grupo de conversa
// minDelayS / maxDelayS: delay entre cada fala (segundos)
// imageChance / audioChance: probabilidade de enviar mídia (0–1)
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

let isWarmupRunning = false;
let _textCache      = null;

// ── Carregamento de recursos ──────────────────────────────────────────────────
const loadTexts = () => {
    if (_textCache) return _textCache;
    try {
        if (!fs.existsSync(WARMUP_TEXT_PATH)) {
            const defaults = [
                'Olá, tudo bem?', 'Como vai você?', 'Bom dia!', 'Boa tarde!', 'Boa noite!',
                'Tudo bem por aí?', 'Você viu as notícias?', 'O que acha disso?',
                'Sim, concordo.', 'Não tenho certeza.', 'Vou verificar.', 'Ok, combinado.',
                'Haha isso é verdade!', 'Que interessante!', 'Pode ser...', 'Com certeza!',
            ];
            fs.writeFileSync(WARMUP_TEXT_PATH, defaults.join('\n'), 'utf8');
            _textCache = defaults;
        } else {
            _textCache = fs.readFileSync(WARMUP_TEXT_PATH, 'utf8')
                .split('\n').map(l => l.trim()).filter(l => l.length > 0);
        }
    } catch (_) {
        _textCache = ['Oi', 'Tudo bem?', 'Sim', 'Ok'];
    }
    return _textCache;
};

const listMediaFiles = (dir) => {
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => !f.startsWith('.'))
            .map(f => path.join(dir, f));
    } catch (_) {
        return [];
    }
};

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Converte caminho local em URL para a Evolution API
const toMediaUrl = (filePath) => {
    const rel = path.relative(path.resolve(__dirname, '../../'), filePath).replace(/\\/g, '/');
    return `${MEDIA_HOST}/${rel}`;
};

// ── Verificação de instância ──────────────────────────────────────────────────
const isReady = async (accountId) => {
    try {
        return (await evolution.getConnectionState(accountId)) === 'open';
    } catch (_) { return false; }
};

/**
 * Obtém o número do dono da instância (para saber para onde mandar resposta).
 */
const getOwnerNumber = async (accountId) => {
    try {
        const instances = await evolution.fetchInstances();
        const inst = instances.find(i => (i.instanceName || i.name) === accountId);
        const owner = inst?.instance?.owner || inst?.owner || null;
        return owner ? String(owner).replace(/\D/g, '') : null;
    } catch (_) { return null; }
};

// ── Envio com mídia aleatória ────────────────────────────────────────────────
const sendWarmupMessage = async (fromId, toNumber, level) => {
    const cfg    = LEVEL_CONFIG[level] || LEVEL_CONFIG[5];
    const texts  = loadTexts();
    const text   = processSpintax(pickRandom(texts));
    const images = listMediaFiles(WARMUP_IMAGES_DIR);
    const audios = listMediaFiles(WARMUP_AUDIOS_DIR);

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
 * Executa uma rodada de conversa em um grupo.
 * Para pares: A→B, delay, B→A
 * Para triângulos (3): A→B, delay, B→A, delay, B→C, delay, C→B
 * Para grupos maiores: chain circular A→B→C→D→A
 */
const runGroupConversation = async (group, level) => {
    const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG[5];

    // Resolve números de telefone de cada membro (necessário para enviar)
    const numbers = await Promise.all(group.map(id => getOwnerNumber(id)));

    for (let i = 0; i < group.length; i++) {
        if (!isWarmupRunning) return;

        const fromId = group[i];
        const toIdx  = (i + 1) % group.length;
        const toNum  = numbers[toIdx];

        if (!toNum) continue;

        await sendWarmupMessage(fromId, toNum, level);
        await humanDelay(cfg.minDelayS, cfg.maxDelayS);

        // Resposta de volta (só para pares e triângulos, evita spam em grupos grandes)
        if (group.length <= 3 && isWarmupRunning) {
            const replyFrom = group[toIdx];
            const replyTo   = numbers[i];
            if (replyTo) {
                await sendWarmupMessage(replyFrom, replyTo, level);
                await humanDelay(cfg.minDelayS * 0.5, cfg.maxDelayS * 0.7);
            }
        }
    }
};

// ── Filtros de contas ativas ──────────────────────────────────────────────────
const filterReady = async (accounts) => {
    const checks = await Promise.all(accounts.map(async id => ({ id, ok: await isReady(id) })));
    return checks.filter(c => {
        if (!c.ok) console.warn(`⚠️ [AQUECIMENTO] ${c.id} offline. Removendo.`);
        return c.ok;
    }).map(c => c.id);
};

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Roda uma sessão de aquecimento por exatamente `durationSeconds`.
 * Usado pelo orquestrador durante as pausas do wave dispatch.
 */
export const runWarmupFor = async (activeAccounts, level = 5, durationSeconds = 300) => {
    const cfg     = LEVEL_CONFIG[level] || LEVEL_CONFIG[5];
    const endTime = Date.now() + durationSeconds * 1000;
    let ready     = await filterReady(activeAccounts);

    if (ready.length < 2) {
        console.log('[AQUECIMENTO] Menos de 2 zaps disponíveis. Pausa sem aquecimento.');
        await new Promise(r => setTimeout(r, durationSeconds * 1000));
        return;
    }

    console.log(`🔥 [AQUECIMENTO] Sessão de ${Math.round(durationSeconds / 60)}min — nível ${level} — ${ready.length} zaps`);

    while (Date.now() < endTime) {
        // Re-filtra a cada rodada para remover zaps que caíram
        ready = await filterReady(ready);
        if (ready.length < 2) break;

        // Divide em grupos e roda todos em paralelo
        const shuffled = [...ready].sort(() => 0.5 - Math.random());
        const groups   = [];
        for (let i = 0; i < shuffled.length; i += cfg.groupSize) {
            const g = shuffled.slice(i, i + cfg.groupSize);
            if (g.length >= 2) groups.push(g);
        }

        console.log(`🔥 [AQUECIMENTO] ${groups.length} grupo(s) de até ${cfg.groupSize} — ${Math.round((endTime - Date.now()) / 1000)}s restantes`);
        await Promise.allSettled(groups.map(g => runGroupConversation(g, level)));

        if (Date.now() >= endTime) break;
        await humanDelay(15, 30);
    }

    console.log('✅ [AQUECIMENTO] Sessão encerrada.');
};

/**
 * Aquecimento contínuo (iniciado manualmente pela página de Zaps).
 */
export const startWarmup = async (accountsList, level = 5) => {
    let active = await filterReady(accountsList);
    if (active.length < 2) {
        console.warn('⚠️ [AQUECIMENTO] Menos de 2 contas conectadas. Abortando.');
        return;
    }

    isWarmupRunning = true;
    console.log(`\n🔥 [AQUECIMENTO] Contínuo iniciado — ${active.length} zaps, nível ${level}`);

    while (isWarmupRunning) {
        active = await filterReady(active);
        if (active.length < 2) { isWarmupRunning = false; break; }

        const cfg      = LEVEL_CONFIG[level] || LEVEL_CONFIG[5];
        const shuffled = [...active].sort(() => 0.5 - Math.random());
        const groups   = [];
        for (let i = 0; i < shuffled.length; i += cfg.groupSize) {
            const g = shuffled.slice(i, i + cfg.groupSize);
            if (g.length >= 2) groups.push(g);
        }

        await Promise.allSettled(groups.map(g => runGroupConversation(g, level)));
        await humanDelay(15, 30);
    }

    console.log('🛑 [AQUECIMENTO] Contínuo parado.');
};

export const stopWarmup = () => { isWarmupRunning = false; };

export default { startWarmup, stopWarmup, runWarmupFor };
