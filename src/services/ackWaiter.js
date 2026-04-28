// Registro de mensagens aguardando confirmação do servidor WA (SERVER_ACK).
// O webhook de messages.update chama notifyAck() quando a confirmação chega.
// preflightCheck() usa waitForAck() para verificar se o zap realmente envia.

const waiters = new Map(); // keyId → resolve(true/false)

/**
 * Aguarda SERVER_ACK para um keyId específico.
 * Resolve true se o ACK chegou, false se expirou o timeout.
 */
export const waitForAck = (keyId, timeoutMs = 8000) =>
    new Promise((resolve) => {
        const timer = setTimeout(() => {
            waiters.delete(keyId);
            resolve(false);
        }, timeoutMs);

        waiters.set(keyId, () => {
            clearTimeout(timer);
            waiters.delete(keyId);
            resolve(true);
        });
    });

/**
 * Chamado pelo webhook handler quando messages.update chega com status >= SERVER_ACK.
 */
export const notifyAck = (keyId) => {
    const fn = waiters.get(keyId);
    if (fn) fn();
};

export default { waitForAck, notifyAck };
