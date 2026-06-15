// FILE: src/optimizers/font.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Оптимізатор шрифтів через subset-font (harfbuzz/hb-subset WASM).
//
// Видаляє з шрифту всі гліфи, крім тих що зазначені в CONFIG.font.subset.
// Це може СУТТЄВО зменшити розмір шрифту (наприклад, з 500KB до 30KB),
// якщо використовується лише частина символів.
//
// ⚠️ Якщо в тексті з'являться символи, які не увійшли в subset —
//    вони не відобразяться! Перевіряй CONFIG.font.subset.
//
// subset-font базується на harfbuzz і коректно працює з:
//   - Extended Latin (турецькі ş ç ğ ı İ, французькі é è ê, тощо)
//   - CJK (японські, китайські, корейські ієрогліфи)
//   - Деванагарі (хінді), арабська, іврит тощо
//   - Variable Fonts
//   - TTF, OTF, WOFF, WOFF2
//
// Залежності: subset-font (npm)
// ─────────────────────────────────────────────────────────────────────────────

import subsetFont from 'subset-font';
import { CONFIG } from '../config.mjs';

const FONT_MIME_BY_FORMAT = {
    sfnt: 'font/ttf',
    truetype: 'font/ttf',
    woff: 'font/woff',
    woff2: 'font/woff2'
};

const normalizeTargetFormat = (format) => {
    const value = String(format || '').toLowerCase();
    if (value === 'preserve') return null;
    if (value === 'ttf' || value === 'otf' || value === 'sfnt' || value === 'truetype') return 'sfnt';
    if (value === 'woff') return 'woff';
    return 'woff2';
};

/**
 * Оптимізує буфер шрифту через font subsetting (harfbuzz).
 *
 * @param {Buffer} buf — оригінальний буфер шрифту (TTF/OTF/WOFF/WOFF2)
 * @param {string} mime — MIME тип оригінального шрифту
 * @param {{ allowFormatChange?: boolean }} options
 * @returns {Promise<{ buffer: Buffer, mime: string }>} оптимізований шрифт та MIME
 */
export const optimizeFontAsset = async (buf, mime = 'font/ttf', { allowFormatChange = true } = {}) => {
    if (!CONFIG.font.optimize) {
        return { buffer: buf, mime };
    }

    if (!CONFIG.font.subset) {
        return { buffer: buf, mime };
    }

    try {
        // Для інлайну можна безпечно конвертувати в WOFF2, якщо разом із байтами
        // повернути новий MIME. Для optimizeOnly формат не міняємо, щоб .ttf/.otf
        // файл не отримав WOFF2-байти під старим розширенням.
        const targetFormat = allowFormatChange
            ? normalizeTargetFormat(CONFIG.font.format)
            : null;

        const subsetOptions = targetFormat ? { targetFormat } : undefined;
        const out = await subsetFont(buf, CONFIG.font.subset, subsetOptions);
        const outMime = targetFormat ? FONT_MIME_BY_FORMAT[targetFormat] : mime;

        // Повертаємо оптимізований тільки якщо він не більший
        return out.length && out.length <= buf.length
            ? { buffer: out, mime: outMime }
            : { buffer: buf, mime };
    } catch (e) {
        console.warn('⚠️ Font subsetting failed, keeping original:', e.message);
        return { buffer: buf, mime };
    }
};

export const optimizeFontBuffer = async (buf, mime, options) =>
    (await optimizeFontAsset(buf, mime, options)).buffer;
