/**
 * Processa Spintax — transforma "{Olá|Oi} {João|amigo}!" em uma variação aleatória.
 */
export const processSpintax = (text) => {
    if (!text) return '';
    return text.replace(/\{([^{}]*)\}/g, (_, contents) => {
        const choices = contents.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });
};

/**
 * Delay humanizado — aguarda um tempo aleatório entre min e max segundos.
 */
export const humanDelay = (minSeconds, maxSeconds) => {
    const ms = Math.floor(Math.random() * ((maxSeconds - minSeconds) * 1000 + 1)) + minSeconds * 1000;
    return new Promise(resolve => setTimeout(resolve, ms));
};

export default { processSpintax, humanDelay };
