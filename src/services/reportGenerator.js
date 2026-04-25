import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../database/postgres.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const getCycleReportDir = (cycleId) => {
    const dir = path.resolve(__dirname, '../../reports', `ciclo_${cycleId}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

export const generateCycleReport = async (cycleId) => {
    const { rows: cycleRows } = await query(`SELECT * FROM dispatch_cycles WHERE id = $1`, [cycleId]);
    const cycle = cycleRows[0];
    if (!cycle) throw new Error('Ciclo não encontrado.');

    const { rows: messages } = await query(`SELECT * FROM messages_queue WHERE cycle_id = $1`, [cycleId]);

    const reportDir = getCycleReportDir(cycleId);
    const filePath  = path.join(reportDir, 'relatorio.md');

    const successRate = cycle.total_messages > 0
        ? ((cycle.sent_count / cycle.total_messages) * 100).toFixed(2)
        : 0;

    let content = `# 📊 Relatório de Disparos - Ciclo #${cycleId}\n\n`;
    content += `**Início:** ${cycle.start_time}\n`;
    content += `**Fim:** ${cycle.end_time || 'Em andamento'}\n`;
    content += `**Status:** ${cycle.status.toUpperCase()}\n\n`;
    content += `## 📈 Resumo\n\n`;
    content += `| Total | Enviados | Falhas | Taxa de Sucesso |\n`;
    content += `| :--- | :--- | :--- | :--- |\n`;
    content += `| ${cycle.total_messages} | ${cycle.sent_count} | ${cycle.fail_count} | ${successRate}% |\n\n`;
    content += `## 📱 Detalhamento\n\n`;
    content += `| Número | Status | Zap | Erro |\n`;
    content += `| :--- | :--- | :--- | :--- |\n`;

    messages.forEach(msg => {
        const icon = msg.status === 'enviado' ? '✅' : '❌';
        content += `| ${msg.phone_number} | ${icon} ${msg.status} | ${msg.whatsapp_id || '-'} | ${msg.error_message || '-'} |\n`;
    });

    fs.writeFileSync(filePath, content);
    return filePath;
};

export const generateFailureList = async (cycleId) => {
    const { rows } = await query(
        `SELECT phone_number FROM messages_queue WHERE cycle_id = $1 AND status != 'enviado'`,
        [cycleId]
    );

    const reportDir = getCycleReportDir(cycleId);
    const filePath  = path.join(reportDir, 'falhas.txt');
    fs.writeFileSync(filePath, rows.map(r => r.phone_number).join('\n'));
    return filePath;
};

export default { generateCycleReport, generateFailureList };
