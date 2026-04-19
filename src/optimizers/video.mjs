// FILE: src/optimizers/video.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Оптимізатор відео через ffmpeg. Підтримує MP4 (H.264) і WebM (VP9).
//
// Два режими роботи:
//   1. CRF-режим (за замовчуванням) — якість задається через --crf
//   2. ABR-режим (якщо задано --targetMbps) — якість через бітрейт
//      Підтримує two-pass для кращого розподілу бітрейту.
//
// Залежності: ffmpeg + ffprobe повинні бути в PATH.
// ─────────────────────────────────────────────────────────────────────────────

import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs-extra';
import { CONFIG } from '../config.mjs';

/**
 * Отримує метадані відеофайлу через ffprobe.
 * @param {string} file — шлях до файлу
 * @returns {Promise<Object>} метадані ffprobe
 */
export const ffprobe = (file) =>
    new Promise((res, rej) =>
        ffmpeg.ffprobe(file, (err, data) => (err ? rej(err) : res(data)))
    );

/**
 * Оптимізує відеофайл і повертає буфер.
 *
 * Алгоритм:
 *   1. Зчитуємо ширину вхідного відео через ffprobe
 *   2. Визначаємо чи потрібен downscale (maxWidth)
 *   3. Формуємо параметри кодування залежно від формату (MP4/WebM)
 *   4. Запускаємо ffmpeg (one-pass або two-pass)
 *   5. Повертаємо вихідний буфер
 *
 * @param {string} tmpInPath — шлях до тимчасового вхідного файлу
 * @param {string} [mime='video/mp4'] — MIME тип для визначення формату виходу
 * @returns {Promise<Buffer>} оптимізований буфер
 */
export const optimizeVideoFileToBuffer = async (tmpInPath, mime = 'video/mp4') => {
    const {
        codec, crf, preset, tune, maxWidth, fps, twoPass,
        targetMbps, maxRateFactor, audioKbps, faststart
    } = CONFIG.video;

    // Визначаємо формат виходу за MIME
    const outExt = mime === 'video/webm' ? '.webm' : '.mp4';
    const isWebm = outExt === '.webm';

    // ──── Зчитуємо ширину для downscale ────
    let inW = 0;
    try {
        const meta = await ffprobe(tmpInPath);
        const v = meta.streams?.find(s => s.codec_type === 'video');
        inW = v?.width || 0;
    } catch { }

    // Масштабування: якщо відео ширше maxWidth — зменшуємо.
    // -2 = автоматичне вирівнювання висоти до парного числа (вимога H.264).
    // Якщо масштабування не потрібне — все одно вирівнюємо до парних.
    const needScale = maxWidth && inW && inW > maxWidth;
    const scaleFilter = needScale
        ? `scale=${maxWidth}:-2`
        : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

    const tmpOut = `${tmpInPath}.${Date.now()}.min${outExt}`;

    // ──── Формуємо базові параметри кодування ────
    const base = isWebm
        ? [
            // VP9 — використовує -b:v 0 для чистого CRF режиму
            '-c:v libvpx-vp9',
            `-crf ${crf}`,
            '-b:v 0',
            `-vf ${scaleFilter}`
        ]
        : [
            // H.264 — повний набір параметрів для максимальної сумісності
            '-pix_fmt yuv420p',            // найбільш сумісний pixel format
            `-c:v ${codec}`,               // кодек (libx264 за замовчуванням)
            `-preset ${preset}`,           // швидкість/якість кодування
            `-crf ${crf}`,                 // якість (0-51)
            '-profile:v high',             // H.264 High Profile
            '-level 4.1',                  // сумісність з більшістю пристроїв
            `-vf ${scaleFilter}`           // фільтр масштабування
        ];

    // tune — тюнінг кодера (тільки для H.264)
    if (tune && !isWebm) base.push(`-tune ${tune}`);

    // Примусове обмеження FPS (якщо задано)
    if (Number.isFinite(fps)) base.push(`-r ${fps}`);

    // faststart — переміщує moov atom на початок (тільки MP4)
    if (faststart && !isWebm) base.push('-movflags +faststart');

    // ──── ABR-режим (якщо задано targetMbps) ────
    const vb = Number.isFinite(targetMbps) ? `${targetMbps}M` : null;
    const maxrate =
        Number.isFinite(targetMbps) && Number.isFinite(maxRateFactor)
            ? `${(targetMbps * maxRateFactor).toFixed(2)}M`
            : null;
    const bufsize =
        Number.isFinite(targetMbps) && Number.isFinite(maxRateFactor)
            ? `${(targetMbps * maxRateFactor * 2).toFixed(2)}M`
            : null;

    if (vb) base.push(`-b:v ${vb}`, `-minrate ${vb}`, `-maxrate ${maxrate}`, `-bufsize ${bufsize}`);

    // ──── Аудіо параметри ────
    const aopts = isWebm
        ? ['-c:a libopus', `-b:a ${audioKbps}k`]    // WebM → Opus
        : ['-c:a aac', `-b:a ${audioKbps}k`];       // MP4 → AAC

    // ──── Кодування ────
    if (twoPass && vb) {
        // Two-pass: перший прохід — аналіз, другий — кодування
        const passlog = `${tmpInPath}.2pass`;
        const nullOutput = process.platform === 'win32' ? 'NUL' : '/dev/null';

        // Pass 1: тільки аналіз, вихід у /dev/null (або NUL на Windows)
        await new Promise((resolve, reject) => {
            ffmpeg(tmpInPath)
                .outputOptions([...base, '-an', '-pass 1', `-passlogfile ${passlog}`, '-f null'])
                .save(nullOutput)
                .on('end', resolve).on('error', reject);
        });

        // Pass 2: фінальне кодування з урахуванням аналізу pass 1
        await new Promise((resolve, reject) => {
            ffmpeg(tmpInPath)
                .outputOptions([...base, ...aopts, '-pass 2', `-passlogfile ${passlog}`])
                .save(tmpOut)
                .on('end', resolve).on('error', reject);
        });

        // Cleanup pass log files
        await Promise.all([
            fs.remove(`${passlog}-0.log`).catch(() => { }),
            fs.remove(`${passlog}.log`).catch(() => { }),
            fs.remove(`${passlog}.log.mbtree`).catch(() => { })
        ]);
    } else {
        // One-pass: просте кодування
        await new Promise((resolve, reject) => {
            ffmpeg(tmpInPath)
                .outputOptions([...base, ...aopts])
                .save(tmpOut)
                .on('end', resolve)
                .on('error', (err) => {
                    console.error('❌ FFmpeg error:', err.message);
                    reject(err);
                });
        });
    }

    const out = await fs.readFile(tmpOut);
    await fs.remove(tmpOut).catch(() => { });
    return out;
};
