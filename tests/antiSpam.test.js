import { describe, it, expect } from 'vitest';
import { processSpintax, humanDelay } from '../src/services/antiSpam.js';

describe('processSpintax', () => {
    it('retorna string vazia para entrada vazia', () => {
        expect(processSpintax('')).toBe('');
        expect(processSpintax(null)).toBe('');
        expect(processSpintax(undefined)).toBe('');
    });

    it('não altera texto sem spintax', () => {
        expect(processSpintax('Olá, tudo bem?')).toBe('Olá, tudo bem?');
    });

    it('escolhe uma das opções do spintax', () => {
        const result = processSpintax('{Olá|Oi}');
        expect(['Olá', 'Oi']).toContain(result);
    });

    it('expande múltiplos grupos spintax independentemente', () => {
        const result = processSpintax('{Bom|Boa} {dia|tarde}!');
        expect(result).toMatch(/^(Bom|Boa) (dia|tarde)!$/);
    });

    it('spintax com opção única funciona como texto fixo', () => {
        expect(processSpintax('{sempre}')).toBe('sempre');
    });

    it('distribui escolhas de forma aleatória ao longo de N chamadas', () => {
        const results = new Set();
        for (let i = 0; i < 50; i++) results.add(processSpintax('{A|B|C}'));
        expect(results.size).toBeGreaterThan(1);
    });
});

describe('humanDelay', () => {
    it('resolve dentro do intervalo especificado', async () => {
        const before = Date.now();
        await humanDelay(0.01, 0.05); // 10–50 ms para não travar o teste
        const elapsed = Date.now() - before;
        expect(elapsed).toBeGreaterThanOrEqual(10);
        expect(elapsed).toBeLessThan(500); // margem generosa
    });

    it('retorna uma Promise', () => {
        const result = humanDelay(0.01, 0.02);
        expect(result).toBeInstanceOf(Promise);
        return result;
    });
});
