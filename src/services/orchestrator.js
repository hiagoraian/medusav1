import {
    getPendingMessages, countPending, countPendingInCycle,
    assignMessagesToCycle, updateCycleStats,
} from './queueService.js';
import { publishBulk, purgeQueues }                      from '../queue/producer.js';
import { startWorkers, stopWorkers, requestWorkerStop, resetWorkerStop } from '../queue/worker.js';
import { rotateMobileIPsStaggered }                      from './networkController.js';
import { runWarmupFor }                                  from './chipWarmup.js';
import { generateCampaignReport }                        from './reportGenerator.js';

// ── Configuração de nível de disparo ─────────────────────────────────────────
// batchPerZap : mensagens por zap por onda
// minDelayS / maxDelayS : delay entre mensagens (segundos)
const DISPATCH_LEVELS = {
    1: { batchPerZap: 3, minDelayS: 90, maxDelayS: 150 },
    2: { batchPerZap: 5, minDelayS: 60, maxDelayS:  90 },
    3: { batchPerZap: 8, minDelayS: 45, maxDelayS:  70 },
};

const SUBGROUP_SIZE   = 4;   // zaps por sub-grupo de onda
const WARMUP_PAUSE_S  = 600; // segundos de aquecimento entre ondas (10 min)
const IP_ROTATE_EVERY = 3;   // rotacionar IPs a cada N ondas

// ── Estado global ─────────────────────────────────────────────────────────────

let stopRequested = false;
export const requestStop     = () => { stopRequested = true; requestWorkerStop(); };
export const resetStop       = () => { stopRequested = false; resetWorkerStop(); };
export const isStopRequested = () => stopRequested;

// ── Janela de horário ─────────────────────────────────────────────────────────

const timeToMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};

const isWithinWindow = (startTime, endTime) => {
    if (!startTime || !endTime) return true;
    const now    = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return nowMin >= timeToMinutes(startTime) && nowMin < timeToMinutes(endTime);
};

const waitUntilWindowOpens = async (startTime, endTime) => {
    while (!stopRequested) {
        if (isWithinWindow(startTime, endTime)) return;
        const now = new Date();
        const [sh, sm] = startTime.split(':').map(Number);
        const target   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0);
        if (target <= now) target.setDate(target.getDate() + 1);
        const diffMs  = target - now;
        const diffMin = Math.ceil(diffMs / 60000);
        console.log(`⏰ [ORQUESTRADOR] Fora do horário. Próximo disparo em ${diffMin} min.`);
        // Dorme em fatias de 5 min para checar stopRequested
        await new Promise(r => setTimeout(r, Math.min(300_000, diffMs)));
    }
};

// ── Offsets de sub-grupo (onda) ───────────────────────────────────────────────

/**
 * Distribui os accountIds em sub-grupos de SUBGROUP_SIZE e atribui a cada um
 * um offset em ms = índice_do_subgrupo × staggerMs.
 */
const buildSubGroupOffsets = (accounts, staggerMs) => {
    const offsets = {};
    for (let i = 0; i < accounts.length; i++) {
        const subGroupIdx   = Math.floor(i / SUBGROUP_SIZE);
        offsets[accounts[i]] = subGroupIdx * staggerMs;
    }
    return offsets;
};

// ── Espera pela conclusão da onda ─────────────────────────────────────────────

const waitForWaveToFinish = async (cycleId) => {
    while (!stopRequested) {
        const pending = await countPendingInCycle(cycleId);
        if (pending === 0) break;
        await new Promise(r => setTimeout(r, 5_000));
    }
};

// ── Loop principal da campanha ────────────────────────────────────────────────

/**
 * campaignConfig campos relevantes:
 *   messageTemplate, mediaUrl, mediaType, mediaMode  — conteúdo
 *   startTime, endTime  — "HH:MM" — janela de horário
 *   dispatchLevel (1–3) — velocidade/volume de disparo
 *   warmupLevel   (1–10) — intensidade do aquecimento entre ondas
 */
