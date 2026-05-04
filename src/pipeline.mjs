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
import { INPUT_FILE, FLAGS, OPT_EXTS, OPTIMIZE_ONLY, OVERRIDE_DIR_NAME, __dirname, CONFIG } from './config.mjs';
import { setProjectRoot, stats } from './state.mjs';
import { findFileRecursive, logSaving } from './utils.mjs';
import { optimizeByMime } from './optimizers/index.mjs';
import { MIME } from './constants.mjs';
import { inlineCssLinks } from './processors/css.mjs';
import { inlineJsScripts, processInlineScripts } from './processors/js.mjs';
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

// ========================== AUTO-DETECT FONT SUBSET ==========================

/**
 * Автоматично збирає всі унікальні символи з HTML, CSS та JS файлів проєкту.
 * Використовується для font subsetting — у шрифті залишаться ТІЛЬКИ символи,
 * що реально використовуються у плейблі.
 *
 * Це вирішує проблему з мультимовністю: турецькі (ş, ç, ğ, ı, İ),
 * французькі (é, è, ê), японські (ひらがな, カタカナ), хінді (हिन्दी)
 * та інші символи автоматично потрапляють у subset.
 *
 * @param {string} htmlContent — вміст HTML файлу
 * @param {string} basePath — базова директорія проєкту
 * @returns {Promise<string>} рядок з усіма унікальними символами
 */
const autoDetectFontSubset = async (htmlContent, basePath) => {
    let allText = htmlContent;

    // Збираємо текст з підключених CSS файлів
    const cssRefs = [...htmlContent.matchAll(/<link[^>]*href=["']([^"']+\.css(?:\?[^"']*)?)["'][^>]*>/gi)];
    for (const [, href] of cssRefs) {
        const cssPath = path.resolve(basePath, href.split('?')[0]);
        if (await fs.pathExists(cssPath)) {
            allText += await fs.readFile(cssPath, 'utf8');
        }
    }

    // Збираємо текст з підключених JS файлів
    const jsRefs = [...htmlContent.matchAll(/<script[^>]*src=["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/gi)];
    for (const [, src] of jsRefs) {
        const jsPath = path.resolve(basePath, src.split('?')[0]);
        if (await fs.pathExists(jsPath)) {
            allText += await fs.readFile(jsPath, 'utf8');
        }
    }

    // Збираємо унікальні символи (без керуючих, крім пробілу)
    const chars = new Set(allText);
    for (const c of chars) {
        const code = c.charCodeAt(0);
        if (code < 32 && code !== 9) chars.delete(c); // видаляємо \n \r тощо, залишаємо tab
    }

    // ⚡ КРИТИЧНО: додаємо uppercase/lowercase пару для КОЖНОГО символу.
    // CSS text-transform: capitalize/uppercase перетворює 'ç' → 'Ç',
    // але авто-детект бачить тільки 'ç' з HTML.
    // Без цього — гліф 'Ç' зникає з subset і браузер показує fallback шрифт.
    const expanded = new Set(chars);
    for (const c of chars) {
        expanded.add(c.toUpperCase());
        expanded.add(c.toLowerCase());
    }

    // Додаємо базові символи-fallback (пунктуація, цифри)
    const fallback = ' !?.,;:-_()[]{}<>@#$%^&*/\\|`~\'"+=0123456789';
    for (const c of fallback) expanded.add(c);

    // Додаємо розширені латинські символи для 10 мов:
    // турецька (ş,ç,ğ,ı,İ,Ş,Ç,Ğ,Ö,Ü,ö,ü)
    // французька (é,è,ê,ë,à,â,ô,ù,û,ü,ï,ç,œ,æ)
    // португальська (ã,õ,á,é,í,ó,ú,â,ê,ô,à,ç)
    // іспанська (ñ,á,é,í,ó,ú,ü,¡,¿)
    // нідерландська (ë,ï,é,ö,ü)
    // італійська (à,è,é,ì,ò,ù)
    // філіпінська (ñ)
    // хінді (деванагарі)
    // японська (поширені хірагана/катакана)
    const multiLang = 'şçğıİŞÇĞÖÜöüéèêëàâôùûïœæãõáíóúñ¡¿ìòÉÈÊËÀÂÔÙÛÏŒÆÃÕÁÍÓÚÑÌÒ';
    for (const c of multiLang) {
        expanded.add(c);
        expanded.add(c.toUpperCase());
        expanded.add(c.toLowerCase());
    }

    return [...expanded].join('');
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
    const saved = stats.totalAssetsOriginalSize - stats.totalAssetsFinalSize;
    console.log(`📦 Assets optimized: ${(stats.totalAssetsFinalSize / 1024).toFixed(1)} KB (saved ${(saved / 1024).toFixed(1)} KB)`);
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
    stats.originalHtmlSize = Buffer.byteLength(html, 'utf8');

    // ──── Авто-детект subset для шрифтів (якщо не задано явно через CLI) ────
    if (!FLAGS.fontSubset && CONFIG.font.optimize) {
        const detectedSubset = await autoDetectFontSubset(html, basePath);
        CONFIG.font.subset = detectedSubset;
        console.log(`🔤 Auto-detected ${detectedSubset.length} unique characters for font subsetting`);
    }

    // Пайплайн обробки (порядок важливий!)
    html = await inlineCssLinks(html, basePath);           // 1. <link> → <style>
    html = await processInlineScripts(html, basePath);     // 2a. Вбудовані <script> (без src) → мініфікація та інлайн ассетів
    html = await inlineJsScripts(html, basePath);          // 2b. <script src> → inline та мініфікація
    html = await inlineHtmlMediaAttrs(html, basePath);     // 3. src/poster/... → data:URI
    html = await inlineSrcset(html, basePath);             // 4. srcset → data:URI
    html = await inlineStylesEverywhere(html, basePath);   // 5. style url() → data:URI
    html = await reencodeAllDataUrisInHtml(html);          // 6. re-optimize всіх data:URI
    html = maybeMinifyHtml(html);                          // 7. minify HTML (text content)

    // Зауваження: Вбудовані <script> та <style> тепер мініфікуються
    // на кроках 2a (processInlineScripts) та 5 (inlineStylesEverywhere).

    // Зберігаємо результат
    stats.finalFileSize = Buffer.byteLength(html, 'utf8');
    await fs.mkdirp('dist');
    await fs.writeFile(path.join('dist', htmlFileName), html);

    // Статистика
    const originalTotal = stats.originalHtmlSize + stats.totalAssetsOriginalSize;
    const finalTotal = stats.finalFileSize;
    const saved = originalTotal - finalTotal;
    console.log(`\n🎉 One-file playable created at: dist/${htmlFileName}`);
    console.log(`📦 Final size: ${(finalTotal / 1024).toFixed(1)} KB (saved ${(saved / 1024).toFixed(1)} KB from ${(originalTotal / 1024).toFixed(1)} KB)`);
};
