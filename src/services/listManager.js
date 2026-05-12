import xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const LISTAS_DIR  = path.join(__dirname, '../../listas');
const ACTIVE_FILE = path.join(LISTAS_DIR, 'listas_ativas.json');

const VALID_DDDS = new Set([
    11,12,13,14,15,16,17,18,19,
    21,22,24,27,28,
    31,32,33,34,35,37,38,
    41,42,43,44,45,46,47,48,49,
    51,53,54,55,
    61,62,63,64,65,66,67,68,69,
    71,73,74,75,77,79,
    81,82,83,84,85,86,87,88,89,
    91,92,93,94,95,96,97,98,99,
]);

const normalizePhone = (raw) => {
    let phone = String(raw).replace(/\D/g, '');
    if (!phone) return null;
    if (phone.startsWith('0')) phone = phone.slice(1);
    if (!phone.startsWith('55') && phone.length >= 10) phone = '55' + phone;
    if (!phone.startsWith('55') || phone.length < 12 || phone.length > 13) return null;
    const ddd   = parseInt(phone.slice(2, 4), 10);
    const local = phone.slice(4);
    if (!VALID_DDDS.has(ddd)) return null;
    if (local.length === 9 && local[0] !== '9') return null;
    return phone;
};

const ensureDir = () => {
    if (!fs.existsSync(LISTAS_DIR)) fs.mkdirSync(LISTAS_DIR, { recursive: true });
};

export const readActiveState = () => {
    try {
        if (fs.existsSync(ACTIVE_FILE)) return JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    } catch (_) {}
    return {};
};

const writeActiveState = (state) => {
    ensureDir();
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(state, null, 2), 'utf8');
};

/** Returns all xlsx files with metadata (name, size, count, active, isTemp). */
export const getAllLists = () => {
    ensureDir();
    const active = readActiveState();
    return fs.readdirSync(LISTAS_DIR)
        .filter(f => /\.(xlsx|xls)$/i.test(f) && !f.startsWith('.'))
        .sort()
        .map(f => {
            const fpath = path.join(LISTAS_DIR, f);
            const size  = fs.statSync(fpath).size;
            const phones = readListPhones(f);
            return {
                name:   f,
                size,
                count:  phones.length,
                active: active[f] !== false,
                isTemp: f.startsWith('Temp_'),
            };
        });
};

/** Reads and returns an array of normalized phone numbers from a list file. */
export const readListPhones = (filename) => {
    try {
        const fpath  = path.join(LISTAS_DIR, path.basename(filename));
        const buffer = fs.readFileSync(fpath);
        const wb     = xlsx.read(buffer, { type: 'buffer' });
        const ws     = wb.Sheets[wb.SheetNames[0]];
        const rows   = xlsx.utils.sheet_to_json(ws, { header: 1 });
        const phones = [];
        const seen   = new Set();
        for (const row of rows) {
            if (!row || !row[0]) continue;
            const n = normalizePhone(row[0]);
            if (n && !seen.has(n)) { seen.add(n); phones.push(n); }
        }
        return phones;
    } catch (_) { return []; }
};

/** Writes an array of phone strings to a xlsx file (one per row). */
export const writeListPhones = (filename, phones) => {
    ensureDir();
    const fpath = path.join(LISTAS_DIR, path.basename(filename));
    // Força tipo string para evitar notação científica no Excel
    const ws    = xlsx.utils.aoa_to_sheet(phones.map(p => [{ v: String(p), t: 's' }]));
    const wb    = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Contatos');
    xlsx.writeFile(wb, fpath);
};

/** Adds a phone to a list. Throws if invalid or duplicate. Returns normalized phone. */
export const addPhoneToList = (filename, rawPhone) => {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new Error(`Número inválido: ${rawPhone}`);
    const phones = readListPhones(filename);
    if (phones.includes(phone)) throw new Error(`Número ${phone} já está na lista.`);
    phones.push(phone);
    writeListPhones(filename, phones);
    return phone;
};

/** Removes a phone from a list. Throws if not found. */
export const removePhoneFromList = (filename, phone) => {
    const phones   = readListPhones(filename);
    const filtered = phones.filter(p => p !== phone);
    if (filtered.length === phones.length) throw new Error(`Número ${phone} não encontrado.`);
    writeListPhones(filename, filtered);
};

/** Merges multiple list files with deduplication. Returns merged phones array. */
export const mergeLists = (filenames) => {
    const seen   = new Set();
    const merged = [];
    for (const f of filenames) {
        for (const p of readListPhones(f)) {
            if (!seen.has(p)) { seen.add(p); merged.push(p); }
        }
    }
    return merged;
};

/** Splits phones into N equal parts, saves each as Temp_<baseName>_PartX.xlsx. */
export const splitIntoN = (phones, n, baseName) => {
    const size  = Math.ceil(phones.length / n);
    const parts = [];
    for (let i = 0; i < n; i++) {
        const chunk = phones.slice(i * size, (i + 1) * size);
        if (!chunk.length) break;
        const filename = `Temp_${baseName}_Part${i + 1}.xlsx`;
        writeListPhones(filename, chunk);
        parts.push({ filename, count: chunk.length });
    }
    return parts;
};

/** Sets the active flag for a list in listas_ativas.json. */
export const setListActive = (filename, active) => {
    const state = readActiveState();
    state[path.basename(filename)] = !!active;
    writeActiveState(state);
};

/** Deletes a list file and removes it from listas_ativas.json. */
export const deleteList = (filename) => {
    const name  = path.basename(filename);
    const fpath = path.join(LISTAS_DIR, name);
    if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
    const state = readActiveState();
    delete state[name];
    writeActiveState(state);
};

export default {
    getAllLists, readListPhones, writeListPhones,
    addPhoneToList, removePhoneFromList,
    mergeLists, splitIntoN,
    setListActive, deleteList, readActiveState,
};
