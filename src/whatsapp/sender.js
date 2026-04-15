import wwebjs from 'whatsapp-web.js';
import { processSpintax, simulateTyping, humanDelay } from '../services/antiSpam.js';
import { generateUniqueVideoHash, cleanTempMedia } from '../services/mediaProcessor.js';

const { MessageMedia } = wwebjs;

/**
 * Função responsável por executar o disparo individual aplicando todas as regras de segurança.
 * @param {Object} client - A instância conectada do whatsapp-web.js
 * @param {string} phone - O número de destino (ex: 5511999999999)
 * @param {string} rawText - O texto com Spintax
 * @param {string} mediaPath - (Opcional) Caminho do vídeo ou imagem original
 * @param {string} mediaMode - (Opcional) 'caption' (legenda) ou 'separate' (separado)
 */
/** Remove formatação e garante que o número tenha apenas dígitos. */
const normalizePhone = (phone) => String(phone).replace(/\D/g, '');

/** Envolve uma promise com timeout para evitar hang infinito no WhatsApp Web. */
const withTimeout = (promise, ms, label) =>
    Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout (${ms}ms) em: ${label}`)), ms)
        )
    ]);

export const executeSend = async (client, phone, rawText, mediaPath = null, mediaMode = 'caption') => {
    try {
        if (!client) {
            return { success: false, status: 'falha', error: 'Cliente não está conectado.' };
        }

        const normalizedPhone = normalizePhone(phone);
        if (normalizedPhone.length < 10) {
            return { success: false, status: 'invalido', error: `Número inválido: "${phone}"` };
        }

        // Retry até 3x para erros de WA interno ainda não inicializado (WidFactory/Store).
        // Acontece quando o cliente acabou de conectar e o WA Web ainda está carregando.
        let contactId = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                contactId = await withTimeout(
                    client.getNumberId(normalizedPhone),
                    15000,
                    `getNumberId(${normalizedPhone})`
                );
                break;
            } catch (err) {
                const waNotReady =
                    err.message?.includes('WidFactory') ||
                    err.message?.includes('Store') ||
                    err.message?.includes('Execution context');

                if (waNotReady && attempt < 3) {
                    console.log(`[sender] WA interno não pronto (tentativa ${attempt}/3). Aguardando 4s...`);
                    await new Promise(r => setTimeout(r, 4000));
                } else {
                    throw err;
                }
            }
        }

        if (!contactId) {
            return { success: false, status: 'invalido', error: 'Número não possui WhatsApp.' };
        }

        const chatId = contactId._serialized;

        // 1. Processa o texto quebrando a Spintax
        const finalText = processSpintax(rawText);

        // 2. Simula o comportamento humano
        await humanDelay(2, 5);
        if (finalText) {
            await simulateTyping(client, chatId, finalText.length);
        }

        // 3. Lógica de Envio
        if (!mediaPath) {
            // CENÁRIO A: Apenas Texto
            await client.sendMessage(chatId, finalText);
            
        } else {
            // CENÁRIO B: Com Mídia
            const safeMediaPath = await generateUniqueVideoHash(mediaPath);
            const media = MessageMedia.fromFilePath(safeMediaPath);

            if (mediaMode === 'caption') {
                // Envia a mídia com o texto na legenda
                await client.sendMessage(chatId, media, { caption: finalText });
            } else {
                // Envia separado: Primeiro o texto, depois a mídia
                if (finalText) {
                    await client.sendMessage(chatId, finalText);
                    await humanDelay(3, 6);
                }
                await client.sendMessage(chatId, media);
            }

            // Limpa a mídia temporária
            cleanTempMedia(safeMediaPath);
        }

        // Sucesso absoluto
        return { success: true, status: 'enviado' };

    } catch (error) {
        console.error(`❌ Erro ao enviar para ${phone}:`, error.message);
        return { success: false, status: 'falha', error: error.message };
    }
};
