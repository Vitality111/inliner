// FILE: src/optimizers/index.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Роутер оптимізації: визначає тип файлу за MIME і делегує відповідному
// оптимізатору. Для файлових оптимізаторів (відео, аудіо, шрифти) створює
// тимчасовий файл, бо ці інструменти працюють через файлову систему.
//
// Повертає оптимізований Buffer. Якщо оптимізація збільшила файл або
// сталася помилка — повертає оригінальний буфер (safe fallback).
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { sha1 } from '../utils.mjs';
import { __dirname } from '../config.mjs';
import { optimizeImageBuffer } from './image.mjs';
import { optimizeVideoFileToBuffer } from './video.mjs';
import { optimizeAudioFileToBuffer } from './audio.mjs';
import { optimizeGlbBuffer } from './gltf.mjs';
import { optimizeFontBuffer } from './font.mjs';

/**
 * Оптимізує буфер на основі його MIME типу.
 *
 * Для кожного типу використовується свій оптимізатор:
 *   image/*           → sharp / pngquant / gifsicle
 *   video/*           → ffmpeg (H.264 / VP9)
 *   audio/*           → ffmpeg (зберігає оригінальний формат)
 *   model/gltf-binary → gltfpack
 *   font/*            → fontmin (subsetting)
 *   інше              → без змін
 *
 * @param {Buffer} buf — вхідний буфер
 * @param {string} mime — MIME тип (наприклад 'image/png')
 * @returns {Promise<Buffer>} оптимізований буфер
 */
export const optimizeByMime = async (buf, mime) => {
    try {
        // ──── Зображення ────
        if (mime.startsWith('image/')) {
            return await optimizeImageBuffer(buf, mime);
        }

        // ──── Відео ────
        // ffmpeg працює з файлами, тому створюємо тимчасовий файл.
        // Розширення важливе — ffmpeg визначає формат за ним.
        if (mime.startsWith('video/')) {
            const ext = mime === 'video/webm' ? '.webm' : '.mp4';
            const tmpIn = path.join(os.tmpdir(), `builder-tmp-${Date.now()}-${sha1(buf)}${ext}`);
            await fs.writeFile(tmpIn, buf);
            try {
                const out = await optimizeVideoFileToBuffer(tmpIn, mime);
                return out.length && out.length < buf.length ? out : buf;
            } finally {
                await fs.remove(tmpIn).catch(() => { });
            }
        }

        // ──── Аудіо ────
        // ffmpeg працює з файлами. Розширення .in — ffmpeg все одно визначає формат
        // за magic bytes, а не за розширенням.
        if (mime.startsWith('audio/')) {
            const tmpIn = path.join(os.tmpdir(), `builder-tmp-${Date.now()}-${sha1(buf)}.in`);
            await fs.writeFile(tmpIn, buf);
            try {
                // optimizeAudioFileToBuffer повертає { buffer, mime: outMime }
                // Зберігає оригінальний формат (OGG→OGG, M4A→M4A, MP3→MP3)
                const result = await optimizeAudioFileToBuffer(tmpIn, mime);
                const out = result.buffer;
                return out.length && out.length < buf.length ? out : buf;
            } finally {
                await fs.remove(tmpIn).catch(() => { });
            }
        }

        // ──── 3D моделі (GLB/GLTF) ────
        if (mime === 'model/gltf-binary') {
            return await optimizeGlbBuffer(buf);
        }

        // ──── Шрифти ────
        if (mime.startsWith('font/')) {
            return await optimizeFontBuffer(buf);
        }

        // ──── Інше — без змін ────
        return buf;
    } catch (e) {
        // Safe fallback: при будь-якій помилці повертаємо оригінал
        return buf;
    }
};
