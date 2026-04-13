import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, '../../orquestrador.sqlite');

// REMOVIDO: A exclusão do banco de dados antigo para garantir persistência e resiliência.
// Se o banco não existir, o SQLite o criará automaticamente.

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ [DB] Erro ao conectar ao SQLite:', err.message);
    } else {
        console.log('✅ [DB] Conectado ao banco de dados SQLite com sucesso.');
    }
});

db.serialize(() => {
    // Tabela para gerenciar a fila de disparos
    db.run(`
        CREATE TABLE IF NOT EXISTS messages_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone_number TEXT NOT NULL,
            message_text TEXT,
            media_path TEXT,
            status TEXT DEFAULT 'pendente',
            whatsapp_id TEXT,
            cycle_id INTEGER,
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sent_at DATETIME
        )
    `);

    // Tabela para registrar os ciclos de disparo
    db.run(`
        CREATE TABLE IF NOT EXISTS dispatch_cycles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            end_time DATETIME,
            total_messages INTEGER,
            sent_count INTEGER DEFAULT 0,
            fail_count INTEGER DEFAULT 0,
            status TEXT DEFAULT 'em_andamento'
        )
    `);

    // Tabela para persistir configurações e estado global (Novo na v4.0)
    db.run(`
        CREATE TABLE IF NOT EXISTS system_state (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log('✅ [DB] Tabelas sincronizadas e persistentes no SQLite.');
});

export default db;
