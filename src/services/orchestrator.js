import {
    getPendingMessages, countPending, countPendingInCycle,
    assignMessagesToCycle, updateCycleStats,
} from './queueService.js';
import { publishBulk, purgeQueues }                                          from '../queue/producer.js';
import { startWorkers, stopWorkers, requestWorkerStop, resetWorkerStop }     from '../queue/worker.js';
import { rotateMobileIPsStaggered, getZapsByGroup, getActiveZteIds }         from './networkController.js';
import { runWarmupFor }                                                      from './chipWarmup.js';
import { generateCampaignReport }                                            from './reportGenerator.js';

// ── Configuração de nível de disparo ─────────────────────────────────────────
const DISPATCH_LEVELS = {
    1: { batchPerZap: 3, minDelayS: 90,  maxDelayS: 150 },
    2: { batchPerZap: 5, minDelayS: 60,  maxDelayS:  90 },
    3: { batchPerZap: 8, minDelayS: 45,  maxDelayS:  70 },
};

const SUBGROUP_SIZE  = 4;   // zaps por sub-grupo dentro de uma onda
const WARMUP_PAUSE_S = 300; // segundos de aquecimento entre ondas (5 min)
const GROUP_ORDER    = ['A', 'B', 'C'];

// ── Estado global ─────────────────────────────────────────────────────────────

let stopRequested = false;
export const requestStop     = () => { stopRequested = true; requestWorkerStop(); };
export const resetStop       = () => { stopRequested = false; resetWorkerStop(); };
export const isStopRequested = () => stopRequested;

// ── Utilitários de janela de horário ──────────────────────────────────────────

const parseHHMM = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};

const isWithinWindow = (windowStart, windowEnd) => {
    const now    = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return nowMin >= parseHHMM(windowStart) && nowMin < parseHHMM(windowEnd);
};

const endOfTodayWindow = (windowEnd) => {
    const [h, m] = windowEnd.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
};

const waitUntilWindowOpens = async (windowStart, windowEnd, campaignEndTime) => {
    while (!stopRequested) {
        if (campaignEndTime && Date.now() >= campaignEndTime.getTime()) return;
        if (isWithinWindow(windowStart, windowEnd)) return;

        const now  = new Date();
        const [sh, sm] = windowStart.split(':').map(Number);
        const target   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0);
        if (target <= now) target.setDate(target.getDate() + 1);

        const diffMs  = target - now;
        const diffMin = Math.ceil(diffMs / 60000);
        console.log(`⏰ [ORCH] Fora da janela. Próximo bloco em ${diffMin} min (${windowStart}).`);
        await new Promise(r => setTimeout(r, Math.min(300_000, diffMs)));
    }
};

// ── Offsets de sub-grupo (onda escalonada) ────────────────────────────────────

const buildSubGroupOffsets = (accounts, staggerMs) => {
    const offsets = {};
    for (let i = 0; i < accounts.length; i++) {
        offsets[accounts[i]] = Math.floor(i / SUBGROUP_SIZE) * staggerMs;
    }
    return offsets;
};

// ── Aguarda conclusão da onda ─────────────────────────────────────────────────

const waitForWaveToFinish = async (cycleId) => {
    while (!stopRequested) {
        if ((await countPendingInCycle(cycleId)) === 0) break;
        await new Promise(r => setTimeout(r, 5_000));
    }
};

// ── Loop principal da campanha ────────────────────────────────────────────────

/**
 * campaignConfig campos:
 *   messageTemplate, mediaUrl, mediaType, mediaMode — conteúdo da mensagem
 *   endDatetime    — ISO string — prazo final absoluto (ex: "2026-04-27T20:00")
 *   windowStart    — "HH:MM" — início da janela diária (default "08:00")
 *   windowEnd      — "HH:MM" — fim da janela diária   (default "19:45")
 *   dispatchLevel  — 1|2|3
 *   warmupLevel    — 1–10
 *
 * Rotação de grupos A→B→C:
 *   Cada ZTE tem 3 grupos de 4 zaps. O orchestrator cicla A→B→C, rodando cada
 *   grupo por 1/3 da janela diária, rotacionando IP entre transições e aquecendo
 *   os grupos inativos durante o bloco ativo.
 */
