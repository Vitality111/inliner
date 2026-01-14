// FILE: src/processors/css.mjs
import fs from 'fs-extra';
import path from 'path';
import { replaceAsync, decodeLocalPath } from '../utils.mjs';
import { processUri } from '../encoder.mjs';
import { CONFIG } from '../config.mjs';
import { transform as cssTransform } from 'lightningcss';

// Обробити вміст CSS: url(...), в тому числі вже data:
// Обробити вміст CSS: url(...), @import, включно з лапками/пробілами/дужками
export const processCssContent = async (cssText, baseDir) => {
    // Допоміжне: безпечне розекейплення css-escape для типових символів
    const unescapeCssPath = (s) =>
        s
            // знімаємо бекслеш перед (), ' ", пробілом і слешем
            .replace(/\\([()'"\s/\\])/g, '$1')
            // normalise подвійні бекслеші
            .replace(/\\\\/g, '\\');

    // 1) url(...) — підтримка 3 варіантів: "…", '…', без лапок
    cssText = await replaceAsync(
        cssText,
        /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi,
        async (_, g1, g2, g3) => {
            const rawPath = unescapeCssPath((g1 ?? g2 ?? g3 ?? '').trim());
            if (!rawPath) return `url(${g1 !== undefined ? `"${g1}"` : g2 !== undefined ? `'${g2}'` : g3})`;
            const replaced = await processUri(rawPath, baseDir);
            // якщо було в подвійних/одинарних — повертаємо з тим самим типом лапок
            if (g1 !== undefined) return `url("${replaced}")`;
            if (g2 !== undefined) return `url('${replaced}')`;
            return `url(${replaced})`;
        }
    );

    // 2) @import url("...") / @import '...' / @import "..."
    //    ВАЖЛИВО: обробляємо окремо, бо синтаксис інший за звичайні url(...)
    cssText = await replaceAsync(
        cssText,
        /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)|"([^"]+)"|'([^']+)')/gi,
        async (match, u1, u2, u3, q1, q2) => {
            const raw = unescapeCssPath((u1 ?? u2 ?? u3 ?? q1 ?? q2 ?? '').trim());
            if (!raw) return match;
            const replaced = await processUri(raw, baseDir);
            // зберігаємо оригінальний стиль (url(...)/лапки)
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

export const maybeMinifyCss = (css) => {
    if (!CONFIG.css?.minify) return css;
    try {
        const out = cssTransform({
            code: Buffer.from(css),
            minify: true,
            // targets можна не задавати — буде ок для більшості плейблів
        });
        return out.code.toString();
    } catch {
        return css; // якщо впало — залишаємо як було
    }
};

// <link rel="stylesheet" href="...">
export const inlineCssLinks = async (html, basePath) => {
    return await replaceAsync(
        html,
        /<link(?=[^>]*rel=["']?stylesheet["']?)[^>]*href=["']([^"']+)["'][^>]*>/gi,
        async (match, href) => {
            // Ignore non-css files
            if (!/\.css(\?.*)?$/i.test(href)) return match;

            const cleanHref = decodeLocalPath(href);
            const full = path.resolve(basePath, cleanHref);
            if (!await fs.pathExists(full)) return ''; // видалимо битий лінк
            let css = await fs.readFile(full, 'utf8');
            css = await processCssContent(css, path.dirname(full));
            css = maybeMinifyCss(css);
            return `<style>${css}</style>`;
        }
    );
};
