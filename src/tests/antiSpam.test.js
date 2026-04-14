import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processSpintax, humanDelay } from '../services/antiSpam.js';

describe('processSpintax', () => {
    it('retorna texto vazio se entrada for vazia ou nula', () => {
        assert.equal(processSpintax(''), '');
        assert.equal(processSpintax(null), '');
        assert.equal(processSpintax(undefined), '');
    });

    it('retorna texto sem alteração se não houver spintax', () => {
        assert.equal(processSpintax('Olá, tudo bem?'), 'Olá, tudo bem?');
    });

    it('escolhe uma das opções dentro de {}', () => {
        const resultado = processSpintax('{Olá|Oi|Hey}');
        assert.ok(['Olá', 'Oi', 'Hey'].includes(resultado), `Inesperado: "${resultado}"`);
    });

    it('processa múltiplos blocos de spintax', () => {
        const resultado = processSpintax('{Bom dia|Boa tarde}, {amigo|parceiro}!');
        assert.match(resultado, /^(Bom dia|Boa tarde), (amigo|parceiro)!$/);
    });

    it('mantém texto fora do spintax intacto', () => {
        const resultado = processSpintax('Prezado {João|Cliente}, seu pedido foi confirmado.');
        assert.match(resultado, /^Prezado (João|Cliente), seu pedido foi confirmado\.$/);
    });

    it('distribui escolhas de forma aleatória (estatístico — 100 amostras)', () => {
        const contagem = { A: 0, B: 0 };
        for (let i = 0; i < 100; i++) {
            contagem[processSpintax('{A|B}')]++;
        }
        // Com 100 amostras, esperamos ao menos 10 ocorrências de cada
        assert.ok(contagem.A >= 10, `"A" saiu só ${contagem.A} vezes`);
        assert.ok(contagem.B >= 10, `"B" saiu só ${contagem.B} vezes`);
    });
});

describe('humanDelay', () => {
    it('aguarda ao menos o tempo mínimo', async () => {
        const inicio = Date.now();
        await humanDelay(0.1, 0.2); // 100ms–200ms
        const decorrido = Date.now() - inicio;
        assert.ok(decorrido >= 80, `Delay muito curto: ${decorrido}ms`);
    });

    it('não ultrapassa muito o tempo máximo', async () => {
        const inicio = Date.now();
        await humanDelay(0.05, 0.1); // 50ms–100ms
        const decorrido = Date.now() - inicio;
        assert.ok(decorrido < 300, `Delay muito longo: ${decorrido}ms`);
    });
});
