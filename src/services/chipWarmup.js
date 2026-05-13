import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as evolution from '../evolution/client.js';
import { query } from '../database/postgres.js';
import { processSpintax } from './antiSpam.js';
import { rotateMobileIPsStaggered, getActiveZteIds } from './networkController.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const WARMUP_TEXT_PATH = path.resolve(__dirname, '../../textAquecimento.txt');
const WARMUP_MEDIA_DIR = path.resolve(__dirname, '../../warmup_media');
const MEDIA_HOST       = process.env.MEDIA_HOST || 'http://host.docker.internal:3000';

const ADMIN_ZAP    = process.env.ADMIN_ZAP    || 'WA-49';
const ADMIN_NUMBER = process.env.ADMIN_NUMBER  || '';

const sendAdminNotification = async (text) => {
    if (!ADMIN_NUMBER) return;
    try {
        const state = await evolution.getConnectionState(ADMIN_ZAP);
        if (state !== 'open') return;
        await evolution.sendText(ADMIN_ZAP, ADMIN_NUMBER, text);
    } catch (_) {}
};

// ── Configuração de níveis ────────────────────────────────────────────────────
//
//  Níveis ligados à idade do chip:
//    1 → chip novo (0–7 dias)   — volume muito baixo, só texto
//    2 → 1–4 semanas             — volume baixo, só texto
//    3 → 1–3 meses               — volume médio, texto + imagens
//    4 → 3+ meses                — volume alto, texto + imagens + áudio
//
//  delay: base; warmupDelay() adiciona variação orgânica (~35% das vezes demora mais)
//  maxMsgsPerDay: limite de envios por zap por dia (reset à meia-noite)

const LEVEL_CONFIG = {
    1: { minDelayS: 180, maxDelayS: 480, maxImages:  0, maxAudios: 0, maxMsgsPerDay:  20 },
    2: { minDelayS: 120, maxDelayS: 240, maxImages:  0, maxAudios: 0, maxMsgsPerDay:  60 },
    3: { minDelayS:  60, maxDelayS: 120, maxImages:  2, maxAudios: 0, maxMsgsPerDay: 120 },
    4: { minDelayS:  45, maxDelayS:  90, maxImages:  3, maxAudios: 4, maxMsgsPerDay: 200 },
};

// ── Delay com variação orgânica ───────────────────────────────────────────────
// 65% do tempo: range normal (minS–maxS)
// 25% do tempo: 1×–2× o máximo  (pessoa estava ocupada)
// 10% do tempo: 2×–3× o máximo  (pessoa demorou mais)
const warmupDelay = async (minS, maxS, shouldContinue = () => true) => {
    const rand = Math.random();
    let seconds;
    if (rand < 0.65) {
        seconds = minS + Math.random() * (maxS - minS);
    } else if (rand < 0.90) {
        seconds = maxS + Math.random() * maxS;
    } else {
        seconds = maxS * 2 + Math.random() * maxS;
    }
    const end = Date.now() + Math.round(seconds * 1000);
    while (shouldContinue() && Date.now() < end) {
        await new Promise(r => setTimeout(r, Math.min(1000, end - Date.now())));
    }
};

// ── Contadores diários por zap ────────────────────────────────────────────────
// Unifica msgs, imagens e áudios em um único Map com reset por data.
const _daily     = new Map(); // accountId → { msgs, images, audios }
let   _dailyDate = '';

const todayStr = () => new Date().toISOString().slice(0, 10);

const resetDailyIfNewDay = (accounts) => {
    const today = todayStr();
    if (_dailyDate !== today) {
        _dailyDate = today;
        accounts.forEach(id => _daily.set(id, { msgs: 0, images: 0, audios: 0 }));
        console.log(`📅 [AQUECIMENTO] Contadores diários reiniciados (${today})`);
    }
};

const getDaily   = (id)       => _daily.get(id) || { msgs: 0, images: 0, audios: 0 };
const hasQuota   = (id, lvl)  => getDaily(id).msgs < (LEVEL_CONFIG[lvl]?.maxMsgsPerDay ?? Infinity);