export const runCampaignLoop = async (activeAccountsList, campaignConfig, cycleId) => {
    const { startTime, endTime, dispatchLevel = 2, warmupLevel = 5 } = campaignConfig;
    const level     = DISPATCH_LEVELS[dispatchLevel] || DISPATCH_LEVELS[2];
    const numZaps   = activeAccountsList.length;
    const staggerMs = level.minDelayS * 1_000; // offset entre sub-grupos

    resetStop();
    let waveCount = 0;

    console.log(`\n🚀 [ORQUESTRADOR] Campanha iniciada — ${numZaps} zap(s) | nível ${dispatchLevel} | aquecimento ${warmupLevel}`);
    if (startTime && endTime) console.log(`   Janela: ${startTime}–${endTime}`);

    while (!stopRequested) {
        // ── Aguarda janela de horário ─────────────────────────────────────────
        if (startTime && endTime) {
            if (!isWithinWindow(startTime, endTime)) {
                console.log('⏸️  [ORQUESTRADOR] Fora da janela. Aguardando...');
                await waitUntilWindowOpens(startTime, endTime);
                if (stopRequested) break;
            }
        }

        // ── Busca próximo lote ────────────────────────────────────────────────
        const totalBatch = level.batchPerZap * numZaps;
        const pendings   = await getPendingMessages(totalBatch);

        if (pendings.length === 0) {
            await generateCampaignReport(cycleId).catch(e => console.warn('⚠️  Relatório:', e.message));
            await updateCycleStats(cycleId, 0, 0, 'concluido');
            console.log('✅ [ORQUESTRADOR] Fila vazia! Campanha finalizada.');
            break;
        }

        // ── Pré-atribui cycleId ao lote (necessário para countPendingInCycle) ─
        const messageIds = pendings.map(r => r.id);
        await assignMessagesToCycle(messageIds, cycleId);

        // ── Monta offsets de onda ─────────────────────────────────────────────
        const subGroupOffsets = buildSubGroupOffsets(activeAccountsList, staggerMs);
        const numSubGroups    = Math.ceil(numZaps / SUBGROUP_SIZE);

        waveCount++;
        console.log(`\n🌊 [ORQUESTRADOR] Onda ${waveCount} — ${pendings.length} msgs | ${numZaps} zap(s) | ${numSubGroups} sub-grupo(s) | stagger ${Math.round(staggerMs / 1000)}s`);

        // ── Publica no RabbitMQ e inicia workers ──────────────────────────────
        await publishBulk(pendings, activeAccountsList);
        await startWorkers(activeAccountsList, {
            ...campaignConfig,
            cycleId,
            minDelayS: level.minDelayS,
            maxDelayS: level.maxDelayS,
            subGroupOffsets,
        });

        await waitForWaveToFinish(cycleId);
        await stopWorkers();

        if (stopRequested) {
            await updateCycleStats(cycleId, 0, 0, 'interrompido');
            await purgeQueues(activeAccountsList);
            console.log('\n🛑 [ORQUESTRADOR] Campanha interrompida pelo usuário.');
            break;
        }

        // ── Aquecimento entre ondas ───────────────────────────────────────────
        const remaining = await countPending();
        if (remaining > 0 && !stopRequested) {
            console.log(`\n🔥 [ORQUESTRADOR] Aquecimento (${Math.round(WARMUP_PAUSE_S / 60)} min, nível ${warmupLevel})...`);
            await runWarmupFor(activeAccountsList, warmupLevel, WARMUP_PAUSE_S);
        }

        // ── Rotação de IPs a cada N ondas ─────────────────────────────────────
        if (waveCount % IP_ROTATE_EVERY === 0 && !stopRequested) {
            console.log('\n🔄 [ORQUESTRADOR] Rotação de IPs escalonada...');
            await rotateMobileIPsStaggered();
        }

        // ── Verifica fim da janela antes da próxima onda ──────────────────────
        if (startTime && endTime && !isWithinWindow(startTime, endTime) && !stopRequested) {
            console.log('⏸️  [ORQUESTRADOR] Fim da janela. Aguardando próximo dia...');
            await waitUntilWindowOpens(startTime, endTime);
        }
    }

    // Gera relatório final se ainda não foi gerado
    if (!stopRequested) {
        await generateCampaignReport(cycleId).catch(e => console.warn('⚠️  Relatório final:', e.message));
    }

    resetStop();
    console.log('🏁 [ORQUESTRADOR] Loop encerrado.\n');
};

export default { runCampaignLoop, requestStop, resetStop, isStopRequested };
