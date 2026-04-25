import amqplib from 'amqplib';
import * as evolution from '../evolution/client.js';
import { updateMessageStatus } from '../services/queueService.js';
import { processSpintax, humanDelay } from '../services/antiSpam.js';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://medusa:medusa@localhost:5672';

let workerConnection  = null;
const consumerTags    = {}; // accountId -> { ch, tag }
let stopSignal        = false;

export const requestWorkerStop = () => { stopSignal = true; };
export const resetWorkerStop   = () => { stopSignal = false; };
export const isWorkerStopped   = () => stopSignal;

/**
 * Detecta se o erro da Evolution API indica número inválido / sem WhatsApp.
 */
const isInvalidNumber = (err) => {
    const msg = (err.response?.data?.message || err.message || '').toLowerCase();
    return msg.includes('invalid') || msg.includes('not on whatsapp') ||
           msg.includes('não existe') || msg.includes('does not exist');
};

/**
 * Envia uma mensagem via Evolution API.
 * Retorna { status: 'enviado' | 'invalido' | 'falha', error? }
 */
const sendMessage = async (accountId, phone, config) => {
    const { messageTemplate, mediaUrl, mediaType, mediaMode } = config;
    const normalizedPhone = String(phone).replace(/\D/g, '');

    if (normalizedPhone.length < 10) {
        return { status: 'invalido', error: `Número inválido: ${phone}` };
    }

    const finalText = processSpintax(messageTemplate);

    try {
        if (!mediaUrl) {
            await evolution.sendText(accountId, normalizedPhone, finalText);
        } else if (mediaMode === 'caption') {
            await evolution.sendMedia(accountId, normalizedPhone, mediaUrl, mediaType, finalText);
        } else {
            if (finalText) await evolution.sendText(accountId, normalizedPhone, finalText);
            await humanDelay(2, 4);
            await evolution.sendMedia(accountId, normalizedPhone, mediaUrl, mediaType, '');
        }
        return { status: 'enviado' };
    } catch (err) {
        if (isInvalidNumber(err)) return { status: 'invalido', error: err.response?.data?.message || err.message };
        return { status: 'falha', error: err.response?.data?.message || err.message };
    }
};

/**
 * Inicia um worker consumidor por conta ativa.
 * campaignConfig: { cycleId, messageTemplate, mediaUrl, mediaType, mediaMode, minDelayS, maxDelayS }
 */
export const startWorkers = async (activeAccounts, campaignConfig) => {
    stopSignal = false;

    workerConnection = await amqplib.connect(RABBITMQ_URL);
    workerConnection.on('error', (e) => console.error('[WORKER] Conexão perdida:', e.message));

    for (const accountId of activeAccounts) {
        const ch = await workerConnection.createChannel();
        const queue = `medusa.${accountId}`;
        await ch.assertQueue(queue, { durable: true });
        ch.prefetch(1);

        const { consumerTag } = await ch.consume(queue, async (msg) => {
            if (!msg) return;

            if (stopSignal) {
                ch.nack(msg, false, true);
                return;
            }

            const task = JSON.parse(msg.content.toString());

            // Verifica se a instância está conectada antes de tentar enviar
            const state = await evolution.getConnectionState(accountId);
            if (state !== 'open') {
                console.log(`⚠️ [${accountId}] Instância offline. Falha: ${task.phone}`);
                await updateMessageStatus(task.messageId, 'falha', accountId, campaignConfig.cycleId, 'Instância offline');
                ch.ack(msg);
                return;
            }

            // Delay humano antes de cada envio (throttle de acordo com o ciclo)
            await humanDelay(campaignConfig.minDelayS, campaignConfig.maxDelayS);

            if (stopSignal) {
                ch.nack(msg, false, true);
                return;
            }

            console.log(`🚀 [${accountId}] Disparando para ${task.phone}...`);
            const result = await sendMessage(accountId, task.phone, campaignConfig);
            await updateMessageStatus(task.messageId, result.status, accountId, campaignConfig.cycleId, result.error || null);

            if (result.status === 'enviado')       console.log(`✅ [${accountId}] Enviado: ${task.phone}`);
            else if (result.status === 'invalido') console.log(`🚫 [${accountId}] Inválido: ${task.phone}`);
            else                                   console.log(`❌ [${accountId}] Falha (${task.phone}): ${result.error}`);

            ch.ack(msg);
        });

        consumerTags[accountId] = { ch, tag: consumerTag };
        console.log(`🔊 [WORKER] Consumidor ativo: ${accountId}`);
    }
};

/**
 * Para todos os workers (cancela consumers e fecha canais).
 */
export const stopWorkers = async () => {
    stopSignal = true;
    for (const [, { ch, tag }] of Object.entries(consumerTags)) {
        try { await ch.cancel(tag); } catch (_) {}
        try { await ch.close();    } catch (_) {}
    }
    Object.keys(consumerTags).forEach(k => delete consumerTags[k]);
    if (workerConnection) {
        try { await workerConnection.close(); } catch (_) {}
        workerConnection = null;
    }
};

export default { startWorkers, stopWorkers, requestWorkerStop, resetWorkerStop };
