import { getPendingMessages, updateMessageStatus, updateCycleStats, countPending } from './queueService.js';
import { getClientInstance } from '../whatsapp/manager.js';
import { executeSend } from '../whatsapp/sender.js';
import { rotateMobileIPs } from './networkController.js';
import { addHumanVariation } from './delayCalculator.js';
import { humanDelay } from './antiSpam.js';
import { generateCycleReport, generateFailureList } from './reportGenerator.js';
import fs from 'fs';
import path from 'path';

const CYCLE_DURATION_MS = 45 * 60 * 1000; // 45 minutos fixos

/**
 * Calcula o delay entre disparos baseado em msgsPerCycle e janela de 30 min.
 */
const calcDelayBetweenMsgs = (msgsPerCycle) => {
    if (!msgsPerCycle || msgsPerCycle <= 0) return 60000;
    const baseDelay = CYCLE_DURATION_MS / msgsPerCycle;
    const variation = baseDelay * 0.20;
    return Math.floor(baseDelay - variation + Math.random() * variation * 2);
};

/**
 * Verifica se o horário atual está dentro dos horários selecionados
 */
const isWithinSelectedTime = (selectedTimes) => {
    if (!selectedTimes || selectedTimes.length === 0) return true;
    const now = new Date();
    const currentHour   = now.getHours().toString().padStart(2, '0');
    const currentMinute = now.getMinutes().toString().padStart(2, '0');
    const currentTime   = `${currentHour}:${currentMinute}`;
    
    // Verifica se o horário atual coincide com algum dos horários agendados
    return selectedTimes.includes(currentTime);
};

const waitForNextScheduledTime = async (selectedTimes) => {
    if (!selectedTimes || selectedTimes.length === 0) return;
    const now = new Date();
    let minDiff = Infinity;
    let nextTime = null;
    
    selectedTimes.forEach(time => {
        const [hour, minute] = time.split(':').map(Number);
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
        if (target <= now) target.setDate(target.getDate() + 1);
        const diff = target - now;
        if (diff < minDiff) { minDiff = diff; nextTime = target; }
    });
    
    if (nextTime) {
        const waitMinutes = Math.ceil(minDiff / 60000);
        console.log(`⏰ [ORQUESTRADOR] Próximo disparo em ${waitMinutes} minutos (${nextTime.toLocaleTimeString('pt-BR')})`);
        await new Promise(resolve => setTimeout(resolve, minDiff));
    }
};

/**
 * Dispara para UM contato usando UM zap e retorna o resultado.
 */
const dispatchOne = async (msgRow, accountId, messageTemplate, mediaPath, mediaMode, cycleId, delayMs) => {
    const client = getClientInstance(accountId);
    if (!client) {
        console.log(`⚠️ [${accountId}] Cliente offline. Falha para ${msgRow.phone_number}.`);
        await updateMessageStatus(msgRow.id, 'falha', accountId, cycleId, 'Cliente offline durante o ciclo');
        return 'falha';
    }

    // Delay humano proporcional
    const jitter = addHumanVariation(delayMs);
    await humanDelay(jitter / 1000, jitter / 1000 + 0.5);

    console.log(`🚀 [${accountId}] Disparando para ${msgRow.phone_number}...`);
    const result = await executeSend(client, msgRow.phone_number, messageTemplate, mediaPath, mediaMode);
    
    // Persiste o status no banco imediatamente para resiliência
    await updateMessageStatus(msgRow.id, result.status, accountId, cycleId, result.error);

    if (result.status === 'enviado') {
        console.log(`✅ [${accountId}] Enviado para ${msgRow.phone_number}`);
    } else if (result.status === 'invalido') {
        console.log(`🚫 [${accountId}] Número inválido: ${msgRow.phone_number}`);
    } else {
        console.log(`❌ [${accountId}] Falha para ${msgRow.phone_number}: ${result.error}`);
    }
    return result.status;
};

/**
 * Executa UM ciclo de 30 minutos
 */