// ── Estado global ─────────────────────────────────────────────────────────────
let _manualRunning = false;
let _warmupState   = { running: false, level: 0, zapCount: 0, rotateMins: 0, startedAt: null };

export const isWarmupRunning = () => _manualRunning;
export const getWarmupState  = () => ({ ..._warmupState });

// ── Textos ────────────────────────────────────────────────────────────────────
let _texts = null;

const loadTexts = () => {
    if (_texts) return _texts;
    try {
        if (!fs.existsSync(WARMUP_TEXT_PATH)) {
            const defaults = [
                'Olá, tudo bem?', 'Como vai você?', 'Bom dia!', 'Boa tarde!', 'Boa noite!',
                'Tudo bem por aí?', 'Você viu as notícias?', 'O que acha disso?',
                'Sim, concordo.', 'Não tenho certeza.', 'Vou verificar.', 'Ok, combinado.',
                'Que interessante!', 'Pode ser...', 'Com certeza!', 'Entendido!',
            ];
            fs.writeFileSync(WARMUP_TEXT_PATH, defaults.join('\n'), 'utf8');
            _texts = defaults;
        } else {
            _texts = fs.readFileSync(WARMUP_TEXT_PATH, 'utf8')
                .split('\n').map(l => l.trim()).filter(l => l.length > 0);
        }
    } catch (_) {
        _texts = ['Oi', 'Tudo bem?', 'Sim', 'Ok'];
    }
    return _texts;
};

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ── Arquivos de mídia ─────────────────────────────────────────────────────────
const loadMediaFiles = (subfolder) => {
    const dir = path.join(WARMUP_MEDIA_DIR, subfolder);
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => !f.startsWith('.') && f !== '.gitkeep');
    } catch (_) { return []; }
};

// ── Envio de uma mensagem de aquecimento ──────────────────────────────────────
// Ordem de tentativa: áudio → imagem → texto (conforme cota e nível)
const sendWarmupMessage = async (fromId, toNumber, level) => {
    const cfg    = LEVEL_CONFIG[level] || LEVEL_CONFIG[2];
    const counts = getDaily(fromId);

    // Indicador "digitando..." (best-effort, falha silenciosa)
    const typingMs = 1200 + Math.random() * 1800; // 1,2–3s
    await evolution.sendTyping(fromId, toNumber, typingMs);
    await new Promise(r => setTimeout(r, typingMs));

    // Tenta áudio (nível 4)
    if (cfg.maxAudios > 0 && counts.audios < cfg.maxAudios && Math.random() < 0.25) {
        const files = loadMediaFiles('audios');
        if (files.length > 0) {
            const file = pickRandom(files);
            try {
                const base64 = fs.readFileSync(path.join(WARMUP_MEDIA_DIR, 'audios', file)).toString('base64');
                await evolution.sendAudio(fromId, toNumber, base64);
                counts.audios++;
                counts.msgs++;
                _daily.set(fromId, counts);
                console.log(`🎵 [AQUECIMENTO] ${fromId} → áudio (${counts.audios}/${cfg.maxAudios} | ${counts.msgs}/${cfg.maxMsgsPerDay} msgs)`);
                return;
            } catch (_) {}
        }
    }

    // Tenta imagem (níveis 3 e 4)
    if (cfg.maxImages > 0 && counts.images < cfg.maxImages && Math.random() < 0.30) {
        const files = loadMediaFiles('imagens');
        if (files.length > 0) {
            const file = pickRandom(files);
            const url  = `${MEDIA_HOST}/warmup_media/imagens/${encodeURIComponent(file)}`;
            try {
                await evolution.sendMedia(fromId, toNumber, url, 'image', '');
                counts.images++;
                counts.msgs++;
                _daily.set(fromId, counts);
                console.log(`🖼️ [AQUECIMENTO] ${fromId} → imagem (${counts.images}/${cfg.maxImages} | ${counts.msgs}/${cfg.maxMsgsPerDay} msgs)`);
                return;
            } catch (_) {}
        }
    }

    // Texto
    const text = processSpintax(pickRandom(loadTexts()));
    try {
        await evolution.sendText(fromId, toNumber, text);
        counts.msgs++;
        _daily.set(fromId, counts);
    } catch (err) {
        console.warn(`⚠️ [AQUECIMENTO] Falha ${fromId}→${toNumber}: ${err.message}`);
    }
};

