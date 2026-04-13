/**
 * Calculador de Delays Adaptativos
 * Baseado em mensagens por hora, calcula o delay entre disparos por zap
 */

/**
 * Calcula o delay em ms entre disparos para atingir a meta de mensagens por hora
 * @param {number} msgsPerHour - Meta de mensagens por hora (ex: 45)
 * @returns {number} Delay em milissegundos entre disparos
 */
export const calculateAdaptiveDelay = (msgsPerHour) => {
    if (!msgsPerHour || msgsPerHour <= 0) return 5000; // Default 5 segundos
    
    // 1 hora = 3600 segundos = 3.600.000 ms
    const msPerHour = 3600000;
    
    // Delay base = tempo total / quantidade de mensagens
    let baseDelay = msPerHour / msgsPerHour;
    
    // Adiciona variação humana (±20%)
    const variation = baseDelay * 0.2;
    const minDelay = baseDelay - variation;
    const maxDelay = baseDelay + variation;
    
    // Retorna um valor aleatório dentro da faixa
    const randomDelay = Math.random() * (maxDelay - minDelay) + minDelay;
    
    return Math.floor(randomDelay);
};

/**
 * Calcula o delay com "esquenta" (warm-up) no início
 * Começa lento e vai acelerando gradualmente
 * @param {number} msgsPerHour - Meta de mensagens por hora
 * @param {number} messageNumber - Número sequencial da mensagem (1, 2, 3...)
 * @param {number} totalMessages - Total de mensagens a enviar
 * @returns {number} Delay em milissegundos
 */
export const calculateWarmupDelay = (msgsPerHour, messageNumber, totalMessages) => {
    const baseDelay = calculateAdaptiveDelay(msgsPerHour);
    
    // Primeiros 10% das mensagens: delay 50% maior (esquenta)
    const warmupThreshold = Math.ceil(totalMessages * 0.1);
    
    if (messageNumber <= warmupThreshold) {
        // Progressão: começa com 80% de aumento, vai diminuindo
        const progressPercentage = messageNumber / warmupThreshold;
        const extraDelay = baseDelay * 0.8 * (1 - progressPercentage);
        return Math.floor(baseDelay + extraDelay);
    }
    
    // Depois do aquecimento: delay normal com variação
    return baseDelay;
};

/**
 * Calcula delays por zap baseado no total de disparos e zaps selecionados
 * @param {number} totalDispatch - Total de disparos (ex: 300)
 * @param {number} selectedZaps - Quantidade de zaps selecionados (ex: 10)
 * @param {number} msgsPerHour - Meta de mensagens por hora por zap
 * @returns {Object} { delayPerZap, totalTime, cyclesNeeded }
 */
export const calculateDistributionDelay = (totalDispatch, selectedZaps, msgsPerHour) => {
    // Mensagens por zap
    const msgsPerZap = Math.ceil(totalDispatch / selectedZaps);
    
    // Delay adaptativo para cada zap
    const delayPerZap = calculateAdaptiveDelay(msgsPerHour);
    
    // Tempo total estimado
    const totalTimeMs = msgsPerZap * delayPerZap;
    const totalTimeMinutes = Math.floor(totalTimeMs / 60000);
    const totalTimeHours = (totalTimeMinutes / 60).toFixed(2);
    
    // Quantos ciclos (ondas) serão necessários
    const cyclesNeeded = Math.ceil(msgsPerZap / selectedZaps);
    
    return {
        msgsPerZap,
        delayPerZap,
        totalTimeMs,
        totalTimeMinutes,
        totalTimeHours,
        cyclesNeeded
    };
};

/**
 * Gera um delay com variação humana para parecer mais natural
 * @param {number} baseDelay - Delay base em ms
 * @returns {number} Delay com variação
 */
export const addHumanVariation = (baseDelay) => {
    // Variação de ±15%
    const variation = baseDelay * 0.15;
    const min = baseDelay - variation;
    const max = baseDelay + variation;
    return Math.floor(Math.random() * (max - min) + min);
};

/**
 * Calcula delay para rotação de IP (entre ciclos)
 * Mais longo para parecer natural
 * @returns {number} Delay em milissegundos
 */
export const calculateIPRotationDelay = () => {
    // Entre 15 a 30 segundos para rotação de IP
    return Math.floor(Math.random() * 15000) + 15000;
};
