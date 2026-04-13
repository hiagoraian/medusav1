import xlsx from 'xlsx';

/**
 * Processa arquivos Excel e extrai números de telefone.
 * Melhorada a validação para reduzir números inválidos.
 */
export const processExcelFiles = (files) => {
    let allNumbers = [];
    let totalRecebidos = 0;

    files.forEach(file => {
        const workbook = xlsx.read(file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        // Converte para JSON (array de arrays)
        const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
        
        rows.forEach(row => {
            if (row && row[0]) {
                totalRecebidos++;
                let phone = row[0].toString().replace(/\D/g, ''); // Remove tudo que não é dígito
                
                // --- NOVA LÓGICA DE VALIDAÇÃO ---
                
                // 1. Se o número começar com 0, remove o 0
                if (phone.startsWith('0')) phone = phone.substring(1);
                
                // 2. Se o número não tiver o código do país (55), adiciona
                if (phone.length >= 10 && !phone.startsWith('55')) {
                    phone = '55' + phone;
                }
                
                // 3. Validação de tamanho (Brasil: 55 + DDD + 8 ou 9 dígitos)
                // Mínimo: 55 + DDD(2) + 8 dígitos = 12
                // Máximo: 55 + DDD(2) + 9 dígitos = 13
                if (phone.length >= 12 && phone.length <= 13 && phone.startsWith('55')) {
                    allNumbers.push(phone);
                }
            }
        });
    });

    // Remove duplicatas
    const uniqueNumbers = [...new Set(allNumbers)];

    return {
        totalRecebidos,
        totalUnicos: uniqueNumbers.length,
        numeros: uniqueNumbers
    };
};

export default { processExcelFiles };
