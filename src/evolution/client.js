import axios from 'axios';

const api = axios.create({
    baseURL: process.env.EVOLUTION_URL || 'http://localhost:8081',
    headers: { apikey: process.env.EVOLUTION_API_KEY || 'medusa-evolution-secret-key' },
    timeout: 40000,
});

/**
 * Cria ou reconecta uma instância WhatsApp.
 * @param {string} instanceName
 * @param {object|null} proxyConfig - { host, port } para rotear via 4G, ou null para Wi-Fi
 */
export const createInstance = async (instanceName, proxyConfig = null, withQR = true, phoneNumber = null, webhookUrl = null) => {
    const body = {
        instanceName,
        qrcode:      withQR,
        integration: 'WHATSAPP-BAILEYS',
    };
    if (phoneNumber) body.number = phoneNumber.replace(/\D/g, '');
    if (proxyConfig) {
        body.proxyHost     = proxyConfig.host;
        body.proxyPort     = String(proxyConfig.port);
        body.proxyProtocol = 'http';
    }
    // Configura webhook atomicamente na criação — evita race condition onde
    // o Baileys emite QRCODE_UPDATED antes de setWebhook ser chamado
    if (webhookUrl) {
        body.webhook = {
            enabled:        true,
            url:            webhookUrl,
            events:         ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
            webhookByEvents: false,
            webhookBase64:   false,
        };
    }
    const { data } = await api.post('/instance/create', body);
    return data;
};

/**
 * Retorna dados de conexão da instância.
 * Sem phoneNumber → QR Code via GET /instance/connect/{name} → { base64 }
 * Com phoneNumber → Pairing Code via POST /instance/pairing-code/{name} → { pairingCode }
 * Retorna { base64, pairingCode } — apenas um dos dois virá preenchido.
 */
export const getConnectData = async (instanceName, phoneNumber = null) => {
    try {
        if (phoneNumber) {
            const { data } = await api.post(`/instance/pairing-code/${instanceName}`, {
                number: phoneNumber.replace(/\D/g, ''),
            });
            console.log(`[PAIRING client] ${instanceName} resposta:`, JSON.stringify(data).slice(0, 300));
            return {
                base64:      null,
                pairingCode: data?.pairingCode || data?.code || null,
            };
        }
        const { data } = await api.get(`/instance/connect/${instanceName}`);
        return {
            base64:      data?.base64 || data?.qrcode?.base64 || null,
            pairingCode: null,
        };
    } catch (err) {
        if (phoneNumber) {
            console.error(`[PAIRING client] ${instanceName} erro ${err.response?.status}:`, JSON.stringify(err.response?.data || {}).slice(0, 200));
        }
        return { base64: null, pairingCode: null };
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

/** Reinicia o socket Baileys da instância (força reconexão real). */
export const restartInstance = async (instanceName) => {
    try {
        const { data } = await api.put(`/instance/restart/${instanceName}`);
        return data;
    } catch (_) { return null; }
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
export const sendText = async (instanceName, number, text, timeoutMs) => {
    const cfg = timeoutMs ? { timeout: timeoutMs } : {};
    const { data } = await api.post(`/message/sendText/${instanceName}`, { number, text }, cfg);
    return data;
};

/**
 * Envia mídia via URL.
 * @param {string} mediaUrl  - URL acessível pela Evolution API (use host.docker.internal para local)
 * @param {string} mediatype - 'image' | 'video' | 'audio'
 * @param {string} caption   - Legenda (pode ser vazio)
 */
const MIMETYPES = { video: 'video/mp4', image: 'image/jpeg', audio: 'audio/mpeg' };

export const sendMedia = async (instanceName, number, mediaUrl, mediatype, caption) => {
    const { data } = await api.post(`/message/sendMedia/${instanceName}`, {
        number,
        mediatype,
        mimetype: MIMETYPES[mediatype] || 'application/octet-stream',
        media:    mediaUrl,
        caption:  caption || '',
    }, { timeout: 60000 });
    return data;
};

/** Configura webhook de eventos para a instância. */
export const setWebhook = async (instanceName, webhookUrl) => {
    const { data } = await api.post(`/webhook/set/${instanceName}`, {
        webhook: {
            enabled: true,
            url: webhookUrl,
            events: [
                'MESSAGES_UPSERT',
                'MESSAGES_UPDATE',
                'CONNECTION_UPDATE',
                'QRCODE_UPDATED',
            ],
            webhookByEvents: false,
            webhookBase64:   false,
        },
    });
    return data;
};

/** Lista grupos em que a instância participa. */
export const fetchGroups = async (instanceName) => {
    try {
        const { data } = await api.get(`/group/fetchAllGroups/${instanceName}?getParticipants=false`);
        return Array.isArray(data) ? data : [];
    } catch (_) { return []; }
};

/** Obtém mídia de uma mensagem recebida como base64. */
export const getMediaBase64 = async (instanceName, messageData) => {
    try {
        const { data } = await api.post(`/chat/getBase64FromMediaMessage/${instanceName}`, { message: messageData });
        return data?.base64 || null;
    } catch (_) { return null; }
};

/** Envia áudio (base64) como mensagem de voz no WhatsApp. */
export const sendAudio = async (instanceName, number, audioBase64) => {
    const { data } = await api.post(`/message/sendWhatsAppAudio/${instanceName}`, {
        number,
        audio:    audioBase64,
        encoding: true,
    });
    return data;
};

/** Configura ou atualiza proxy em instância já existente. */
export const setProxy = async (instanceName, proxyConfig) => {
    const { data } = await api.post(`/proxy/set/${instanceName}`, {
        enabled:  true,
        host:     proxyConfig.host,
        port:     String(proxyConfig.port),
        protocol: 'http',
        username: '',
        password: '',
    });
    return data;
};

/** Remove proxy da instância — força uso de Wi-Fi. Falha silenciosa. */
export const clearProxy = async (instanceName) => {
    try {
        await api.post(`/proxy/set/${instanceName}`, { enabled: false });
    } catch (_) {}
};

/** Envia indicador "digitando..." antes de uma mensagem. Falha silenciosa. */
export const sendTyping = async (instanceName, number, durationMs = 2000) => {
    try {
        await api.post(`/chat/updatePresence/${instanceName}`, {
            number,
            options: { presence: 'composing', delay: durationMs },
        });
    } catch (_) {}
};

export default { createInstance, getConnectData, getConnectionState, fetchInstances, restartInstance, logoutInstance, deleteInstance, sendText, sendMedia, setWebhook, fetchGroups, getMediaBase64, sendAudio, sendTyping, setProxy, clearProxy };
