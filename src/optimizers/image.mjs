// FILE: src/optimizers/image.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Оптимізатор зображень. Підтримує JPEG, WebP, PNG, GIF, SVG.
//
// PNG: двоетапна оптимізація:
//   1. pngquant (lossy) — зменшує кількість кольорів у палітрі
//   2. sharp (fallback) — якщо pngquant недоступний або провалився
//
// GIF: gifsicle з lossy та color reduction
// JPEG/WebP: sharp з налаштованою якістю
// SVG: без змін (вже текстовий формат)
//
// Залежності:
//   - sharp (обов'язково)
//   - pngquant-bin (опціонально, для кращого PNG стиснення)
//   - gifsicle (опціонально, для GIF оптимізації)
// ─────────────────────────────────────────────────────────────────────────────

import sharp from 'sharp';
import fs from 'fs-extra';
import path from 'path';
import { CONFIG, __dirname } from '../config.mjs';
import { runExternal } from '../utils.mjs';

// Спробуємо імпортувати pngquant-bin (опціональна залежність).
// Якщо не встановлений — використовуємо системний 'pngquant' з PATH.
let pngquantPath = 'pngquant';
try {
    const pngquantBin = await import('pngquant-bin');
    pngquantPath = pngquantBin.default;
} catch { }

/** PNG magic bytes для валідації: 89 50 4E 47 0D 0A 1A 0A */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** Перевірка чи буфер є валідним PNG файлом */
const isValidPng = (buf) => buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);

/** Обмежує числовий параметр у безпечному діапазоні */
const clampNumber = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Повертає стиснений буфер лише якщо він справді менший */
const smallerOrOriginal = (original, optimized) =>
    optimized?.length && optimized.length < original.length ? optimized : original;

/**
 * Для lossy-форматів (JPEG/WebP): приймаємо результат лише якщо він менший
 * щонайменше на CONFIG.lossy.minGainPct відсотків. Інакше файл уже стиснений,
 * і повторне кодування лише додає покоління артефактів (див. config.mjs).
 */
const lossyGainOrOriginal = (original, optimized, label) => {
    if (!optimized?.length || optimized.length >= original.length) return original;
    const minGain = Math.max(0, Number(CONFIG.lossy?.minGainPct) || 0);
    const gainPct = (1 - optimized.length / original.length) * 100;
    if (gainPct < minGain) {
        console.log(`⏭️  ${label}: gain ${gainPct.toFixed(1)}% < ${minGain}% — already compressed, kept original`);
        return original;
    }
    return optimized;
};

const optimizeJpegBuffer = async (buf) => {
    const quality = clampNumber(CONFIG.image.jpegQ, 1, 100, 70);
    const out = await sharp(buf).jpeg({
        quality,
        mozjpeg: true,
        trellisQuantisation: true,
        overshootDeringing: true,
        optimizeScans: true,
        optimizeCoding: true,
        chromaSubsampling: quality >= 80 ? '4:4:4' : '4:2:0'
    }).toBuffer();

    return lossyGainOrOriginal(buf, out, 'jpeg');
};

const optimizeWebpBuffer = async (buf) => {
    const quality = clampNumber(CONFIG.image.webpQ, 1, 100, 72);
    const out = await sharp(buf).webp({
        quality,
        effort: 6,
        smartSubsample: true,
        nearLossless: quality >= 95
    }).toBuffer();

    return lossyGainOrOriginal(buf, out, 'webp');
};

// ========================== PNG ==========================

/**
 * Оптимізує PNG через pngquant (lossy) з fallback на sharp.
 *
 * Алгоритм:
 *   1. Перевірка валідності PNG (magic bytes) і мінімального розміру
 *   2. Якщо quality=100 — лише lossless через sharp (без pngquant)
 *   3. Запуск pngquant з параметрами quality, speed, colors
 *   4. Якщо pngquant впав — fallback на sharp
 *   5. Якщо результат більший за оригінал — повертаємо оригінал
 *
 * @param {Buffer} buf — PNG буфер
 * @returns {Promise<Buffer>} оптимізований PNG буфер
 */
