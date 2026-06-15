// FILE: src/optimizers/index.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Роутер оптимізації: визначає тип файлу за MIME і делегує відповідному
// оптимізатору. Для файлових оптимізаторів (відео, аудіо, шрифти) створює
// тимчасовий файл, бо ці інструменти працюють через файлову систему.
//
// Повертає оптимізований Buffer разом із MIME. Це важливо для шрифтів/аудіо,
// де оптимізація може змінити контейнер. Якщо оптимізація збільшила файл або
// сталася помилка — повертає оригінальний буфер і MIME (safe fallback).
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
import { optimizeFontAsset } from './font.mjs';

/**
 * Оптимізує буфер на основі його MIME типу.
 *
 * Для кожного типу використовується свій оптимізатор:
 *   image/*           → sharp / pngquant / gifsicle
 *   video/*           → ffmpeg (H.264 / VP9)
 *   audio/*           → ffmpeg (зберігає оригінальний формат)
 *   model/gltf-binary → gltfpack
 *   font/*            → subset-font (subsetting + optional WOFF2)
 *   інше              → без змін
 *
 * @param {Buffer} buf — вхідний буфер
 * @param {string} mime — MIME тип (наприклад 'image/png')
 * @param {Object} [options]
 * @param {boolean} [options.allowFormatChange=true] — дозволити зміну контейнера
 * @returns {Promise<{ buffer: Buffer, mime: string }>} оптимізований ассет
 */
export const optimizeAssetByMime = async (buf, mime, options = {}) => {
    try {
        // ──── Зображення ────
        if (mime.startsWith('image/')) {
            return { buffer: await optimizeImageBuffer(buf, mime), mime };
        }

        // ──── Відео ────
        // ffmpeg працює з файлами, тому створюємо тимчасовий файл.
        // Розширення важливе — ffmpeg визначає формат за ним.
        if (mime.startsWith('video/')) {
            // WebM часто використовується для alpha-відео. Перекодування через
            // ffmpeg може сплющити прозорість у чорний фон, тому лишаємо як є.
            if (mime === 'video/webm') {
                return { buffer: buf, mime };
            }

            const ext = mime === 'video/webm' ? '.webm' : '.mp4';
            const tmpIn = path.join(os.tmpdir(), `builder-tmp-${Date.now()}-${sha1(buf)}${ext}`);
            await fs.writeFile(tmpIn, buf);
            try {
                const out = await optimizeVideoFileToBuffer(tmpIn, mime);
                return { buffer: out.length && out.length < buf.length ? out : buf, mime };
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
                if (out.length && out.length < buf.length) {
                    return { buffer: out, mime: result.mime };
                }
                return { buffer: buf, mime };
            } finally {
                await fs.remove(tmpIn).catch(() => { });
            }
        }

        // ──── 3D моделі (GLB/GLTF) ────
        if (mime === 'model/gltf-binary') {
            return { buffer: await optimizeGlbBuffer(buf), mime };
        }

        // ──── Шрифти ────
        if (mime.startsWith('font/') || mime.startsWith('application/font-') || mime === 'application/x-font-ttf' || mime === 'application/x-font-otf') {
            return await optimizeFontAsset(buf, mime, options);
        }

        // ──── Інше — без змін ────
        return { buffer: buf, mime };
    } catch (e) {
        // Safe fallback: при будь-якій помилці повертаємо оригінал
        return { buffer: buf, mime };
    }
};

export const optimizeByMime = async (buf, mime, options = {}) =>
    (await optimizeAssetByMime(buf, mime, options)).buffer;
