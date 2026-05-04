// FILE: src/encoder.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Центральний модуль кодування. Відповідає за:
//  1. Конвертацію файлів/буферів у data:URI (base64)
//  2. Парсинг існуючих data:URI
//  3. Перекодування (оптимізація) data:URI з кешуванням
//  4. Інлайн локальних файлів з диску
//  5. Завантаження & інлайн HTTP(S) ресурсів
//  6. Уніфіковану обробку URI (processUri) — головна точка входу
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs-extra';
import path from 'path';
import { decodeLocalPath, isHttp, isDataUri, logSaving, askCompress } from './utils.mjs';
import { CONFIG, OVERRIDE_DIR_NAME, INTERACTIVE } from './config.mjs';
import { state, dataUriCache, dataUriPromiseCache, fileCache, filePromiseCache } from './state.mjs';
import { optimizeByMime } from './optimizers/index.mjs';
import { MIME } from './constants.mjs';

// ========================== DATA URI UTILS ==========================

/**
 * Кодує буфер у рядок data:URI.
 * @param {string} mime — MIME тип (наприклад 'image/png')
 * @param {Buffer} buffer — бінарні дані
 * @returns {string} data:image/png;base64,iVBOR...
 */
export const toDataUri = (mime, buffer) =>
    `data:${mime};base64,${buffer.toString('base64')}`;

/**
 * Розбирає data:URI назад у {mime, buffer}.
 * Підтримує формати:
 *   data:image/png;base64,iVBOR...
 *   data:text/plain;charset=utf-8;base64,SGVsbG8=
 *   data:text/plain,Hello%20World  (URL-encoded, без base64)
 *
 * @param {string} dataUri — повний рядок data:URI
 * @returns {{ mime: string, buffer: Buffer } | null}
 */
export const fromDataUri = (dataUri) => {
    const m = /^data:([^;,]+)(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(dataUri);
    if (!m) return null;

    const mime = m[1].toLowerCase();
    const isB64 = !!m[2];
    const data = m[3];

    try {
        // ⚠️ base64 дані НЕ потребують decodeURIComponent!
        // decodeURIComponent потрібен тільки для text/plain без base64.
        const buffer = isB64
            ? Buffer.from(data, 'base64')
            : Buffer.from(decodeURIComponent(data), 'utf8');
        return { mime, buffer };
    } catch { return null; }
};

// ========================== RE-ENCODING ==========================

/**
 * Перекодує існуючий data:URI — оптимізує вміст і повертає новий data:URI.
 * Використовує кеш dataUriCache для уникнення повторної обробки.
 *
 * В інтерактивному режимі пропускає перекодування (файли вже оброблені
 * через encodeFile з вибором користувача).
 *
 * @param {string} dataUri — оригінальний data:URI
 * @returns {Promise<string>} оптимізований data:URI (або оригінал якщо не вдалося)
 */
const reencodeDataUriUncached = async (dataUri) => {
    if (dataUriCache.has(dataUri)) return dataUriCache.get(dataUri);

    const parsed = fromDataUri(dataUri);
    if (!parsed) return dataUri;

    const { mime, buffer } = parsed;
    const before = buffer.length;

    // В інтерактивному режимі не перекодовуємо data:URI повторно
    if (INTERACTIVE) {
        dataUriCache.set(dataUri, dataUri);
        return dataUri;
    }

    const optimized = await optimizeByMime(buffer, mime);

    // Якщо оптимізований більший — повертаємо оригінал (захист від збільшення)
    const finalBuf = optimized.length <= buffer.length ? optimized : buffer;
    const out = toDataUri(mime, finalBuf);
    logSaving(`data:${mime}`, before, finalBuf.length);
    dataUriCache.set(dataUri, out);
    return out;
};

export const reencodeDataUri = async (dataUri) => {
    if (dataUriCache.has(dataUri)) return dataUriCache.get(dataUri);
    if (dataUriPromiseCache.has(dataUri)) return await dataUriPromiseCache.get(dataUri);

    const work = reencodeDataUriUncached(dataUri);
    dataUriPromiseCache.set(dataUri, work);
    try {
        return await work;
    } finally {
        dataUriPromiseCache.delete(dataUri);
    }
};

// ========================== FILE ENCODING ==========================

/**
 * Читає локальний файл з диску, оптимізує і повертає data:URI.
 * Результат кешується у fileCache по абсолютному шляху.
 *
 * В інтерактивному режимі запитує у користувача чи стискати.
 *
 * @param {string} fileAbsPath — абсолютний шлях до файлу
 * @returns {Promise<string|null>} data:URI або null якщо файл не існує
 */
const encodeFileUncached = async (fileAbsPath) => {
    if (!await fs.pathExists(fileAbsPath)) return null;
    if (fileCache.has(fileAbsPath)) return fileCache.get(fileAbsPath);

    const ext = path.extname(fileAbsPath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const original = await fs.readFile(fileAbsPath);
    const before = original.length;
    let outBuf = original;

    // Інтерактивний режим — запитуємо чи стискати
    const shouldCompress = INTERACTIVE
        ? await askCompress(path.basename(fileAbsPath), before / 1024)
        : true;

    if (shouldCompress) {
        try {
            outBuf = await optimizeByMime(original, mime);
        } catch {
            outBuf = original;
        }
    }

    // Захист: якщо оптимізований більший — лишаємо оригінал
    const finalBuf = outBuf.length <= original.length ? outBuf : original;
    logSaving(path.basename(fileAbsPath), before, finalBuf.length);

    const dataUri = toDataUri(mime, finalBuf);
    fileCache.set(fileAbsPath, dataUri);

    // Також кешуємо в dataUriCache — щоб reencodeAllDataUrisInHtml
    // не намагався повторно оптимізувати вже оптимізований data:URI
    dataUriCache.set(dataUri, dataUri);

    return dataUri;
};

export const encodeFile = async (fileAbsPath) => {
    if (fileCache.has(fileAbsPath)) return fileCache.get(fileAbsPath);
    if (filePromiseCache.has(fileAbsPath)) return await filePromiseCache.get(fileAbsPath);

    const work = encodeFileUncached(fileAbsPath);
    filePromiseCache.set(fileAbsPath, work);
    try {
        return await work;
    } finally {
        filePromiseCache.delete(fileAbsPath);
    }
};

// ========================== HTTP FETCH & ENCODE ==========================

/**
 * Завантажує зовнішній HTTP(S) ресурс, оптимізує і повертає data:URI.
 * Працює тільки якщо CONFIG.externals.fetch === true і global.fetch доступний.
 *
 * @param {string} url — HTTP/HTTPS URL
 * @returns {Promise<string|null>} data:URI або null при помилці
 */
export const fetchAndEncode = async (url) => {
    if (!CONFIG.externals.fetch || typeof fetch !== 'function') return null;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;

        const arrBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrBuf);

        // Визначаємо MIME з заголовків або розширення URL
        let mime = res.headers.get('content-type')?.split(';')[0]?.trim() || '';
        if (!mime) {
            const ext = path.extname(new URL(url).pathname).toLowerCase();
            mime = MIME[ext] || 'application/octet-stream';
        }

        const before = buf.length;
        const optimized = await optimizeByMime(buf, mime);

        // ✅ FIX: перевіряємо чи оптимізований менший за оригінал
        const finalBuf = optimized.length <= buf.length ? optimized : buf;
        logSaving(url, before, finalBuf.length);
        return toDataUri(mime, finalBuf);
    } catch {
        return null;
    }
};

