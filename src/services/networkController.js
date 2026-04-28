import { exec } from 'child_process';
import util from 'util';
import os from 'os';

const execPromise = util.promisify(exec);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Configuração dos ZTEs ─────────────────────────────────────────────────────
// Cada ZTE gerencia 12 zaps divididos em 3 grupos (A/B/C) de 4 zaps cada.
// O orchestrator cicla A→B→C, rotacionando IP do ZTE entre cada bloco.
// Serials lidos do .env — nunca commitados (específicos de cada máquina).
const ZTE_CONFIG = {
    ZTE1: {
        serial:      process.env.ZTE_1_SERIAL || '',
        port:        8080,
        description: 'ZTE 1 (Zaps 1–12)',
        groups: {
            A: ['WA-01', 'WA-02', 'WA-03', 'WA-04'],
            B: ['WA-05', 'WA-06', 'WA-07', 'WA-08'],
            C: ['WA-09', 'WA-10', 'WA-11', 'WA-12'],
        },
    },
    ZTE2: {
        serial:      process.env.ZTE_2_SERIAL || '',
        port:        8081,
        description: 'ZTE 2 (Zaps 13–24)',
        groups: {
            A: ['WA-13', 'WA-14', 'WA-15', 'WA-16'],
            B: ['WA-17', 'WA-18', 'WA-19', 'WA-20'],
            C: ['WA-21', 'WA-22', 'WA-23', 'WA-24'],
        },
    },
    ZTE3: {
        serial:      process.env.ZTE_3_SERIAL || '',
        port:        8082,
        description: 'ZTE 3 (Zaps 25–36)',
        groups: {
            A: ['WA-25', 'WA-26', 'WA-27', 'WA-28'],
            B: ['WA-29', 'WA-30', 'WA-31', 'WA-32'],
            C: ['WA-33', 'WA-34', 'WA-35', 'WA-36'],
        },
    },
    ZTE4: {
        serial:      process.env.ZTE_4_SERIAL || '',
        port:        8083,
        description: 'ZTE 4 (Zaps 37–48)',
        groups: {
            A: ['WA-37', 'WA-38', 'WA-39', 'WA-40'],
            B: ['WA-41', 'WA-42', 'WA-43', 'WA-44'],
            C: ['WA-45', 'WA-46', 'WA-47', 'WA-48'],
        },
    },
};

// ── Helpers de mapeamento ─────────────────────────────────────────────────────

// Retorna o ZTE responsável por um accountId, ou null
export const getZteForAccount = (accountId) => {
    for (const [id, cfg] of Object.entries(ZTE_CONFIG)) {
        for (const zaps of Object.values(cfg.groups)) {
            if (zaps.includes(accountId)) return id;
        }
    }
    return null;
};

// Retorna a letra do grupo (A/B/C) de um accountId, ou null
export const getGroupForAccount = (accountId) => {
    for (const cfg of Object.values(ZTE_CONFIG)) {
        for (const [letter, zaps] of Object.entries(cfg.groups)) {
            if (zaps.includes(accountId)) return letter;
        }
    }
    return null;
};

// Retorna todos os accountIds de um grupo (A, B ou C) em todos os ZTEs
export const getZapsByGroup = (groupLetter) =>
    Object.values(ZTE_CONFIG).flatMap(cfg => cfg.groups[groupLetter] || []);

// Retorna todos os IDs de ZTE configurados
export const getActiveZteIds = () => Object.keys(ZTE_CONFIG);

// ── ADB ───────────────────────────────────────────────────────────────────────

const getAdbPath = () => {
    if (os.platform() === 'win32') return 'C:\\adb\\adb.exe';
    if (os.platform() === 'darwin') return '/usr/local/bin/adb';
    return '/usr/bin/adb';
};

const adb = async (serial, command, timeout = 10000) => {
    if (!serial) return { ok: false, out: '', err: 'Serial não configurado' };
    try {
        const { stdout } = await execPromise(`"${getAdbPath()}" -s ${serial} ${command}`, { timeout });
        return { ok: true, out: stdout.trim() };
    } catch (err) {
        return { ok: false, out: '', err: err.message };
    }
};

export const checkAdbAvailability = async () => {
    try {
        await execPromise(`"${getAdbPath()}" --version`);
        return true;
    } catch (_) {
        console.warn('⚠️ [ADB] ADB não encontrado.');
        return false;
    }
};

export const checkDeviceConnection = async (serial) => {
    if (!serial) return false;
    const r = await adb(serial, 'shell echo ok');
    return r.ok && r.out.includes('ok');
};

export const checkAllDevicesStatus = async () => {
    const available = await checkAdbAvailability();
    if (!available) return { available: false, devices: [] };

    const devices = [];
    for (const [id, cfg] of Object.entries(ZTE_CONFIG)) {
        const connected = cfg.serial ? await checkDeviceConnection(cfg.serial) : false;
        const status    = cfg.serial ? (connected ? '✅' : '❌') : '⚠️ serial não configurado';
        console.log(`🔌 ${cfg.description}: ${status}`);
        devices.push({ id, port: cfg.port, serial: cfg.serial, description: cfg.description, connected });
    }
    return { available: true, devices };
};

