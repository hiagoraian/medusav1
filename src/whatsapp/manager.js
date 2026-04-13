import wwebjs from 'whatsapp-web.js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import qrcode from 'qrcode-terminal';
import { isMobileConnectionActive } from '../services/networkController.js';

const { Client, LocalAuth } = wwebjs;
puppeteer.use(StealthPlugin());

const activeClients = {};

/**
 * Retorna o proxy para a conta baseada no número do Zap.
 * Reestruturado para 24 números:
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
        // Implementação de Failover Wi-Fi:
        // Verifica se a conexão móvel está ativa. Se não, retorna vazio (usa Wi-Fi do PC)
        const isMobileOk = await isMobileConnectionActive(port);
        if (isMobileOk) {
            console.log(`[${accountId}] Usando Dados Móveis (Porta ${port})`);
            return `--proxy-server=127.0.0.1:${port}`;
        } else {
            console.warn(`⚠️ [${accountId}] Dados Móveis falharam na porta ${port}. Usando Wi-Fi do PC.`);
            return ''; // Sem proxy = Wi-Fi do PC
        }
    }
    
    return '';
};

export const initializeAccount = async (accountId) => {
    console.log(`\n[${accountId}] Iniciando processo de conexão...`);
    const proxyArg = await getProxyForAccount(accountId);
    
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: accountId }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                proxyArg,
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ].filter(arg => arg !== '')
        }
    });

    client.on('qr', (qr) => {
        console.log(`\n======================================================`);
        console.log(`⚠️ QR CODE EXIGIDO PARA A CONTA: ${accountId}`);
        console.log(`Escaneie o código abaixo com o celular físico:`);
        qrcode.generate(qr, { small: true });
        console.log(`======================================================\n`);
    });

    client.on('ready', () => {
        console.log(`✅ [${accountId}] Conectado e Pronto para Disparos!`);
    });

    client.on('disconnected', (reason) => {
        console.log(`❌ [${accountId}] Foi desconectado! Motivo:`, reason);
        delete activeClients[accountId];
    });

    try {
        await client.initialize();
        activeClients[accountId] = client;
        return { success: true, message: `Instância ${accountId} iniciada.` };
    } catch (error) {
        console.error(`[${accountId}] Erro fatal ao iniciar:`, error);
        return { success: false, error: error.message };
    }
};

export const getClientStatus = (accountId) => {
    return !!activeClients[accountId];
};

export const getClientInstance = (accountId) => {
    return activeClients[accountId];
};

export const getAllClientsStatus = async () => {
    const status = [];
    // Atualizado para 24 números
    for (let i = 1; i <= 24; i++) {
        const accountId = `WA-${i.toString().padStart(2, '0')}`;
        const isConnected = getClientStatus(accountId);
        status.push({ accountId, connected: isConnected });
    }
    return status;
};

export default { initializeAccount, getClientInstance, getClientStatus, getAllClientsStatus };
