import fs from 'fs-extra';
import { minify } from 'terser';
import { gzip } from 'zlib';
import { promisify } from 'util';
import path from 'path';

const gzipAsync = promisify(gzip);

async function processJsFile(inputPath, outputPath, options = {}) {
    const {
        minify: shouldMinify = true,
        compress = false,
        base64 = false
    } = options;

    console.log(`📦 Processing: ${inputPath}`);

    let code = await fs.readFile(inputPath, 'utf8');
    let outputData = code;

    // Мінімізація
    if (shouldMinify) {
        console.log('⚙️  Minifying...');
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
        outputData = result.code;
        console.log(`✓ Size: ${code.length} → ${outputData.length} bytes`);
    }

    // Стиснення gzip
    if (compress) {
        console.log('🗜️  Compressing...');
        const buffer = await gzipAsync(Buffer.from(outputData));
        outputData = buffer;
        console.log(`✓ Compressed: ${outputData.length} bytes`);
    }

    // Base64
    if (base64) {
        console.log('🔤 Encoding to Base64...');
        const b64 = Buffer.from(outputData).toString('base64');
        // Створюємо самовиконуючийся код для декодування
        outputData = compress
            ? `eval(pako.ungzip(atob('${b64}'), { to: 'string' }));`
            : `eval(atob('${b64}'));`;
    }

    // Запис результату
    await fs.writeFile(outputPath, outputData);
    console.log(`✅ Saved: ${outputPath}`);
}

// CLI
const args = process.argv.slice(2);
const input = args[0];
const flags = {
    minify: args.includes('--minify'),
    compress: args.includes('--compress'),
    base64: args.includes('--base64')
};

if (!input) {
    console.log(`
Usage: node minify-js.mjs <input.js> [options]

Options:
  --minify      Minify JS code (default: true)
  --compress    Gzip compression
  --base64      Encode to Base64

Example:
  node minify-js.mjs script.js --minify --compress --base64
  `);
    process.exit(1);
}

const ext = flags.compress && flags.base64 ? '.js.gz.b64' :
    flags.compress ? '.js.gz' :
        flags.base64 ? '.js.b64' :
            '.min.js';

const output = input.replace(/\.js$/, ext);

processJsFile(input, output, flags).catch(console.error);