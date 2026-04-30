import {
    getPendingMessages, countPending, countPendingInCycle,
    assignMessagesToCycle, updateCycleStats,
} from './queueService.js';
import { publishBulk, purgeQueues }                                          from '../queue/producer.js';
import { startWorkers, stopWorkers, requestWorkerStop, resetWorkerStop }     from '../queue/worker.js';
import { rotateMobileIPsStaggered, getZapsByGroup, getActiveZteIds }         from './networkController.js';
import { runWarmupFor }                                                      from './chipWarmup.js';
import { generateCampaignReport, clearReports }                              from './reportGenerator.js';
import * as evolution                                                        from '../evolution/client.js';

const SLOT_DURATION_MS = 18 * 60 * 1000;  // 18 min por slot de grupo
const TRANSITION_MS    =  5 * 60 * 1000;  // transição/pré-aquecimento entre grupos
const MSG_MIN_DELAY_S  = 45;              // delay mínimo entre msgs no worker
const MSG_MAX_DELAY_S  = 90;              // delay máximo entre msgs no worker

const SUBGROUP_SIZE = 4;
const GROUP_ORDER   = ['A', 'B', 'C'];

// ── Health check pré-disparo ──────────────────────────────────────────────────
// Verifica estado de conexão de cada zap antes de cada onda.
// Zaps desconectados são removidos daquela onda sem enviar mensagens.
const preflightCheck = async (accounts) => {
    const healthy = [];
    const sick    = [];

    await Promise.allSettled(accounts.map(async (id) => {
        try {
            const state = await evolution.getConnectionState(id);
            if (state === 'open') {
                console.log(`✅ [PREFLIGHT] ${id} OK`);
                healthy.push(id);
            } else {
                console.warn(`🔴 [PREFLIGHT] ${id} suspenso — estado: ${state}`);
                sick.push(id);
            }
        } catch (err) {
            console.warn(`🔴 [PREFLIGHT] ${id} suspenso — ${err.message}`);
            sick.push(id);
        }
    }));

    if (sick.length > 0) {
        console.warn(`⚠️ [PREFLIGHT] ${sick.length} zap(s) suspenso(s): ${sick.join(', ')}`);
    }
    return healthy;
};

// Janela diária de disparo — fixo; não exposto via config
const WINDOW_START = '08:00';
const WINDOW_END   = '19:45';

// ── Estado global ─────────────────────────────────────────────────────────────

let stopRequested = false;
export const requestStop     = () => { stopRequested = true; requestWorkerStop(); };
export const resetStop       = () => { stopRequested = false; resetWorkerStop(); };
export const isStopRequested = () => stopRequested;

// Exportados para testes unitários
export { parseHHMM, isWithinWindow, endOfTodayWindow };

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

const waitUntilStartDatetime = async (startDatetime) => {
    if (!startDatetime) return;
    const startMs = new Date(startDatetime).getTime();
    while (!stopRequested && Date.now() < startMs) {
        const remaining = startMs - Date.now();
        console.log(`⏳ [ORCH] Início agendado em ${Math.ceil(remaining / 60000)} min...`);
        await new Promise(r => setTimeout(r, Math.min(60_000, remaining)));
    }
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
    const deadline = Date.now() + 45 * 60_000; // máximo 45 min por onda
    while (!stopRequested) {
        if ((await countPendingInCycle(cycleId)) === 0) break;
        if (Date.now() > deadline) {
            console.warn(`[ORCH] waitForWaveToFinish: timeout de 45min para ciclo ${cycleId} — avançando.`);
            break;
        }
        await new Promise(r => setTimeout(r, 5_000));
    }
};

// ── Loop principal da campanha ────────────────────────────────────────────────

/**
 * campaignConfig campos:
 *   messageTemplate, mediaUrl, mediaFilename, mediaType, mediaMode — conteúdo da mensagem
 *   startDatetime  — ISO string — quando iniciar (null = imediato)
 *   endDatetime    — ISO string — prazo final absoluto (ex: "2026-04-27T12:00")
 *   warmupLevel    — 1|2|3
 *
 * Janela diária fixada em WINDOW_START–WINDOW_END (08:00–19:45).
 * Rotação A→B→C divide a janela em 3 blocos iguais (~3h55 cada).
 */
