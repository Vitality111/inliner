// FILE: src/pipeline.mjs
import fs from 'fs-extra';
import path from 'path';
import { INPUT_FILE, FLAGS, OPT_EXTS, OVERRIDE_DIR_NAME, __dirname } from './config.mjs';
import { setProjectRoot, stats } from './state.mjs';
import { findFileRecursive, logSaving } from './utils.mjs';
import { optimizeByMime } from './optimizers/index.mjs';
import { MIME } from './constants.mjs';
import { inlineCssLinks } from './processors/css.mjs';
import { inlineJsScripts } from './processors/js.mjs';
import { inlineHtmlMediaAttrs, inlineSrcset, inlineStylesEverywhere, reencodeAllDataUrisInHtml, maybeMinifyHtml } from './processors/html.mjs';

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

        // ✅ перезапис тільки якщо реально менше
        if (outBuf && outBuf.length && outBuf.length < before) {
            await fs.writeFile(fileAbsPath, outBuf);
            logSaving(path.relative(assetsDirAbs, fileAbsPath), before, outBuf.length);
        } else {
            logSaving(path.relative(assetsDirAbs, fileAbsPath), before, before);
        }
    }

    console.log(`\n✅ Assets optimized in-place: ${assetsDirAbs}`);
};

export const inlineHtml = async () => {
    // Fix: search from parent of the project root (where inline.mjs is located)
    // __dirname in config.mjs is .../src
    // path.resolve(__dirname, '../..') -> .../ (parent of project)
    const startDir = path.resolve(__dirname, '../..');

    const result = await findFileRecursive(INPUT_FILE, startDir);
    if (!result) throw new Error(`❌ File "${INPUT_FILE}" not found in any subfolder of ${startDir}`);
    const { basePath, fullPath } = result;

    setProjectRoot(basePath); // ✅ Set global root for override logic

    // ✅ 0) Якщо режим optimizeOnly — стискаємо файли в папці і ВИХОДИМО
    if (!!FLAGS.optimizeOnly) {
        // assetsDir можна передавати як relative (відносно index.html) або absolute
        const assetsDirAbs = FLAGS.assetsDir
            ? (path.isAbsolute(FLAGS.assetsDir)
                ? FLAGS.assetsDir
                : path.resolve(basePath, FLAGS.assetsDir))
            : null;

        await optimizeAssetsFolderInPlace(assetsDirAbs);
        return; // 🚫 НЕ робимо інлайн HTML взагалі
    }

    const htmlFileName = path.basename(fullPath);
    let html = await fs.readFile(fullPath, 'utf8');

    html = await inlineCssLinks(html, basePath);
    html = await inlineJsScripts(html, basePath);
    html = await inlineHtmlMediaAttrs(html, basePath);
    html = await inlineSrcset(html, basePath);
    html = await inlineStylesEverywhere(html, basePath);
    html = await reencodeAllDataUrisInHtml(html);
    html = maybeMinifyHtml(html);

    await fs.mkdirp('dist');
    await fs.writeFile(path.join('dist', htmlFileName), html);

    const saved = stats.totalOriginalSize - stats.totalFinalSize;
    console.log(`\n🎉 One-file playable created at: dist/${htmlFileName}`);
    console.log(`📦 Total size: ${(stats.totalFinalSize / 1024).toFixed(1)} KB (saved ${(saved / 1024).toFixed(1)} KB)`);
};
