// FILE: src/validation.mjs
// Фінальна read-only перевірка: шукає статичні посилання на асети, які не
// були перетворені на data:URI. Не перевіряє навігаційні href або JavaScript.

const ASSET_ATTRS = new Set([
    'src',
    'poster',
    'data-src',
    'data-port',
    'data-land',
    'background'
]);

const DATA_URI_IN_SRCSET_RE = /data:[^,\s]+(?:;charset=[^,;\s]+)?;base64,[A-Za-z0-9+/=%_-]+/gi;

const readAttributes = (tag) => {
    const attrs = [];
    const pattern = /\s([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let match;

    while ((match = pattern.exec(tag))) {
        attrs.push({
            name: match[1].toLowerCase(),
            value: match[2] ?? match[3] ?? match[4] ?? ''
        });
    }

    return attrs;
};

const isRuntimeOrInlinedReference = (value) => {
    const ref = String(value || '').trim();
    if (!ref) return false;

    return /^(?:data:|blob:|about:|#)/i.test(ref) || /^var\(/i.test(ref);
};

const shorten = (value, maxLength = 140) => {
    const normalized = String(value).replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength
        ? `${normalized.slice(0, maxLength - 1)}…`
        : normalized;
};

const addReferenceIssue = (issues, location, attribute, value) => {
    if (isRuntimeOrInlinedReference(value)) return;

    issues.push({
        location,
        attribute,
        value: shorten(value),
        reason: String(value || '').trim() ? 'not-inlined' : 'empty'
    });
};

const inspectSrcset = (issues, location, value) => {
    if (!String(value || '').trim()) {
        addReferenceIssue(issues, location, 'srcset', value);
        return;
    }

    // Base64 data URI містить власну кому. Тимчасово замінюємо весь data URI,
    // щоб вона не сприймалася як розділювач між кандидатами srcset.
    const normalized = value.replace(DATA_URI_IN_SRCSET_RE, 'data:inlined');
    for (const candidate of normalized.split(',')) {
        const url = candidate.trim().split(/\s+/, 1)[0];
        if (url) addReferenceIssue(issues, location, 'srcset', url);
    }
};

const inspectCss = (issues, css, location) => {
    const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"]+))\s*\)/gi;
    let match;

    while ((match = urlPattern.exec(css))) {
        const value = match[1] ?? match[2] ?? match[3] ?? '';
        addReferenceIssue(issues, location, 'url()', value);
    }

    // @import "file.css" / @import 'file.css'. Варіант url() уже знайдений вище.
    const importPattern = /@import\s+(?:"([^"]+)"|'([^']+)')/gi;
    while ((match = importPattern.exec(css))) {
        addReferenceIssue(issues, location, '@import', match[1] ?? match[2] ?? '');
    }
};

/**
 * Повертає список неінлайнених статичних посилань на асети.
 * Навігаційні <a href>, window.open() та інший JavaScript не аналізуються.
 *
 * @param {string} html
 * @returns {Array<{location: string, attribute: string, value: string, reason: string}>}
 */
export const findUninlinedAssetReferences = (html) => {
    const issues = [];

    // CSS перевіряємо окремо, а тіла script/style маскуємо перед пошуком HTML
    // тегів, щоб рядки на кшталт "<img src='...'>" у JS не дали false positive.
    const styleBlockPattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let styleMatch;
    while ((styleMatch = styleBlockPattern.exec(html))) {
        inspectCss(issues, styleMatch[1], '<style>');
    }

    const tagsOnly = html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
        .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2')
        .replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/gi, '$1$2');

    const tagPattern = /<([a-z][\w:-]*)\b[^>]*>/gi;
    let tagMatch;
    while ((tagMatch = tagPattern.exec(tagsOnly))) {
        const tagName = tagMatch[1].toLowerCase();
        const attrs = readAttributes(tagMatch[0]);

        for (const { name, value } of attrs) {
            if (ASSET_ATTRS.has(name)) {
                addReferenceIssue(issues, `<${tagName}>`, name, value);
            } else if (name === 'srcset') {
                inspectSrcset(issues, `<${tagName}>`, value);
            } else if (name === 'style') {
                inspectCss(issues, value, `<${tagName} style>`);
            } else if (tagName === 'link' && name === 'href') {
                // href у <a> є навігацією і навмисно ігнорується. href у <link>
                // завантажує stylesheet/icon/preload, тому це посилання на асет.
                addReferenceIssue(issues, '<link>', 'href', value);
            }
        }
    }

    return issues;
};

/**
 * Друкує preflight-звіт. Збірка завжди продовжується незалежно від результату.
 *
 * @param {string} html
 * @returns {ReturnType<typeof findUninlinedAssetReferences>}
 */
export const warnAboutUninlinedAssets = (html) => {
    const issues = findUninlinedAssetReferences(html);

    if (issues.length === 0) {
        console.log('✅ Preflight: all static asset references are inlined');
        return issues;
    }

    console.warn(`\n⚠️ Preflight: ${issues.length} static asset reference(s) remain non-inlined:`);
    for (const issue of issues) {
        const shownValue = issue.value || '(empty)';
        console.warn(`   - ${issue.location} ${issue.attribute}="${shownValue}"`);
    }
    console.warn('⚠️ Build continues; navigation links were not checked.');

    return issues;
};
