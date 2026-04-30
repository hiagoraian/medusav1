// Registro de mensagens aguardando confirmação do servidor WA (SERVER_ACK).
// O webhook de messages.update chama notifyAck() quando a confirmação chega.

const waiters  = new Map(); // keyId → resolve fn
const preAcked = new Map(); // ACKs que chegaram antes do waitForAck ser registrado

/**
 * Aguarda SERVER_ACK para um keyId específico.
 * Resolve true se ACK chegou, false se expirou o timeout.
 * Trata a race condition onde o ACK chega antes do registro.
 */
export const waitForAck = (keyId, timeoutMs = 8000) => {
    if (preAcked.has(keyId)) {
        preAcked.delete(keyId);
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
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
};

/**
 * Chamado pelo webhook handler quando messages.update chega com status >= SERVER_ACK.
 */
export const notifyAck = (keyId) => {
    const fn = waiters.get(keyId);
    if (fn) {
        fn();
    } else {
        // ACK chegou antes do waitForAck — guarda por 2 minutos
        preAcked.set(keyId, true);
        setTimeout(() => preAcked.delete(keyId), 120_000);
    }
};

export default { waitForAck, notifyAck };
