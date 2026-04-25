import { getPendingMessages, countPending, countPendingInCycle, updateCycleStats } from './queueService.js';
import { publishBulk, purgeQueues } from '../queue/producer.js';
import { startWorkers, stopWorkers, requestWorkerStop, resetWorkerStop } from '../queue/worker.js';
import { rotateMobileIPs } from './networkController.js';
import { generateCycleReport, generateFailureList } from './reportGenerator.js';

const CYCLE_DURATION_MS = 45 * 60 * 1000;

let stopRequested = false;
export const requestStop     = () => { stopRequested = true; requestWorkerStop(); };
export const resetStop       = () => { stopRequested = false; resetWorkerStop(); };
export const isStopRequested = () => stopRequested;

const calcDelayPerMsg = (msgsPerCycle, numZaps) => {
    if (!msgsPerCycle || msgsPerCycle <= 0 || !numZaps) return { min: 45, max: 90 };
    const msgsPerZap = Math.ceil(msgsPerCycle / numZaps);
    const baseDelayS = (CYCLE_DURATION_MS / 1000) / Math.max(msgsPerZap, 1);
    return {
        min: Math.max(8,  Math.floor(baseDelayS * 0.80)),
        max: Math.ceil(baseDelayS * 1.20),
    };
};

const isWithinSelectedTime = (selectedTimes) => {
    if (!selectedTimes || selectedTimes.length === 0) return true;
    const now = new Date();
    return selectedTimes.some(time => {
        const [h, m] = time.split(':').map(Number);
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
        const diff   = now - target;
        return diff >= 0 && diff <= 5 * 60 * 1000;
    });
};

const waitForNextScheduledTime = async (selectedTimes) => {
    if (!selectedTimes || selectedTimes.length === 0) return;
    const now    = new Date();
    let minDiff  = Infinity;
    let nextTime = null;

    selectedTimes.forEach(time => {
        const [h, m] = time.split(':').map(Number);
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
        if (target <= now) target.setDate(target.getDate() + 1);
        const diff = target - now;
        if (diff < minDiff) { minDiff = diff; nextTime = target; }
    });

    if (nextTime) {
        console.log(`⏰ [ORQUESTRADOR] Próximo disparo em ${Math.ceil(minDiff / 60000)} min (${nextTime.toLocaleTimeString('pt-BR')})`);
        await new Promise(r => setTimeout(r, minDiff));
    }
};

const waitForWorkersToFinish = async (cycleId) => {
    while (!stopRequested) {
        const pending = await countPendingInCycle(cycleId);
        if (pending === 0) break;
        await new Promise(r => setTimeout(r, 5000));
    }
};

export const runCycle = async (activeAccountsList, campaignConfig, cycleId, selectedTimes = null) => {
    if (selectedTimes?.length > 0 && !isWithinSelectedTime(selectedTimes)) {
        console.log(`⏸️ [ORQUESTRADOR] Fora do horário. Aguardando...`);
        await waitForNextScheduledTime(selectedTimes);
    }

    const { msgsPerCycle } = campaignConfig;
    const numZaps    = activeAccountsList.length;
    const totalBatch = msgsPerCycle || numZaps * 16;
    const pendings   = await getPendingMessages(totalBatch);

    if (pendings.length === 0) {
        await updateCycleStats(cycleId, 0, 0, 'concluido');
        console.log('✅ [ORQUESTRADOR] Fila vazia! Campanha finalizada.');
        return false;
    }

    const delay = calcDelayPerMsg(pendings.length, numZaps);
    console.log(`\n🌊 [ORQUESTRADOR] Ciclo: ${pendings.length} msgs | ${numZaps} zap(s) | delay ${delay.min}-${delay.max}s/msg`);

    await publishBulk(pendings, activeAccountsList);
    await startWorkers(activeAccountsList, { ...campaignConfig, cycleId, ...delay });

    await waitForWorkersToFinish(cycleId);
    await stopWorkers();

    if (stopRequested) {
        console.log('\n🛑 [ORQUESTRADOR] Campanha interrompida pelo usuário.');
        await updateCycleStats(cycleId, 0, 0, 'interrompido');
        await purgeQueues(activeAccountsList);
        return false;
    }

    try {
        const reportPath  = await generateCycleReport(cycleId);
        const failurePath = await generateFailureList(cycleId);
        console.log(`📊 Relatórios:\n   ${reportPath}\n   ${failurePath}`);
    } catch (e) {
        console.warn('⚠️ Erro ao gerar relatórios:', e.message);
    }

    console.log('\n🔄 [ORQUESTRADOR] Rotação de IPs...');
    await rotateMobileIPs();

    const remaining = await countPending();
    if (remaining === 0) {
        await updateCycleStats(cycleId, 0, 0, 'concluido');
        console.log('🏁 [ORQUESTRADOR] Todos os contatos processados!');
        return false;
    }

    return true;
};

export const runCampaignLoop = async (activeAccountsList, campaignConfig, cycleId, selectedTimes = null) => {
    resetStop();
    let hasMore = true;

    while (hasMore && !stopRequested) {
        hasMore = await runCycle(activeAccountsList, campaignConfig, cycleId, selectedTimes);

        if (hasMore && !stopRequested) {
            const waitMs = (!selectedTimes || selectedTimes.length === 0) ? CYCLE_DURATION_MS : 60000;
            console.log(`\n⏳ [ORQUESTRADOR] Aguardando próxima janela (${Math.round(waitMs / 60000)} min)...`);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }

    resetStop();
};

export default { runCycle, runCampaignLoop, requestStop, resetStop };
