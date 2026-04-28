import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as evolution from '../evolution/client.js';
import { query } from '../database/postgres.js';

const __filename      = fileURLToPath(import.meta.url);
const __dirname       = path.dirname(__filename);
const CONFIG_PATH     = path.resolve(__dirname, '../../notification_config.json');
const WHITELIST_PATH  = path.resolve(__dirname, '../../whitelist_notificacao.txt');

// ── Whitelist ─────────────────────────────────────────────────────────────────

const loadWhitelist = () => {
    try {
        if (!fs.existsSync(WHITELIST_PATH)) return new Set();
        return new Set(
            fs.readFileSync(WHITELIST_PATH, 'utf8')
                .split('\n')
                .map(l => l.trim().replace(/\D/g, ''))
                .filter(l => l.length >= 10)
        );
    } catch (_) { return new Set(); }
};

// ── Config persistence ────────────────────────────────────────────────────────

export const getNotificationConfig = () => {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return { groupJid: null, groupName: null };
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (_) { return { groupJid: null, groupName: null }; }
};

export const saveNotificationConfig = (cfg) => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const phoneFromJid = (jid = '') => jid.split('@')[0];
const isLidJid     = (jid = '') => jid.endsWith('@lid');

// Retorna label de exibição e phone para lookup (phone=null se LID)
const parseJid = (jid = '', pushName = '') => {
    const lid   = isLidJid(jid);
    const phone = lid ? null : phoneFromJid(jid);
    const label = phone
        ? `*${phone}*${pushName ? ` _(${pushName})_` : ''}`
        : `*${pushName || phoneFromJid(jid)}*`;
    return { phone, label };
};

// Status lido/ouvido: Evolution v2 pode enviar número (4/5) ou string
const isReadStatus   = s => s === 4 || s === 'READ'   || s === 'read';
const isPlayedStatus = s => s === 5 || s === 'PLAYED' || s === 'played';

// Retorna qual zap enviou para esse número
const getZapThatSent = async (phone) => {
    try {
        const { rows } = await query(
            `SELECT whatsapp_id FROM messages_queue
             WHERE phone_number = $1 AND status IN ('enviado','invalido','falha')
             ORDER BY id DESC LIMIT 1`,
            [phone]
        );
        return rows[0]?.whatsapp_id || null;
    } catch (_) { return null; }
};

// Tenta enviar texto via zap preferido, e se falhar tenta todos os outros
const sendViaAnyZap = async (preferredZap, groupJid, text) => {
    const tryZap = async (zap) => {
        await evolution.sendText(zap, groupJid, text);
        console.log(`[NOTIF] ✅ Enviado via ${zap}`);
    };

    try {
        await tryZap(preferredZap);
        return;
    } catch (_) {}

    // Fallback: tenta qualquer instância disponível
    try {
        const instances = await evolution.fetchInstances();
        for (const inst of instances) {
            const name = inst.instanceName || inst.name;
            if (name === preferredZap) continue;
            try { await tryZap(name); return; } catch (_) {}
        }
    } catch (_) {}

    throw new Error(`Nenhum zap conseguiu enviar para o grupo ${groupJid}`);
};

// ── Handler principal ─────────────────────────────────────────────────────────

