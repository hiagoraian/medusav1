import wwebjs from 'whatsapp-web.js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isMobileConnectionActive } from '../services/networkController.js';

const { Client, LocalAuth } = wwebjs;
puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const activeClients = {};

// Contador de retries de auth_failure por conta (módulo-level para sobreviver a tentativas consecutivas)
const authRetries = {};

const MAX_RETRIES       = 3;
const MAX_AUTH_RETRIES  = 3;   // quantas vezes tenta reconectar do cache após auth_failure
const MAX_QR_ATTEMPTS   = 3;   // quantos QR codes mostra antes de parar e pedir nova conexão
const RETRY_BASE_DELAY_MS = 6000;
const STAGGER_DELAY_MS    = 5000;

const RETRYABLE_ERRORS = [
    'Execution context was destroyed',
    'Session closed',
    'Target closed',
    'Protocol error',
    'Navigation timeout',
    'net::ERR_',
];

const isRetryable = (error) =>
    RETRYABLE_ERRORS.some(msg => error?.message?.includes(msg));

/**
 * Verifica se existe pasta de sessão salva para a conta.
 * Usado para distinguir "reconexão com cache" de "primeiro login".
 */
export const hasSessionCache = (accountId) => {
    const sessionPath = path.resolve(__dirname, '../../.wwebjs_auth', `session-${accountId}`);
    try {
        return fs.existsSync(sessionPath);
    } catch (_) {
        return false;
    }
};

/**
 * Retorna o proxy para a conta baseada no número do Zap.
 * ZTE 1: 1-8 (Porta 8080)
 * ZTE 2: 9-16 (Porta 8081)
 * ZTE 3: 17-24 (Porta 8082)
 */
const getProxyForAccount = async (accountId) => {
    const num = parseInt(accountId.split('-')[1]);
    let port = 0;

    if (num >= 1 && num <= 8) port = 8080;
    else if (num >= 9 && num <= 16) port = 8081;
    else if (num >= 17 && num <= 24) port = 8082;

    if (port > 0) {
        const isMobileOk = await isMobileConnectionActive(port);
        if (isMobileOk) {
            console.log(`[${accountId}] Usando Dados Móveis (Porta ${port})`);
            return `--proxy-server=127.0.0.1:${port}`;
        } else {
            console.warn(`⚠️ [${accountId}] Dados Móveis falharam na porta ${port}. Usando Wi-Fi do PC.`);
            return '';
        }
    }

    return '';
};

