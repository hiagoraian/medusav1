import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../database/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Gera um relatório detalhado de um ciclo específico
 * @param {number} cycleId - ID do ciclo
 * @returns {Promise<string>} Caminho do arquivo gerado
 */
export const generateCycleReport = async (cycleId) => {
    return new Promise((resolve, reject) => {
        // Busca informações do ciclo
        db.get(`SELECT * FROM dispatch_cycles WHERE id = ?`, [cycleId], (err, cycle) => {
            if (err || !cycle) return reject(new Error('Ciclo não encontrado.'));

            // Busca todas as mensagens do ciclo
            db.all(`SELECT * FROM messages_queue WHERE cycle_id = ?`, [cycleId], (err, messages) => {
                if (err) return reject(err);

                const reportDir = path.resolve(__dirname, '../../reports');
                if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);

                const fileName = `relatorio_ciclo_${cycleId}_${Date.now()}.md`;
                const filePath = path.join(reportDir, fileName);

                let content = `# 📊 Relatório de Disparos - Ciclo #${cycleId}\n\n`;
                content += `**Início:** ${cycle.start_time}\n`;
                content += `**Fim:** ${cycle.end_time || 'Em andamento'}\n`;
                content += `**Status:** ${cycle.status.toUpperCase()}\n\n`;

                content += `## 📈 Resumo Estatístico\n\n`;
                content += `| Total de Mensagens | Enviadas com Sucesso | Falhas | Taxa de Sucesso |\n`;
                content += `| :--- | :--- | :--- | :--- |\n`;
                const successRate = cycle.total_messages > 0 ? ((cycle.sent_count / cycle.total_messages) * 100).toFixed(2) : 0;
                content += `| ${cycle.total_messages} | ${cycle.sent_count} | ${cycle.fail_count} | ${successRate}% |\n\n`;

                content += `## 📱 Detalhamento por Disparo\n\n`;
                content += `| Número | Status | Zap Utilizado | Erro (se houver) |\n`;
                content += `| :--- | :--- | :--- | :--- |\n`;

                messages.forEach(msg => {
                    const statusIcon = msg.status === 'enviado' ? '✅' : '❌';
                    content += `| ${msg.phone_number} | ${statusIcon} ${msg.status} | ${msg.whatsapp_id || '-'} | ${msg.error_message || '-'} |\n`;
                });

                fs.writeFileSync(filePath, content);
                resolve(filePath);
            });
        });
    });
};

/**
 * Gera uma lista de números que falharam no ciclo para re-envio
 * @param {number} cycleId - ID do ciclo
 * @returns {Promise<string>} Caminho do arquivo .txt
 */
export const generateFailureList = async (cycleId) => {
    return new Promise((resolve, reject) => {
        db.all(`SELECT phone_number FROM messages_queue WHERE cycle_id = ? AND status != 'enviado'`, [cycleId], (err, rows) => {
            if (err) return reject(err);

            const reportDir = path.resolve(__dirname, '../../reports');
            if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);

            const fileName = `falhas_ciclo_${cycleId}_${Date.now()}.txt`;
            const filePath = path.join(reportDir, fileName);

            const content = rows.map(r => r.phone_number).join('\n');
            fs.writeFileSync(filePath, content);
            resolve(filePath);
        });
    });
};

export default {
    generateCycleReport,
    generateFailureList
};
