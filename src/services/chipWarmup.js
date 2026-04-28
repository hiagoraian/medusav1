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

export default { startWarmup, stopWarmup, runWarmupFor, isWarmupRunning, getWarmupState, clearOwnerCache, buildPairs };
