import { query } from '../database/postgres.js';

export const addContactsToQueue = async (numbers) => {
    if (numbers.length === 0) return 0;
    const values = numbers.map((_, i) => `($${i + 1}, 'pendente')`).join(', ');
    await query(`INSERT INTO messages_queue (phone_number, status) VALUES ${values}`, numbers);
    return numbers.length;
};

export const clearQueue = async () => {
    await query(`DELETE FROM messages_queue WHERE status = 'pendente'`);
};

export const getPendingMessages = async (limit) => {
    const { rows } = await query(
        `SELECT id, phone_number FROM messages_queue WHERE status = 'pendente' ORDER BY id ASC LIMIT $1`,
        [limit]
    );
    return rows;
};

export const updateMessageStatus = async (id, status, whatsappId, cycleId = null, errorMessage = null) => {
    await query(
        `UPDATE messages_queue
         SET status = $1, whatsapp_id = $2, cycle_id = $3, error_message = $4,
             sent_at = CASE WHEN $1 = 'enviado' THEN NOW() ELSE NULL END
         WHERE id = $5`,
        [status, whatsappId, cycleId, errorMessage, id]
    );
};

export const countPending = async () => {
    const { rows } = await query(`SELECT COUNT(*) AS total FROM messages_queue WHERE status = 'pendente'`);
    return parseInt(rows[0].total, 10);
};

export const countPendingInCycle = async (cycleId) => {
    const { rows } = await query(
        `SELECT COUNT(*) AS total FROM messages_queue WHERE cycle_id = $1 AND status = 'pendente'`,
        [cycleId]
    );
    return parseInt(rows[0].total, 10);
};

export const createCycle = async (totalMessages) => {
    const { rows } = await query(
        `INSERT INTO dispatch_cycles (total_messages) VALUES ($1) RETURNING id`,
        [totalMessages]
    );
    return rows[0].id;
};

export const updateCycleStats = async (cycleId, sentCount, failCount, status = 'em_andamento') => {
    await query(
        `UPDATE dispatch_cycles
         SET sent_count = sent_count + $1, fail_count = fail_count + $2,
             status = $3,
             end_time = CASE WHEN $3 IN ('concluido', 'interrompido') THEN NOW() ELSE NULL END
         WHERE id = $4`,
        [sentCount, failCount, status, cycleId]
    );
};

export const getDashboardStats = async () => {
    const { rows: pendingRows } = await query(
        `SELECT COUNT(*) AS total FROM messages_queue WHERE status = 'pendente'`
    );

    // Retorna o ciclo mais recente independente do status (inclui 'concluido')
    const { rows: cycleRows } = await query(
        `SELECT id, status, total_messages FROM dispatch_cycles ORDER BY id DESC LIMIT 1`
    );
    const cycle = cycleRows[0] || null;

    let totalSent = 0, totalFailed = 0, totalInvalid = 0;
    if (cycle) {
        const { rows: statsRows } = await query(
            `SELECT status, COUNT(*) AS cnt FROM messages_queue WHERE cycle_id = $1 GROUP BY status`,
            [cycle.id]
        );
        for (const row of statsRows) {
            const n = parseInt(row.cnt, 10);
            if (row.status === 'enviado')  totalSent    = n;
            if (row.status === 'falha')    totalFailed  = n;
            if (row.status === 'invalido') totalInvalid = n;
        }
    }

    return {
        totalPending: parseInt(pendingRows[0].total, 10),
        totalSent,
        totalFailed,
        totalInvalid,
        lastCycle: cycle ? { ...cycle, sent_count: totalSent, fail_count: totalFailed } : null,
    };
};

export const getInterruptedCycle = async () => {
    const { rows } = await query(
        `SELECT id, total_messages, sent_count, fail_count FROM dispatch_cycles
         WHERE status = 'em_andamento' ORDER BY id DESC LIMIT 1`
    );
    return rows[0] || null;
};

/**
 * Pré-atribui um cycleId a um lote de mensagens antes de publicar no RabbitMQ.
 * Necessário para que countPendingInCycle funcione corretamente durante a onda.
 */
export const assignMessagesToCycle = async (messageIds, cycleId) => {
    if (messageIds.length === 0) return;
    const placeholders = messageIds.map((_, i) => `$${i + 2}`).join(', ');
    await query(
        `UPDATE messages_queue SET cycle_id = $1 WHERE id IN (${placeholders})`,
        [cycleId, ...messageIds]
    );
};

export const resetCampaign = async (cycleId) => {
    if (cycleId) {
        await query(
            `UPDATE dispatch_cycles SET status = 'interrompido', end_time = NOW() WHERE id = $1`,
            [cycleId]
        );
    }
    await query(`DELETE FROM messages_queue WHERE status = 'pendente'`);
};

export default {
    addContactsToQueue, clearQueue, getPendingMessages, updateMessageStatus,
    countPending, countPendingInCycle, assignMessagesToCycle,
    createCycle, updateCycleStats, getDashboardStats, getInterruptedCycle, resetCampaign,
};
