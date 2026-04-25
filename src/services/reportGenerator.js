import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../database/postgres.js';

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = path.dirname(__filename);
const REPORTS_DIR  = path.resolve(__dirname, '../../reports');

const ensureReportsDir = () => fs.mkdirSync(REPORTS_DIR, { recursive: true });

/**
 * Gera os 3 arquivos de relatório plano da campanha.
 * Sobrescreve os arquivos anteriores a cada execução.
 *
 * reports/enviados.txt   — um número por linha
 * reports/invalidos.txt  — um número por linha
 * reports/falhas.txt     — "55119...  |  WA-03  |  motivo"
 */
export const generateCampaignReport = async (cycleId) => {
    ensureReportsDir();

    const { rows } = await query(
        `SELECT phone_number, status, whatsapp_id, error_message
         FROM messages_queue WHERE cycle_id = $1 ORDER BY id ASC`,
        [cycleId]
    );

    const enviados  = rows.filter(r => r.status === 'enviado').map(r => r.phone_number);
    const invalidos = rows.filter(r => r.status === 'invalido').map(r => r.phone_number);
    const falhas    = rows.filter(r => r.status === 'falha');

    const write = (filename, content) =>
        fs.writeFileSync(path.join(REPORTS_DIR, filename), content, 'utf8');

    write('enviados.txt',  enviados.join('\n'));
    write('invalidos.txt', invalidos.join('\n'));
    write('falhas.txt',    falhas.map(r => {
        const phone  = (r.phone_number || '').padEnd(15);
        const zap    = (r.whatsapp_id  || '-').padEnd(6);
        const reason = r.error_message || 'desconhecido';
        return `${phone}  |  ${zap}  |  ${reason}`;
    }).join('\n'));

    console.log(`📊 [RELATÓRIO] enviados=${enviados.length} | inválidos=${invalidos.length} | falhas=${falhas.length}`);
    return REPORTS_DIR;
};

/** Retrocompatibilidade — alias para generateCampaignReport */
export const generateCycleReport  = generateCampaignReport;
export const generateFailureList  = async (cycleId) => {
    await generateCampaignReport(cycleId);
    return path.join(REPORTS_DIR, 'falhas.txt');
};

export default { generateCampaignReport, generateCycleReport, generateFailureList };
