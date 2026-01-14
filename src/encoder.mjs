// FILE: src/encoder.mjs
import fs from 'fs-extra';
import path from 'path';
import { decodeLocalPath, isHttp, isDataUri, logSaving } from './utils.mjs';
import { CONFIG, OVERRIDE_DIR_NAME } from './config.mjs';
import { state, dataUriCache, fileCache } from './state.mjs';
import { optimizeByMime } from './optimizers/index.mjs';
import { MIME } from './constants.mjs';

// Кодування буфера у data:URI
export const toDataUri = (mime, buffer) =>
    `data:${mime};base64,${buffer.toString('base64')}`;

// Розбір data:URI → {mime, buffer}
export const fromDataUri = (dataUri) => {
    // приклад: data:image/png;base64,AAAA...
    const m = /^data:([^;,]+)(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(dataUri);
    if (!m) return null;
    const mime = m[1].toLowerCase();
    const isB64 = !!m[2];
    const data = m[3];
    try {
        const buffer = isB64 ? Buffer.from(decodeURIComponent(data), 'base64')
            : Buffer.from(decodeURIComponent(data), 'utf8');
        return { mime, buffer };
    } catch { return null; }
};

// Перекодувати існуючий data:URI (із кешем)
export const reencodeDataUri = async (dataUri) => {
    if (dataUriCache.has(dataUri)) return dataUriCache.get(dataUri);
    const parsed = fromDataUri(dataUri);
    if (!parsed) return dataUri;

    const { mime, buffer } = parsed;
    const before = buffer.length;
    const optimized = await optimizeByMime(buffer, mime);
    const out = toDataUri(mime, optimized);
    logSaving(`data:${mime}`, before, optimized.length);
    dataUriCache.set(dataUri, out);
    return out;
};

// Інлайн файлу на диску (із кешем)
export const encodeFile = async (fileAbsPath) => {
    if (!await fs.pathExists(fileAbsPath)) return null;
    if (fileCache.has(fileAbsPath)) return fileCache.get(fileAbsPath);

    const ext = path.extname(fileAbsPath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const original = await fs.readFile(fileAbsPath);
    const before = original.length;
    let outBuf = original;

    try {
        outBuf = await optimizeByMime(original, mime);
    } catch {
        outBuf = original;
    }

    const finalBuf = outBuf.length <= original.length ? outBuf : original;
    logSaving(path.basename(fileAbsPath), before, finalBuf.length);

    const dataUri = toDataUri(mime, finalBuf);
    fileCache.set(fileAbsPath, dataUri);
    return dataUri;
};

// Завантажити http(s) ресурс (якщо дозволено) і закодувати
export const fetchAndEncode = async (url) => {
    if (!CONFIG.externals.fetch || typeof fetch !== 'function') return null;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const arrBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrBuf);
        // Спробуємо визначити mime
        let mime = res.headers.get('content-type')?.split(';')[0]?.trim() || '';
        if (!mime) {
            const ext = path.extname(new URL(url).pathname).toLowerCase();
            mime = MIME[ext] || 'application/octet-stream';
        }
        const before = buf.length;
        const optimized = await optimizeByMime(buf, mime);
        logSaving(url, before, optimized.length);
        return toDataUri(mime, optimized);
    } catch {
        return null;
    }
};

// Уніфікований процесор URI (локальний шлях, http(s), data:)
export const processUri = async (uri, baseDir) => {
    if (!uri) return uri;
    if (isDataUri(uri)) return await reencodeDataUri(uri);

    let cleanUri = uri;
    if (isHttp(uri)) {
        // Check override for HTTP (basename only)
        if (state.projectRoot) {
            const bname = path.basename(new URL(uri).pathname);
            const overridePath = path.join(state.projectRoot, OVERRIDE_DIR_NAME, bname);
            if (await fs.pathExists(overridePath)) {
                console.log(`⚡ Override used for ${uri} -> ${OVERRIDE_DIR_NAME}/${bname}`);
                return (await encodeFile(overridePath)) || uri;
            }
        }
        const fetched = await fetchAndEncode(uri);
        return fetched || uri;
    }

    const decoded = decodeLocalPath(uri);
    // Check override for Local File
    if (state.projectRoot) {
        // 1. Try relative path from Project Root (preserving subdir structure)
        // Full path logic: baseDir + decoded -> relative to PROJECT_ROOT
        const fullOriginal = path.resolve(baseDir, decoded);
        const relToRoot = path.relative(state.projectRoot, fullOriginal);

        // Security check: don't allow escaping up
        if (!relToRoot.startsWith('..') && !path.isAbsolute(relToRoot)) {
            // Normalize slashes for Windows: "assets\img.png" -> "assets/img.png"
            const relSafe = relToRoot.split(path.sep).join('/');
            const overrideRel = path.join(state.projectRoot, OVERRIDE_DIR_NAME, relSafe);

            if (await fs.pathExists(overrideRel)) {
                console.log(`⚡ Override used for ${decoded} -> ${OVERRIDE_DIR_NAME}/${relSafe}`);
                return (await encodeFile(overrideRel)) || uri;
            }
        }

        // 2. Fallback: try basename only
        const bname = path.basename(decoded);
        const overrideBase = path.join(state.projectRoot, OVERRIDE_DIR_NAME, bname);
        if (await fs.pathExists(overrideBase)) {
            console.log(`⚡ Override used for ${decoded} -> ${OVERRIDE_DIR_NAME}/${bname}`);
            return (await encodeFile(overrideBase)) || uri;
        }
    }

    const full = path.resolve(baseDir, decoded);
    if (!await fs.pathExists(full)) {
        console.warn('❌ Not found:', full, ' (from:', uri, ')');
    }
    const encoded = await encodeFile(full);
    return encoded || uri;
};