export const runCampaignLoop = async (activeAccounts, config, cycleId) => {
    clearReports();

    const {
        startDatetime,
        endDatetime,
        warmupLevel = 2,
        testMode    = false,
    } = config;

    const campaignEnd = endDatetime ? new Date(endDatetime) : null;

    resetStop();

    // Aguarda data/hora de início se agendado
    await waitUntilStartDatetime(startDatetime);
    if (stopRequested) { resetStop(); return; }

    let groupIdx         = 0;
    let waveCount        = 0;
    let consecutiveSkips = 0;

    console.log(`\n🚀 [ORCH] Campanha iniciada`);
    console.log(`   Zaps: ${activeAccounts.length} | Slot: ${SLOT_DURATION_MS / 60000} min | Aquecimento: ${warmupLevel}`);
    console.log(`   Janela: ${WINDOW_START}–${WINDOW_END} | Fim: ${campaignEnd ? campaignEnd.toLocaleString('pt-BR') : 'sem limite'}`);

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
        if (!testMode) {
            await waitUntilWindowOpens(WINDOW_START, WINDOW_END, campaignEnd);
            if (stopRequested || (campaignEnd && Date.now() >= campaignEnd.getTime())) break;
        }

        // ── Determina grupo ativo ─────────────────────────────────────────────
        const groupLetter = GROUP_ORDER[groupIdx % 3];
        const groupZaps   = getZapsByGroup(groupLetter).filter(id => activeAccounts.includes(id));
        const otherZaps   = activeAccounts.filter(id => !groupZaps.includes(id));

        if (groupZaps.length === 0) {
            console.warn(`⚠️ [ORCH] Grupo ${groupLetter} sem zaps ativos. Avançando para próximo grupo.`);
            consecutiveSkips++;
            if (consecutiveSkips >= 3) {
                console.error('🔴 [ORCH] Nenhum grupo com zaps ativos. Encerrando campanha.');
                break;
            }
            groupIdx++;
            continue;
        }
        consecutiveSkips = 0;

        // Slot de 18 min, limitado pelo fim da janela/campanha
        const blockEnd = new Date(Math.min(
            Date.now() + SLOT_DURATION_MS,
            testMode ? Infinity : endOfTodayWindow(WINDOW_END).getTime(),
            campaignEnd ? campaignEnd.getTime() : Infinity,
        ));

        console.log(`\n🔤 [ORCH] Bloco ${groupLetter} — ${groupZaps.length} zaps — até ${blockEnd.toLocaleTimeString('pt-BR')}`);

        // ── Ondas dentro do bloco ─────────────────────────────────────────────
        while (!stopRequested && Date.now() < blockEnd.getTime()) {
            if (!testMode && !isWithinWindow(WINDOW_START, WINDOW_END)) break;

            // ── Health check: remove zaps que não conseguem enviar ────────────
            console.log(`  🔍 [PREFLIGHT] Verificando ${groupZaps.length} zap(s)...`);
            const healthyZaps = await preflightCheck(groupZaps);
            if (healthyZaps.length === 0) {
                console.error('🔴 [ORCH] Nenhum zap passou no preflight. Encerrando bloco.');
                break;
            }
            if (healthyZaps.length < groupZaps.length) {
                console.warn(`⚠️ [ORCH] Continuando com ${healthyZaps.length}/${groupZaps.length} zap(s) saudáveis.`);
            }

            // Calcula dinamicamente quantas msgs por zap neste slot
            const totalPending  = await countPending();
            const timeLeftMs    = Math.max(SLOT_DURATION_MS, (campaignEnd || endOfTodayWindow(WINDOW_END)).getTime() - Date.now());
            const slotsLeft     = Math.max(1, Math.round(timeLeftMs / (SLOT_DURATION_MS + TRANSITION_MS)));
            const batchPerZap   = Math.max(1, Math.ceil(totalPending / (healthyZaps.length * slotsLeft)));

            const batch = await getPendingMessages(batchPerZap * healthyZaps.length);
            if (batch.length === 0) break;

            await assignMessagesToCycle(batch.map(r => r.id), cycleId);

            const offsets = buildSubGroupOffsets(healthyZaps, MSG_MIN_DELAY_S * 1_000);
            const numSubs = Math.ceil(healthyZaps.length / SUBGROUP_SIZE);
            waveCount++;

            console.log(`  🌊 Onda ${waveCount} [Grupo ${groupLetter}] — ${batch.length} msgs — ${healthyZaps.length} zap(s) — ${batchPerZap}/zap — slots restantes ~${slotsLeft}`);

            const waveStartMs = Date.now();
            await publishBulk(batch, healthyZaps);
            await startWorkers(healthyZaps, {
                ...config,
                cycleId,
                minDelayS:       MSG_MIN_DELAY_S,
                maxDelayS:       MSG_MAX_DELAY_S,
                subGroupOffsets: offsets,
            });
            await waitForWaveToFinish(cycleId);
            await stopWorkers();

            if (stopRequested) break;

            // ── Pacing: distribui ondas pelo tempo restante da campanha ──────────
            const waveDurMs  = Date.now() - waveStartMs;
            const remaining  = await countPending();
            if (remaining === 0) break;

            let pauseSec = TRANSITION_MS / 1000;
            if (campaignEnd) {
                const timeLeftMs   = campaignEnd.getTime() - Date.now();
                const wavesLeft    = Math.max(1, Math.ceil(remaining / batch.length));
                const idealPauseMs = Math.max(0, (timeLeftMs / wavesLeft) - waveDurMs);
                pauseSec = Math.max(30, Math.floor(idealPauseMs / 1000));
                console.log(`  ⏱️  Pacing: ${remaining} restantes, ~${wavesLeft} ondas, pausa ideal ${Math.round(idealPauseMs / 1000)}s`);
            }

            // Cap: não ultrapassa o fim do bloco (deixa 60 s de margem)
            const timeLeft = blockEnd.getTime() - Date.now();
            pauseSec = Math.min(pauseSec, Math.max(0, Math.floor(timeLeft / 1000) - 60));

            if (pauseSec > 30 && otherZaps.length >= 2) {
                console.log(`  🔥 Aquecimento grupos inativos (${pauseSec}s)...`);
                await runWarmupFor(otherZaps, warmupLevel, pauseSec);
            } else if (pauseSec > 5) {
                console.log(`  ⏳ Pausa entre ondas (${pauseSec}s)...`);
                await new Promise(r => setTimeout(r, pauseSec * 1_000));
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

    // Não chama resetStop() aqui — stopSignal deve permanecer true até a próxima
    // campanha iniciar, para que callbacks de consumer ainda em execução não disparem.
    // resetStop() é chamado no início de runCampaignLoop para cada nova campanha.
    console.log('🏁 [ORCH] Loop encerrado.\n');
};

export default { runCampaignLoop, requestStop, resetStop, isStopRequested };
