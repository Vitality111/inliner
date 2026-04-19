// FILE: src/utils.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Утиліти: виконання зовнішніх процесів, async replace, пошук файлів,
// логування, інтерактивний режим.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import readline from 'readline';
import { stats } from './state.mjs';

export const execFileAsync = promisify(execFile);

// ========================== INTERACTIVE FLAG ==========================

/**
 * Прапорець інтерактивного режиму для replaceAsync.
 * Коли true — replaceAsync обробляє матчі послідовно (а не паралельно),
 * щоб промпти не змішувались.
 */
let isInteractiveMode = false;
export const setInteractiveFlag = (val) => { isInteractiveMode = val; };

// ========================== CROSS-PLATFORM RUNNER ==========================

/**
 * Запускає зовнішню команду крос-платформово.
 * На Windows npm-пакети встановлюють .cmd shim-и, які потребують
 * запуску через cmd.exe, інакше spawn кидає EINVAL.
 *
 * @param {string} bin — назва виконуваного файлу (наприклад 'pngquant', 'gifsicle')
 * @param {string[]} args — аргументи
 * @param {Object} [options] — опції для execFile
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export const runExternal = async (bin, args, options = {}) => {
    const isWin = process.platform === 'win32';
    if (isWin) {
        return await execFileAsync('cmd.exe', ['/c', bin, ...args], { windowsHide: true, ...options });
    }
    return await execFileAsync(bin, args, options);
};

// ========================== ASYNC STRING REPLACE ==========================

/**
 * Асинхронна версія String.prototype.replace з підтримкою async callback.
 * Стандартний replace не підтримує async — ця функція вирішує це.
 *
 * В інтерактивному режимі обробляє матчі ПОСЛІДОВНО (for...of),
 * щоб промпти в консолі не змішувались.
 * В звичайному режимі — ПАРАЛЕЛЬНО (Promise.all) для швидкості.
 *
 * @param {string} str — вхідний рядок
 * @param {RegExp} regex — регулярний вираз (з флагом g)
 * @param {Function} asyncFn — async callback (same signature as replace callback)
 * @returns {Promise<string>} рядок з заміненими матчами
 */
export const replaceAsync = async (str, regex, asyncFn) => {
    const matches = [...str.matchAll(regex)];
    if (matches.length === 0) return str;
    const parts = [];
    let lastIndex = 0;

    // Вибір стратегії: послідовно (interactive) або паралельно
    let replacements;
    if (isInteractiveMode) {
        replacements = [];
        for (const m of matches) {
            replacements.push(await asyncFn(...m));
        }
    } else {
        replacements = await Promise.all(matches.map((m) => asyncFn(...m)));
    }

    // Збираємо результат: чергуємо незмінені частини і заміни
    matches.forEach((m, i) => {
        parts.push(str.slice(lastIndex, m.index), replacements[i]);
        lastIndex = m.index + m[0].length;
    });
    parts.push(str.slice(lastIndex));
    return parts.join('');
};

// ========================== CRYPTO ==========================

/** SHA-1 хеш буфера (використовується для унікальних імен тимчасових файлів) */
export const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// ========================== PATH UTILS ==========================

/**
 * Очищає і декодує локальний шлях:
 *   - Видаляє hash (#fragment) і query (?params)
 *   - Декодує URL-encoded символи (%20 → пробіл)
 *
 * @param {string} u — URL або шлях
 * @returns {string} очищений шлях
 */
export const decodeLocalPath = (u) => {
    const clean = String(u).split('#')[0].split('?')[0];
    try { return decodeURI(clean); } catch { return clean; }
};

// ========================== FILE SEARCH ==========================

/**
 * Рекурсивно шукає файл за ім'ям починаючи з startDir.
 * Пропускає node_modules і .git.
 *
 * @param {string} targetFile — ім'я файлу для пошуку (наприклад 'index.html')
 * @param {string} startDir — директорія для початку пошуку
 * @returns {Promise<{basePath: string, fullPath: string} | null>}
 *   basePath — директорія де знайдений файл
 *   fullPath — повний шлях до файлу
 */
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

// ========================== LOGGING ==========================

/**
 * Логує економію розміру для одного файлу/ресурсу.
 * Також оновлює глобальні лічильники stats.
 *
 * Формат: ✅ filename: 1000 → 500 bytes (50.0% saved)
 *
 * @param {string} label — ім'я файлу або опис ресурсу
 * @param {number} original — розмір до оптимізації (bytes)
 * @param {number} final — розмір після оптимізації (bytes)
 */
export const logSaving = (label, original, final) => {
    stats.totalOriginalSize += original;
    stats.totalFinalSize += final;
    const saved = original - final;
    const pct = original ? ((1 - final / original) * 100).toFixed(1) : '0.0';
    console.log(`✅ ${label}: ${original} → ${final} bytes (${pct}% saved)`);
};

// ========================== URL CHECKS ==========================

/** Перевіряє чи URL є HTTP/HTTPS */
export const isHttp = (p) => /^https?:\/\//i.test(p);

/** Перевіряє чи рядок є data:URI */
export const isDataUri = (p) => /^data:/i.test(p);

// ========================== INTERACTIVE PROMPT ==========================

/**
 * Система інтерактивного режиму для вибору файлів для стиснення.
 *
 * Стани:
 *   'ask'  — питає для кожного файлу (початковий стан)
 *   'all'  — стискати все автоматично (після відповіді 'a')
 *   'none' — пропускати все (після відповіді 's')
 */
let interactiveMode = 'ask';
let rl = null;

/** Ініціалізує readline interface для інтерактивного режиму */
export const initInteractive = () => {
    if (rl) return;
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });
};

/** Закриває readline і скидає стан */
export const closeInteractive = () => {
    if (rl) {
        rl.close();
        rl = null;
    }
    interactiveMode = 'ask'; // reset для повторного використання
};

export const setInteractiveMode = (mode) => {
    interactiveMode = mode;
};

export const getInteractiveMode = () => interactiveMode;

/**
 * Запитує користувача чи стискати конкретний файл.
 *
 * Формат промпту:
 *   🖼️  bg.png (448 KB) - Compress? [y/n/a/s]:
 *
 * Відповіді:
 *   y (або Enter) — стиснути цей файл
 *   n — пропустити цей файл
 *   a — стиснути цей і ВСІ наступні файли автоматично
 *   s — пропустити цей і ВСІ наступні файли
 *
 * @param {string} filename — ім'я файлу
 * @param {number} sizeKb — розмір у кілобайтах
 * @returns {Promise<boolean>} true = стискати, false = пропустити
 */
export const askCompress = async (filename, sizeKb) => {
    if (interactiveMode === 'all') return true;
    if (interactiveMode === 'none') return false;

    // Форматування розміру
    const sizeStr = sizeKb >= 1024
        ? `${(sizeKb / 1024).toFixed(1)} MB`
        : `${sizeKb.toFixed(0)} KB`;

    // Іконка за типом файлу
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
                // y, Enter, або будь-що інше = стискати
                resolve(true);
            }
        };

        process.stdin.once('data', onData);
    });
};
