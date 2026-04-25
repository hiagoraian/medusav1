import amqplib from 'amqplib';
import * as evolution from '../evolution/client.js';
import { updateMessageStatus } from '../services/queueService.js';
import { processSpintax, humanDelay } from '../services/antiSpam.js';

const RABBITMQ_URL      = process.env.RABBITMQ_URL || 'amqp://medusa:medusa@localhost:5672';
const ORPHAN_THRESHOLD  = 3; // falhas offline consecutivas antes de drenar

let workerConnection = null;
const consumerTags   = {}; // accountId → { ch, tag }
let stopSignal       = false;

export const requestWorkerStop = () => { stopSignal = true; };
export const resetWorkerStop   = () => { stopSignal = false; };
export const isWorkerStopped   = () => stopSignal;

// ── Detecção de erros ─────────────────────────────────────────────────────────

const isInvalidNumber = (err) => {
    const msg = (err.response?.data?.message || err.message || '').toLowerCase();
    return msg.includes('invalid') || msg.includes('not on whatsapp') ||
           msg.includes('não existe') || msg.includes('does not exist');
};

// ── Envio de mensagem ─────────────────────────────────────────────────────────

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

// ── Drenagem de órfão ─────────────────────────────────────────────────────────

/**
 * Após cancelar o consumer, drena a fila com Basic.Get (pull) e marca tudo como 'falha'.
 * Só deve ser chamado depois que o consumer já foi cancelado.
 */
const drainOrphanQueue = async (ch, queue, cycleId, accountId, reason) => {
    let drained = 0;
    try {
        let msg;
        while ((msg = await ch.get(queue, { noAck: false })) !== false) {
            if (!msg) break;
            try {
                const task = JSON.parse(msg.content.toString());
                await updateMessageStatus(task.messageId, 'falha', accountId, cycleId, reason);
                ch.ack(msg);
                drained++;
            } catch (_) {
                ch.nack(msg, false, false); // descarta se não conseguir parsear
            }
        }
    } catch (_) {}
    console.log(`🔴 [${accountId}] Órfão drenado — ${drained} mensagem(ns) marcada(s) como falha.`);
};

// ── Worker por conta ──────────────────────────────────────────────────────────

/**
 * campaignConfig:
 *   cycleId, messageTemplate, mediaUrl, mediaType, mediaMode,
 *   minDelayS, maxDelayS,
 *   subGroupOffsets: { [accountId]: milliseconds } — atraso antes da 1ª mensagem
 */
export const startWorkers = async (activeAccounts, campaignConfig) => {
    stopSignal = false;

    workerConnection = await amqplib.connect(RABBITMQ_URL);
    workerConnection.on('error', (e) => console.error('[WORKER] Conexão perdida:', e.message));

    for (const accountId of activeAccounts) {
        const ch    = await workerConnection.createChannel();
        const queue = `medusa.${accountId}`;
        await ch.assertQueue(queue, { durable: true });
        ch.prefetch(1);

        const offsetMs      = campaignConfig.subGroupOffsets?.[accountId] ?? 0;
        let isFirstMessage  = true;
        let offlineStreak   = 0;
        let orphaned        = false;

        // Ref para o tag — preenchida após ch.consume() retornar
        const consumerRef = { tag: null };

        const { consumerTag } = await ch.consume(queue, async (msg) => {
            if (!msg) return;

            // Zap já foi marcado como órfão — nunca deveria receber mais msgs,
            // mas por segurança devolve à fila
            if (orphaned) {
                ch.nack(msg, false, true);
                return;
            }

            if (stopSignal) {
                ch.nack(msg, false, true);
                return;
            }

            // ── Offset de onda: dorme antes da 1ª mensagem ───────────────────
            if (isFirstMessage) {
                isFirstMessage = false;
                if (offsetMs > 0) {
                    console.log(`⏱  [${accountId}] Offset de onda: aguardando ${Math.round(offsetMs / 1000)}s`);
                    await new Promise(r => setTimeout(r, offsetMs));
                }
            }

            if (stopSignal) {
                ch.nack(msg, false, true);
                return;
            }

            const task = JSON.parse(msg.content.toString());

            // ── Verificação de conectividade ──────────────────────────────────
            const state = await evolution.getConnectionState(accountId);
            if (state !== 'open') {
                offlineStreak++;
                console.warn(`⚠️  [${accountId}] Offline (${offlineStreak}/${ORPHAN_THRESHOLD}). Falha: ${task.phone}`);
                await updateMessageStatus(task.messageId, 'falha', accountId, campaignConfig.cycleId, 'Instância offline');
                ch.ack(msg);

                if (offlineStreak >= ORPHAN_THRESHOLD) {
                    orphaned = true;
                    console.error(`🔴 [${accountId}] Declarado órfão. Drenando fila restante...`);
                    // Cancela o consumer e drena assincronamente (fora do handler)
                    setImmediate(async () => {
                        try { await ch.cancel(consumerRef.tag); } catch (_) {}
                        await drainOrphanQueue(ch, queue, campaignConfig.cycleId, accountId, 'Instância offline — órfão');
                        try { await ch.close(); } catch (_) {}
                        delete consumerTags[accountId];
                    });
                }
                return;
            }

            // Instância voltou online — zera o streak
            offlineStreak = 0;

            // ── Delay humano antes do envio ───────────────────────────────────
            await humanDelay(campaignConfig.minDelayS, campaignConfig.maxDelayS);

            if (stopSignal) {
                ch.nack(msg, false, true);
                return;
            }

            console.log(`🚀 [${accountId}] Disparando para ${task.phone}...`);
            const result = await sendMessage(accountId, task.phone, campaignConfig);
            await updateMessageStatus(task.messageId, result.status, accountId, campaignConfig.cycleId, result.error || null);

            if      (result.status === 'enviado')  console.log(`✅ [${accountId}] Enviado: ${task.phone}`);
            else if (result.status === 'invalido') console.log(`🚫 [${accountId}] Inválido: ${task.phone}`);
            else                                   console.log(`❌ [${accountId}] Falha (${task.phone}): ${result.error}`);

            ch.ack(msg);
        });

        consumerRef.tag          = consumerTag;
        consumerTags[accountId]  = { ch, tag: consumerTag };
        console.log(`🔊 [WORKER] Consumidor ativo: ${accountId}${offsetMs ? ` (offset ${Math.round(offsetMs / 1000)}s)` : ''}`);
    }
};

// ── Parada global ─────────────────────────────────────────────────────────────

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
