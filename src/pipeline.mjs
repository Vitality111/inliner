// FILE: src/pipeline.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Головний пайплайн збірки. Два режими:
//
//   1. Inline HTML (за замовчуванням):
//      Знаходить вхідний HTML → інлайнить CSS/JS/ассети → dist/output.html
//
//   2. Optimize Only (--optimizeOnly --assetsDir=assets):
//      Стискає файли в папці на місці, HTML не чіпає
//
// Порядок обробки HTML (важливий!):
//   1. CSS links → <style> (щоб потім обробити url() всередині)
//   2. JS scripts → inline (з бандлінгом ES модулів)
//   3. Media attrs (src, poster, data-src, background) → data:URI
//   4. srcset → data:URI
//   5. Styles everywhere (<style> та style="") → url() → data:URI
//   6. Re-encode всіх data:URI (фінальна оптимізація)
//   7. HTML minify (видалення коментарів/пробілів)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs-extra';
import path from 'path';
import { INPUT_FILE, FLAGS, OPT_EXTS, OPTIMIZE_ONLY, OVERRIDE_DIR_NAME, __dirname } from './config.mjs';
import { setProjectRoot, stats } from './state.mjs';
import { findFileRecursive, logSaving } from './utils.mjs';
import { optimizeByMime } from './optimizers/index.mjs';
import { MIME } from './constants.mjs';
import { inlineCssLinks } from './processors/css.mjs';
import { inlineJsScripts } from './processors/js.mjs';
import { inlineHtmlMediaAttrs, inlineSrcset, inlineStylesEverywhere, reencodeAllDataUrisInHtml, maybeMinifyHtml } from './processors/html.mjs';

// ========================== FILESYSTEM WALKER ==========================

/**
 * Рекурсивно збирає всі файли в директорії.
 * Пропускає папку оверрайдів (OVERRIDE_DIR_NAME = 'dir').
 *
 * @param {string} dir — абсолютний шлях до директорії
 * @returns {Promise<string[]>} масив абсолютних шляхів до файлів
 */
const walkFiles = async (dir) => {
    const out = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        if (e.isDirectory()) {
            if (e.name === OVERRIDE_DIR_NAME) continue; // 🚫 Skip override dir
            const p = path.join(dir, e.name);
            out.push(...await walkFiles(p));
        } else {
            out.push(path.join(dir, e.name));
        }
    }
    return out;
};

// ========================== OPTIMIZE ONLY MODE ==========================

/**
 * Режим оптимізації на місці: стискає файли в папці, перезаписує оригінали.
 * Замінює файл тільки якщо оптимізований менший.
 *
 * Підтримувані розширення визначаються в OPT_EXTS (config.mjs).
 *
 * @param {string} assetsDirAbs — абсолютний шлях до папки з ассетами
 */
export const optimizeAssetsFolderInPlace = async (assetsDirAbs) => {
    if (!assetsDirAbs) throw new Error('❌ Missing --assetsDir. Example: --assetsDir=assets');
    if (!await fs.pathExists(assetsDirAbs)) {
        throw new Error(`❌ assetsDir not found: ${assetsDirAbs}`);
    }

    const files = await walkFiles(assetsDirAbs);

    for (const fileAbsPath of files) {
        const ext = path.extname(fileAbsPath).toLowerCase();
        if (!OPT_EXTS.has(ext)) continue;

        const mime = MIME[ext] || 'application/octet-stream';
        const original = await fs.readFile(fileAbsPath);
        const before = original.length;

        let outBuf = original;
        try {
            outBuf = await optimizeByMime(original, mime);
        } catch { outBuf = original; }

        // Перезаписуємо файл тільки якщо реально менший
        if (outBuf && outBuf.length && outBuf.length < before) {
            await fs.writeFile(fileAbsPath, outBuf);
            logSaving(path.relative(assetsDirAbs, fileAbsPath), before, outBuf.length);
        } else {
            logSaving(path.relative(assetsDirAbs, fileAbsPath), before, before);
        }
    }

    console.log(`\n✅ Assets optimized in-place: ${assetsDirAbs}`);
};

// ========================== MAIN PIPELINE ==========================

/**
 * Головна функція збірки. Знаходить HTML файл, обробляє його
 * через весь пайплайн і зберігає результат у dist/.
 *
 * Пошук файлу починається з батьківської директорії проєкту
 * (на 2 рівні вище від src/), що дозволяє запускати з будь-якої
 * вкладеної папки.
 */
export const inlineHtml = async () => {
    // __dirname = .../src, тому '../..' = батьківська директорія проєкту
    const startDir = path.resolve(__dirname, '../..');

    const result = await findFileRecursive(INPUT_FILE, startDir);
    if (!result) throw new Error(`❌ File "${INPUT_FILE}" not found in any subfolder of ${startDir}`);
    const { basePath, fullPath } = result;

    setProjectRoot(basePath); // Встановлюємо корінь проєкту для override логіки

    // ──── Режим оптимізації на місці ────
    if (OPTIMIZE_ONLY) {
        const assetsDirAbs = FLAGS.assetsDir
            ? (path.isAbsolute(FLAGS.assetsDir)
                ? FLAGS.assetsDir
                : path.resolve(basePath, FLAGS.assetsDir))
            : null;

        await optimizeAssetsFolderInPlace(assetsDirAbs);
        return; // 🚫 НЕ робимо інлайн HTML
    }

    // ──── Режим інлайну HTML ────
    const htmlFileName = path.basename(fullPath);
    let html = await fs.readFile(fullPath, 'utf8');

    // Пайплайн обробки (порядок важливий!)
    html = await inlineCssLinks(html, basePath);           // 1. <link> → <style>
    html = await inlineJsScripts(html, basePath);          // 2. <script src> → inline
    html = await inlineHtmlMediaAttrs(html, basePath);     // 3. src/poster/... → data:URI
    html = await inlineSrcset(html, basePath);             // 4. srcset → data:URI
    html = await inlineStylesEverywhere(html, basePath);   // 5. style url() → data:URI
    html = await reencodeAllDataUrisInHtml(html);          // 6. re-optimize всіх data:URI
    html = maybeMinifyHtml(html);                          // 7. minify HTML

    // Зберігаємо результат
    await fs.mkdirp('dist');
    await fs.writeFile(path.join('dist', htmlFileName), html);

    // Статистика
    const saved = stats.totalOriginalSize - stats.totalFinalSize;
    console.log(`\n🎉 One-file playable created at: dist/${htmlFileName}`);
    console.log(`📦 Total size: ${(stats.totalFinalSize / 1024).toFixed(1)} KB (saved ${(saved / 1024).toFixed(1)} KB)`);
};
