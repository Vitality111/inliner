// FILE: src/processors/html.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Обробка HTML: інлайн медіа-атрибутів, srcset, inline styles, re-encoding
// data:URI, та мініфікація HTML.
//
// Порядок обробки в pipeline.mjs:
//   1. inlineCssLinks       — <link rel="stylesheet"> → <style>
//   2. inlineJsScripts      — <script src="..."> → <script>inline</script>
//   3. inlineHtmlMediaAttrs — src, poster, data-src, background → data:URI
//   4. inlineSrcset          — srcset → data:URI
//   5. inlineStylesEverywhere — <style> і style="" → url() → data:URI
//   6. reencodeAllDataUrisInHtml — повторна оптимізація всіх data:URI
//   7. maybeMinifyHtml      — видалення коментарів і зайвих пробілів
// ─────────────────────────────────────────────────────────────────────────────

import { replaceAsync } from '../utils.mjs';
import { processUri, reencodeDataUri } from '../encoder.mjs';
import { processCssContent, maybeMinifyCss } from './css.mjs';
import { CONFIG } from '../config.mjs';

// ========================== MEDIA ATTRIBUTES ==========================

/**
 * Інлайнить медіа-атрибути в HTML тегах: src, poster, data-src, background.
 * Кожне значення обробляється через processUri (optimize + base64).
 *
 * ⚠️ Виключаємо <script> теги — вони вже оброблені inlineJsScripts.
 *    Без цього виключення data:URI скриптів оброблялися б повторно.
 *
 * @param {string} html — HTML контент
 * @param {string} basePath — базовий шлях для відносних URL
 * @returns {Promise<string>} HTML з інлайненими атрибутами
 */
export const inlineHtmlMediaAttrs = async (html, basePath) => {
    const attrPatterns = [
        // ✅ src — але НЕ в <script> тегах (вони вже оброблені)
        // Негативний lookbehind: не матчить якщо перед src= є <script...
        /(<(?!script[\s>])[^>]*?)\s(src)=["']([^"']+)["']/gi,
        /\s(poster)=["']([^"']+)["']/gi,
        /\s(data-src)=["']([^"']+)["']/gi,
        /\s(background)=["']([^"']+)["']/gi
    ];

    // Окремо обробляємо src (з перевіркою на script)
    html = await replaceAsync(html, attrPatterns[0], async (match, tagStart, attr, val) => {
        const replaced = await processUri(val, basePath);
        return `${tagStart} ${attr}="${replaced}"`;
    });

    // Решта атрибутів — без спеціальних перевірок
    for (let i = 1; i < attrPatterns.length; i++) {
        html = await replaceAsync(html, attrPatterns[i], async (_, attr, val) => {
            const replaced = await processUri(val, basePath);
            return ` ${attr}="${replaced}"`;
        });
    }

    return html;
};

// ========================== SRCSET ==========================

/**
 * Інлайнить srcset атрибути (responsive images).
 * Формат: srcset="image1.png 1x, image2.png 2x"
 * Кожен URL обробляється окремо, дескриптори зберігаються.
 *
 * @param {string} html — HTML контент
 * @param {string} basePath — базовий шлях
 * @returns {Promise<string>} HTML з інлайненим srcset
 */
export const inlineSrcset = async (html, basePath) => {
    return await replaceAsync(
        html,
        /\s(srcset)=["']([^"']+)["']/gi,
        async (_, attr, list) => {
            const items = list.split(',').map(s => s.trim()).filter(Boolean);
            const mapped = [];
            for (const item of items) {
                const parts = item.split(/\s+/, 2);
                const url = parts[0];
                const descriptor = parts[1] || '';  // '1x', '2x', '300w', тощо
                const replaced = await processUri(url, basePath);
                mapped.push(`${replaced}${descriptor ? ' ' + descriptor : ''}`);
            }
            return ` ${attr}="${mapped.join(', ')}"`;
        }
    );
};

// ========================== INLINE STYLES ==========================

/**
 * Обробляє CSS у двох місцях HTML:
 *   1. <style>...</style> блоки — повний CSS парсинг
 *   2. style="..." атрибути — inline CSS
 *
 * В обох випадках url() всередині CSS обробляються через processUri.
 *
 * @param {string} html — HTML контент
 * @param {string} basePath — базовий шлях
 * @returns {Promise<string>} HTML з обробленими стилями
 */
export const inlineStylesEverywhere = async (html, basePath) => {
    // <style>...</style> блоки
    html = await replaceAsync(
        html,
        /<style[^>]*>([\s\S]*?)<\/style>/gi,
        async (match, css) => {
            const newCss = maybeMinifyCss(await processCssContent(css, basePath));
            return match.replace(css, newCss);
        }
    );

    // style="..." атрибути
    html = await replaceAsync(
        html,
        /\sstyle=["']([^"']+)["']/gi,
        async (match, css) => {
            const newCss = maybeMinifyCss(await processCssContent(css, basePath));
            return match.replace(css, newCss);
        }
    );

    return html;
};

// ========================== DATA URI RE-ENCODING ==========================

/**
 * Фінальний прохід: знаходить ВСІ data:URI в HTML і перекодовує
 * (оптимізує) їх. Це ловить data:URI, які могли бути вставлені
 * попередніми етапами або вже існували в оригіналі.
 *
 * Кешування через dataUriCache запобігає повторній обробці.
 *
 * @param {string} html — HTML контент
 * @returns {Promise<string>} HTML з оптимізованими data:URI
 */
export const reencodeAllDataUrisInHtml = async (html) => {
    return await replaceAsync(
        html,
        /(data:[^"'()\s<>]+?(?:;charset=[^;,]+)?;base64,[A-Za-z0-9+/=%_-]+)/gi,
        async (match) => {
            const recoded = await reencodeDataUri(match);
            return recoded || match;
        }
    );
};

// ========================== HTML MINIFICATION ==========================

/**
 * М'яка мініфікація HTML. Увімкнення: --minifyHtml
 *
 * Що робить:
 *   - Видаляє HTML-коментарі (<!-- ... -->)
 *   - Стискає пробіли між тегами (> ... < → ><)
 *
 * Що НЕ робить (безпечно):
 *   - Не чіпає вміст <script> і <style> (вони мініфікуються окремо)
 *   - Не видаляє атрибути
 *   - Не змінює структуру DOM
 *
 * ⚠️ Conditional comments IE (<!--[if IE]>) більше не актуальні,
 *    тому видаляємо всі коментарі без виключень.
 *
 * @param {string} html — HTML контент
 * @returns {string} мініфікований HTML (або оригінал якщо вимкнено)
 */
export const maybeMinifyHtml = (html) => {
    if (!CONFIG.html.minify) return html;

    // Видаляємо HTML-коментарі
    html = html.replace(/<!--([\s\S]*?)-->/g, '');

    // Стискаємо пробіли між тегами
    html = html.replace(/>\s+</g, '><');

    return html;
};
