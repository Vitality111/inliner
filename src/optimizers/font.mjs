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

/**
 * Оптимізує буфер шрифту через font subsetting (harfbuzz).
 *
 * @param {Buffer} buf — оригінальний буфер шрифту (TTF/OTF/WOFF/WOFF2)
 * @returns {Promise<Buffer>} оптимізований буфер (або оригінал якщо більший)
 */
export const optimizeFontBuffer = async (buf) => {
    if (!CONFIG.font.optimize) {
        return buf;
    }

    if (!CONFIG.font.subset) {
        return buf;
    }

    try {
        // subset-font приймає Buffer і рядок з символами,
        // повертає Buffer з тільки потрібними гліфами.
        // The call intentionally omits targetFormat, so subset-font keeps woff/woff2/sfnt.
        const out = await subsetFont(buf, CONFIG.font.subset);

        // Повертаємо оптимізований тільки якщо він не більший
        return out.length && out.length <= buf.length ? out : buf;
    } catch (e) {
        console.warn('⚠️ Font subsetting failed, keeping original:', e.message);
        return buf;
    }
};
