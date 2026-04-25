import xlsx from 'xlsx';

// DDDs válidos no Brasil
const VALID_DDDS = new Set([
    11,12,13,14,15,16,17,18,19,
    21,22,24,27,28,
    31,32,33,34,35,37,38,
    41,42,43,44,45,46,47,48,49,
    51,53,54,55,
    61,62,63,64,65,66,67,68,69,
    71,73,74,75,77,79,
    81,82,83,84,85,86,87,88,89,
    91,92,93,94,95,96,97,98,99,
]);

/**
 * Valida e normaliza um número de telefone brasileiro.
 * Retorna o número normalizado (13 dígitos com 55) ou null se inválido.
 *
 * Camadas:
 *   1. Remove tudo que não é dígito
 *   2. Remove 0 inicial (ex: 011 → 11)
 *   3. Adiciona 55 se ausente e o tamanho for compatível
 *   4. Verifica comprimento (12 ou 13 dígitos com código de país)
 *   5. Valida DDD e 9º dígito para celulares
 */
const normalizePhone = (raw) => {
    // Camada 1 — só dígitos
    let phone = String(raw).replace(/\D/g, '');
    if (!phone) return null;

    // Camada 2 — remove 0 inicial
    if (phone.startsWith('0')) phone = phone.slice(1);

    // Camada 3 — adiciona código do país
    if (!phone.startsWith('55') && phone.length >= 10) phone = '55' + phone;

    // Camada 4 — comprimento: 55 + DDD(2) + 8-9 dígitos = 12 ou 13
    if (!phone.startsWith('55') || phone.length < 12 || phone.length > 13) return null;

    // Camada 5 — DDD e 9º dígito de celular
    const ddd      = parseInt(phone.slice(2, 4), 10);
    const localPart = phone.slice(4); // 8 ou 9 dígitos

    if (!VALID_DDDS.has(ddd)) return null;

    // Celulares com 9 dígitos: primeiro dígito deve ser 9
    if (localPart.length === 9 && localPart[0] !== '9') return null;

    return phone;
};

/**
 * Processa arquivos Excel e extrai números de telefone únicos e válidos.
 */
export const processExcelFiles = (files) => {
    const seen         = new Set();
    const numeros      = [];
    let totalRecebidos = 0;

    files.forEach(file => {
        const workbook  = xlsx.read(file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rows      = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });

        rows.forEach(row => {
            if (!row || !row[0]) return;
            totalRecebidos++;
            const normalized = normalizePhone(row[0]);
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                numeros.push(normalized);
            }
        });
    });

    return { totalRecebidos, totalUnicos: numeros.length, numeros };
};

export default { processExcelFiles };
