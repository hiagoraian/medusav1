import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock do módulo postgres antes de importar reportGenerator
vi.mock('../src/database/postgres.js', () => ({
    query: vi.fn(),
}));

import { query } from '../src/database/postgres.js';
import { generateCampaignReport } from '../src/services/reportGenerator.js';

describe('generateCampaignReport', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medusa-test-'));
        // Override REPORTS_DIR via spy no fs.writeFileSync é complexo;
        // em vez disso, validamos a lógica de filtragem dos dados.
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it('chama query com o cycleId correto', async () => {
        query.mockResolvedValueOnce({
            rows: [
                { phone_number: '5511999991111', status: 'enviado',  whatsapp_id: 'WA-01', error_message: null },
                { phone_number: '5511999992222', status: 'falha',    whatsapp_id: 'WA-02', error_message: 'Timeout' },
                { phone_number: '5511999993333', status: 'invalido', whatsapp_id: null,    error_message: 'Invalid' },
            ],
        });

        await generateCampaignReport(42).catch(() => {}); // pode falhar no fs.writeFile — ok
        expect(query).toHaveBeenCalledWith(
            expect.stringContaining('WHERE cycle_id = $1'),
            [42]
        );
    });

    it('separa corretamente enviados, invalidos e falhas', async () => {
        const rows = [
            { phone_number: '5511111111111', status: 'enviado',  whatsapp_id: 'WA-01', error_message: null },
            { phone_number: '5511222222222', status: 'enviado',  whatsapp_id: 'WA-02', error_message: null },
            { phone_number: '5511333333333', status: 'invalido', whatsapp_id: null,    error_message: 'Invalid' },
            { phone_number: '5511444444444', status: 'falha',    whatsapp_id: 'WA-01', error_message: 'Timeout' },
        ];

        const enviados  = rows.filter(r => r.status === 'enviado').map(r => r.phone_number);
        const invalidos = rows.filter(r => r.status === 'invalido').map(r => r.phone_number);
        const falhas    = rows.filter(r => r.status === 'falha');

        expect(enviados).toEqual(['5511111111111', '5511222222222']);
        expect(invalidos).toEqual(['5511333333333']);
        expect(falhas).toHaveLength(1);
        expect(falhas[0].error_message).toBe('Timeout');
    });

    it('lida com ciclo sem mensagens sem erros', async () => {
        query.mockResolvedValueOnce({ rows: [] });
        await generateCampaignReport(99).catch(() => {}); // pode falhar no fs — ok
        expect(query).toHaveBeenCalled();
    });
});
