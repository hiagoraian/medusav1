import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseHHMM, isWithinWindow, endOfTodayWindow } from '../src/services/orchestrator.js';

describe('parseHHMM', () => {
    it('converte "08:00" para 480', () => expect(parseHHMM('08:00')).toBe(480));
    it('converte "19:45" para 1185', () => expect(parseHHMM('19:45')).toBe(1185));
    it('converte "00:00" para 0',    () => expect(parseHHMM('00:00')).toBe(0));
    it('converte "23:59" para 1439', () => expect(parseHHMM('23:59')).toBe(1439));

    it('calcula duração da janela 08:00–19:45 = 705 min', () => {
        expect(parseHHMM('19:45') - parseHHMM('08:00')).toBe(705);
    });

    it('bloco A→B→C = 235 min por bloco (705/3)', () => {
        const windowMin = parseHHMM('19:45') - parseHHMM('08:00');
        expect(Math.floor(windowMin / 3)).toBe(235);
    });
});

describe('isWithinWindow', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('retorna true às 10:00 (dentro de 08:00–19:45)', () => {
        vi.setSystemTime(new Date('2026-04-26T10:00:00'));
        expect(isWithinWindow('08:00', '19:45')).toBe(true);
    });

    it('retorna false às 07:59 (antes da janela)', () => {
        vi.setSystemTime(new Date('2026-04-26T07:59:00'));
        expect(isWithinWindow('08:00', '19:45')).toBe(false);
    });

    it('retorna false às 19:45 (exatamente no fim — janela é exclusiva)', () => {
        vi.setSystemTime(new Date('2026-04-26T19:45:00'));
        expect(isWithinWindow('08:00', '19:45')).toBe(false);
    });

    it('retorna true às 08:00 exato (início incluso)', () => {
        vi.setSystemTime(new Date('2026-04-26T08:00:00'));
        expect(isWithinWindow('08:00', '19:45')).toBe(true);
    });

    it('retorna false às 20:00 (após a janela)', () => {
        vi.setSystemTime(new Date('2026-04-26T20:00:00'));
        expect(isWithinWindow('08:00', '19:45')).toBe(false);
    });
});

describe('endOfTodayWindow', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('retorna 19:45 do dia atual', () => {
        vi.setSystemTime(new Date('2026-04-26T10:00:00'));
        const end = endOfTodayWindow('19:45');
        expect(end.getHours()).toBe(19);
        expect(end.getMinutes()).toBe(45);
        expect(end.getDate()).toBe(26);
    });
});

describe('blockDurMs — lógica de bloco', () => {
    it('blockDurMs = 235 min × 60000 ms', () => {
        const windowDurMs = (parseHHMM('19:45') - parseHHMM('08:00')) * 60_000;
        const blockDurMs  = Math.floor(windowDurMs / 3);
        expect(blockDurMs).toBe(14_100_000); // 235 min
    });

    it('3 blocos cobrem toda a janela diária', () => {
        const windowMin = parseHHMM('19:45') - parseHHMM('08:00'); // 705
        const blockMin  = Math.floor(windowMin / 3);               // 235
        expect(blockMin * 3).toBeLessThanOrEqual(windowMin);
        expect(blockMin * 3 + 3).toBeGreaterThan(windowMin); // sobra < 3 min
    });
});
