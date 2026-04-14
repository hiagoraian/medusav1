import { exec } from 'child_process';
import util from 'util';
import os from 'os';

const execPromise = util.promisify(exec);

// Configuração dos dispositivos ZTE por porta (Cada celular em sua porta correta)
// Reestruturado para 24 números: 
// ZTE 1: 1-8 (Porta 8080)
// ZTE 2: 9-16 (Porta 8081)
// ZTE 3: 17-24 (Porta 8082)
const ZTE_CONFIG = {
    8080: {
        deviceId: '320436309078',
        description: 'ZTE 1 (Zaps 1-8)',
        port: 8080
    },
    8081: {
        deviceId: '320436306469',
        description: 'ZTE 2 (Zaps 9-16)',
        port: 8081
    },
    8082: {
        deviceId: '320436306616',
        description: 'ZTE 3 (Zaps 17-24)',
        port: 8082
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Detecta o caminho do ADB baseado no SO
 */
const getAdbPath = () => {
    const platform = os.platform();
    if (platform === 'win32') return 'C:\\adb\\adb.exe';
    if (platform === 'darwin') return '/usr/local/bin/adb';
    return '/usr/bin/adb';
};

/**
 * Verifica se o ADB está disponível
 */
const checkAdbAvailability = async () => {
    try {
        const adbPath = getAdbPath();
        await execPromise(`"${adbPath}" --version`);
        return true;
    } catch (error) {
        console.warn('⚠️ [REDE] ADB não encontrado no caminho padrão.');
        return false;
    }
};

/**
 * Executa comando ADB com tratamento de erro e timeout
 */
const executeAdbCommand = async (deviceId, command, timeout = 10000) => {
    try {
        const adbPath = getAdbPath();
        const fullCommand = `"${adbPath}" -s ${deviceId} ${command}`;
        const { stdout } = await execPromise(fullCommand, { timeout });
        return { success: true, output: stdout, error: null };
    } catch (error) {
        return { success: false, output: null, error: error.message };
    }
};

/**
 * Verifica se o dispositivo está conectado
 */
export const checkDeviceConnection = async (deviceId) => {
    const result = await executeAdbCommand(deviceId, 'shell echo "connected"');
    return result.success && result.output.includes('connected');
};

/**
 * Verifica o status de todos os dispositivos
 */
export const checkAllDevicesStatus = async () => {
    console.log('\n📱 [REDE] Verificando status de todos os dispositivos...\n');
    const adbAvailable = await checkAdbAvailability();
    if (!adbAvailable) return { available: false, devices: [] };
    
    const deviceStatus = [];
    for (const [port, config] of Object.entries(ZTE_CONFIG)) {
        const isConnected = await checkDeviceConnection(config.deviceId);
        console.log(`🔌 Porta ${port} - ${config.description}: ${isConnected ? '✅ Conectado' : '❌ Desconectado'}`);
        deviceStatus.push({ port, deviceId: config.deviceId, connected: isConnected });
    }
    return { available: true, devices: deviceStatus };
};

/**
 * Configura o forward de porta ADB com retries
 */
export const setupAdbForward = async (port, deviceId, retries = 3) => {
    const adbPath = getAdbPath();
    const forwardCmd = `"${adbPath}" -s ${deviceId} forward tcp:${port} tcp:${port}`;
    
    for (let i = 1; i <= retries; i++) {
        try {
            await execPromise(forwardCmd);
            console.log(`✅ [REDE] Forward configurado: ${deviceId} → porta ${port}`);
            return true;
        } catch (error) {
            console.warn(`⚠️ [REDE] Tentativa ${i}/${retries} falhou para ${deviceId}: ${error.message}`);
            if (i < retries) await sleep(2000);
        }
    }
    console.error(`❌ [REDE] Falha definitiva ao configurar forward para ${deviceId}`);
    return false;
};

/**
 * Configura todos os forwards de porta necessários
 */
export const setupAllAdbForwards = async () => {
    console.log('\n🔗 [REDE] Configurando forwards de porta ADB...\n');
    const adbAvailable = await checkAdbAvailability();
    if (!adbAvailable) return false;
    
    let allSuccess = true;
    for (const [port, config] of Object.entries(ZTE_CONFIG)) {
        const success = await setupAdbForward(port, config.deviceId);
        if (!success) allSuccess = false;
    }
    return allSuccess;
};

/**
 * Liga o Modo Avião em um dispositivo
 */
export const enableAirplaneMode = async (deviceId) => {
    const result = await executeAdbCommand(deviceId, 'shell cmd connectivity airplane-mode enable');
    if (result.success) {
        console.log(`✈️ [REDE] Modo Avião LIGADO: ${deviceId}`);
        return true;
    }
    return false;
};

/**
 * Desliga o Modo Avião em um dispositivo
 */
export const disableAirplaneMode = async (deviceId) => {
    const result = await executeAdbCommand(deviceId, 'shell cmd connectivity airplane-mode disable');
    if (result.success) {
        console.log(`📶 [REDE] Modo Avião DESLIGADO: ${deviceId}`);
        return true;
    }
    return false;
};

/**
 * Rotação de IP para um dispositivo específico
 */
export const rotateDeviceIP = async (deviceId) => {
    try {
        console.log(`\n🔄 [REDE] Rotacionando IP do dispositivo: ${deviceId}`);
        if (!await checkDeviceConnection(deviceId)) {
            console.warn(`⚠️ [REDE] Dispositivo ${deviceId} desconectado. Pulando rotação.`);
            return false;
        }
        
        await enableAirplaneMode(deviceId);
        await sleep(15000);
        await disableAirplaneMode(deviceId);
        await sleep(5000);
        return true;
    } catch (error) {
        return false;
    }
};

/**
 * Rotação de IPs em lote
 */
export const rotateMobileIPs = async () => {
    console.log('\n🔄 INICIANDO ROTAÇÃO DE IPs (Modo Avião)');
    const adbAvailable = await checkAdbAvailability();
    if (!adbAvailable) return false;
    
    const uniqueDevices = [...new Set(Object.values(ZTE_CONFIG).map(c => c.deviceId))];
    for (const deviceId of uniqueDevices) {
        await rotateDeviceIP(deviceId);
    }
    return true;
};

/**
 * Verifica se a conexão móvel (via ADB forward) está ativa.
 * Caso falhe, o sistema deve usar o Wi-Fi do PC.
 */
export const isMobileConnectionActive = async (port) => {
    try {
        // /dev/null não existe no Windows — usa NUL no Windows e /dev/null nos demais.
        // Bug anterior: no Windows a chamada sempre lançava erro silencioso e retornava
        // false, fazendo TODOS os zaps ignorarem o proxy e usarem o Wi-Fi do PC.
        const nullDevice = os.platform() === 'win32' ? 'NUL' : '/dev/null';
        const { stdout } = await execPromise(
            `curl -s -o ${nullDevice} -w "%{http_code}" --proxy 127.0.0.1:${port} http://www.google.com --connect-timeout 5`,
            { timeout: 8000 }
        );
        return stdout.trim() === '200';
    } catch (error) {
        return false;
    }
};

export default {
    checkDeviceConnection,
    checkAllDevicesStatus,
    setupAdbForward,
    setupAllAdbForwards,
    rotateMobileIPs,
    getAdbPath,
    checkAdbAvailability,
    isMobileConnectionActive,
    ZTE_CONFIG
};