export const optimizePngBuffer = async (buf) => {
    // Маленькі буфери або не-PNG дані (наприклад, inline pixel data)
    // — обробляємо лише через sharp
    if (!isValidPng(buf) || buf.length < 256) {
        try {
            return await sharp(buf).png({
                compressionLevel: 9,
                palette: !!CONFIG.image.pngPalette
            }).toBuffer();
        } catch {
            return buf;
        }
    }

    // Тимчасові файли для pngquant (працює з файлами, не буферами)
    const tmpIn = path.join(__dirname, `.tmp-png-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    const tmpOut = `${tmpIn}.out.png`;

    // Валідація і clamping параметрів.
    //
    // ⚠️ Ключове про pngquant: верхня межа --quality — це ЦІЛЬ, під яку він
    // добирає МІНІМАЛЬНУ кількість кольорів ("least amount of colors required
    // to meet or exceed the max quality"). Тому --quality=75-80 легко з'їдає
    // фото до 10–20 кольорів, і зображення виглядає безколірним, навіть коли
    // pngColors=256 (це лише стеля палітри, а не її мінімум).
    //
    //   quality — НИЖНЯ межа: мінімально прийнятна якість (нижче → fallback)
    //   target  — ВЕРХНЯ межа: ціль, що керує розміром палітри (100 = не ріже)
    const quality = clampNumber(CONFIG.image.pngQuality, 0, 100, 80);
    const target = Math.max(quality, clampNumber(CONFIG.image.pngTarget, 1, 100, 100));
    const speed = clampNumber(CONFIG.image.pngLevel, 1, 11, 3);
    const colors = clampNumber(CONFIG.image.pngColors, 2, 256, 256);
    const usePalette = !!CONFIG.image.pngPalette;

    // pngQuality=100 — lossless режим, pngquant не потрібен
    if (quality >= 100) {
        return await sharp(buf).png({
            compressionLevel: 9,
            palette: usePalette,
            quality: 100
        }).toBuffer();
    }

    await fs.writeFile(tmpIn, buf);

    // pngquant --quality=<min>-<target>:
    //   min    — якщо результат гірший, pngquant виходить з кодом 99
    //             і ми переходимо на безпечний lossless fallback (sharp)
    //   target — ціль, під яку добирається розмір палітри:
    //             100 = палітра не ріжеться (кольори збережені, файл більший)
    //              80 = агресивно, палітра може впасти до кількох кольорів
    // Формуємо аргументи pngquant
    const args = [
        `--quality=${quality}-${target}`,
        '--speed', String(speed),        // швидкість (1=найкраще, 11=найшвидше)
        '--force',                       // перезаписати вихідний файл
        '--strip',                       // видалити EXIF/метадані
        '--output', tmpOut,              // вихідний файл
    ];

    // usePalette = true → вимикаємо Floyd-Steinberg dithering
    // Менший файл, але гірші градієнти
    if (usePalette) {
        args.push('--nofs');
    }

    // Кількість кольорів у палітрі (2–256) — жорстка СТЕЛЯ.
    // Передаємо завжди, включно з 256: у парі з --quality=…-100 це і є
    // гарантія, що палітра залишиться повною.
    if (colors >= 2 && colors <= 256) {
        args.push(String(colors));
    }

    // Вхідний файл — завжди останній аргумент
    args.push(tmpIn);

    try {
        await runExternal(pngquantPath, args);

        // Якщо вихідний файл не з'явився — pngquant міг вирішити що quality
        // недосяжна (exit code 99). Нижче піде безпечний lossless fallback.
        if (!await fs.pathExists(tmpOut)) {
            throw new Error('pngquant: output not created (likely quality not achievable)');
        }

        const outBuf = await fs.readFile(tmpOut);

        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });

        return smallerOrOriginal(buf, outBuf);
    } catch (firstErr) {
        // ─── Fallback: sharp PNG ───
        console.warn('⚠️ pngquant skipped (fallback to sharp):', firstErr?.message || firstErr);
        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });

        try {
            // Спробуємо кілька стратегій sharp і виберемо найменший результат
            const candidates = [];

            // Стратегія 1: без palette, максимальне lossless стиснення
            try {
                candidates.push(await sharp(buf).png({
                    compressionLevel: 9,
                    palette: false,
                    effort: 10
                }).toBuffer());
            } catch { }

            // Стратегія 2: adaptive filtering
            try {
                candidates.push(await sharp(buf).png({
                    compressionLevel: 9,
                    adaptiveFiltering: true,
                    effort: 10
                }).toBuffer());
            } catch { }

            // Стратегія 3: palette лише для явно агресивних налаштувань.
            if (target < 90 || colors < 256 || usePalette) {
                try {
                    candidates.push(await sharp(buf).png({
                        compressionLevel: 9,
                        palette: true,
                        quality: quality,
                        effort: 10,
                        colors
                    }).toBuffer());
                } catch { }
            }

            // Вибираємо найменший з кандидатів (який ще менший за оригінал)
            const best = candidates
                .filter(c => c.length > 0 && c.length < buf.length)
                .sort((a, b) => a.length - b.length)[0];

            return best || buf;
        } catch {
            return buf;
        }
    }
};

// ========================== GIF ==========================

/**
 * Оптимізує GIF через gifsicle.
 * Gifsicle — опціональна залежність, при відсутності повертає оригінал.
 *
 * Параметри:
 *   -O3        — максимальний рівень оптимізації
 *   --lossy=N  — lossy стиснення (0=lossless, 200=максимум)
 *   --colors=N — зменшення кількості кольорів (2-256)
 *
 * @param {Buffer} buf — GIF буфер
 * @returns {Promise<Buffer>} оптимізований GIF буфер
 */
export const optimizeGifBuffer = async (buf) => {
    const tmpIn = path.join(__dirname, `.tmp-gif-${Date.now()}-${Math.random().toString(36).slice(2)}.gif`);
    const tmpOut = `${tmpIn}.out.gif`;

    await fs.writeFile(tmpIn, buf);

    const lossy = CONFIG.image.gifLossy;
    const colors = CONFIG.image.gifColors;

    const args = ['-O3'];  // максимальна оптимізація
    if (Number.isFinite(lossy) && lossy > 0) args.push(`--lossy=${lossy}`);
    if (Number.isFinite(colors) && colors > 0 && colors <= 256) args.push('--colors', String(colors));
    args.push(tmpIn, '-o', tmpOut);

    try {
        await runExternal('gifsicle', args);
        const outBuf = await fs.readFile(tmpOut);

        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });

        return outBuf.length && outBuf.length < buf.length ? outBuf : buf;
    } catch (e) {
        // gifsicle не встановлений або помилка — повертаємо оригінал
        console.warn('⚠️ gifsicle skipped:', e?.message || e);
        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });
        return buf;
    }
};

// ========================== РОУТЕР ==========================

/**
 * Головний роутер оптимізації зображень.
 * Визначає тип за MIME і делегує відповідній функції.
 *
 * @param {Buffer} buf — буфер зображення
 * @param {string} mime — MIME тип (image/jpeg, image/png, тощо)
 * @returns {Promise<Buffer>} оптимізований буфер
 */
export const optimizeImageBuffer = async (buf, mime) => {
    try {
        if (mime === 'image/jpeg') {
            return await optimizeJpegBuffer(buf);
        }
        if (mime === 'image/webp') {
            return await optimizeWebpBuffer(buf);
        }
        if (mime === 'image/png') {
            return await optimizePngBuffer(buf);
        }
        if (mime === 'image/gif') {
            return await optimizeGifBuffer(buf);
        }
        if (mime === 'image/svg+xml') {
            // SVG — вже текстовий формат, не оптимізуємо
            // (можна додати svgo у майбутньому)
            return buf;
        }
        return buf;
    } catch {
        return buf;
    }
};
