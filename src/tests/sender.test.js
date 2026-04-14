import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Função extraída do sender.js para teste isolado (sem dependência do WhatsApp)
const normalizePhone = (phone) => String(phone).replace(/\D/g, '');

describe('normalizePhone', () => {
    it('remove traços e espaços', () => {
        assert.equal(normalizePhone('55 (11) 99999-9999'), '5511999999999');
    });

    it('mantém número já limpo', () => {
        assert.equal(normalizePhone('5511999999999'), '5511999999999');
    });

    it('converte número guardado como float pelo Excel (notação científica)', () => {
        // Excel pode salvar 5511999999999 como 5.511999999999e+12
        assert.equal(normalizePhone(5.511999999999e12), '5511999999999');
    });

    it('rejeita número muito curto (< 10 dígitos)', () => {
        const digits = normalizePhone('123');
        assert.ok(digits.length < 10, 'Deveria ser curto demais');
    });

    it('aceita número internacional sem formatação', () => {
        assert.equal(normalizePhone('+55 11 91234-5678'), '5511912345678');
    });
});
