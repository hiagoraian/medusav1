import {
    getPendingMessages, countPending, countPendingInCycle,
    assignMessagesToCycle, updateCycleStats, countCycleStats,
} from './queueService.js';
import { publishBulk, purgeQueues }                                          from '../queue/producer.js';
import { startWorkers, stopWorkers, requestWorkerStop, resetWorkerStop }     from '../queue/worker.js';
import { rotateMobileIPsStaggered, getZapsByZte, ZTE_PAIR_ORDER, getActiveZteIds, getZteForAccount, isZteOnline } from './networkController.js';
import { runWarmupFor }                                                      from './chipWarmup.js';
import { generateCampaignReport, clearReports }                              from './reportGenerator.js';
import * as evolution                                                        from '../evolution/client.js';

const SLOT_DURATION_MS = 25 * 60 * 1000;  // 25 min por rodada (24 zaps com 6 sub-grupos)
const TRANSITION_MS    = 11 * 60 * 1000;  // rotação de IP entre rodadas (~10.5 min real)
const MSG_MIN_DELAY_S  = 90;              // delay mínimo entre msgs no worker
const MSG_MAX_DELAY_S  = 150;             // delay máximo entre msgs no worker

const SUBGROUP_SIZE = 4;                  // 24 zaps ÷ 4 = 6 sub-grupos, offset 90s cada

const ADMIN_ZAP    = process.env.ADMIN_ZAP    || 'WA-49';
const ADMIN_NUMBER = process.env.ADMIN_NUMBER  || '';

const sendAdminReport = async (roundNum, pairLabel, sentThisRound, cycleId, pendingLeft, fallenThisRound) => {
    if (!ADMIN_NUMBER) return;
    try {
        const state = await evolution.getConnectionState(ADMIN_ZAP);
        if (state !== 'open') { console.log(`[ADMIN] ${ADMIN_ZAP} offline — relatório não enviado.`); return; }
        const stats  = await countCycleStats(cycleId);
        const now    = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const zapsLine = fallenThisRound.size > 0
            ? `\n🔴 Zaps caídos: ${[...fallenThisRound].join(', ')}`
            : `\n💚 Todos os zaps ok`;
        const text  =
            `📊 *Medusa — Ciclo ${roundNum}*\n\n` +
            `🕐 ${now}  |  🔁 ${pairLabel}\n\n` +
            `📬 Pendentes: ${pendingLeft}\n` +
            `✅ Enviados: ${stats.enviado + stats.invalido}\n` +
            `❌ Falhas técnicas: ${stats.falha}` +
            zapsLine +
            (pendingLeft === 0 ? '\n\n🏁 *Campanha concluída!*' : '');
        await evolution.sendText(ADMIN_ZAP, ADMIN_NUMBER, text);
        console.log(`[ADMIN] Relatório ciclo ${roundNum} enviado → ${ADMIN_NUMBER}`);
    } catch (err) {
        console.warn(`[ADMIN] Falha ao enviar relatório: ${err.message}`);
    }
};

// ── Sistema de reservas ───────────────────────────────────────────────────────
// Um zap reserva por ZTE — ativado quando o titular do mesmo ZTE cai.
// Campanha pausa automaticamente ao atingir MAX_FALLEN_BEFORE_PAUSE caídos.
const RESERVE_ZTE_MAP       = { ZTE1: 'WA-12', ZTE2: 'WA-24', ZTE3: 'WA-36', ZTE4: 'WA-48' };
const ALL_RESERVES          = new Set(Object.values(RESERVE_ZTE_MAP));
const MAX_FALLEN_BEFORE_PAUSE = 5;

