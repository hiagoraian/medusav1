import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as evolution from '../evolution/client.js';
import { humanDelay } from './antiSpam.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const WARMUP_FILE_PATH = path.resolve(__dirname, '../../textAquecimento.txt');

let isWarmupRunning = false;
let _phrasesCache   = null;

const loadWarmupPhrases = () => {
    if (_phrasesCache) return _phrasesCache;
    try {
        if (!fs.existsSync(WARMUP_FILE_PATH)) {
            const defaults = [
                'Olá, tudo bem?', 'Como vai você?', 'Bom dia!', 'Boa tarde!',
                'Você viu as notícias de hoje?', 'O que você acha disso?',
                'Sim, concordo plenamente.', 'Não tenho certeza sobre isso.',
                'Vou verificar e te aviso.', 'Até logo!', 'Tchau!', 'Ok, combinado.',
            ];
            fs.writeFileSync(WARMUP_FILE_PATH, defaults.join('\n'), 'utf8');
            _phrasesCache = defaults;
            return _phrasesCache;
        }
        const content = fs.readFileSync(WARMUP_FILE_PATH, 'utf8');
        _phrasesCache = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        return _phrasesCache;
    } catch (err) {
        console.error('❌ [AQUECIMENTO] Erro ao carregar frases:', err.message);
        return ['Oi', 'Tudo bem?', 'Sim', 'Não'];
    }
};

const randomPhrase = (phrases) => phrases[Math.floor(Math.random() * phrases.length)];

/**
 * Verifica se a instância está conectada na Evolution API.
 */
const isInstanceReady = async (accountId) => {
    const state = await evolution.getConnectionState(accountId);
    return state === 'open';
};

/**
 * Obtém o número de telefone da instância (para saber para onde enviar a resposta).
 * A Evolution retorna o número no campo instance.owner ou profilePictureUrl owner.
 */
const getInstanceNumber = async (accountId) => {
    try {
        const instances = await evolution.fetchInstances();
        const inst      = instances.find(i => i.instanceName === accountId || i.name === accountId);
        return inst?.instance?.owner || inst?.owner || null;
    } catch (_) {
        return null;
    }
};

/**
 * Executa uma conversa de IDA E VOLTA entre dois chips via Evolution API.
 */
export const warmupChipConversation = async (fromAccountId, toAccountId) => {
    const [fromReady, toReady] = await Promise.all([
        isInstanceReady(fromAccountId),
        isInstanceReady(toAccountId),
    ]);

    if (!fromReady || !toReady) {
        console.log(`⚠️ [AQUECIMENTO] ${fromAccountId} ou ${toAccountId} offline. Pulando par.`);
        return;
    }

    const toNumber   = await getInstanceNumber(toAccountId);
    const fromNumber = await getInstanceNumber(fromAccountId);

    if (!toNumber || !fromNumber) {
        console.log(`⚠️ [AQUECIMENTO] Número não disponível para ${fromAccountId} ou ${toAccountId}.`);
        return;
    }

    try {
        const phrases = loadWarmupPhrases();

        const phrase1 = randomPhrase(phrases);
        console.log(`🔥 [AQUECIMENTO] ${fromAccountId} → ${toAccountId}: "${phrase1}"`);
        await evolution.sendText(fromAccountId, toNumber.replace(/\D/g, ''), phrase1);

        await humanDelay(8, 15);
        if (!isWarmupRunning) return;

        const phrase2 = randomPhrase(phrases);
        console.log(`🔥 [AQUECIMENTO] ${toAccountId} → ${fromAccountId}: "${phrase2}"`);
        await evolution.sendText(toAccountId, fromNumber.replace(/\D/g, ''), phrase2);

        await humanDelay(5, 10);
    } catch (err) {
        console.error(`❌ [AQUECIMENTO] Erro entre ${fromAccountId} e ${toAccountId}:`, err.message);
    }
};

const filterActiveAccounts = async (accountsList) => {
    const results = await Promise.all(
        accountsList.map(async id => ({ id, ready: await isInstanceReady(id) }))
    );
    return results.filter(r => {
        if (!r.ready) console.warn(`⚠️ [AQUECIMENTO] ${r.id} desconectado. Removendo.`);
        return r.ready;
    }).map(r => r.id);
};

export const startWarmup = async (accountsList) => {
    let active = await filterActiveAccounts(accountsList);
    if (active.length < 2) {
        console.warn('⚠️ [AQUECIMENTO] Menos de 2 contas conectadas. Abortando.');
        return;
    }

    isWarmupRunning = true;
    console.log(`\n🔥 [AQUECIMENTO] Iniciando entre ${active.length} contas...`);
    console.log(`📄 Frases: ${WARMUP_FILE_PATH}`);

    while (isWarmupRunning) {
        const before = active.length;
        active = await filterActiveAccounts(active);
        if (active.length < before) console.log(`[AQUECIMENTO] ${active.length} zap(s) ativo(s).`);

        if (active.length < 2) {
            console.warn('⚠️ [AQUECIMENTO] Menos de 2 contas ativas. Encerrando.');
            isWarmupRunning = false;
            break;
        }

        const shuffled = [...active].sort(() => 0.5 - Math.random());
        for (let i = 0; i < shuffled.length - 1; i += 2) {
            if (!isWarmupRunning) break;
            await warmupChipConversation(shuffled[i], shuffled[i + 1]);
            await humanDelay(10, 20);
        }

        await humanDelay(15, 30);
    }

    console.log('🛑 [AQUECIMENTO] Processo parado.');
};

export const stopWarmup = () => {
    isWarmupRunning = false;
    console.log('⏳ [AQUECIMENTO] Solicitando parada...');
};

export default { startWarmup, stopWarmup, warmupChipConversation };
