import axios from 'axios';

const api = axios.create({
    baseURL: process.env.EVOLUTION_URL || 'http://localhost:8081',
    headers: { apikey: process.env.EVOLUTION_API_KEY || 'medusa-evolution-secret-key' },
    timeout: 20000,
});

/**
 * Cria (ou recria) uma instância WhatsApp na Evolution API.
 * Se a instância já existir, a Evolution retorna os dados sem erro.
 */
export const createInstance = async (instanceName) => {
    const { data } = await api.post('/instance/create', {
        instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
    });
    return data;
};

/**
 * Retorna o QR code atual da instância (base64 PNG).
 * Retorna null se a instância já estiver conectada ou não existir.
 */
export const getQRCode = async (instanceName) => {
    try {
        const { data } = await api.get(`/instance/connect/${instanceName}`);
        return data?.base64 || data?.qrcode?.base64 || null;
    } catch (_) {
        return null;
    }
};

/**
 * Retorna o estado da conexão: 'open' | 'close' | 'connecting'
 */
export const getConnectionState = async (instanceName) => {
    try {
        const { data } = await api.get(`/instance/connectionState/${instanceName}`);
        return data?.instance?.state || data?.state || 'close';
    } catch (_) {
        return 'close';
    }
};

/**
 * Lista todas as instâncias com seus estados.
 */
export const fetchInstances = async () => {
    try {
        const { data } = await api.get('/instance/fetchInstances');
        return Array.isArray(data) ? data : [];
    } catch (_) {
        return [];
    }
};

/**
 * Desconecta a sessão WhatsApp (sem apagar a instância).
 */
export const logoutInstance = async (instanceName) => {
    const { data } = await api.delete(`/instance/logout/${instanceName}`);
    return data;
};

/**
 * Remove a instância completamente da Evolution API.
 */
export const deleteInstance = async (instanceName) => {
    const { data } = await api.delete(`/instance/delete/${instanceName}`);
    return data;
};

/**
 * Envia mensagem de texto.
 * @param {string} instanceName - Ex: 'WA-01'
 * @param {string} number - Número no formato 5511999999999 (só dígitos)
 * @param {string} text - Texto da mensagem
 */
export const sendText = async (instanceName, number, text) => {
    const { data } = await api.post(`/message/sendText/${instanceName}`, {
        number,
        text,
    });
    return data;
};

/**
 * Envia mídia (imagem ou vídeo) com ou sem legenda.
 * @param {string} mediaUrl - URL acessível pela Evolution API (use host.docker.internal para arquivos locais)
 * @param {string} mediatype - 'image' | 'video'
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

/**
 * Configura o webhook da instância para receber eventos de entrega e conexão.
 */
export const setWebhook = async (instanceName, webhookUrl) => {
    const { data } = await api.post(`/webhook/set/${instanceName}`, {
        webhook: {
            enabled: true,
            url: webhookUrl,
            events: ['MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
            webhookByEvents: false,
            webhookBase64: false,
        },
    });
    return data;
};

export default { createInstance, getQRCode, getConnectionState, fetchInstances, logoutInstance, deleteInstance, sendText, sendMedia, setWebhook };
