import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Garante que a pasta temporária existe
const tempDir = path.resolve(__dirname, '../../temp_media');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// Cache simples em memória para evitar reprocessamento de arquivos (embora agora apenas retornemos o caminho)
const videoCache = new Map();

/**
 * Retorna o caminho do vídeo original. 
 * O sistema de Hash via FFmpeg foi removido para simplificação e economia de dados.
 * Implementado cache básico para evitar verificações repetidas de disco.
 */
export const generateUniqueVideoHash = async (originalFilePath) => {
    // Se já processamos este arquivo neste ciclo, retorna o cache
    if (videoCache.has(originalFilePath)) {
        return videoCache.get(originalFilePath);
    }

    if (!fs.existsSync(originalFilePath)) {
        throw new Error(`Arquivo não encontrado: ${originalFilePath}`);
    }

    // Apenas retornamos o caminho original para economizar processamento e dados móveis
    // O WhatsApp Web.js já lida com o upload e cache interno do navegador
    videoCache.set(originalFilePath, originalFilePath);
    
    console.log(`[MEDIA] Usando vídeo original (Hash simplificado): ${path.basename(originalFilePath)}`);
    return originalFilePath;
};

/**
 * Função mantida por compatibilidade, mas não apaga mais o original.
 */
export const cleanTempMedia = (filePath) => {
    // Não apagamos mais o arquivo original, apenas se fosse um arquivo temporário gerado
    if (filePath.includes('video_') && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch (err) {
            console.error('Erro ao limpar mídia temporária:', err);
        }
    }
};

export default { generateUniqueVideoHash, cleanTempMedia };
