// FILE: src/processors/html-noise.mjs
// Опціонально додає випадкові класи-шум до елементів, які вже мають class.
// Реальні класи, CSS та JavaScript не перейменовуються і не переписуються.

import crypto from 'crypto';

const VARIANTS = ['sm', 'md', 'lg', 'xl', 'hover', 'focus', 'motion-safe'];
const UTILITY_HINTS = ['p', 'm', 'gap', 'col', 'row', 'flow', 'place', 'stack'];

const createDecoyClass = () => {
    const bytes = crypto.randomBytes(6);
    const variant = VARIANTS[bytes[0] % VARIANTS.length];
    const utility = UTILITY_HINTS[bytes[1] % UTILITY_HINTS.length];
    const hash = bytes.subarray(2).toString('hex');
    const scale = (bytes[5] % 9) + 1;
    return `${variant}:u-${hash}-${utility}${scale}`;
};

const findSafetyBlocker = (html) => {
    const styleText = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
        .map(match => match[1])
        .join('\n');

    // Додавання класу змінює повне значення class="...", тому точні/prefix/
    // substring CSS-селектори можуть перестати працювати. [class~=token] безпечний.
    if (/\[\s*class\s*(?:=|\|=|\^=|\$=|\*=)/i.test(styleText)) {
        return 'CSS contains a class attribute selector that depends on the full class value';
    }

    const scriptText = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
        .map(match => match[1])
        .join('\n');

    if (/\[\s*class\s*(?:=|\|=|\^=|\$=|\*=)/i.test(scriptText)) {
        return 'JavaScript contains a selector that depends on the full class value';
    }

    if (/\.getAttribute\s*\(\s*['"]class['"]\s*\)/i.test(scriptText)) {
        return 'JavaScript reads the complete class attribute';
    }

    // Просте `element.className = ...` безпечне: воно лише перезапише шум.
    // Читання, порівняння або += залежать від повного значення і є небезпечними.
    for (const match of scriptText.matchAll(/\.className\b/gi)) {
        const tail = scriptText.slice(match.index + match[0].length);
        if (!/^\s*=(?!=)/.test(tail)) {
            return 'JavaScript reads or modifies the complete className value';
        }
    }

    return null;
};

const addClassesToTag = (tag, count, usedNames, tokenFactory) => {
    if (/^<\s*\//.test(tag)) return { tag, added: 0 };

    const classPattern = /(\sclass\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
    const match = classPattern.exec(tag);
    if (!match) return { tag, added: 0 };

    const original = match[2] ?? match[3] ?? match[4] ?? '';
    const originalNames = original.trim().split(/\s+/).filter(Boolean);
    if (originalNames.length === 0) return { tag, added: 0 };

    const decoys = [];
    let attempts = 0;
    while (decoys.length < count && attempts < count * 20) {
        attempts += 1;
        const candidate = tokenFactory();
        if (!candidate || /\s/.test(candidate) || usedNames.has(candidate)) continue;
        usedNames.add(candidate);
        decoys.push(candidate);
    }

    if (decoys.length === 0) return { tag, added: 0 };

    const value = [...originalNames, ...decoys].join(' ');
    const replacement = `${match[1]}"${value}"`;
    return {
        tag: `${tag.slice(0, match.index)}${replacement}${tag.slice(match.index + match[0].length)}`,
        added: decoys.length
    };
};

/**
 * Додає класи-шум тільки до реальних HTML-тегів з непорожнім class.
 * Тіла <script>/<style>, коментарі, CSS і JS залишаються байт-у-байт незмінними.
 *
 * @param {string} html
 * @param {{count?: number, tokenFactory?: () => string}} options
 * @returns {{html: string, addedClasses: number, changedElements: number, skippedReason: string|null}}
 */
export const addDecoyHtmlClasses = (html, { count = 2, tokenFactory = createDecoyClass } = {}) => {
    const safeCount = Math.max(1, Math.min(5, Number(count) || 2));
    const blocker = findSafetyBlocker(html);
    if (blocker) {
        return { html, addedClasses: 0, changedElements: 0, skippedReason: blocker };
    }

    const usedNames = new Set();
    const tagsOnly = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');

    for (const match of tagsOnly.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const value = match[1] ?? match[2] ?? match[3] ?? '';
        for (const name of value.trim().split(/\s+/).filter(Boolean)) usedNames.add(name);
    }

    let addedClasses = 0;
    let changedElements = 0;

    // Альтернативи впорядковані так, щоб script/style цілком споживалися одним
    // матчем: HTML-подібні рядки всередині JavaScript не будуть змінені.
    const tokenPattern = /<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->|<[^>]+>/gi;
    const output = html.replace(tokenPattern, (token) => {
        if (/^<\s*(?:script|style)\b/i.test(token) || /^<!--/.test(token)) return token;

        const result = addClassesToTag(token, safeCount, usedNames, tokenFactory);
        if (result.added > 0) {
            addedClasses += result.added;
            changedElements += 1;
        }
        return result.tag;
    });

    return { html: output, addedClasses, changedElements, skippedReason: null };
};