// ── Health check pré-disparo ──────────────────────────────────────────────────
// Verifica estado de conexão de cada zap antes de cada onda.
// Se um zap caiu e seu ZTE está offline, tenta fallback via Wi-Fi antes de descartar.
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
                console.warn(`🔴 [PREFLIGHT] ${id} offline — estado: ${state}`);
                sick.push(id);
            }
        } catch (err) {
            console.warn(`🔴 [PREFLIGHT] ${id} offline — ${err.message}`);
            sick.push(id);
        }
    }));

    if (sick.length === 0) return healthy;

    // ── Fallback Wi-Fi: agrupa zaps caídos por ZTE ───────────────────────────
    const sickByZte = {};
    const sickNoZte = [];
    for (const id of sick) {
        const zteId = getZteForAccount(id);
        zteId ? (sickByZte[zteId] = [...(sickByZte[zteId] || []), id]) : sickNoZte.push(id);
    }

    const recovered = [];

    // Verifica cada ZTE em paralelo — se offline, muda todos os seus zaps para Wi-Fi
    await Promise.allSettled(Object.entries(sickByZte).map(async ([zteId, ids]) => {
        const online = await isZteOnline(zteId);
        if (online) return; // ZTE vivo → queda é do WhatsApp, não do proxy

        console.warn(`🌐 [PREFLIGHT] ${zteId} offline — fallback Wi-Fi em ${ids.length} zap(s)...`);

        // Remove proxy e reinicia todos em paralelo
        await Promise.allSettled(ids.map(async (id) => {
            await evolution.clearProxy(id).catch(() => {});
            await evolution.restartInstance(id).catch(() => {});
        }));

        // Aguarda reconexão via Wi-Fi (até 15s, checando a cada 3s)
        for (let t = 0; t < 5; t++) {
            await new Promise(r => setTimeout(r, 3000));
            await Promise.allSettled(ids.map(async (id) => {
                if (recovered.includes(id)) return;
                const s = await evolution.getConnectionState(id).catch(() => 'close');
                if (s === 'open') {
                    console.log(`✅ [PREFLIGHT] ${id} recuperado via Wi-Fi`);
                    recovered.push(id);
                }
            }));
            if (ids.every(id => recovered.includes(id))) break;
        }

        const failed = ids.filter(id => !recovered.includes(id));
        if (failed.length > 0)
            console.warn(`🔴 [PREFLIGHT] Wi-Fi fallback falhou: ${failed.join(', ')}`);
    }));

    const allSick = sick.filter(id => !recovered.includes(id));
    if (allSick.length > 0)
        console.warn(`⚠️ [PREFLIGHT] ${allSick.length} zap(s) suspenso(s): ${allSick.join(', ')}`);

    return [...healthy, ...recovered];
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

    // Separa reservas e admin dos zaps ativos
    let workingAccounts     = activeAccounts.filter(id => !ALL_RESERVES.has(id) && id !== ADMIN_ZAP);
    const reservePool       = activeAccounts.filter(id =>  ALL_RESERVES.has(id));
    const fallenZaps        = new Set();
    const activatedReserves = new Set();

    // Aguarda data/hora de início se agendado
    await waitUntilStartDatetime(startDatetime);
    if (stopRequested) { resetStop(); return; }

    let pairIdx          = 0;
    let waveCount        = 0;
    let consecutiveSkips = 0;
    let roundNum         = 0;

    console.log(`\n🚀 [ORCH] Campanha iniciada — modo par de ZTEs`);
    console.log(`   Zaps: ${workingAccounts.length} ativos + ${reservePool.length} reserva(s) | Slot: ${SLOT_DURATION_MS / 60000} min | Aquecimento: ${warmupLevel}`);
    console.log(`   Reservas: ${reservePool.join(', ') || 'nenhuma'} | Pausa após: ${MAX_FALLEN_BEFORE_PAUSE} caídos`);
    console.log(`   Janela: ${WINDOW_START}–${WINDOW_END} | Fim: ${campaignEnd ? campaignEnd.toLocaleString('pt-BR') : 'sem limite'}`);
    console.log(`   Rodada 1: ${ZTE_PAIR_ORDER[0].join('+')} | Rodada 2: ${ZTE_PAIR_ORDER[1].join('+')}`);

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

        // ── Determina par de ZTEs ativo ───────────────────────────────────────
        const pairZtes  = ZTE_PAIR_ORDER[pairIdx % 2];
        const pairLabel = pairZtes.join('+');
        let pairZaps    = pairZtes.flatMap(zteId => getZapsByZte(zteId))
                                  .filter(id => workingAccounts.includes(id));
        const otherZaps = workingAccounts.filter(id => !pairZaps.includes(id));

        if (pairZaps.length === 0) {
            console.warn(`⚠️ [ORCH] Par ${pairLabel} sem zaps ativos. Avançando para próximo par.`);
            consecutiveSkips++;
            if (consecutiveSkips >= 2) {
                console.error('🔴 [ORCH] Nenhum par com zaps ativos. Encerrando campanha.');
                break;
            }
            pairIdx++;
            continue;
        }
        consecutiveSkips = 0;

        // Slot de 25 min, limitado pelo fim da janela/campanha
        const blockEnd = new Date(Math.min(
            Date.now() + SLOT_DURATION_MS,
            testMode ? Infinity : endOfTodayWindow(WINDOW_END).getTime(),
            campaignEnd ? campaignEnd.getTime() : Infinity,
        ));

        console.log(`\n🔤 [ORCH] Rodada ${pairLabel} — ${pairZaps.length} zaps — até ${blockEnd.toLocaleTimeString('pt-BR')}`);

        const pendingBeforeRound = await countPending();
        const fallenThisRound   = new Set();

        // ── Ondas dentro do bloco ─────────────────────────────────────────────
        while (!stopRequested && Date.now() < blockEnd.getTime()) {
            if (!testMode && !isWithinWindow(WINDOW_START, WINDOW_END)) break;

            // ── Health check: remove zaps que não conseguem enviar ────────────
            console.log(`  🔍 [PREFLIGHT] Verificando ${pairZaps.length} zap(s)...`);
            const healthyZaps = await preflightCheck(pairZaps);

            // ── Sistema de reservas: detecta novos caídos e ativa substitutos ──
            const newlyFallen = pairZaps.filter(id => !healthyZaps.includes(id) && !fallenZaps.has(id));
            for (const fallen of newlyFallen) {
                fallenZaps.add(fallen);
                fallenThisRound.add(fallen);
                console.warn(`🔴 [RESERVE] ${fallen} caiu — total caídos: ${fallenZaps.size}/${MAX_FALLEN_BEFORE_PAUSE}`);

                const zteId     = getZteForAccount(fallen);
                const reserveId = zteId ? RESERVE_ZTE_MAP[zteId] : null;
                if (reserveId && reservePool.includes(reserveId) && !activatedReserves.has(reserveId)) {
                    const state = await evolution.getConnectionState(reserveId);
                    if (state === 'open') {
                        workingAccounts.push(reserveId);
                        activatedReserves.add(reserveId);
                        console.log(`✅ [RESERVE] ${reserveId} ativado como reserva de ${fallen} (${zteId})`);
                        // Inclui na onda atual se for do mesmo par de ZTEs
                        if (pairZtes.includes(zteId)) {
                            pairZaps = [...pairZaps, reserveId];
                        }
                    } else {
                        fallenZaps.add(reserveId);
                        console.warn(`⚠️ [RESERVE] ${reserveId} offline (${state}) — contabilizado como caído. Total: ${fallenZaps.size}/${MAX_FALLEN_BEFORE_PAUSE}`);
                    }
                }

                if (fallenZaps.size >= MAX_FALLEN_BEFORE_PAUSE) {
                    console.error(`🛑 [RESERVE] ${MAX_FALLEN_BEFORE_PAUSE} zaps caídos. Pausando campanha automaticamente.`);
                    requestStop();
                    break;
                }
            }
            if (stopRequested) break;

            if (healthyZaps.length === 0) {
                console.error('🔴 [ORCH] Nenhum zap passou no preflight. Encerrando bloco.');
                break;
            }
            if (healthyZaps.length < pairZaps.length) {
                console.warn(`⚠️ [ORCH] Continuando com ${healthyZaps.length}/${pairZaps.length} zap(s) saudáveis.`);
            }

            // Calcula dinamicamente quantas msgs por zap neste slot
            const totalPending  = await countPending();
            const timeLeftMs    = Math.max(0, (campaignEnd || endOfTodayWindow(WINDOW_END)).getTime() - Date.now());
            const slotsLeft     = Math.max(1, Math.round(timeLeftMs / (SLOT_DURATION_MS + TRANSITION_MS)));
            const batchPerZap   = Math.max(1, Math.ceil(totalPending / (healthyZaps.length * slotsLeft)));

            const batch = await getPendingMessages(batchPerZap * healthyZaps.length);
            if (batch.length === 0) break;

            await assignMessagesToCycle(batch.map(r => r.id), cycleId);

            const offsets = buildSubGroupOffsets(healthyZaps, MSG_MIN_DELAY_S * 1_000);
            waveCount++;

            console.log(`  🌊 Onda ${waveCount} [${pairLabel}] — ${batch.length} msgs — ${healthyZaps.length} zap(s) — ${batchPerZap}/zap — slots restantes ~${slotsLeft}`);

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

            let pauseSec = 30;
            if (campaignEnd) {
                const timeLeftMs2  = campaignEnd.getTime() - Date.now();
                const wavesLeft    = Math.max(1, Math.ceil(remaining / batch.length));
                const idealPauseMs = Math.max(0, (timeLeftMs2 / wavesLeft) - waveDurMs);
                pauseSec = Math.max(30, Math.floor(idealPauseMs / 1000));
                console.log(`  ⏱️  Pacing: ${remaining} restantes, ~${wavesLeft} ondas, pausa ideal ${Math.round(idealPauseMs / 1000)}s`);
            }

            // Cap: não ultrapassa o fim do bloco (deixa 60s de margem)
            const timeLeft = blockEnd.getTime() - Date.now();
            pauseSec = Math.min(pauseSec, Math.max(0, Math.floor(timeLeft / 1000) - 60));

            if (pauseSec > 30 && otherZaps.length >= 2) {
                console.log(`  🔥 Aquecimento par inativo (${pauseSec}s)...`);
                await runWarmupFor(otherZaps, warmupLevel, pauseSec);
            } else if (pauseSec > 5) {
                console.log(`  ⏳ Pausa entre ondas (${pauseSec}s)...`);
                await new Promise(r => setTimeout(r, pauseSec * 1_000));
            }
        }

        // ── Interrompido pelo usuário ─────────────────────────────────────────
        if (stopRequested) {
            await updateCycleStats(cycleId, 0, 0, 'interrompido');
            await purgeQueues(workingAccounts);
            console.log('\n🛑 [ORCH] Campanha interrompida pelo usuário.');
            break;
        }

        // ── Relatório de ciclo para o admin ──────────────────────────────────
        roundNum++;
        const pendingAfterRound  = await countPending();
        const sentThisRound      = pendingBeforeRound - pendingAfterRound;
        await sendAdminReport(roundNum, pairLabel, sentThisRound, cycleId, pendingAfterRound, fallenThisRound);

        // Fila zerou dentro do bloco
        if (pendingAfterRound === 0) break;

        // ── Transição de par: rotaciona IPs de todos os ZTEs ─────────────────
        pairIdx++;
        const nextPairZtes = ZTE_PAIR_ORDER[pairIdx % 2];
        const nextPairZaps = nextPairZtes.flatMap(zteId => getZapsByZte(zteId))
                                         .filter(id => workingAccounts.includes(id));

        console.log(`\n🔄 [ORCH] Transição → ${nextPairZtes.join('+')} | Rotacionando IPs...`);
        await rotateMobileIPsStaggered(getActiveZteIds());

        if (nextPairZaps.length >= 2 && !stopRequested) {
            console.log(`  🔥 Pré-aquecimento ${nextPairZtes.join('+')} (2 min)...`);
            await runWarmupFor(nextPairZaps, warmupLevel, 120);
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