// ── Número do dono da instância ───────────────────────────────────────────────
const _ownerCache = new Map();

const getOwnerNumber = async (accountId) => {
    if (_ownerCache.has(accountId)) return _ownerCache.get(accountId);
    try {
        const instances = await evolution.fetchInstances();
        for (const inst of instances) {
            const name  = inst.instanceName || inst.name;
            const owner = inst?.ownerJid || inst?.instance?.owner || inst?.owner || null;
            if (name && owner) _ownerCache.set(name, String(owner).replace(/\D/g, ''));
        }
        return _ownerCache.get(accountId) || null;
    } catch (_) { return null; }
};

export const clearOwnerCache    = () => _ownerCache.clear();
export const clearOwnerCacheFor = (accountId) => _ownerCache.delete(accountId);

// ── Conectividade ─────────────────────────────────────────────────────────────

// Uma única chamada à Evolution API para checar todos os zaps — evita 48 requests paralelos
// que causam timeouts e falsos negativos. Fallback em lotes de 5 se fetchInstances falhar.
const filterReady = async (accounts) => {
    try {
        const insts  = await evolution.fetchInstances();
        const openSet = new Set(insts.filter(i => i.connectionStatus === 'open').map(i => i.name));
        return accounts.filter(id => {
            const ok = openSet.has(id);
            if (!ok) console.warn(`⚠️ [AQUECIMENTO] ${id} offline. Removendo.`);
            return ok;
        });
    } catch (_) {
        // Fallback: lotes de 5 para não saturar a API
        const ready = [];
        for (let i = 0; i < accounts.length; i += 5) {
            const batch = await Promise.allSettled(
                accounts.slice(i, i + 5).map(async id => {
                    const state = await evolution.getConnectionState(id).catch(() => 'close');
                    return { id, ok: state === 'open' };
                })
            );
            batch.forEach(r => {
                if (r.status === 'fulfilled') {
                    if (!r.value.ok) console.warn(`⚠️ [AQUECIMENTO] ${r.value.id} offline. Removendo.`);
                    if (r.value.ok) ready.push(r.value.id);
                }
            });
        }
        return ready;
    }
};

// ── Ping-pong entre um par ────────────────────────────────────────────────────
const pingPong = async (zapA, zapB, numA, numB, level, shouldContinue) => {
    const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG[2];

    // A → B
    if (!shouldContinue()) return;
    if (hasQuota(zapA, level)) {
        console.log(`🏓 [AQUECIMENTO] ${zapA} → ${zapB}`);
        await sendWarmupMessage(zapA, numB, level);

        // 20% chance de segunda mensagem seguida (simula conversa real)
        if (shouldContinue() && hasQuota(zapA, level) && Math.random() < 0.20) {
            await new Promise(r => setTimeout(r, 8000 + Math.random() * 12000)); // 8–20s
            await sendWarmupMessage(zapA, numB, level);
        }
    }

    await warmupDelay(cfg.minDelayS, cfg.maxDelayS, shouldContinue);

    // B → A
    if (!shouldContinue()) return;
    if (hasQuota(zapB, level)) {
        console.log(`🏓 [AQUECIMENTO] ${zapB} → ${zapA}`);
        await sendWarmupMessage(zapB, numA, level);

        // 20% chance de segunda mensagem
        if (shouldContinue() && hasQuota(zapB, level) && Math.random() < 0.20) {
            await new Promise(r => setTimeout(r, 8000 + Math.random() * 12000));
            await sendWarmupMessage(zapB, numA, level);
        }
    }

    await warmupDelay(cfg.minDelayS, cfg.maxDelayS, shouldContinue);
};

// ── Montagem de pares (round-robin de torneio) ────────────────────────────────
export const buildPairs = (zaps, round = 0) => {
    if (zaps.length < 2) return [];
    const n    = zaps.length;
    const list = [zaps[0], ...zaps.slice(1).slice(round % (n - 1)).concat(zaps.slice(1).slice(0, round % (n - 1)))];
    const pairs = [];
    for (let i = 0; i < Math.floor(n / 2); i++) {
        pairs.push([list[i], list[n - 1 - i]]);
    }
    return pairs;
};

