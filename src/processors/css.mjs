// FILE: src/processors/css.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Обробка CSS: інлайн url() і @import, мініфікація через lightningcss,
// та інлайн <link rel="stylesheet"> у HTML.
//
// Підтримує:
//   - url("path"), url('path'), url(path) — з лапками і без
//   - @import url("path"), @import "path", @import 'path'
//   - CSS-escaped шляхи (бекслеш перед спецсимволами)
//   - data:URI всередині url() (обробляються через reencodeDataUri)
//   - Мініфікація через lightningcss (швидша за cssnano)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs-extra';
import path from 'path';
import { replaceAsync, decodeLocalPath } from '../utils.mjs';
import { processUri } from '../encoder.mjs';
import { CONFIG } from '../config.mjs';
import { transform as cssTransform } from 'lightningcss';

/**
 * Обробляє CSS контент: знаходить всі url() та @import і
 * замінює шляхи на data:URI через processUri.
 *
 * Зберігає оригінальний стиль лапок (подвійні/одинарні/без).
 *
 * @param {string} cssText — CSS контент
 * @param {string} baseDir — базова директорія для відносних шляхів
 * @returns {Promise<string>} CSS з інлайненими ресурсами
 */
export const processCssContent = async (cssText, baseDir) => {
    /**
     * Знімає CSS-escape з шляхів.
     * Наприклад: font\ file.woff → font file.woff
     *            path\/to\/file   → path/to/file
     */
    const unescapeCssPath = (s) =>
        s
            .replace(/\\([()'"\s/\\])/g, '$1')   // зняти бекслеш перед спецсимволами
            .replace(/\\\\/g, '\\');              // подвійний бекслеш → одинарний

    // ──── 1) url(...) — основний CSS-ресурсний синтаксис ────
    // Підтримує три варіанти: url("..."), url('...'), url(...)
    cssText = await replaceAsync(
        cssText,
        /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi,
        async (_, g1, g2, g3) => {
            const rawPath = unescapeCssPath((g1 ?? g2 ?? g3 ?? '').trim());

            // Пропускаємо порожні та якірні (#) посилання
            if (!rawPath || rawPath.startsWith('#')) {
                return `url(${g1 !== undefined ? `"${g1}"` : g2 !== undefined ? `'${g2}'` : g3})`;
            }

            const replaced = await processUri(rawPath, baseDir);

            // Зберігаємо оригінальний стиль лапок
            if (g1 !== undefined) return `url("${replaced}")`;
            if (g2 !== undefined) return `url('${replaced}')`;
            return `url(${replaced})`;
        }
    );

    // ──── 2) @import — підтримка всіх варіантів синтаксису ────
    // @import url("..."), @import url('...'), @import url(...)
    // @import "...", @import '...'
    cssText = await replaceAsync(
        cssText,
        /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)|"([^"]+)"|'([^']+)')/gi,
        async (match, u1, u2, u3, q1, q2) => {
            const raw = unescapeCssPath((u1 ?? u2 ?? u3 ?? q1 ?? q2 ?? '').trim());
            if (!raw) return match;

            const replaced = await processUri(raw, baseDir);

            // Зберігаємо оригінальний стиль
            if (u1 !== undefined) return `@import url("${replaced}")`;
            if (u2 !== undefined) return `@import url('${replaced}')`;
            if (u3 !== undefined) return `@import url(${replaced})`;
            if (q1 !== undefined) return `@import "${replaced}"`;
            if (q2 !== undefined) return `@import '${replaced}'`;
            return match;
        }
    );

    return cssText;
};

/**
 * Мініфікує CSS через lightningcss (якщо увімкнено --minifyCss).
 * lightningcss — значно швидший за cssnano, підходить для плейблів.
 *
 * При помилці парсингу повертає оригінал (не ламає збірку).
 *
 * @param {string} css — CSS контент
 * @returns {string} мініфікований CSS (або оригінал)
 */
export const maybeMinifyCss = (css) => {
    if (!CONFIG.css?.minify) return css;
    try {
        const out = cssTransform({
            code: Buffer.from(css),
            minify: true,
            // targets можна додати для autoprefixer-подібної поведінки,
            // але для плейблів зазвичай не потрібно
        });
        return out.code.toString();
    } catch {
        return css; // якщо парсинг CSS впав — лишаємо як було
    }
};

// ========================== LINK STYLESHEET INLINING ==========================

/**
 * Знаходить <link rel="stylesheet" href="..."> в HTML і замінює
 * на <style>...інлайнений CSS...</style>.
 *
 * CSS файл читається з диску, обробляються url() всередині,
 * і застосовується мініфікація (якщо увімкнено).
 *
 * Якщо CSS файл не знайдений — тег видаляється (порожній рядок).
 *
 * @param {string} html — HTML контент
 * @param {string} basePath — базовий шлях (директорія HTML файлу)
 * @returns {Promise<string>} HTML з інлайненими стилями
 */
export const inlineCssLinks = async (html, basePath) => {
    return await replaceAsync(
        html,
        /<link(?=[^>]*rel=["']?stylesheet["']?)[^>]*href=["']([^"']+)["'][^>]*>/gi,
        async (match, href) => {
            // Ігноруємо не-CSS файли (наприклад, preload для шрифтів)
            if (!/\.css(\?.*)?$/i.test(href)) return match;

            const cleanHref = decodeLocalPath(href);
            const full = path.resolve(basePath, cleanHref);

            if (!await fs.pathExists(full)) return ''; // видаляємо битий лінк

            let css = await fs.readFile(full, 'utf8');
            css = await processCssContent(css, path.dirname(full));
            css = maybeMinifyCss(css);
            return `<style>${css}</style>`;
        }
    );
};