export const runCycle = async (
    activeAccountsList,
    messageTemplate,
    mediaPath,
    mediaMode,
    msgsPerCycle,
    cycleId,
    selectedTimes = null
) => {
    // --- Controle de horário ---
    if (selectedTimes && selectedTimes.length > 0 && !isWithinSelectedTime(selectedTimes)) {
        console.log(`⏸️ [ORQUESTRADOR] Fora do horário de disparo. Aguardando...`);
        await waitForNextScheduledTime(selectedTimes);
    }

    const numZaps = activeAccountsList.length;
    const totalThisCycle = msgsPerCycle || numZaps * 16; // 16 por zap conforme solicitado
    const pendings = await getPendingMessages(totalThisCycle);

    if (pendings.length === 0) {
        await updateCycleStats(cycleId, 0, 0, 'concluido');
        console.log('✅ [ORQUESTRADOR] Fila vazia! Campanha finalizada.');
        return false;
    }

    const msgsPerZap  = Math.ceil(pendings.length / numZaps);
    const delayPerMsg = calcDelayBetweenMsgs(msgsPerZap > 0 ? msgsPerZap : 1);

    console.log(`\n🌊 [ORQUESTRADOR] Iniciando Ciclo com ${pendings.length} disparos em ${numZaps} zap(s)`);
    console.log(`⏱️  Delay médio entre msgs por zap: ${Math.round(delayPerMsg / 1000)}s (±20%)`);

    // Distribui mensagens por zap de forma equilibrada
    const zapQueues = activeAccountsList.map((_, zapIdx) =>
        pendings.filter((_, msgIdx) => msgIdx % numZaps === zapIdx)
    );

    const cycleStart = Date.now();
    const zapPromises = zapQueues.map(async (queue, zapIdx) => {
        const accountId = activeAccountsList[zapIdx];
        let sent = 0, failed = 0, invalid = 0;
        for (let i = 0; i < queue.length; i++) {
            const status = await dispatchOne(
                queue[i], accountId, messageTemplate, mediaPath, mediaMode, cycleId, delayPerMsg
            );
            if (status === 'enviado') sent++;
            else if (status === 'invalido') invalid++;
            else failed++;
        }
        return { accountId, sent, failed, invalid };
    });

    const results = await Promise.allSettled(zapPromises);

    let totalSent = 0, totalFailed = 0, totalInvalid = 0;
    results.forEach(r => {
        if (r.status === 'fulfilled') {
            totalSent    += r.value.sent;
            totalFailed  += r.value.failed;
            totalInvalid += r.value.invalid;
        }
    });

    // Atualiza estatísticas do ciclo (falhas incluem inválidos para contagem de progresso)
    await updateCycleStats(cycleId, totalSent, totalFailed + totalInvalid, 'em_andamento');
    
    console.log(`\n✅ [ORQUESTRADOR] Ciclo finalizado.`);
    console.log(`📊 Resumo: ✅ Enviados: ${totalSent} | ❌ Falhas: ${totalFailed} | 🚫 Inválidos: ${totalInvalid}`);

    // --- RELATÓRIOS AUTOMÁTICOS (v4.0) ---
    try {
        const reportPath = await generateCycleReport(cycleId);
        const failurePath = await generateFailureList(cycleId);
        console.log(`📊 [ORQUESTRADOR] Relatórios salvos automaticamente:`);
        console.log(`   - Geral: ${reportPath}`);
        console.log(`   - Falhas: ${failurePath}`);
    } catch (e) {
        console.warn('⚠️ [ORQUESTRADOR] Erro ao gerar relatórios automáticos:', e.message);
    }

    // --- Rotação de IPs (Modo Avião) ---
    // O usuário sugeriu fazer isso uma vez dentro do ciclo ou ao final. 
    // Faremos ao final para garantir estabilidade durante os disparos simultâneos.
    console.log('\n🔄 [ORQUESTRADOR] Iniciando Rotação de IPs pós-ciclo...');
    await rotateMobileIPs();

    const remaining = await countPending();
    if (remaining === 0) {
        await updateCycleStats(cycleId, 0, 0, 'concluido');
        console.log('🏁 [ORQUESTRADOR] Todos os contatos foram processados!');
        return false;
    }

    return true;
};

export const runCampaignLoop = async (
    activeAccountsList,
    messageTemplate,
    mediaPath,
    mediaMode,
    msgsPerCycle,
    cycleId,
    selectedTimes = null
) => {
    let hasMore = true;
    while (hasMore) {
        hasMore = await runCycle(
            activeAccountsList, messageTemplate, mediaPath, mediaMode,
            msgsPerCycle, cycleId, selectedTimes
        );

        if (hasMore) {
            console.log(`\n⏳ [ORQUESTRADOR] Ciclo concluído. Aguardando próximo horário ou janela de 30 min...`);
            // Se não houver horários específicos, espera 30 min. 
            // Se houver, o runCycle já terá esperado dentro dele.
            if (!selectedTimes || selectedTimes.length === 0) {
                await new Promise(resolve => setTimeout(resolve, CYCLE_DURATION_MS));
            } else {
                // Pequena pausa para evitar loop infinito rápido se o horário ainda for o mesmo
                await new Promise(resolve => setTimeout(resolve, 60000));
            }
        }
    }
};

export default { runCycle, runCampaignLoop };