// ── Carrega números de um conjunto de zaps ────────────────────────────────────
const loadNumbers = async (accounts) => {
    const numbers = {};
    for (const id of accounts) {
        numbers[id] = await getOwnerNumber(id);
        if (numbers[id]) {
            console.log(`✅ [AQUECIMENTO] ${id} → ${numbers[id]}`);
        } else {
            console.warn(`⚠️ [AQUECIMENTO] ${id} sem número identificado — será ignorado.`);
        }
    }
    return numbers;
};

// ── API pública: aquecimento por tempo determinado (usado pelo orquestrador) ──
export const runWarmupFor = async (activeAccounts, level = 2, durationSeconds = 300) => {
    const cfg     = LEVEL_CONFIG[level] || LEVEL_CONFIG[2];
    const endTime = Date.now() + durationSeconds * 1000;
    const shouldContinue = () => Date.now() < endTime;

    resetDailyIfNewDay(activeAccounts);

    let ready = await filterReady(activeAccounts);
    if (ready.length < 2) {
        console.log('[AQUECIMENTO] Menos de 2 zaps disponíveis. Pausa sem aquecimento.');
        await new Promise(r => setTimeout(r, durationSeconds * 1000));
        return;
    }

    const numbers = await loadNumbers(ready);
    const withNum = ready.filter(id => numbers[id]);
    if (withNum.length < 2) {
        console.warn('[AQUECIMENTO] Menos de 2 zaps com número identificado. Pausa simples.');
        await new Promise(r => setTimeout(r, durationSeconds * 1000));
        return;
    }

    console.log(`🔥 [AQUECIMENTO] ${Math.round(durationSeconds / 60)}min — nível ${level} — ${withNum.length} zaps — delay ${cfg.minDelayS}–${cfg.maxDelayS}s — limite ${cfg.maxMsgsPerDay} msgs/dia`);

    let round = 0;
    while (shouldContinue()) {
        // Filtra zaps que ainda têm cota de mensagens
        const onlineNow = await filterReady(withNum);
        // Remove permanentemente zaps que caíram — evita re-log a cada rodada
        const stillOnline = withNum.filter(id => onlineNow.includes(id));
        const alive = stillOnline.filter(id => hasQuota(id, level));
        if (alive.length < 2) {
            console.log('✅ [AQUECIMENTO] Todos os zaps atingiram o limite diário ou ficaram offline.');
            break;
        }

        const pairs = buildPairs(alive, round).filter(([a, b]) => numbers[a] && numbers[b]);
        round++;

        if (pairs.length === 0) break;
        console.log(`🔥 [AQUECIMENTO] Rodada ${round} — ${pairs.length} par(es) — ${Math.round((endTime - Date.now()) / 1000)}s restantes`);

        await Promise.allSettled(pairs.map(([a, b]) => pingPong(a, b, numbers[a], numbers[b], level, shouldContinue)));
    }

    console.log('✅ [AQUECIMENTO] Sessão encerrada.');
};

