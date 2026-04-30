import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://medusa:medusa@localhost:5432/medusa',
    max: 25,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 8000,
});

pool.on('error', (err) => {
    console.error('[PG] Erro no pool de conexões:', err.message);
});

export const query = (text, params) => pool.query(text, params);

export const initSchema = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages_queue (
            id            SERIAL PRIMARY KEY,
            phone_number  VARCHAR(50) NOT NULL,
            status        VARCHAR(50) DEFAULT 'pendente',
            whatsapp_id   VARCHAR(50),
            cycle_id      INT,
            error_message TEXT,
            sent_at       TIMESTAMPTZ,
            created_at    TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS dispatch_cycles (
            id             SERIAL PRIMARY KEY,
            total_messages INT DEFAULT 0,
            sent_count     INT DEFAULT 0,
            fail_count     INT DEFAULT 0,
            status         VARCHAR(50) DEFAULT 'em_andamento',
            start_time     TIMESTAMPTZ DEFAULT NOW(),
            end_time       TIMESTAMPTZ
        );

        CREATE INDEX IF NOT EXISTS idx_mq_status  ON messages_queue(status);
        CREATE INDEX IF NOT EXISTS idx_mq_cycle   ON messages_queue(cycle_id);
        CREATE INDEX IF NOT EXISTS idx_mq_phone   ON messages_queue(phone_number);
    `);
    console.log('✅ [PG] Schema sincronizado.');
};

export default pool;
