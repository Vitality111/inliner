// FILE: src/utils.mjs
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import readline from 'readline';
import { stats } from './state.mjs';

export const execFileAsync = promisify(execFile);

// Прапорець інтерактивного режиму (встановлюється з inline.mjs)
let isInteractiveMode = false;
export const setInteractiveFlag = (val) => { isInteractiveMode = val; };

// -------------------- Cross-platform external runner --------------------
// On Windows, many npm-installed CLIs are .cmd shims; running via `cmd.exe /c` avoids spawn EINVAL.
export const runExternal = async (bin, args, options = {}) => {
    const isWin = process.platform === 'win32';
    if (isWin) {
        return await execFileAsync('cmd.exe', ['/c', bin, ...args], { windowsHide: true, ...options });
    }
    return await execFileAsync(bin, args, options);
};

// Безпечний replaceAsync
export const replaceAsync = async (str, regex, asyncFn) => {
    const matches = [...str.matchAll(regex)];
    if (matches.length === 0) return str;
    const parts = [];
    let lastIndex = 0;

    // В інтерактивному режимі — послідовно, інакше — паралельно
    let replacements;
    if (isInteractiveMode) {
        replacements = [];
        for (const m of matches) {
            replacements.push(await asyncFn(...m));
        }
    } else {
        replacements = await Promise.all(matches.map((m) => asyncFn(...m)));
    }

    matches.forEach((m, i) => {
        parts.push(str.slice(lastIndex, m.index), replacements[i]);
        lastIndex = m.index + m[0].length;
    });
    parts.push(str.slice(lastIndex));
    return parts.join('');
};

export const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

export const decodeLocalPath = (u) => {
    const clean = String(u).split('#')[0].split('?')[0];
    try { return decodeURI(clean); } catch { return clean; }
};

// Пошук файлу в проекті (можна додати --root для обмеження)
export const findFileRecursive = async (targetFile, startDir) => {
    const entries = await fs.readdir(startDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(startDir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const result = await findFileRecursive(targetFile, fullPath);
            if (result) return result;
        } else if (entry.name === targetFile) {
            return { basePath: path.dirname(fullPath), fullPath };
        }
    }
    return null;
};

// Логгер економії
export const logSaving = (label, original, final) => {
    stats.totalOriginalSize += original;
    stats.totalFinalSize += final;
    const saved = original - final;
    const pct = original ? ((1 - final / original) * 100).toFixed(1) : '0.0';
    console.log(`✅ ${label}: ${original} → ${final} bytes (${pct}% saved)`);
};

export const isHttp = (p) => /^https?:\/\//i.test(p);
export const isDataUri = (p) => /^data:/i.test(p);

// -------------------- Interactive prompt --------------------
let interactiveMode = 'ask'; // 'ask' | 'all' | 'none'
let rl = null;

export const initInteractive = () => {
    if (rl) return;
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });
};

export const closeInteractive = () => {
    if (rl) {
        rl.close();
        rl = null;
    }
    interactiveMode = 'ask'; // reset
};

export const setInteractiveMode = (mode) => {
    interactiveMode = mode;
};

export const getInteractiveMode = () => interactiveMode;

// Запитати користувача чи стискати файл
// Повертає: true = стискати, false = пропустити
export const askCompress = async (filename, sizeKb) => {
    if (interactiveMode === 'all') return true;
    if (interactiveMode === 'none') return false;

    const sizeStr = sizeKb >= 1024
        ? `${(sizeKb / 1024).toFixed(1)} MB`
        : `${sizeKb.toFixed(0)} KB`;

    // Визначаємо іконку по розширенню
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const icons = {
        png: '🖼️', jpg: '🖼️', jpeg: '🖼️', webp: '🖼️', gif: '🎞️',
        mp3: '🎵', m4a: '🎵', wav: '🎵', ogg: '🎵',
        mp4: '🎬', webm: '🎬',
        woff: '🔤', woff2: '🔤', ttf: '🔤', otf: '🔤',
        glb: '🎮'
    };
    const icon = icons[ext] || '📦';

    process.stdout.write(`\n${icon}  ${filename} (${sizeStr}) - Compress? [y/n/a/s]: `);

    return new Promise((resolve) => {
        const onData = (chunk) => {
            const answer = chunk.toString().trim().toLowerCase();
            process.stdin.removeListener('data', onData);

            if (answer === 'a') {
                interactiveMode = 'all';
                console.log('   ➡️  Auto mode: compressing all remaining files');
                resolve(true);
            } else if (answer === 's') {
                interactiveMode = 'none';
                console.log('   ➡️  Skip mode: skipping all remaining files');
                resolve(false);
            } else if (answer === 'n') {
                resolve(false);
            } else {
                resolve(true);
            }
        };

        process.stdin.once('data', onData);
    });
};
