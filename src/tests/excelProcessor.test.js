import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import xlsx from 'xlsx';
import { processExcelFiles } from '../services/excelProcessor.js';

/** Cria um buffer de Excel em memória com os valores fornecidos na coluna A */
const makeExcelBuffer = (values) => {
    const ws = xlsx.utils.aoa_to_sheet(values.map(v => [v]));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

describe('processExcelFiles', () => {
    it('extrai e normaliza número brasileiro sem DDI', () => {
        const buf = makeExcelBuffer(['11999999999']);
        const result = processExcelFiles([{ buffer: buf }]);
        assert.equal(result.totalUnicos, 1);
        assert.equal(result.numeros[0], '5511999999999');
    });

    it('aceita número já com DDI 55', () => {
        const buf = makeExcelBuffer(['5511999999999']);
        const result = processExcelFiles([{ buffer: buf }]);
        assert.equal(result.numeros[0], '5511999999999');
    });

    it('remove duplicatas entre linhas', () => {
        const buf = makeExcelBuffer(['5511999999999', '5511999999999', '5521988888888']);
        const result = processExcelFiles([{ buffer: buf }]);
        assert.equal(result.totalUnicos, 2);
    });

    it('descarta números com tamanho inválido', () => {
        const buf = makeExcelBuffer(['123', '55119', '99999999999999']); // curto, curto, longo
        const result = processExcelFiles([{ buffer: buf }]);
        assert.equal(result.totalUnicos, 0);
    });

    it('remove número começando com 0', () => {
        const buf = makeExcelBuffer(['011999999999']);
        const result = processExcelFiles([{ buffer: buf }]);
        // Após remover o 0 → 11999999999 (11 dígitos) → adiciona 55 → 5511999999999
        assert.equal(result.numeros[0], '5511999999999');
    });

    it('processa múltiplos arquivos e deduplica entre eles', () => {
        const buf1 = makeExcelBuffer(['5511999999999']);
        const buf2 = makeExcelBuffer(['5511999999999', '5521988888888']);
        const result = processExcelFiles([{ buffer: buf1 }, { buffer: buf2 }]);
        assert.equal(result.totalUnicos, 2);
    });
});
