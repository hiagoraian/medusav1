import XLSX from 'xlsx';
import { query, initSchema } from '../src/database/postgres.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await initSchema();

const colWidths = [{ wch: 18 }, { wch: 35 }, { wch: 8 }, { wch: 8 }, { wch: 16 }];

const { rows: falhas } = await query(`
    SELECT
        phone_number                                                                    AS "Número",
        error_message                                                                   AS "Motivo da Falha",
        whatsapp_id                                                                     AS "Zap",
        cycle_id                                                                        AS "Ciclo",
        TO_CHAR(created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')    AS "Data"
    FROM messages_queue
    WHERE status = 'falha'
    ORDER BY cycle_id, id
`);

const { rows: pendentes } = await query(`
    SELECT
        phone_number                                                                    AS "Número",
        TO_CHAR(created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')    AS "Data"
    FROM messages_queue
    WHERE status = 'pendente'
    ORDER BY id
`);

const wb = XLSX.utils.book_new();

const wsFalhas = XLSX.utils.json_to_sheet(falhas);
wsFalhas['!cols'] = colWidths;
XLSX.utils.book_append_sheet(wb, wsFalhas, 'Falhas');

const wsPendentes = XLSX.utils.json_to_sheet(pendentes);
wsPendentes['!cols'] = [{ wch: 18 }, { wch: 16 }];
XLSX.utils.book_append_sheet(wb, wsPendentes, 'Pendentes');

const outPath = path.join(__dirname, '..', 'enviar.xlsx');
XLSX.writeFile(wb, outPath);

console.log(`✅ Excel gerado: ${outPath}`);
console.log(`   Falhas: ${falhas.length} | Pendentes: ${pendentes.length}`);

process.exit(0);
