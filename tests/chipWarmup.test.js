import { describe, it, expect } from 'vitest';
import { buildGroups } from '../src/services/chipWarmup.js';

describe('buildGroups', () => {
    it('cria grupos do tamanho especificado', () => {
        const groups = buildGroups(['A','B','C','D','E','F'], 3);
        expect(groups).toHaveLength(2);
        groups.forEach(g => expect(g).toHaveLength(3));
    });

    it('descarta grupo com menos de 2 elementos', () => {
        // 7 contas, groupSize=3 → [3,3,1] → o grupo de 1 é descartado
        const accounts = ['A','B','C','D','E','F','G'];
        const groups   = buildGroups(accounts, 3);
        expect(groups).toHaveLength(2);
    });

    it('aceita grupo de 2 (mínimo válido)', () => {
        const groups = buildGroups(['A','B'], 3);
        expect(groups).toHaveLength(1);
        expect(groups[0]).toHaveLength(2);
    });

    it('retorna vazio com menos de 2 contas', () => {
        expect(buildGroups(['A'], 3)).toHaveLength(0);
        expect(buildGroups([],    3)).toHaveLength(0);
    });

    it('cada conta aparece exatamente uma vez', () => {
        const accounts = ['WA-01','WA-02','WA-03','WA-04','WA-05','WA-06','WA-07','WA-08'];
        const groups   = buildGroups(accounts, 4);
        const flat     = groups.flat();
        const unique   = new Set(flat);
        expect(flat).toHaveLength(unique.size);
        expect(unique.size).toBe(8);
    });

    it('distribui embaralhado (não mantém ordem original)', () => {
        // Com 20 contas e 100 rodadas, a chance de ficar na ordem original é negligível
        const accounts = Array.from({ length: 20 }, (_, i) => `WA-${i + 1}`);
        let alwaysOrdered = true;
        for (let i = 0; i < 20; i++) {
            const flat = buildGroups(accounts, 4).flat();
            if (flat.join(',') !== accounts.join(',')) { alwaysOrdered = false; break; }
        }
        expect(alwaysOrdered).toBe(false);
    });
});
