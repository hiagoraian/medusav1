import db from '../database/db.js';

/**
 * Insere uma lista de números na fila do banco de dados de forma massiva.
 */
export const addContactsToQueue = (numbers) => {
    return new Promise((resolve, reject) => {
        // stmt criado e finalizado DENTRO do serialize para evitar race condition
        // com o COMMIT. O bug anterior (stmt.finalize fora do serialize) podia
        // chamar finalize antes do COMMIT completar, corrompendo a transação.
        db.serialize(() => {
            const stmt = db.prepare(`INSERT INTO messages_queue (phone_number, status) VALUES (?, 'pendente')`);
            db.run('BEGIN TRANSACTION');
            numbers.forEach(phone => stmt.run(phone));
            db.run('COMMIT', (err) => {
                stmt.finalize();
                if (err) reject(err);
                else resolve(numbers.length);
            });
        });
    });
};

/**
 * Remove todas as mensagens pendentes da fila.
 */
export const clearQueue = () => {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM messages_queue WHERE status = 'pendente'`, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
};

/**
 * Puxa a próxima "Onda" de mensagens pendentes.
 */
export const getPendingMessages = (limit) => {
    return new Promise((resolve, reject) => {
        db.all(`SELECT id, phone_number FROM messages_queue WHERE status = 'pendente' ORDER BY id ASC LIMIT ?`, [limit], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

/**
 * Atualiza o status de um disparo.
 */
export const updateMessageStatus = (id, status, whatsappId, cycleId = null, errorMessage = null) => {
    return new Promise((resolve, reject) => {
        const sentAt = status === 'enviado' ? 'CURRENT_TIMESTAMP' : 'NULL';
        db.run(
            `UPDATE messages_queue SET status = ?, whatsapp_id = ?, cycle_id = ?, error_message = ?, sent_at = ${sentAt} WHERE id = ?`,
            [status, whatsappId, cycleId, errorMessage, id],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
};

/**
 * Conta quantas mensagens ainda estão pendentes.
 */
export const countPending = () => {
    return new Promise((resolve, reject) => {
        db.get(`SELECT COUNT(*) as total FROM messages_queue WHERE status = 'pendente'`, (err, row) => {
            if (err) reject(err);
            else resolve(row.total);
        });
    });
};

/**
 * Cria um novo ciclo de disparo.
 */
export const createCycle = (totalMessages) => {
    return new Promise((resolve, reject) => {
        db.run(`INSERT INTO dispatch_cycles (total_messages) VALUES (?)`, [totalMessages], function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
    });
};

/**
 * Atualiza as estatísticas do ciclo.
 */
export const updateCycleStats = (cycleId, sentCount, failCount, status = 'em_andamento') => {
    return new Promise((resolve, reject) => {
        const endTime = status === 'concluido' || status === 'interrompido' ? 'CURRENT_TIMESTAMP' : 'NULL';
        db.run(
            `UPDATE dispatch_cycles SET sent_count = sent_count + ?, fail_count = fail_count + ?, status = ?, end_time = ${endTime} WHERE id = ?`,
            [sentCount, failCount, status, cycleId],
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
    });
};

/**
 * Obtém estatísticas do Dashboard filtradas pelo ciclo ativo.
 * Retorna zeros quando não há campanha em andamento.
 */
export const getDashboardStats = () => {
    return new Promise((resolve) => {
        const stats = { totalSent: 0, totalFailed: 0, totalPending: 0, lastCycle: null };

        db.get(`SELECT COUNT(*) as total FROM messages_queue WHERE status = 'pendente'`, (_err, row) => {
            stats.totalPending = row?.total || 0;

            db.get(
                `SELECT id, status, sent_count, fail_count, total_messages FROM dispatch_cycles WHERE status = 'em_andamento' ORDER BY id DESC LIMIT 1`,
                (_e, cycle) => {
                    if (cycle) {
                        stats.lastCycle   = cycle;
                        stats.totalSent   = cycle.sent_count;
                        stats.totalFailed = cycle.fail_count;
                    }
                    resolve(stats);
                }
            );
        });
    });
};

/**
 * Suspende a campanha interrompida: marca o ciclo como 'interrompido' e limpa a fila de pendentes.
 */
export const resetCampaign = (cycleId) => {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            if (cycleId) {
                db.run(
                    `UPDATE dispatch_cycles SET status = 'interrompido', end_time = CURRENT_TIMESTAMP WHERE id = ?`,
                    [cycleId]
                );
            }
            db.run(`DELETE FROM messages_queue WHERE status = 'pendente'`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });
};

export default {
    addContactsToQueue,
    clearQueue,
    getPendingMessages,
    updateMessageStatus,
    countPending,
    createCycle,
    updateCycleStats,
    getDashboardStats,
    resetCampaign
};
