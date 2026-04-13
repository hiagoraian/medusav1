import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getClientInstance } from '../whatsapp/manager.js';
import { humanDelay, simulateTyping } from './antiSpam.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WARMUP_FILE_PATH = path.resolve(__dirname, '../../textAquecimento.txt');

let isWarmupRunning = false;

/**
 * Carrega as frases do arquivo textAquecimento.txt
 */
const loadWarmupPhrases = () => {
    try {
        if (!fs.existsSync(WARMUP_FILE_PATH)) {
            const defaultPhrases = [
                "Olá, tudo bem?", "Como vai você?", "Bom dia!", "Boa tarde!",
                "Você viu as notícias de hoje?", "O que você acha disso?",
                "Sim, concordo plenamente.", "Não tenho certeza sobre isso.",
                "Vou verificar e te aviso.", "Até logo!", "Tchau!", "Ok, combinado."
            ];
            fs.writeFileSync(WARMUP_FILE_PATH, defaultPhrases.join('\n'), 'utf8');
            return defaultPhrases;
        }
        const content = fs.readFileSync(WARMUP_FILE_PATH, 'utf8');
        return content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    } catch (error) {
        console.error('❌ [AQUECIMENTO] Erro ao carregar frases:', error.message);
        return ["Oi", "Tudo bem?", "Sim", "Não"];
    }
};

/**
 * Escolhe uma frase aleatória do arquivo
 */
const getRandomPhrase = (phrases) => {
    return phrases[Math.floor(Math.random() * phrases.length)];
};

/**
 * Obtém o ID do WhatsApp do cliente de forma segura
 */
const getClientNumber = (client) => {
    try {
        if (client && client.info && client.info.wid) {
            return client.info.wid._serialized;
        }
        return null;
    } catch (e) {
        return null;
    }
};

/**
 * Verifica se o cliente está realmente pronto para enviar mensagens
 */
const isClientReady = (client) => {
    try {
        return client && client.pupPage && !client.pupPage.isClosed();
    } catch (e) {
        return false;
    }
};

/**
 * Executa uma conversa de IDA E VOLTA entre dois chips
 */
export const warmupChipConversation = async (fromAccountId, toAccountId) => {
    const fromClient = getClientInstance(fromAccountId);
    const toClient   = getClientInstance(toAccountId);

    // Validação de prontidão dos clientes
    if (!isClientReady(fromClient) || !isClientReady(toClient)) {
        console.log(`⚠️ [AQUECIMENTO] Aguardando prontidão total de ${fromAccountId} ou ${toAccountId}...`);
        return;
    }

    try {
        const phrases = loadWarmupPhrases();
        const fromId = getClientNumber(fromClient);
        const toId = getClientNumber(toClient);

        if (!fromId || !toId) {
            console.log(`⚠️ [AQUECIMENTO] IDs de WhatsApp não disponíveis para ${fromAccountId} ou ${toAccountId}.`);
            return;
        }

        // --- FASE 1: IDA (A -> B) ---
        const phrase1 = getRandomPhrase(phrases);
        console.log(`🔥 [AQUECIMENTO] ${fromAccountId} -> ${toAccountId}: "${phrase1}"`);
        
        await simulateTyping(fromClient, toId, phrase1.length);
        await fromClient.sendMessage(toId, phrase1);

        // Delay para simular tempo de leitura e início da resposta
        await humanDelay(8, 15);

        if (!isWarmupRunning) return;

        // --- FASE 2: VOLTA (B -> A) ---
        const phrase2 = getRandomPhrase(phrases);
        console.log(`🔥 [AQUECIMENTO] ${toAccountId} -> ${fromAccountId}: "${phrase2}" (Resposta)`);
        
        await simulateTyping(toClient, fromId, phrase2.length);
        await toClient.sendMessage(fromId, phrase2);

        // Delay final da conversa
        await humanDelay(5, 10);

    } catch (error) {
        // Silencia erros de 'getChat' ou 'undefined' se o cliente desconectar no meio
        if (error.message.includes('undefined') || error.message.includes('closed')) {
            console.log(`⚠️ [AQUECIMENTO] Conexão instável entre ${fromAccountId} e ${toAccountId}. Pulando...`);
        } else {
            console.error(`❌ [AQUECIMENTO] Erro na conversa entre ${fromAccountId} e ${toAccountId}:`, error.message);
        }
    }
};

/**
 * Inicia o processo de aquecimento contínuo entre todos os chips selecionados
 */
export const startWarmup = async (accountsList) => {
    if (accountsList.length < 2) {
        console.warn('⚠️ [AQUECIMENTO] Necessário pelo menos 2 contas para aquecer.');
        return;
    }

    isWarmupRunning = true;
    console.log(`\n🔥 [AQUECIMENTO] Iniciando aquecimento em PARES (Ida e Volta) entre ${accountsList.length} contas...`);
    console.log(`📄 Usando frases de: ${WARMUP_FILE_PATH}`);

    while (isWarmupRunning) {
        // Embaralha a lista para criar pares aleatórios
        const shuffled = [...accountsList].sort(() => 0.5 - Math.random());
        
        // Tenta realizar conversas em pares
        for (let i = 0; i < shuffled.length - 1; i += 2) {
            if (!isWarmupRunning) break;
            
            const from = shuffled[i];
            const to = shuffled[i+1];
            
            await warmupChipConversation(from, to);
            
            // Intervalo entre diferentes pares
            await humanDelay(10, 20);
        }

        // Pequena pausa antes de re-embaralhar e começar nova rodada de pares
        await humanDelay(15, 30);
        
        if (!isWarmupRunning) break;
    }
    
    console.log('🛑 [AQUECIMENTO] Processo de aquecimento parado.');
};

/**
 * Para o processo de aquecimento
 */
export const stopWarmup = () => {
    isWarmupRunning = false;
    console.log('⏳ [AQUECIMENTO] Solicitando parada do aquecimento...');
};

/**
 * Função de aquecimento rápido (usada após ciclos de disparo)
 */
export const quickWarmupAfterCycle = async (accountsList, durationMinutes = 5) => {
    console.log(`\n🔥 [AQUECIMENTO] Iniciando aquecimento rápido de ${durationMinutes} min pós-ciclo...`);
    
    const endTime = Date.now() + (durationMinutes * 60 * 1000);
    
    while (Date.now() < endTime) {
        const shuffled = [...accountsList].sort(() => 0.5 - Math.random());
        const from = shuffled[0];
        const to = shuffled[1];

        await warmupChipConversation(from, to);
        
        // Intervalo menor para aquecimento rápido
        await humanDelay(5, 10);
    }
    
    console.log('✅ [AQUECIMENTO] Aquecimento rápido concluído.');
};

export default { startWarmup, stopWarmup, quickWarmupAfterCycle, warmupChipConversation };