export const setupAdbForward = async (port, serial, retries = 3) => {
    if (!serial) {
        console.warn(`⚠️ [ADB] Serial não configurado para porta ${port}. Pulando forward.`);
        return false;
    }
    for (let i = 1; i <= retries; i++) {
        const r = await adb(serial, `forward tcp:${port} tcp:${port}`);
        if (r.ok) {
            console.log(`✅ [ADB] Forward ${serial} → :${port}`);
            return true;
        }
        console.warn(`⚠️ [ADB] Forward falhou (${i}/${retries}): ${r.err}`);
        if (i < retries) await sleep(2000);
    }
    return false;
};

export const setupAllAdbForwards = async () => {
    if (!await checkAdbAvailability()) return false;
    let ok = true;
    for (const cfg of Object.values(ZTE_CONFIG)) {
        if (!cfg.serial) continue; // pula ZTE sem serial configurado
        if (!await setupAdbForward(cfg.port, cfg.serial)) ok = false;
    }
    return ok;
};

// ── Proxy / Conexão 4G ────────────────────────────────────────────────────────

export const isMobileConnectionActive = async (port) => {
    try {
        const nullDev = os.platform() === 'win32' ? 'NUL' : '/dev/null';
        const { stdout } = await execPromise(
            `curl -s -o ${nullDev} -w "%{http_code}" --proxy 127.0.0.1:${port} http://www.google.com --connect-timeout 5`,
            { timeout: 8000 }
        );
        return stdout.trim() === '200';
    } catch (_) {
        return false;
    }
};

export const getProxyConfigForAccount = async (accountId) => {
    const zteId = getZteForAccount(accountId);
    if (!zteId) return null;
    const cfg = ZTE_CONFIG[zteId];
    if (!cfg.serial) return null;
    const active = await isMobileConnectionActive(cfg.port);
    if (active) {
        console.log(`[NET] ${accountId} → 4G (porta ${cfg.port})`);
        return { host: 'host.docker.internal', port: cfg.port };
    }
    console.warn(`⚠️ [NET] ${accountId} → 4G indisponível na porta ${cfg.port}. Usando Wi-Fi.`);
    return null;
};

// ── Rotação de IP ─────────────────────────────────────────────────────────────

export const rotateZteIP = async (zteId) => {
    const cfg = ZTE_CONFIG[zteId];
    if (!cfg) return false;
    if (!cfg.serial) {
        console.warn(`⚠️ [ROTATE] ${cfg.description} sem serial. Pulando rotação.`);
        return false;
    }

    console.log(`\n✈️  [ROTATE] ${cfg.description} — iniciando rotação de IP...`);

    const connected = await checkDeviceConnection(cfg.serial);
    if (!connected) {
        console.warn(`⚠️ [ROTATE] ${cfg.description} não responde no ADB. Pulando rotação.`);
        return false;
    }

    await adb(cfg.serial, 'shell cmd connectivity airplane-mode enable');
    console.log(`✈️  [ROTATE] Modo avião ON — ${cfg.description}`);
    await sleep(30000);

    await adb(cfg.serial, 'shell cmd connectivity airplane-mode disable');
    console.log(`📶 [ROTATE] Modo avião OFF — ${cfg.description}. Aguardando reconexão...`);
    await sleep(120000);

    const ok = await isMobileConnectionActive(cfg.port);
    console.log(ok
        ? `✅ [ROTATE] ${cfg.description} reconectado com novo IP.`
        : `⚠️ [ROTATE] ${cfg.description} não reconectou no 4G. Seguindo com Wi-Fi.`
    );
    return ok;
};

// Rotaciona IPs de todos os ZTEs de forma escalonada (90s entre cada um).
export const rotateMobileIPsStaggered = async (zteIds = Object.keys(ZTE_CONFIG)) => {
    const configured = zteIds.filter(id => ZTE_CONFIG[id]?.serial);
    if (configured.length === 0) {
        console.log('⚠️ [ROTATE] Nenhum ZTE com serial configurado. Rotação ignorada.');
        return;
    }

    if (!await checkAdbAvailability()) {
        console.warn('⚠️ [ROTATE] ADB indisponível. Rotação de IP ignorada.');
        return;
    }

    console.log(`\n🔄 [ROTATE] Iniciando rotação escalonada: ${configured.join(', ')}`);
    for (let i = 0; i < configured.length; i++) {
        if (i > 0) {
            console.log(`⏳ [ROTATE] Aguardando 90s antes de rotar ${configured[i]}...`);
            await sleep(90000);
        }
        await rotateZteIP(configured[i]);
    }
    console.log('✅ [ROTATE] Rotação de IPs concluída.\n');
};

export default {
    ZTE_CONFIG, getZteForAccount, getGroupForAccount, getZapsByGroup, getActiveZteIds,
    checkAdbAvailability, checkDeviceConnection, checkAllDevicesStatus,
    setupAllAdbForwards, isMobileConnectionActive, getProxyConfigForAccount,
    rotateZteIP, rotateMobileIPsStaggered,
};