export const runCampaignLoop = async (activeAccounts, config, cycleId) => {
    const {
        endDatetime,
        windowStart   = '08:00',
        windowEnd     = '19:45',
        dispatchLevel = 2,
        warmupLevel   = 5,
    } = config;

    const level       = DISPATCH_LEVELS[dispatchLevel] || DISPATCH_LEVELS[2];
    const campaignEnd = endDatetime ? new Date(endDatetime) : null;

    // Duração de cada bloco = 1/3 da janela diária
    const windowDurMs = (parseHHMM(windowEnd) - parseHHMM(windowStart)) * 60_000;
    const blockDurMs  = Math.floor(windowDurMs / 3);

    resetStop();
    let groupIdx  = 0;
    let waveCount = 0;

    console.log(`\n🚀 [ORCH] Campanha iniciada`);
    console.log(`   Zaps: ${activeAccounts.length} | Nível: ${dispatchLevel} | Aquecimento: ${warmupLevel}`);
    console.log(`   Janela: ${windowStart}–${windowEnd} | Bloco: ${Math.round(blockDurMs / 60000)} min | Fim: ${campaignEnd ? campaignEnd.toLocaleString('pt-BR') : 'sem limite'}`);

    while (!stopRequested) {
        // ── Fim por data ──────────────────────────────────────────────────────
        if (campaignEnd && Date.now() >= campaignEnd.getTime()) {
            console.log('📅 [ORCH] Data/hora de fim atingida. Encerrando.');
            break;
        }

        // ── Fila vazia ────────────────────────────────────────────────────────
        if ((await countPending()) === 0) {
            console.log('✅ [ORCH] Fila vazia. Campanha concluída.');
            break;
        }

        // ── Aguarda janela de horário ─────────────────────────────────────────
        await waitUntilWindowOpens(windowStart, windowEnd, campaignEnd);
        if (stopRequested || (campaignEnd && Date.now() >= campaignEnd.getTime())) break;

        // ── Determina grupo ativo ─────────────────────────────────────────────
        const groupLetter = GROUP_ORDER[groupIdx % 3];
        const groupZaps   = getZapsByGroup(groupLetter).filter(id => activeAccounts.includes(id));
        const otherZaps   = activeAccounts.filter(id => !groupZaps.includes(id));

        if (groupZaps.length === 0) {
            console.warn(`⚠️ [ORCH] Grupo ${groupLetter} sem zaps ativos. Avançando para próximo grupo.`);
            groupIdx++;
            continue;
        }

        // Bloco termina no menor entre: fim do bloco, fim da janela hoje, fim da campanha
        const blockEnd = new Date(Math.min(
            Date.now() + blockDurMs,
            endOfTodayWindow(windowEnd).getTime(),
            campaignEnd ? campaignEnd.getTime() : Infinity,
        ));

        console.log(`\n🔤 [ORCH] Bloco ${groupLetter} — ${groupZaps.length} zaps — até ${blockEnd.toLocaleTimeString('pt-BR')}`);

        // ── Ondas dentro do bloco ─────────────────────────────────────────────
        while (!stopRequested && Date.now() < blockEnd.getTime()) {
            if (!isWithinWindow(windowStart, windowEnd)) break;

            const batch = await getPendingMessages(level.batchPerZap * groupZaps.length);
            if (batch.length === 0) break;

            await assignMessagesToCycle(batch.map(r => r.id), cycleId);

            const offsets = buildSubGroupOffsets(groupZaps, level.minDelayS * 1_000);
            const numSubs = Math.ceil(groupZaps.length / SUBGROUP_SIZE);
            waveCount++;

            console.log(`  🌊 Onda ${waveCount} [Grupo ${groupLetter}] — ${batch.length} msgs — ${groupZaps.length} zap(s) — ${numSubs} sub-grupo(s)`);

            await publishBulk(batch, groupZaps);
            await startWorkers(groupZaps, {
                ...config,
                cycleId,
                minDelayS:       level.minDelayS,
                maxDelayS:       level.maxDelayS,
                subGroupOffsets: offsets,
            });
            await waitForWaveToFinish(cycleId);
            await stopWorkers();

            if (stopRequested) break;

            // Aquecimento dos grupos inativos enquanto espera próxima onda
            const timeLeft  = blockEnd.getTime() - Date.now();
            const warmupSec = Math.min(WARMUP_PAUSE_S, Math.floor(timeLeft / 1000) - 60);
            if (warmupSec > 30 && otherZaps.length >= 2) {
                console.log(`  🔥 Aquecimento grupos inativos (${warmupSec}s)...`);
                await runWarmupFor(otherZaps, warmupLevel, warmupSec);
            }
        }

        // ── Interrompido pelo usuário ─────────────────────────────────────────
        if (stopRequested) {
            await updateCycleStats(cycleId, 0, 0, 'interrompido');
            await purgeQueues(activeAccounts);
            console.log('\n🛑 [ORCH] Campanha interrompida pelo usuário.');
            break;
        }

        // Fila zerou dentro do bloco
        if ((await countPending()) === 0) break;

        // ── Transição de grupo ────────────────────────────────────────────────
        groupIdx++;
        const nextLetter = GROUP_ORDER[groupIdx % 3];
        const nextZaps   = getZapsByGroup(nextLetter).filter(id => activeAccounts.includes(id));

        console.log(`\n🔄 [ORCH] Transição → Grupo ${nextLetter} | Rotacionando IPs (escalonado)...`);
        await rotateMobileIPsStaggered(getActiveZteIds());

        if (nextZaps.length >= 2 && !stopRequested) {
            console.log(`  🔥 Pré-aquecimento Grupo ${nextLetter} (5 min)...`);
            await runWarmupFor(nextZaps, warmupLevel, 300);
        }
    }

    // ── Finalização ───────────────────────────────────────────────────────────
    if (!stopRequested) {
        await generateCampaignReport(cycleId).catch(e => console.warn('⚠️ Relatório:', e.message));
        await updateCycleStats(cycleId, 0, 0, 'concluido');
    }

    resetStop();
    console.log('🏁 [ORCH] Loop encerrado.\n');
};

export default { runCampaignLoop, requestStop, resetStop, isStopRequested };
