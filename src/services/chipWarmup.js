import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as evolution from '../evolution/client.js';
import { humanDelay, processSpintax } from './antiSpam.js';
import { rotateMobileIPsStaggered, getActiveZteIds } from './networkController.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const WARMUP_TEXT_PATH = path.resolve(__dirname, '../../textAquecimento.txt');

// Níveis 1–4: ping-pong, texto apenas
const LEVEL_CONFIG = {
    1: { minDelayS: 120, maxDelayS: 180 },
    2: { minDelayS:  60, maxDelayS:  90 },
    3: { minDelayS:  30, maxDelayS:  60 },
    4: { minDelayS:  15, maxDelayS:  30 },
};

// Estado do aquecimento manual
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

// Limpa o cache quando zaps reconectam (evita número desatualizado)
export const clearOwnerCache = () => _ownerCache.clear();

// ── Conectividade ─────────────────────────────────────────────────────────────
const isReady = async (accountId) => {
    try { return (await evolution.getConnectionState(accountId)) === 'open'; }
    catch (_) { return false; }
};

const filterReady = async (accounts) => {
    const checks = await Promise.all(accounts.map(async id => ({ id, ok: await isReady(id) })));
    return checks.filter(c => {
        if (!c.ok) console.warn(`⚠️ [AQUECIMENTO] ${c.id} offline. Removendo.`);
        return c.ok;
    }).map(c => c.id);
};

// ── Envio ─────────────────────────────────────────────────────────────────────
const sendWarmupText = async (fromId, toNumber) => {
    const text = processSpintax(pickRandom(loadTexts()));
    try {
        await evolution.sendText(fromId, toNumber, text);
    } catch (err) {
        console.warn(`⚠️ [AQUECIMENTO] Falha ${fromId}→${toNumber}: ${err.message}`);
    }
};

// ── Ping-pong entre um par ────────────────────────────────────────────────────
// Uma rodada: A→B, espera, B→A, espera
const pingPong = async (zapA, zapB, numA, numB, level, shouldContinue) => {
    const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG[2];

    if (!shouldContinue()) return;
    console.log(`🏓 [AQUECIMENTO] ${zapA} → ${zapB}`);
    await sendWarmupText(zapA, numB);
    await humanDelay(cfg.minDelayS, cfg.maxDelayS);

    if (!shouldContinue()) return;
    console.log(`🏓 [AQUECIMENTO] ${zapB} → ${zapA}`);
    await sendWarmupText(zapB, numA);
    await humanDelay(cfg.minDelayS, cfg.maxDelayS);
};

// ── Montagem de pares (rotação a cada rodada) ─────────────────────────────────
// Algoritmo round-robin de torneio: fixa o primeiro, rotaciona os demais.
// Com N zaps gera floor(N/2) pares por rodada, cobrindo todos ao longo das rodadas.
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

// ── Carrega números de um conjunto de zaps ───────────────────────────────────
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

    console.log(`🔥 [AQUECIMENTO] ${Math.round(durationSeconds / 60)}min — nível ${level} — ${withNum.length} zaps — delay ${cfg.minDelayS}–${cfg.maxDelayS}s`);

    let round = 0;
    while (shouldContinue()) {
        const alive = (await filterReady(withNum)).filter(id => numbers[id]);
        if (alive.length < 2) break;

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

    const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG[2];
    _manualRunning = true;
    _warmupState   = { running: true, level, zapCount: withNum.length, rotateMins, startedAt: Date.now() };

    const shouldContinue   = () => _manualRunning;
    const rotateIntervalMs = rotateMins > 0 ? rotateMins * 60_000 : 0;
    let   nextRotateAt     = rotateIntervalMs > 0 ? Date.now() + rotateIntervalMs : Infinity;
    let   round            = 0;

    console.log(`\n🔥 [AQUECIMENTO] Iniciado — ${withNum.length} zaps | nível ${level} | delay ${cfg.minDelayS}–${cfg.maxDelayS}s${rotateMins > 0 ? ` | rotação a cada ${rotateMins} min` : ''}`);

    while (_manualRunning) {
        if (Date.now() >= nextRotateAt) {
            console.log('🔄 [AQUECIMENTO] Rotacionando IPs...');
            await rotateMobileIPsStaggered(getActiveZteIds());
            nextRotateAt = Date.now() + rotateIntervalMs;
            active = await filterReady(accountsList);
        }

        const alive = (await filterReady(active)).filter(id => numbers[id]);
        if (alive.length < 2) { _manualRunning = false; break; }

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
};

export const stopWarmup = () => { _manualRunning = false; };

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
    const now    = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
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
    startDatetime,         // ISO string ou null = imediato
    endDatetime,           // ISO string — prazo final absoluto
    windowStart = '08:00',
    windowEnd   = '19:00',
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

    // ── 1. Aguarda data/hora de início ────────────────────────────────────────
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

    // ── 2. Loop diário respeitando a janela ───────────────────────────────────
    while (_manualRunning && Date.now() < endMs) {

        if (!isWithinWindow(windowStart, windowEnd)) {
            const waitMs  = msUntilWindowOpen(windowStart);
            const waitMin = Math.ceil(waitMs / 60_000);
            console.log(`⏰ [AQUECIMENTO] Fora da janela ${windowStart}–${windowEnd}. Retomando em ${waitMin} min.`);
            // Espera em fatias de 5 min para poder ser interrompido
            const sleepUntil = Date.now() + waitMs;
            while (_manualRunning && Date.now() < sleepUntil) {
                await new Promise(r => setTimeout(r, Math.min(300_000, sleepUntil - Date.now())));
            }
            continue;
        }

        // Dentro da janela — calcula quanto tempo resta (janela ou prazo final)
        const windowCloseMs = endOfWindowToday(windowEnd).getTime();
        const durationMs    = Math.min(windowCloseMs, endMs) - Date.now();

        if (durationMs < 60_000) {
            // Menos de 1 min restante na janela — espera a janela fechar
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
};

export default { startWarmup, stopWarmup, startScheduledWarmup, runWarmupFor, isWarmupRunning, getWarmupState, clearOwnerCache, buildPairs };
