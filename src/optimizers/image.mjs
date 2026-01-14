// FILE: src/optimizers/image.mjs
import sharp from 'sharp';
import fs from 'fs-extra';
import path from 'path';
import { CONFIG, __dirname } from '../config.mjs';
import { runExternal } from '../utils.mjs';

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
            return await sharp(buf).png({
                compressionLevel: CONFIG.image.pngLevel,
                palette: !!CONFIG.image.pngPalette,
                quality: CONFIG.image.pngQuality
            }).toBuffer();
        }
        if (mime === 'image/gif') {
            return await optimizeGifBuffer(buf); // ← тут
        }
        if (mime === 'image/svg+xml') {
            return buf;
        }
        return buf;
    } catch {
        return buf;
    }
};
