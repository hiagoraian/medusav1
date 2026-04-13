/**
 * 1. Processador de Spintax
 * Transforma strings como "Olá {João|Maria}, tudo {bem|joia}?" em variações únicas.
 */
export const processSpintax = (text) => {
    if (!text) return '';
    
    // Expressão regular que encontra padrões entre chaves {opcao1|opcao2}
    const spintaxRegex = /\{([^{}]*)\}/g;
    
    return text.replace(spintaxRegex, (match, contents) => {
        const choices = contents.split('|');
        // Escolhe uma opção aleatória matematicamente
        const randomIndex = Math.floor(Math.random() * choices.length);
        return choices[randomIndex];
    });
};

/**
 * 2. Gerador de Delays Humanos (Pausas)
 * Cria tempos de espera dinâmicos para simular digitação e leitura.
 */
export const humanDelay = (minSeconds, maxSeconds) => {
    const minMs = minSeconds * 1000;
    const maxMs = maxSeconds * 1000;
    const randomTime = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    
    return new Promise(resolve => setTimeout(resolve, randomTime));
};

/**
 * 3. Simulador de Digitação
 * Faz o status "digitando..." aparecer lá no celular do cliente antes de mandar o texto.
 */
export const simulateTyping = async (client, chatId, textLength) => {
    let typingTimeMs = textLength * 100; 
    if (typingTimeMs < 2000) typingTimeMs = 2000;
    if (typingTimeMs > 8000) typingTimeMs = 8000;

    try {
        // Pega a conversa específica antes de fingir que está digitando
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        await humanDelay(typingTimeMs / 1000, (typingTimeMs / 1000) + 1); 
        await chat.clearState();
    } catch (error) {
        console.log(`[Anti-Spam] Aviso: Não foi possível simular digitação para ${chatId}.`);
    }
};