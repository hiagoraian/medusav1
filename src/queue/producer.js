import amqplib from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://medusa:medusa@localhost:5672';

// Cacheamos a Promise, não o valor resolvido.
// Isso elimina a race condition: chamadas concorrentes recebem a mesma Promise
// em vez de criarem conexões duplicadas.
let _channelPromise = null;

const getChannel = () => {
    if (_channelPromise) return _channelPromise;

    _channelPromise = (async () => {
        const conn = await amqplib.connect(RABBITMQ_URL);
        const ch   = await conn.createChannel();

        // Qualquer erro na connection OU no channel invalida o cache,
        // forçando reconexão na próxima chamada.
        const reset = () => { _channelPromise = null; };
        conn.on('error', reset);
        conn.on('close', reset);
        ch.on('error',   reset);
        ch.on('close',   reset);

        return ch;
    })();

    return _channelPromise;
};

const queueName  = (accountId) => `medusa.${accountId}`;

const assertQueue = async (ch, accountId) =>
    ch.assertQueue(queueName(accountId), { durable: true });

/**
 * Publica um lote de tarefas no RabbitMQ, distribuindo round-robin entre as contas ativas.
 */
export const publishBulk = async (pendingRows, activeAccounts) => {
    const ch = await getChannel();

    for (const accountId of activeAccounts) {
        await assertQueue(ch, accountId);
    }

    let zapIdx = 0;
    for (const row of pendingRows) {
        const accountId = activeAccounts[zapIdx % activeAccounts.length];
        const task = { messageId: row.id, phone: row.phone_number, accountId };
        ch.sendToQueue(queueName(accountId), Buffer.from(JSON.stringify(task)), { persistent: true });
        zapIdx++;
    }

    console.log(`[PRODUCER] ${pendingRows.length} mensagens publicadas para ${activeAccounts.length} zap(s).`);
};

/**
 * Esvazia as filas dos accounts informados (parada/suspensão de campanha).
 */
export const purgeQueues = async (activeAccounts) => {
    try {
        const ch = await getChannel();
        for (const accountId of activeAccounts) {
            await assertQueue(ch, accountId);
            await ch.purgeQueue(queueName(accountId));
        }
    } catch (_) {}
};

export default { publishBulk, purgeQueues };
