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

    // Валідація і clamping параметрів
    const quality = Number.isFinite(CONFIG.image.pngQuality) ? Math.min(100, Math.max(0, CONFIG.image.pngQuality)) : 100;
    const speed = Number.isFinite(CONFIG.image.pngLevel) ? Math.min(11, Math.max(1, CONFIG.image.pngLevel)) : 1;
    const colors = Number.isFinite(CONFIG.image.pngColors) ? Math.min(256, Math.max(2, CONFIG.image.pngColors)) : 256;
    const usePalette = !!CONFIG.image.pngPalette;

    // quality=100 — lossless режим, pngquant не потрібен
    if (quality >= 100) {
        return await sharp(buf).png({
            compressionLevel: 9,
            palette: usePalette,
            quality: 100
        }).toBuffer();
    }

    await fs.writeFile(tmpIn, buf);

    // pngquant --quality: простий діапазон 0-{quality}
    // pngquant сам обирає оптимальне стиснення, quality — це стеля.
    //   80 = стиснення до прийнятної візуальної якості
    //   60 = агресивніше, помітна деградація на фото
    //  100 = мінімальне lossy стиснення
    // Якщо pngquant не може вписатись — retry без --quality (в catch нижче)

    // Формуємо аргументи pngquant
    const args = [
        `--quality=0-${quality}`,        // стеля якості (pngquant сам обирає оптимум)
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

    // Кількість кольорів у палітрі (2–256)
    // Завжди передаємо якщо менше 256 (256 = дефолт pngquant)
    if (colors >= 2 && colors < 256) {
        args.push(String(colors));
    }

    // Вхідний файл — завжди останній аргумент
    args.push(tmpIn);

    try {
        await runExternal(pngquantPath, args);

        // Якщо вихідний файл не з'явився — pngquant міг вирішити що quality
        // недосяжна (exit code 99). Спробуємо без обмеження quality.
        if (!await fs.pathExists(tmpOut)) {
            throw new Error('pngquant: output not created (likely quality not achievable)');
        }

        const outBuf = await fs.readFile(tmpOut);

        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });

        // Повертаємо оптимізований тільки якщо він менший
        return outBuf.length && outBuf.length < buf.length ? outBuf : buf;
    } catch (firstErr) {
        // ─── Retry: pngquant без обмеження --quality ───
        // pngquant часто фейлиться з exit code 99 коли діапазон якості
        // занадто вузький для складних зображень (фото, градієнти).
        // Повторюємо без --quality — pngquant сам визначить оптимальну якість.
        try {
            await fs.remove(tmpOut).catch(() => { });

            const retryArgs = [
                '--speed', String(speed),
                '--force',
                '--strip',
                '--output', tmpOut,
            ];
            if (usePalette) retryArgs.push('--nofs');
            if (colors >= 2 && colors < 256) retryArgs.push(String(colors));
            retryArgs.push(tmpIn);

            await runExternal(pngquantPath, retryArgs);

            if (await fs.pathExists(tmpOut)) {
                const outBuf = await fs.readFile(tmpOut);
                await fs.remove(tmpIn).catch(() => { });
                await fs.remove(tmpOut).catch(() => { });
                if (outBuf.length && outBuf.length < buf.length) {
                    console.log('   ↪ pngquant retry without --quality succeeded');
                    return outBuf;
                }
            }
        } catch {
            // Retry теж не вдався — переходимо до sharp
        }

        // ─── Fallback: sharp PNG ───
        console.warn('⚠️ pngquant skipped (fallback to sharp):', firstErr?.message || firstErr);
        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });

        try {
            // Спробуємо кілька стратегій sharp і виберемо найменший результат
            const candidates = [];

            // Стратегія 1: palette mode з максимальним стисненням
            try {
                candidates.push(await sharp(buf).png({
                    compressionLevel: 9,
                    palette: true,
                    quality,
                    effort: 10,
                    colors
                }).toBuffer());
            } catch { }

            // Стратегія 2: без palette, максимальне стиснення
            try {
                candidates.push(await sharp(buf).png({
                    compressionLevel: 9,
                    palette: false,
                    effort: 10
                }).toBuffer());
            } catch { }

            // Стратегія 3: adaptive filtering
            try {
                candidates.push(await sharp(buf).png({
                    compressionLevel: 9,
                    adaptiveFiltering: true,
                    effort: 10
                }).toBuffer());
            } catch { }

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
            return await sharp(buf).jpeg({ quality: CONFIG.image.jpegQ }).toBuffer();
        }
        if (mime === 'image/webp') {
            return await sharp(buf).webp({ quality: CONFIG.image.webpQ }).toBuffer();
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
