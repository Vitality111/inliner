// FILE: src/optimizers/image.mjs
import sharp from 'sharp';
import fs from 'fs-extra';
import path from 'path';
import { CONFIG, __dirname } from '../config.mjs';
import { runExternal } from '../utils.mjs';

// Спробуємо імпортувати pngquant-bin
let pngquantPath = 'pngquant';
try {
    const pngquantBin = await import('pngquant-bin');
    pngquantPath = pngquantBin.default;
} catch { }

// PNG через pngquant (lossy) для кращого стиснення
export const optimizePngBuffer = async (buf) => {
    const tmpIn = path.join(__dirname, `.tmp-png-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    const tmpOut = `${tmpIn}.out.png`;

    await fs.writeFile(tmpIn, buf);

    const quality = CONFIG.image.pngQuality; // 0-100, чим вище тим краща якість
    const speed = CONFIG.image.pngLevel;     // 1-11, 1=найкращий/повільний, 11=швидкий/гірший
    const colors = CONFIG.image.pngColors;   // 2-256, кількість кольорів у палітрі
    const noDither = CONFIG.image.pngPalette; // true = вимкнути дизеринг (менший розмір, гірші градієнти)

    // pngquant quality: min-max
    // Встановлюємо min=0 щоб pngquant не падав з exit code 99 ("quality too low")
    // для складних зображень, де неможливо досягти високої якості
    const minQ = 0;

    // pngquant args: pngquant [options] [ncolors] -- input.png
    const args = [
        `--quality=${minQ}-${quality}`,
        '--speed', String(Math.min(11, Math.max(1, speed || 1))),
        '--force',
        '--strip',
        '--output', tmpOut,
    ];

    // Дизеринг важливий для градієнтів
    if (noDither) {
        args.push('--nofs'); // no Floyd-Steinberg dithering
    }

    // Кількість кольорів у палітрі (2-256)
    // 256 - це значення за замовчуванням, не вказуємо його щоб уникнути проблем з аргументами
    if (Number.isFinite(colors) && colors >= 2 && colors < 256) {
        args.push(String(colors));
    }

    // Input файл
    args.push(tmpIn);

    try {
        await runExternal(pngquantPath, args);
        const outBuf = await fs.readFile(tmpOut);

        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });

        return outBuf.length && outBuf.length < buf.length ? outBuf : buf;
    } catch (e) {
        // If pngquant fails, fallback to sharp
        console.error('⚠️ pngquant failed:', e?.message || e);
        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });

        try {
            return await sharp(buf).png({
                compressionLevel: 9,
                palette: !!CONFIG.image.pngPalette
            }).toBuffer();
        } catch {
            return buf;
        }
    }
};

export const optimizeGifBuffer = async (buf) => {
    const tmpIn = path.join(__dirname, `.tmp-gif-${Date.now()}-${Math.random().toString(36).slice(2)}.gif`);
    const tmpOut = `${tmpIn}.out.gif`;

    await fs.writeFile(tmpIn, buf);

    const lossy = CONFIG.image.gifLossy;
    const colors = CONFIG.image.gifColors;

    // gifsicle args
    const args = ['-O3'];
    if (Number.isFinite(lossy) && lossy > 0) args.push(`--lossy=${lossy}`);
    if (Number.isFinite(colors) && colors > 0 && colors <= 256) args.push('--colors', String(colors));
    args.push(tmpIn, '-o', tmpOut);

    try {
        await runExternal('gifsicle', args);
        const outBuf = await fs.readFile(tmpOut);

        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });

        // беремо тільки якщо реально менше
        return outBuf.length && outBuf.length < buf.length ? outBuf : buf;
    } catch (e) {
        // If gifsicle is missing, keep original GIF
        console.error('gifsicle failed:', e?.message || e);
        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });
        return buf;
    }
};

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
            return buf;
        }
        return buf;
    } catch {
        return buf;
    }
};
