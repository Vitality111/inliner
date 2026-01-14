// FILE: src/optimizers/index.mjs
import fs from 'fs-extra';
import path from 'path';
import { sha1 } from '../utils.mjs';
import { __dirname } from '../config.mjs';
import { optimizeImageBuffer } from './image.mjs';
import { optimizeVideoFileToBuffer } from './video.mjs';
import { optimizeAudioFileToBuffer } from './audio.mjs';
import { optimizeGlbBuffer } from './gltf.mjs';
import { optimizeFontBuffer } from './font.mjs';

// Оптимізація за MIME із буфера (через тимчасовий файл для відео/аудіо/шрифтів)
export const optimizeByMime = async (buf, mime) => {
    try {
        if (mime.startsWith('image/')) {
            return await optimizeImageBuffer(buf, mime);
        }
        if (mime.startsWith('video/')) {
            const tmpIn = path.join(__dirname, `.tmp-${Date.now()}-${sha1(buf)}.in`);
            await fs.writeFile(tmpIn, buf);
            const out = await optimizeVideoFileToBuffer(tmpIn);
            await fs.remove(tmpIn).catch(() => { });
            return out.length && out.length < buf.length ? out : buf;
        }
        if (mime.startsWith('audio/')) {
            const tmpIn = path.join(__dirname, `.tmp-${Date.now()}-${sha1(buf)}.in`);
            await fs.writeFile(tmpIn, buf);
            const out = await optimizeAudioFileToBuffer(tmpIn);
            await fs.remove(tmpIn).catch(() => { });
            return out.length && out.length < buf.length ? out : buf;
        }
        if (mime === 'model/gltf-binary') {
            return await optimizeGlbBuffer(buf);
        }
        if (mime.startsWith('font/')) {
            return await optimizeFontBuffer(buf);
        }
        // інше — як є
        return buf;
    } catch (e) {
        return buf;
    }
};
