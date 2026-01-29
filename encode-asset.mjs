// FILE: encode-asset.mjs
// Кодування assets (зображення, аудіо, відео) в base64 data URI

import fs from 'fs-extra';
import path from 'path';

const MIME_TYPES = {
    // Images
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',

    // Audio
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',

    // Video
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',

    // Fonts
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',

    // Other
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
};

async function encodeAsset(inputPath, outputPath = null) {
    const ext = path.extname(inputPath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    console.log(`📦 Encoding: ${inputPath}`);
    console.log(`📝 MIME type: ${mimeType}`);

    // Читання файлу
    const buffer = await fs.readFile(inputPath);
    const base64 = buffer.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64}`;

    console.log(`✓ Size: ${buffer.length} bytes → ${dataUri.length} chars`);

    // Збереження результату
    if (outputPath) {
        await fs.writeFile(outputPath, dataUri, 'utf8');
        console.log(`✅ Saved to: ${outputPath}`);
    } else {
        // Вивести в консоль
        console.log('\n📋 Data URI:');
        console.log(dataUri);
    }

    return dataUri;
}

// CLI
const args = process.argv.slice(2);
const input = args.find(arg => !arg.startsWith('--'));
const outputFlag = args.find((arg, i) => args[i - 1] === '--output' || args[i - 1] === '-o');

if (!input) {
    console.log(`
Usage: node encode-asset.mjs <input-file> [options]

Options:
  -o, --output  Output file path (default: print to console)

Examples:
  node encode-asset.mjs image.png
  node encode-asset.mjs image.png -o image.txt
  node encode-asset.mjs audio.mp3 --output audio-base64.txt
  `);
    process.exit(1);
}

encodeAsset(input, outputFlag).catch(console.error);
