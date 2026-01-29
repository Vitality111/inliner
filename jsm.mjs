// FILE: inline-assets-in-js.mjs
// Знаходить всі асети в JS файлі, конвертує їх в base64 і інлайнить

import fs from 'fs-extra';
import path from 'path';
import { minify } from 'terser';
import { optimizeByMime } from './src/optimizers/index.mjs';
import { MIME } from './src/constants.mjs';

// Конвертація асету в data URI (використовує той самий оптимізатор, що й inline.mjs)
async function assetToDataUri(filePath, baseDir) {
    // Декодуємо URL-encoded шлях (наприклад, %20 → пробіл)
    const decodedPath = decodeURIComponent(filePath);
    const fullPath = path.resolve(baseDir, decodedPath);

    if (!await fs.pathExists(fullPath)) {
        console.log(`  ⚠️  Not found: ${decodedPath}`);
        return null;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const mimeType = MIME[ext] || 'application/octet-stream';

    console.log(`  📦 Processing: ${filePath}`);

    const original = await fs.readFile(fullPath);
    const before = original.length;

    // 🚀 Використовуємо той самий оптимізатор, що й inline.mjs
    let optimized = original;
    try {
        optimized = await optimizeByMime(original, mimeType);
    } catch (err) {
        console.log(`  ⚠️  Optimization failed, using original`);
        optimized = original;
    }

    const finalBuf = optimized.length <= original.length ? optimized : original;
    const base64 = finalBuf.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64}`;

    console.log(`  ✓ Encoded: ${before} bytes → ${finalBuf.length} bytes → ${dataUri.length} chars`);

    return dataUri;
}

// Знайти всі посилання на асети в коді
function findAssetReferences(code) {
    const patterns = [
        // src="path" або src='path'
        /src\s*=\s*["']([^"']+)["']/g,
        // url("path") або url('path') - з лапками (підтримує будь-які символи всередині)
        /url\s*\(\s*["']([^"']+)["']\s*\)/g,
        // url(path) - без лапок (тільки без пробілів і спецсимволів)
        /url\s*\(\s*([^"'\s)]+)\s*\)/g,
        // require('path') або require("path")
        /require\s*\(\s*["']([^"']+)["']\s*\)/g,
        // import ... from 'path'
        /from\s+["']([^"']+)["']/g,
    ];

    const references = new Set();

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(code)) !== null) {
            const ref = match[1];
            // Фільтруємо тільки локальні файли (не http, не node_modules)
            if (!ref.startsWith('http') &&
                !ref.startsWith('//') &&
                !ref.startsWith('data:') &&
                /\.(png|jpe?g|gif|svg|webp|mp3|wav|ogg|m4a|mp4|webm|woff2?|ttf|otf)$/i.test(ref)) {
                references.add(ref);
            }
        }
    }

    return Array.from(references);
}

// Основна функція
async function inlineAssetsInJs(inputPath, outputPath = null, options = {}) {
    const {
        minifyCode = true,
        optimizeAssets = true,
    } = options;

    console.log(`\n🚀 Processing: ${inputPath}`);

    const baseDir = path.dirname(inputPath);
    let code = await fs.readFile(inputPath, 'utf8');
    const originalSize = code.length;

    // Знайти всі асети
    const assetRefs = findAssetReferences(code);
    console.log(`\n📋 Found ${assetRefs.length} asset(s):`);
    assetRefs.forEach(ref => console.log(`   - ${ref}`));

    // Конвертувати і замінити
    console.log(`\n🔄 Converting assets to data URIs...`);
    for (const ref of assetRefs) {
        const dataUri = await assetToDataUri(ref, baseDir);
        if (dataUri) {
            // Замінюємо всі входження цього шляху
            code = code.replaceAll(ref, dataUri);
        }
    }

    // Мініфікація
    if (minifyCode) {
        console.log(`\n⚙️  Minifying JS...`);
        const result = await minify(code, {
            compress: {
                drop_console: false,
                passes: 2
            },
            mangle: true,
            format: {
                comments: false
            }
        });
        code = result.code;
    }

    // Статистика
    console.log(`\n📊 Results:`);
    console.log(`   Original: ${originalSize} bytes`);
    console.log(`   Final: ${code.length} bytes`);
    console.log(`   Change: ${code.length > originalSize ? '+' : ''}${code.length - originalSize} bytes`);

    // Збереження
    const output = outputPath || inputPath.replace(/\.js$/, '.inline.js');
    await fs.writeFile(output, code, 'utf8');
    console.log(`\n✅ Saved: ${output}`);

    return output;
}

// CLI
const args = process.argv.slice(2);
const input = args.find(arg => !arg.startsWith('--'));
const output = args.find((arg, i) => args[i - 1] === '--output' || args[i - 1] === '-o');
const flags = {
    minifyCode: !args.includes('--no-minify'),
    optimizeAssets: !args.includes('--no-optimize'),
};

if (!input) {
    console.log(`
Usage: node inline-assets-in-js.mjs <input.js> [options]

Options:
  -o, --output      Output file (default: input.inline.js)
  --no-minify       Skip JS minification
  --no-optimize     Skip asset optimization

Examples:
  node inline-assets-in-js.mjs main.js
  node inline-assets-in-js.mjs main.js -o main.min.js
  node inline-assets-in-js.mjs main.js --no-optimize
  `);
    process.exit(1);
}

inlineAssetsInJs(input, output, flags).catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
