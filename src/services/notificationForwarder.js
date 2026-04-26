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
// Números neste arquivo (um por linha) nunca disparam notificação no grupo.
// Útil para adicionar os próprios zaps de aquecimento.

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

// Retorna qual zap enviou para esse número (para usar como remetente da notificação)
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

// ── Handler principal ─────────────────────────────────────────────────────────

export const handleWebhookEvent = async (event) => {
    const { groupJid } = getNotificationConfig();
    if (!groupJid) return;

    const eventName = (event?.event || '').toUpperCase();
    const instance  = event?.instance || '';
    const data      = event?.data || {};

    try {
        const whitelist = loadWhitelist();

        // ── Mensagem recebida (texto / áudio / mídia) ──────────────────────────
        if (eventName === 'MESSAGES_UPSERT') {
            const messages = Array.isArray(data) ? data : [data];

            for (const msg of messages) {
                const key       = msg?.key || {};
                if (key?.fromMe) continue;                         // mensagem enviada por nós
                const remoteJid = key?.remoteJid || '';
                if (remoteJid.includes('@g.us')) continue;         // mensagem de grupo

                const phone    = phoneFromJid(remoteJid);
                if (whitelist.has(phone)) continue;                // número na whitelist (ex: zap de aquecimento)
                const pushName = msg?.pushName || '';
                const message  = msg?.message || {};

                const notifyZap = (await getZapThatSent(phone)) || instance;
                const nameTag   = pushName ? ` _(${pushName})_` : '';

                const text      = message?.conversation || message?.extendedTextMessage?.text || '';
                const hasAudio  = !!message?.audioMessage;
                const hasImage  = !!message?.imageMessage;
                const hasVideo  = !!message?.videoMessage;
                const hasDoc    = !!message?.documentMessage;

                if (hasAudio) {
                    await evolution.sendText(notifyZap, groupJid,
                        `🎤 *${phone}*${nameTag} enviou um áudio:`);
                    try {
                        const b64 = await evolution.getMediaBase64(instance, msg);
                        if (b64) await evolution.sendAudio(notifyZap, groupJid, b64);
                    } catch (_) {}

                } else if (text) {
                    await evolution.sendText(notifyZap, groupJid,
                        `💬 *${phone}*${nameTag} respondeu:\n${text}`);

                } else if (hasImage) {
                    await evolution.sendText(notifyZap, groupJid,
                        `🖼️ *${phone}*${nameTag} enviou uma imagem`);

                } else if (hasVideo) {
                    await evolution.sendText(notifyZap, groupJid,
                        `🎬 *${phone}*${nameTag} enviou um vídeo`);

                } else if (hasDoc) {
                    const docName = message.documentMessage?.fileName || 'arquivo';
                    await evolution.sendText(notifyZap, groupJid,
                        `📄 *${phone}*${nameTag} enviou um documento: ${docName}`);
                }
            }

        // ── Reação ─────────────────────────────────────────────────────────────
        } else if (eventName === 'MESSAGES_REACTION') {
            const key       = data?.key || {};
            const remoteJid = key?.remoteJid || '';
            if (remoteJid.includes('@g.us')) return;

            const emoji = data?.reaction?.text || '';
            if (!emoji) return; // emoji vazio = reação removida

            const phone     = phoneFromJid(remoteJid);
            if (whitelist.has(phone)) return;
            const notifyZap = (await getZapThatSent(phone)) || instance;

            await evolution.sendText(notifyZap, groupJid,
                `${emoji} *${phone}* reagiu com ${emoji}`);

        // ── Visualizou / Ouviu ─────────────────────────────────────────────────
        } else if (eventName === 'MESSAGES_UPDATE') {
            const updates = Array.isArray(data) ? data : [data];

            for (const upd of updates) {
                const key    = upd?.key || {};
                if (!key?.fromMe) continue;                        // só mensagens que enviamos

                const status    = upd?.update?.status;
                if (status !== 4 && status !== 5) continue;        // 4=lido 5=áudio ouvido

                const remoteJid = key?.remoteJid || '';
                if (remoteJid.includes('@g.us')) continue;

                const phone     = phoneFromJid(remoteJid);
                if (whitelist.has(phone)) continue;
                const notifyZap = (await getZapThatSent(phone)) || instance;

                const icon   = status === 5 ? '🎧' : '👁️';
                const action = status === 5 ? 'ouviu o áudio' : 'visualizou a mensagem';

                await evolution.sendText(notifyZap, groupJid, `${icon} *${phone}* ${action}`);
            }
        }
    } catch (err) {
        console.warn(`⚠️ [NOTIF] Erro ao processar ${eventName}:`, err.message);
    }
};

export default { handleWebhookEvent, getNotificationConfig, saveNotificationConfig };
