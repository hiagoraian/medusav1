import axios from 'axios';

const api = axios.create({
    baseURL: process.env.EVOLUTION_URL || 'http://localhost:8081',
    headers: { apikey: process.env.EVOLUTION_API_KEY || 'medusa-evolution-secret-key' },
    timeout: 20000,
});

/**
 * Cria ou reconecta uma instância WhatsApp.
 * @param {string} instanceName
 * @param {object|null} proxyConfig - { host, port } para rotear via 4G, ou null para Wi-Fi
 */
export const createInstance = async (instanceName, proxyConfig = null) => {
    const body = {
        instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
    };
    if (proxyConfig) {
        body.proxyHost     = proxyConfig.host;
        body.proxyPort     = String(proxyConfig.port);
        body.proxyProtocol = 'http';
    }
    const { data } = await api.post('/instance/create', body);
    return data;
};

/** Retorna o QR code base64 da instância, ou null se já conectada. */
export const getQRCode = async (instanceName) => {
    try {
        const { data } = await api.get(`/instance/connect/${instanceName}`);
        return data?.base64 || data?.qrcode?.base64 || null;
    } catch (_) {
        return null;
    }
};

/** Retorna o estado: 'open' | 'connecting' | 'close' */
export const getConnectionState = async (instanceName) => {
    try {
        const { data } = await api.get(`/instance/connectionState/${instanceName}`);
        return data?.instance?.state || data?.state || 'close';
    } catch (_) {
        return 'close';
    }
};

/** Lista todas as instâncias. */
export const fetchInstances = async () => {
    try {
        const { data } = await api.get('/instance/fetchInstances');
        return Array.isArray(data) ? data : [];
    } catch (_) {
        return [];
    }
};

/** Desconecta a sessão sem apagar a instância. */
export const logoutInstance = async (instanceName) => {
    const { data } = await api.delete(`/instance/logout/${instanceName}`);
    return data;
};

/** Remove a instância completamente. */
export const deleteInstance = async (instanceName) => {
    const { data } = await api.delete(`/instance/delete/${instanceName}`);
    return data;
};

/**
 * Envia texto.
 * @param {string} number - Só dígitos, ex: 5511999999999
 */
export const sendText = async (instanceName, number, text) => {
    const { data } = await api.post(`/message/sendText/${instanceName}`, { number, text });
    return data;
};

/**
 * Envia mídia via URL.
 * @param {string} mediaUrl  - URL acessível pela Evolution API (use host.docker.internal para local)
 * @param {string} mediatype - 'image' | 'video' | 'audio'
 * @param {string} caption   - Legenda (pode ser vazio)
 */
export const sendMedia = async (instanceName, number, mediaUrl, mediatype, caption) => {
    const { data } = await api.post(`/message/sendMedia/${instanceName}`, {
        number,
        mediatype,
        media: mediaUrl,
        caption: caption || '',
    });
    return data;
};

/** Configura webhook de eventos para a instância. */
export const setWebhook = async (instanceName, webhookUrl) => {
    const { data } = await api.post(`/webhook/set/${instanceName}`, {
        webhook: {
            enabled: true,
            url: webhookUrl,
            events: ['MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
            webhookByEvents: false,
            webhookBase64:   false,
        },
    });
    return data;
};

export default { createInstance, getQRCode, getConnectionState, fetchInstances, logoutInstance, deleteInstance, sendText, sendMedia, setWebhook };
