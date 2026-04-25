import amqplib from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://medusa:medusa@localhost:5672';

let _connection = null;
let _channel    = null;

const getChannel = async () => {
    if (_channel) return _channel;
    _connection = await amqplib.connect(RABBITMQ_URL);
    _channel    = await _connection.createChannel();
    _connection.on('error', () => { _channel = null; _connection = null; });
    _connection.on('close', () => { _channel = null; _connection = null; });
    return _channel;
};

const queueName = (accountId) => `medusa.${accountId}`;

const assertQueue = async (ch, accountId) => {
    await ch.assertQueue(queueName(accountId), { durable: true });
};

/**
 * Publica um lote de tarefas no RabbitMQ, distribuindo round-robin entre as contas ativas.
 * Cada mensagem contém só o id e o telefone — o worker recebe o resto via campaignConfig.
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
 * Esvazia todas as filas dos accounts informados (usado no stop/suspend de campanha).
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
