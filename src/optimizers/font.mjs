// FILE: src/optimizers/font.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Оптимізатор шрифтів через Fontmin (font subsetting).
//
// Видаляє з шрифту всі гліфи, крім тих що зазначені в CONFIG.font.subset.
// Це може СУТТЄВО зменшити розмір шрифту (наприклад, з 500KB до 30KB),
// якщо використовується лише латиниця.
//
// ⚠️ Якщо в тексті з'являться символи, які не увійшли в subset —
//    вони не відобразяться! Перевіряй CONFIG.font.subset.
//
// Fontmin працює через файлову систему (не з буферами), тому
// створюються тимчасові файли.
//
// Залежності: fontmin (npm)
// ─────────────────────────────────────────────────────────────────────────────

import Fontmin from 'fontmin';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { CONFIG, __dirname } from '../config.mjs';

/**
 * Оптимізує буфер шрифту через font subsetting.
 *
 * @param {Buffer} buf — оригінальний буфер шрифту (TTF/OTF/WOFF/WOFF2)
 * @returns {Promise<Buffer>} оптимізований буфер (або оригінал якщо більший)
 */
export const optimizeFontBuffer = async (buf) => {
    if (!CONFIG.font.optimize) {
        return buf;
    }

    // Тимчасові шляхи (Fontmin працює з файлами)
    const tmpIn = path.join(__dirname, `.font-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const tmpOutDir = path.join(__dirname, `.font-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    await fs.writeFile(tmpIn, buf);

    const fontmin = new Fontmin()
        .src(tmpIn)
        .use(Fontmin.glyph({ text: CONFIG.font.subset }))  // залишити тільки потрібні гліфи
        .dest(tmpOutDir);

    await promisify(fontmin.run.bind(fontmin))();

    const outFiles = await fs.readdir(tmpOutDir);
    let out = buf;
    if (outFiles.length) {
        const first = path.join(tmpOutDir, outFiles[0]);
        out = await fs.readFile(first);
    }

    // Cleanup тимчасових файлів
    await fs.remove(tmpIn).catch(() => { });
    await fs.remove(tmpOutDir).catch(() => { });

    // Повертаємо оптимізований тільки якщо він не більший
    return out.length && out.length <= buf.length ? out : buf;
};
