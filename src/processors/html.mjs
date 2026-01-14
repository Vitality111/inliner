// FILE: src/processors/html.mjs
import { replaceAsync } from '../utils.mjs';
import { processUri, reencodeDataUri } from '../encoder.mjs';
import { processCssContent, maybeMinifyCss } from './css.mjs';
import { CONFIG } from '../config.mjs';

// Інлайн медіа-атрибутів у HTML: src, poster, data-src, background
export const inlineHtmlMediaAttrs = async (html, basePath) => {
    const attrPatterns = [
        /\s(src)=["']([^"']+)["']/gi,
        /\s(poster)=["']([^"']+)["']/gi,
        /\s(data-src)=["']([^"']+)["']/gi,
        /\s(background)=["']([^"']+)["']/gi
    ];
    for (const pattern of attrPatterns) {
        html = await replaceAsync(html, pattern, async (_, attr, val) => {
            const replaced = await processUri(val, basePath);
            return ` ${attr}="${replaced}"`;
        });
    }
    return html;
};

// srcset
export const inlineSrcset = async (html, basePath) => {
    return await replaceAsync(
        html,
        /\s(srcset)=["']([^"']+)["']/gi,
        async (_, attr, list) => {
            const items = list.split(',').map(s => s.trim()).filter(Boolean);
            const mapped = await Promise.all(items.map(async item => {
                const parts = item.split(/\s+/, 2);
                const url = parts[0];
                const descriptor = parts[1] || '';
                const replaced = await processUri(url, basePath);
                return `${replaced}${descriptor ? ' ' + descriptor : ''}`;
            }));
            return ` ${attr}="${mapped.join(', ')}"`;
        }
    );
};

// Інлайн <style>...</style> і style="..."
export const inlineStylesEverywhere = async (html, basePath) => {
    // <style>...</style>
    html = await replaceAsync(
        html,
        /<style[^>]*>([\s\S]*?)<\/style>/gi,
        async (match, css) => {
            const newCss = maybeMinifyCss(await processCssContent(css, basePath));
            return match.replace(css, newCss);
        }
    );

    // style="..."
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

// Фінальний прохід: повторно стиснути ВСІ data:URI, що залишились у HTML
export const reencodeAllDataUrisInHtml = async (html) => {
    return await replaceAsync(
        html,
        /(data:[^"'()\s<>]+?(?:;charset=[^;,]+)?;base64,[A-Za-z0-9+/=%_-]+)/gi,
        async (match) => {
            // match — повний data:...
            const recoded = await reencodeDataUri(match);
            return recoded || match;
        }
    );
};

// Обережна «мінімізація» HTML (за бажанням)
export const maybeMinifyHtml = (html) => {
    if (!CONFIG.html.minify) return html;
    // ⚠️ Дуже мʼяко: прибираємо HTML-коментарі (не чіпаємо скрипти/стилі), стискаємо проміжні пробіли між тегами
    html = html.replace(/<!--([\s\S]*?)-->/g, ''); // може вплинути на умовні коментарі IE (неактуально)
    html = html.replace(/>\s+</g, '><');
    return html;
};