export const handleWebhookEvent = async (event) => {
    const { groupJid } = getNotificationConfig();
    if (!groupJid) return;

    // Normaliza "messages.upsert" → "MESSAGES_UPSERT" (Evolution v2 usa ponto)
    const eventName = (event?.event || '').toUpperCase().replace(/\./g, '_');
    const instance  = event?.instance || '';
    const data      = event?.data || {};

    try {
        const whitelist = loadWhitelist();

        // ── Mensagem recebida ──────────────────────────────────────────────────
        if (eventName === 'MESSAGES_UPSERT') {
            const messages = Array.isArray(data) ? data : [data];

            for (const msg of messages) {
                const key       = msg?.key || {};
                if (key?.fromMe) continue;
                const remoteJid = key?.remoteJid || '';
                if (remoteJid.includes('@g.us')) continue;

                const pushName = msg?.pushName || '';
                const { phone, label } = parseJid(remoteJid, pushName);

                if (phone && whitelist.has(phone)) continue;

                const message   = msg?.message || {};
                const notifyZap = (phone && await getZapThatSent(phone)) || instance;

                const text     = message?.conversation || message?.extendedTextMessage?.text || '';
                const hasAudio = !!message?.audioMessage;
                const hasImage = !!message?.imageMessage;
                const hasVideo = !!message?.videoMessage;
                const hasDoc   = !!message?.documentMessage;

                if (hasAudio) {
                    await sendViaAnyZap(notifyZap, groupJid, `🎤 ${label} enviou um áudio:`);
                    try {
                        const b64 = await evolution.getMediaBase64(instance, msg);
                        if (b64) await evolution.sendAudio(notifyZap, groupJid, b64);
                    } catch (_) {}

                } else if (text) {
                    await sendViaAnyZap(notifyZap, groupJid, `💬 ${label} respondeu:\n${text}`);

                } else if (hasImage) {
                    await sendViaAnyZap(notifyZap, groupJid, `🖼️ ${label} enviou uma imagem`);

                } else if (hasVideo) {
                    await sendViaAnyZap(notifyZap, groupJid, `🎬 ${label} enviou um vídeo`);

                } else if (hasDoc) {
                    const docName = message.documentMessage?.fileName || 'arquivo';
                    await sendViaAnyZap(notifyZap, groupJid, `📄 ${label} enviou um documento: ${docName}`);
                }
            }

        // ── Reação ─────────────────────────────────────────────────────────────
        } else if (eventName === 'MESSAGES_REACTION') {
            const key       = data?.key || {};
            const remoteJid = key?.remoteJid || '';
            if (remoteJid.includes('@g.us')) return;

            const emoji = data?.reaction?.text || '';
            if (!emoji) return;

            const { phone: rPhone, label: rLabel } = parseJid(remoteJid, data?.pushName || '');
            if (rPhone && whitelist.has(rPhone)) return;

            const notifyZap = (rPhone && await getZapThatSent(rPhone)) || instance;
            await sendViaAnyZap(notifyZap, groupJid, `${emoji} ${rLabel} reagiu com ${emoji}`);

        // ── Visualizou / Ouviu ─────────────────────────────────────────────────
        } else if (eventName === 'MESSAGES_UPDATE') {
            const updates = Array.isArray(data) ? data : [data];

            for (const upd of updates) {
                // Evolution v2: flat { fromMe, remoteJid, status }
                // Evolution v1: nested { key: { fromMe, remoteJid }, update: { status } }
                const fromMe    = upd?.key?.fromMe ?? upd?.fromMe;
                if (!fromMe) continue;

                const status    = upd?.update?.status ?? upd?.status;

                if (!isReadStatus(status) && !isPlayedStatus(status)) continue;

                const remoteJid = upd?.key?.remoteJid || upd?.remoteJid || '';
                if (remoteJid.includes('@g.us')) continue;

                const { phone: uPhone, label: uLabel } = parseJid(remoteJid);
                if (uPhone && whitelist.has(uPhone)) continue;

                const notifyZap = (uPhone && await getZapThatSent(uPhone)) || instance;
                const icon      = isPlayedStatus(status) ? '🎧' : '👁️';
                const action    = isPlayedStatus(status) ? 'ouviu o áudio' : 'visualizou a mensagem';

                await sendViaAnyZap(notifyZap, groupJid, `${icon} ${uLabel} ${action}`);
            }
        }
    } catch (err) {
        console.warn(`⚠️ [NOTIF] Erro ao processar ${eventName}:`, err.message);
    }
};

export default { handleWebhookEvent, getNotificationConfig, saveNotificationConfig };
