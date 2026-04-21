import { getPendingMessages, updateMessageStatus, updateCycleStats, countPending } from './queueService.js';
import { getClientInstance, isClientReady } from '../whatsapp/manager.js';
import { executeSend } from '../whatsapp/sender.js';
import { rotateMobileIPs } from './networkController.js';
import { addHumanVariation } from './delayCalculator.js';
import { humanDelay } from './antiSpam.js';
import { generateCycleReport, generateFailureList } from './reportGenerator.js';
import fs from 'fs';
import path from 'path';

const CYCLE_DURATION_MS = 45 * 60 * 1000; // 45 minutos fixos

let stopRequested = false;
export const requestStop  = () => { stopRequested = true; };
export const resetStop    = () => { stopRequested = false; };
export const isStopRequested = () => stopRequested;

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
 * Verifica se o horário atual está dentro dos horários selecionados.
 * Aceita uma janela de até 5 minutos APÓS o horário agendado para tolerar
 * pequenos atrasos no loop (ex: agendado 08:00, checado às 08:03 → ok).
 */
const isWithinSelectedTime = (selectedTimes) => {
    if (!selectedTimes || selectedTimes.length === 0) return true;
    const now = new Date();
    return selectedTimes.some(time => {
        const [hour, minute] = time.split(':').map(Number);
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
        const diffMs = now - target; // positivo = já passou, negativo = ainda não chegou
        return diffMs >= 0 && diffMs <= 5 * 60 * 1000; // até 5 min após o horário
    });
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
    // isClientReady verifica tanto a presença no mapa quanto a página Chromium ainda aberta.
    // Isso pega o "zap fantasma": instância no mapa mas tab já morta por OOM ou crash.
    if (!isClientReady(accountId)) {
        console.log(`⚠️ [${accountId}] Zap offline ou página fechada. Marcando como falha: ${msgRow.phone_number}`);
        await updateMessageStatus(msgRow.id, 'falha', accountId, cycleId, 'Zap offline durante o ciclo');
        return 'falha';
    }
    const client = getClientInstance(accountId);

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

    // Distribui mensagens por zap de forma equilibrada (round-robin)
    const zapQueues = activeAccountsList.map((_, zapIdx) =>
        pendings.filter((_, msgIdx) => msgIdx % numZaps === zapIdx)
    );

    // Agrupa os zaps em blocos de 8 (alinha com os grupos ZTE: 1-8, 9-16, 17-24).
    // Cada bloco inicia com um delay escalonado = delayPerMsg / numBlocos,
    // distribuindo os envios uniformemente ao longo da janela de cada mensagem
    // em vez de disparar todos simultaneamente.
    const BLOCK_SIZE = 8;
    const blocks = [];
    for (let i = 0; i < activeAccountsList.length; i += BLOCK_SIZE) {
        blocks.push(activeAccountsList.slice(i, i + BLOCK_SIZE));
    }
    const blockStaggerMs = Math.floor(delayPerMsg / blocks.length);

    console.log(`\n🌊 [ORQUESTRADOR] Iniciando Ciclo com ${pendings.length} disparos em ${numZaps} zap(s) — ${blocks.length} bloco(s) de até ${BLOCK_SIZE}`);
    console.log(`⏱️  Delay entre msgs por zap: ~${Math.round(delayPerMsg / 1000)}s | Escalonamento entre blocos: ${Math.round(blockStaggerMs / 1000)}s`);

    const blockPromises = blocks.map((blockAccounts, blockIdx) => (async () => {
        if (blockIdx > 0) {
            const wait = blockStaggerMs * blockIdx;
            console.log(`⏳ [BLOCO ${blockIdx + 1}/${blocks.length}] Aguardando ${Math.round(wait / 1000)}s para iniciar (${blockAccounts[0]}–${blockAccounts[blockAccounts.length - 1]})...`);
            await new Promise(r => setTimeout(r, wait));
        }
        console.log(`🚀 [BLOCO ${blockIdx + 1}/${blocks.length}] Iniciando ${blockAccounts.length} zap(s): ${blockAccounts.join(', ')}`);

        const zapPromises = blockAccounts.map(async (accountId) => {
            const zapIdx = activeAccountsList.indexOf(accountId);
            const queue  = zapQueues[zapIdx];
            let sent = 0, failed = 0, invalid = 0;
            for (let i = 0; i < queue.length; i++) {
                if (stopRequested) {
                    console.log(`🛑 [${accountId}] Parada solicitada. Interrompendo fila.`);
                    break;
                }
                const status = await dispatchOne(
                    queue[i], accountId, messageTemplate, mediaPath, mediaMode, cycleId, delayPerMsg
                );
                if (status === 'enviado') sent++;
                else if (status === 'invalido') invalid++;
                else failed++;
            }
            return { accountId, sent, failed, invalid };
        });

        return Promise.allSettled(zapPromises);
    })());

    const blockResults = await Promise.allSettled(blockPromises);

    let totalSent = 0, totalFailed = 0, totalInvalid = 0;
    blockResults.forEach(blockResult => {
        if (blockResult.status === 'fulfilled') {
            blockResult.value.forEach(zapResult => {
                if (zapResult.status === 'fulfilled') {
                    totalSent    += zapResult.value.sent;
                    totalFailed  += zapResult.value.failed;
                    totalInvalid += zapResult.value.invalid;
                }
            });
        }
    });

    // Atualiza estatísticas do ciclo (falhas incluem inválidos para contagem de progresso)
    await updateCycleStats(cycleId, totalSent, totalFailed + totalInvalid, 'em_andamento');
    
    console.log(`\n✅ [ORQUESTRADOR] Ciclo finalizado.`);
    console.log(`📊 Resumo: ✅ Enviados: ${totalSent} | ❌ Falhas: ${totalFailed} | 🚫 Inválidos: ${totalInvalid}`);

    // --- RELATÓRIOS AUTOMÁTICOS ---
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
    resetStop();
    let hasMore = true;
    while (hasMore && !stopRequested) {
        hasMore = await runCycle(
            activeAccountsList, messageTemplate, mediaPath, mediaMode,
            msgsPerCycle, cycleId, selectedTimes
        );

        if (stopRequested) {
            console.log('\n🛑 [ORQUESTRADOR] Campanha interrompida pelo usuário.');
            await updateCycleStats(cycleId, 0, 0, 'interrompido');
            break;
        }

        if (hasMore) {
            console.log(`\n⏳ [ORQUESTRADOR] Ciclo concluído. Aguardando próximo horário ou janela de 30 min...`);
            if (!selectedTimes || selectedTimes.length === 0) {
                await new Promise(resolve => setTimeout(resolve, CYCLE_DURATION_MS));
            } else {
                await new Promise(resolve => setTimeout(resolve, 60000));
            }
        }
    }
    resetStop();
};

export default { runCycle, runCampaignLoop };