// ── API pública: aquecimento contínuo manual ──────────────────────────────────
export const startWarmup = async (accountsList, level = 2, rotateMins = 0) => {
    if (_manualRunning) {
        console.warn('⚠️ [AQUECIMENTO] Já está rodando. Ignorando nova chamada.');
        return;
    }

    let active = await filterReady(accountsList);
    if (active.length < 2) {
        console.warn('⚠️ [AQUECIMENTO] Menos de 2 contas online. Abortando.');
        return;
    }

    const numbers = await loadNumbers(active);
    const withNum = active.filter(id => numbers[id]);
    if (withNum.length < 2) {
        console.warn('⚠️ [AQUECIMENTO] Menos de 2 zaps com número identificado. Abortando.');
        return;
    }

    // Zaps inativos desde o início
    const offlineAtStart = accountsList.filter(id => !active.includes(id));
    const noNumber       = active.filter(id => !numbers[id]);
    const inactiveAtStart = [...offlineAtStart, ...noNumber];

    const startTime = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const inactiveLine = inactiveAtStart.length > 0
        ? `\n❌ Inativos: ${inactiveAtStart.join(', ')}`
        : '\n✅ Todos os zaps ativos';
    await sendAdminNotification(
        `🔥 *Aquecimento iniciado*\n\n🕐 ${startTime} | Nível ${level}\n👥 Zaps: ${withNum.length}${inactiveLine}`
    );

    const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG[2];
    _manualRunning = true;
    _warmupState   = { running: true, level, zapCount: withNum.length, rotateMins, startedAt: Date.now() };
    const _sessionStart   = new Date();
    const _dailyBefore    = new Map(withNum.map(id => [id, getDaily(id).msgs]));

    resetDailyIfNewDay(withNum);

    const shouldContinue   = () => _manualRunning;
    const rotateIntervalMs = rotateMins > 0 ? rotateMins * 60_000 : 0;
    let   nextRotateAt     = rotateIntervalMs > 0 ? Date.now() + rotateIntervalMs : Infinity;
    let   round            = 0;
    const felledDuring     = new Set(); // zaps que caíram durante a sessão

    console.log(`\n🔥 [AQUECIMENTO] Iniciado — ${withNum.length} zaps | nível ${level} | delay ${cfg.minDelayS}–${cfg.maxDelayS}s | limite ${cfg.maxMsgsPerDay} msgs/dia${rotateMins > 0 ? ` | rotação a cada ${rotateMins} min` : ''}`);

    while (_manualRunning) {
        if (Date.now() >= nextRotateAt) {
            console.log('🔄 [AQUECIMENTO] Rotacionando IPs...');
            await rotateMobileIPsStaggered(getActiveZteIds());
            nextRotateAt = Date.now() + rotateIntervalMs;
            active = await filterReady(accountsList);
            resetDailyIfNewDay(active);
        }

        const onlineNow = await filterReady(active);
        // Detecta quedas desta rodada
        active.filter(id => !onlineNow.includes(id)).forEach(id => felledDuring.add(id));
        active = active.filter(id => onlineNow.includes(id));
        const alive = active.filter(id => numbers[id] && hasQuota(id, level));
        if (alive.length < 2) {
            console.log('✅ [AQUECIMENTO] Todos os zaps atingiram o limite diário ou ficaram offline.');
            _manualRunning = false;
            break;
        }

        _warmupState.zapCount = alive.length;

        const pairs = buildPairs(alive, round).filter(([a, b]) => numbers[a] && numbers[b]);
        round++;

        if (pairs.length === 0) { _manualRunning = false; break; }

        console.log(`🏓 [AQUECIMENTO] Rodada ${round} — ${pairs.length} par(es)`);
        await Promise.allSettled(pairs.map(([a, b]) => pingPong(a, b, numbers[a], numbers[b], level, shouldContinue)));
    }

    _manualRunning = false;
    _warmupState   = { running: false, level: 0, zapCount: 0, rotateMins: 0, startedAt: null };
    console.log('🛑 [AQUECIMENTO] Parado.');

    const _sessionEnd      = new Date();
    const _durationMin     = Math.round((_sessionEnd - _sessionStart) / 60000);
    const _zapsSent        = withNum.filter(id => getDaily(id).msgs > (_dailyBefore.get(id) || 0));
    query(
        `INSERT INTO warmup_reports (started_at, ended_at, duration_minutes, zaps_sent)
         VALUES ($1, $2, $3, $4)`,
        [_sessionStart, _sessionEnd, _durationMin, _zapsSent]
    ).catch(e => console.warn('[WARMUP REPORT] Erro ao salvar:', e.message));

    const endTime  = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const totalMsg = withNum.reduce((sum, id) => sum + getDaily(id).msgs, 0);
    const fellLine = felledDuring.size > 0
        ? `\n🔴 Caíram durante: ${[...felledDuring].join(', ')}`
        : '\n💚 Nenhum zap caiu';
    await sendAdminNotification(
        `✅ *Aquecimento encerrado*\n\n🕐 ${endTime}\n📊 Msgs enviadas: ${totalMsg}${fellLine}`
    );
};

