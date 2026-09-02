// FILE: src/processors/html.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Обробка HTML: інлайн медіа-атрибутів, srcset, inline styles, re-encoding
// data:URI, та мініфікація HTML.
//
// Порядок обробки в pipeline.mjs:
//   1. inlineCssLinks       — <link rel="stylesheet"> → <style>
//   2. inlineJsScripts      — <script src="..."> → <script>inline</script>
//   3. inlineHtmlMediaAttrs — src, poster, data-src, data-port, data-land,
//                              background → data:URI
//   4. inlineSrcset          — srcset → data:URI
//   5. inlineStylesEverywhere — <style> і style="" → url() → data:URI
//   6. reencodeAllDataUrisInHtml — повторна оптимізація всіх data:URI
//   7. maybeMinifyHtml      — видалення коментарів і зайвих пробілів
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs-extra';
import path from 'path';
import { replaceAsync, decodeLocalPath, isHttp, isDataUri } from '../utils.mjs';
import { processUri, reencodeDataUri } from '../encoder.mjs';
import { processCssContent, maybeMinifyCss } from './css.mjs';
import { CONFIG } from '../config.mjs';

// ========================== MEDIA ATTRIBUTES ==========================

/**
 * Переносить lazy-source з data-src у стандартний src для <img>, які не
 * мають власного src. Після інлайну lazy-loading уже не економить мережеві
 * запити, зате <img> без src не проходить валідацію частини рекламних мереж.
 *
 * data-src видаляється, щоб не дублювати великий base64 у фінальному HTML.
 * Якщо валідний src уже є, тег не змінюється і lazy-loading зберігається.
 *
 * @param {string} html — HTML з уже інлайненими data-src
 * @returns {string} HTML без <img data-src> з відсутнім/порожнім src
 */
export const promoteImgDataSrc = (html) => html.replace(/<img\b[^>]*>/gi, (tag) => {
    const dataSrcMatch = /\sdata-src\s*=\s*(["'])([^"']+)\1/i.exec(tag);
    if (!dataSrcMatch) return tag;

    const srcMatch = /\ssrc\s*=\s*(["'])([^"']*)\1/i.exec(tag);
    if (srcMatch?.[2]?.trim()) return tag;

    const dataSrc = dataSrcMatch[2];
    let normalized = tag.replace(dataSrcMatch[0], '');

    if (srcMatch) {
        normalized = normalized.replace(/\ssrc\s*=\s*(["'])\s*\1/i, ` src="${dataSrc}"`);
    } else {
        normalized = normalized.replace(/^<img\b/i, (opening) => `${opening} src="${dataSrc}"`);
    }

    return normalized;
});

/**
 * Інлайнить медіа-атрибути в HTML тегах:
 * src, poster, data-src, data-port, data-land, background.
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
        /\s(data-port)=["']([^"']+)["']/gi,
        /\s(data-land)=["']([^"']+)["']/gi,
        /\s(background)=["']([^"']+)["']/gi,
        // <object data="file.svg"> — вбудований документ/зображення
        /(<object\b[^>]*?)\s(data)=["']([^"']+)["']/gi,
        // <image href> / <image xlink:href> всередині інлайнового <svg>
        /(<image\b[^>]*?)\s(href|xlink:href)=["']([^"']+)["']/gi
    ];

    // Окремо обробляємо src (з перевіркою на script)
    html = await replaceAsync(html, attrPatterns[0], async (match, tagStart, attr, val) => {
        const replaced = await processUri(val, basePath);
        return `${tagStart} ${attr}="${replaced}"`;
    });

    // Решта атрибутів — без спеціальних перевірок
    for (let i = 1; i < attrPatterns.length - 2; i++) {
        html = await replaceAsync(html, attrPatterns[i], async (_, attr, val) => {
            const replaced = await processUri(val, basePath);
            return ` ${attr}="${replaced}"`;
        });
    }

    // Атрибути, прив'язані до конкретного тега (object[data], image[href])
    for (const pattern of attrPatterns.slice(-2)) {
        html = await replaceAsync(html, pattern, async (_, tagStart, attr, val) => {
            const replaced = await processUri(val, basePath);
            return `${tagStart} ${attr}="${replaced}"`;
        });
    }

    html = await inlineLinkAssets(html, basePath);

    return promoteImgDataSrc(html);
};

// ========================== <link> ASSETS ==========================

/**
 * Обробляє <link> теги, які не є stylesheet (ті вже інлайнені у <style>):
 *
 *   rel="icon" / "shortcut icon" / "apple-touch-icon" / "manifest"
 *       → href інлайниться як data:URI
 *
 *   rel="preload" / "prefetch" / "modulepreload" на ЛОКАЛЬНИЙ ассет
 *       → тег видаляється. Ассет уже вшитий у файл, тому preload лишається
 *         мертвим мережевим запитом на неіснуючий шлях (і попередженням
 *         від preflight). Зовнішні (http) preload не чіпаємо.
 *
 * @param {string} html
 * @param {string} basePath
 * @returns {Promise<string>}
 */
export const inlineLinkAssets = async (html, basePath) => {
    return await replaceAsync(
        html,
        /<link\b[^>]*>/gi,
        async (tag) => {
            const relMatch = /\srel\s*=\s*["']?([^"'>]+)["']?/i.exec(tag);
            const hrefMatch = /\shref\s*=\s*(["'])([^"']+)\1/i.exec(tag);
            if (!relMatch || !hrefMatch) return tag;

            const rels = relMatch[1].toLowerCase().split(/\s+/);
            const href = hrefMatch[2];
            if (isDataUri(href)) return tag;

            // stylesheet обробляється в inlineCssLinks
            if (rels.includes('stylesheet')) return tag;

            const isPreload = rels.some(r => r === 'preload' || r === 'prefetch' || r === 'modulepreload');
            if (isPreload) {
                if (isHttp(href)) return tag;
                const full = path.resolve(basePath, decodeLocalPath(href));
                // локальний файл існує → він буде/вже інлайнений → preload зайвий
                return (await fs.pathExists(full)) ? '' : tag;
            }

            const isIconLike = rels.some(r =>
                r === 'icon' || r === 'shortcut' || r === 'apple-touch-icon' ||
                r === 'apple-touch-icon-precomposed' || r === 'manifest' || r === 'mask-icon'
            );
            if (!isIconLike) return tag;

            const replaced = await processUri(href, basePath);
            return tag.replace(hrefMatch[0], ` href=${hrefMatch[1]}${replaced}${hrefMatch[1]}`);
        }
    );
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

    // Стискаємо пробіли між тегами до ОДНОГО пробілу, а не до нуля.
    // `><` ламав текст між інлайновими елементами:
    //   <span>Tap</span> <span>to play</span>  →  "Tapto play"
    // Один пробіл між тегами коштує ~1 байт на пару тегів і зберігає семантику.
    html = html.replace(/>\s+</g, '> <');

    return html;
};