// ========================== UNIFIED URI PROCESSOR ==========================

/**
 * Головна точка входу для обробки будь-якого URI:
 *   - data:URI → перекодувати/оптимізувати
 *   - http(s):// → перевірити override, або fetch & encode
 *   - відносний шлях → перевірити override, потім encode з диску
 *
 * Override логіка (папка dir/):
 *   1. Спершу шукає файл за повним відносним шляхом: dir/assets/img.png
 *   2. Якщо не знайдено — за іменем файлу: dir/img.png
 *
 * @param {string} uri — URI для обробки
 * @param {string} baseDir — базова директорія для відносних шляхів
 * @returns {Promise<string>} data:URI або оригінальний URI якщо не вдалося
 */
export const processUri = async (uri, baseDir) => {
    if (!uri) return uri;

    // 1. Data URI — перекодувати
    if (isDataUri(uri)) return await reencodeDataUri(uri);

    // 2. HTTP(S) — перевірити override або fetch
    if (isHttp(uri)) {
        // Спершу перевіряємо чи є локальний override для цього URL
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

    // 3. Локальний шлях
    const decoded = decodeLocalPath(uri);

    // Перевіряємо override-и
    if (state.projectRoot) {
        // 3a. Override за повним відносним шляхом (зберігає структуру папок)
        const fullOriginal = path.resolve(baseDir, decoded);
        const relToRoot = path.relative(state.projectRoot, fullOriginal);

        // Безпечність: не дозволяємо вийти за межі проєкту (..)
        if (!relToRoot.startsWith('..') && !path.isAbsolute(relToRoot)) {
            const relSafe = relToRoot.split(path.sep).join('/');
            const overrideRel = path.join(state.projectRoot, OVERRIDE_DIR_NAME, relSafe);

            if (await fs.pathExists(overrideRel)) {
                console.log(`⚡ Override used for ${decoded} -> ${OVERRIDE_DIR_NAME}/${relSafe}`);
                return (await encodeFile(overrideRel)) || uri;
            }
        }

        // 3b. Override за іменем файлу (fallback)
        const bname = path.basename(decoded);
        const overrideBase = path.join(state.projectRoot, OVERRIDE_DIR_NAME, bname);
        if (await fs.pathExists(overrideBase)) {
            console.log(`⚡ Override used for ${decoded} -> ${OVERRIDE_DIR_NAME}/${bname}`);
            return (await encodeFile(overrideBase)) || uri;
        }
    }

    // 4. Резолвимо повний шлях і кодуємо
    let full = path.resolve(baseDir, decoded);

    // Fallback: якщо файл не знайдений відносно baseDir (наприклад, CSS/JS у підпапці),
    // спробуємо відносно кореня проєкту (де лежить HTML). Це потрібно для Vite/Webpack,
    // де бандлер кладе JS у assets/, але шляхи ресурсів відносні до HTML root.
    if (!await fs.pathExists(full) && state.projectRoot) {
        const fallback = path.resolve(state.projectRoot, decoded);
        if (await fs.pathExists(fallback)) {
            full = fallback;
        } else {
            console.warn(`❌ Not found: ${full} and ${fallback}  (from: ${uri} )`);
        }
    } else if (!await fs.pathExists(full)) {
        console.warn('❌ Not found:', full, ' (from:', uri, ')');
    }

    const encoded = await encodeFile(full);
    return encoded || uri;
};