export const stopWarmup = () => {
    _manualRunning = false;
    _warmupState   = { running: false, level: 0, zapCount: 0, rotateMins: 0, startedAt: null };
};

// ── Helpers de janela horária ─────────────────────────────────────────────────

const parseHHMM = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};

const isWithinWindow = (windowStart, windowEnd) => {
    const now    = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return nowMin >= parseHHMM(windowStart) && nowMin < parseHHMM(windowEnd);
};

const msUntilWindowOpen = (windowStart) => {
    const now = new Date();
    const [sh, sm] = windowStart.split(':').map(Number);
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
};

const endOfWindowToday = (windowEnd) => {
    const [h, m] = windowEnd.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
};

// ── API pública: aquecimento agendado com janela diária ───────────────────────
export const startScheduledWarmup = async (
    accountsList,
    level       = 2,
    startDatetime,
    endDatetime,
    windowStart = '08:00',
    windowEnd   = '19:45',
) => {
    if (_manualRunning) {
        console.warn('⚠️ [AQUECIMENTO] Já está rodando. Ignorando.');
        return;
    }

    _manualRunning = true;
    const endMs    = new Date(endDatetime).getTime();

    _warmupState = {
        running: true, level, zapCount: accountsList.length, rotateMins: 0,
        startedAt: Date.now(),
        scheduled: true, endDatetime, windowStart, windowEnd,
    };

    if (startDatetime) {
        const startMs = new Date(startDatetime).getTime();
        while (_manualRunning && Date.now() < startMs) {
            const diffMin = Math.ceil((startMs - Date.now()) / 60_000);
            console.log(`⏳ [AQUECIMENTO] Início agendado em ${diffMin} min (${new Date(startMs).toLocaleString('pt-BR')})`);
            await new Promise(r => setTimeout(r, Math.min(60_000, startMs - Date.now())));
        }
        if (!_manualRunning) { _warmupState = { running: false }; return; }
    }

    console.log(`🔥 [AQUECIMENTO] Agendado iniciado`);
    console.log(`   Janela: ${windowStart}–${windowEnd} | Fim: ${new Date(endMs).toLocaleString('pt-BR')}`);
    await sendAdminNotification(
        `🔥 *Aquecimento agendado iniciado*\n\n👥 Zaps: ${accountsList.length} | Nível ${level}\n⏰ Janela: ${windowStart}–${windowEnd}`
    );

    while (_manualRunning && Date.now() < endMs) {

        if (!isWithinWindow(windowStart, windowEnd)) {
            const waitMs  = msUntilWindowOpen(windowStart);
            const waitMin = Math.ceil(waitMs / 60_000);
            console.log(`⏰ [AQUECIMENTO] Fora da janela ${windowStart}–${windowEnd}. Retomando em ${waitMin} min.`);
            const sleepUntil = Date.now() + waitMs;
            while (_manualRunning && Date.now() < sleepUntil) {
                await new Promise(r => setTimeout(r, Math.min(300_000, sleepUntil - Date.now())));
            }
            continue;
        }

        const windowCloseMs = endOfWindowToday(windowEnd).getTime();
        const durationMs    = Math.min(windowCloseMs, endMs) - Date.now();

        if (durationMs < 60_000) {
            await new Promise(r => setTimeout(r, durationMs + 5_000));
            continue;
        }

        const durationSec = Math.floor(durationMs / 1000);
        console.log(`🔥 [AQUECIMENTO] Janela aberta — aquecendo por ${Math.round(durationSec / 60)} min`);
        await runWarmupFor(accountsList, level, durationSec);
    }

    _manualRunning = false;
    _warmupState   = { running: false, level: 0, zapCount: 0, rotateMins: 0, startedAt: null };
    console.log('✅ [AQUECIMENTO] Agendamento concluído.');
    await sendAdminNotification(`✅ *Aquecimento agendado concluído*\n\n🕐 ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
};

export default { startWarmup, stopWarmup, startScheduledWarmup, runWarmupFor, isWarmupRunning, getWarmupState, clearOwnerCache, buildPairs };