export const initializeAccount = async (accountId, attempt = 1) => {
    console.log(`\n[${accountId}] Iniciando conexão... (tentativa ${attempt}/${MAX_RETRIES})`);
    const proxyArg = await getProxyForAccount(accountId);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: accountId }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-accelerated-2d-canvas',
                '--disable-extensions',
                '--disable-component-extensions-with-background-pages',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-translate',
                '--disable-default-apps',
                '--mute-audio',
                '--no-first-run',
                '--no-zygote',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-client-side-phishing-detection',
                '--disable-component-update',
                proxyArg,
            ].filter(arg => arg !== '')
        }
    });

    // Flags por instância de cliente
    let qrCount          = 0;
    let hadQr            = false; // QR foi exibido antes do ready → conexão via scan
    let destroyed        = false; // impede que 'ready' re-registre um client destruído pelo timeout
    let authFailureFired = false; // impede double-retry se auth_failure E catch dispararem juntos

    client.on('qr', (qr) => {
        qrCount++;
        hadQr = true;

        // Após MAX_QR_ATTEMPTS QR Codes exibidos sem leitura, para e avisa
        if (qrCount > MAX_QR_ATTEMPTS) {
            console.log(`\n⏰ [${accountId}] QR Code expirou ${MAX_QR_ATTEMPTS} vezes sem leitura.`);
            console.log(`   ➤ Clique em "Conectar" novamente para tentar.\n`);
            destroyed = true;
            client.destroy().catch(() => {});
            return;
        }

        console.log(`\n======================================================`);
        console.log(`⚠️ QR CODE (${qrCount}/${MAX_QR_ATTEMPTS}) — CONTA: ${accountId}`);
        console.log(`Escaneie o código abaixo com o celular físico:`);
        qrcode.generate(qr, { small: true });
        console.log(`======================================================\n`);
    });

    client.on('auth_failure', async (msg) => {
        console.warn(`⚠️ [${accountId}] Falha de autenticação: ${msg}`);
        authFailureFired = true; // sinaliza para o catch do initialize() não fazer double-retry
        delete activeClients[accountId];

        authRetries[accountId] = (authRetries[accountId] || 0) + 1;

        // Se tem cache salvo, tenta reconectar automaticamente antes de pedir nova leitura
        if (hasSessionCache(accountId) && authRetries[accountId] <= MAX_AUTH_RETRIES) {
            console.log(`[${accountId}] Cache existe. Retry automático ${authRetries[accountId]}/${MAX_AUTH_RETRIES} em 5s...`);
            try { await client.destroy(); } catch (_) {}
            await new Promise(r => setTimeout(r, 5000));
            initializeAccount(accountId, 1).catch(e =>
                console.error(`[${accountId}] Erro no retry de auth_failure:`, e.message)
            );
        } else {
            console.log(`[${accountId}] Autenticação falhou após ${authRetries[accountId]} tentativa(s). Clique em "Conectar" novamente.`);
            authRetries[accountId] = 0;
        }
    });

    client.on('ready', async () => {
        // Guard: client foi destruído pelo timeout do QR — ignora ready tardio do celular
        if (destroyed) return;
        // Guard: ignora disparos duplicados do evento 'ready'
        if (activeClients[accountId]) return;

        // Reset do contador de auth_failure ao conectar com sucesso
        authRetries[accountId] = 0;

        // O evento 'ready' dispara quando o Chromium termina a injeção,
        // mas os objetos internos do WA Web (client.info.wid, Store.WidFactory)
        // ainda levam alguns segundos para inicializar. Aguarda até 10s.
        for (let i = 0; i < 10; i++) {
            try {
                if (client.info?.wid?._serialized) break;
            } catch (_) {}
            await new Promise(r => setTimeout(r, 1000));
        }

        activeClients[accountId] = client;
        if (hadQr) {
            console.log(`✅ [${accountId}] QR Code escaneado com sucesso! Pronto para Disparos!`);
        } else {
            console.log(`✅ [${accountId}] Sessão restaurada do cache. Pronto para Disparos!`);
        }
    });

    client.on('disconnected', (reason) => {
        console.log(`❌ [${accountId}] Foi desconectado! Motivo:`, reason);
        delete activeClients[accountId];
    });

    try {
        await client.initialize();
        if (!activeClients[accountId]) activeClients[accountId] = client;
        return { success: true, message: `Instância ${accountId} iniciada.` };
    } catch (error) {
        console.error(`[${accountId}] Erro na tentativa ${attempt}:`, error.message);
        try { await client.destroy(); } catch (_) {}

        // auth_failure já disparou seu próprio retry — não criar segundo Chromium em paralelo
        if (authFailureFired) return { success: false, error: 'auth_failure em andamento' };

        if (isRetryable(error) && attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY_MS * attempt;
            console.log(`[${accountId}] Erro recuperável. Nova tentativa em ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return initializeAccount(accountId, attempt + 1);
        }

        return { success: false, error: error.message };
    }
};

/**
 * Inicia múltiplas contas com delay escalonado entre cada uma,
 * evitando pico de memória por subir todos os Chromiums ao mesmo tempo.
 */
export const initializeAccountsBulk = async (accountIds) => {
    const results = [];
    for (let i = 0; i < accountIds.length; i++) {
        const accountId = accountIds[i];

        if (getClientStatus(accountId)) {
            console.log(`[BULK] [${accountId}] Já estava ativo. Pulando.`);
            results.push({ accountId, success: true, message: 'Já estava ativo.' });
        } else {
            console.log(`[BULK] Iniciando ${accountId} (${i + 1}/${accountIds.length})...`);
            const result = await initializeAccount(accountId);
            results.push({ accountId, ...result });
        }

        if (i < accountIds.length - 1) {
            await new Promise(resolve => setTimeout(resolve, STAGGER_DELAY_MS));
        }
    }
    return results;
};

export const getClientStatus = (accountId) => {
    return !!activeClients[accountId];
};

/** Verifica se o cliente está conectado, com a página aberta E com os objetos
 *  internos do WA Web prontos (client.info.wid disponível). */
export const isClientReady = (accountId) => {
    const client = activeClients[accountId];
    try {
        return !!(
            client &&
            client.pupPage &&
            !client.pupPage.isClosed() &&
            client.info?.wid?._serialized
        );
    } catch (_) {
        return false;
    }
};

export const getClientInstance = (accountId) => {
    return activeClients[accountId];
};

export const getAllClientsStatus = async () => {
    const status = [];
    for (let i = 1; i <= 24; i++) {
        const accountId = `WA-${i.toString().padStart(2, '0')}`;
        status.push({ accountId, connected: isClientReady(accountId) });
    }
    return status;
};

export default { initializeAccount, initializeAccountsBulk, getClientInstance, getClientStatus, isClientReady, getAllClientsStatus, hasSessionCache };
