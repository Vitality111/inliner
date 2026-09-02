// FILE: src/optimizers/audio.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Оптимізатор аудіо: перекодовує з меншим бітрейтом, ЗБЕРІГАЮЧИ оригінальний
// формат контейнера. НЕ конвертує між форматами (OGG→OGG, M4A→M4A, MP3→MP3).
//
// WAV — особливий випадок: конвертується в MP3, бо WAV = нестиснений формат,
// і перекодування WAV→WAV з меншим бітрейтом не має сенсу.
//
// Залежності: ffmpeg повинен бути в PATH.
// ─────────────────────────────────────────────────────────────────────────────

import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs-extra';
import path from 'path';
import { CONFIG } from '../config.mjs';
import { ffprobe } from './video.mjs';

/**
 * Визначає параметри кодування залежно від MIME-типу вхідного аудіо.
 * Повертає кодек, розширення файлу і новий MIME для виходу.
 *
 * Логіка:
 *   audio/mpeg (MP3)  → libmp3lame / .mp3 / audio/mpeg
 *   audio/ogg  (OGG)  → libvorbis  / .ogg / audio/ogg
 *   audio/mp4  (M4A)  → aac        / .m4a / audio/mp4
 *   audio/wav  (WAV)  → libmp3lame / .mp3 / audio/mpeg  ← конвертація, бо WAV нестиснений
 *   інше              → libmp3lame / .mp3 / audio/mpeg  ← fallback
 *
 * @param {string} mime — MIME тип вхідного аудіо
 * @returns {{ codec: string, ext: string, outMime: string }}
 */
const getAudioParams = (mime) => {
    switch (mime) {
        case 'audio/ogg':
            return { codec: 'libvorbis', ext: '.ogg', outMime: 'audio/ogg' };
        case 'audio/mp4':
            return { codec: 'aac', ext: '.m4a', outMime: 'audio/mp4' };
        case 'audio/mpeg':
            return { codec: 'libmp3lame', ext: '.mp3', outMime: 'audio/mpeg' };
        case 'audio/wav':
        default:
            // WAV та невідомі формати — конвертуємо в MP3
            // (WAV = нестиснений, немає сенсу зберігати формат)
            return { codec: 'libmp3lame', ext: '.mp3', outMime: 'audio/mpeg' };
    }
};

/**
 * Перекодовує аудіофайл з меншим бітрейтом, зберігаючи оригінальний формат.
 *
 * @param {string} tmpInPath — шлях до тимчасового вхідного файлу
 * @param {string} [mime='audio/mpeg'] — MIME тип вхідного аудіо
 * @returns {Promise<{ buffer: Buffer, mime: string }>} — оптимізований буфер і його MIME
 */
export const optimizeAudioFileToBuffer = async (tmpInPath, mime = 'audio/mpeg') => {
    const { codec, ext, outMime } = getAudioParams(mime);
    const tmpOut = `${tmpInPath}.${Date.now()}.min${ext}`;
    const targetKbps = Number(CONFIG.audio.mp3Kbps) || 64;
    const mono = !!CONFIG.audio.mono;

    // ──── Пропуск "порожнього" перекодування ────
    // Якщо джерело в тому ж контейнері вже має бітрейт ≤ цільового (і не треба
    // зводити в моно), повторне lossy-кодування дасть ще одне покоління
    // артефактів без економії. Повертаємо оригінал — index.mjs однаково
    // залишить менший з двох.
    // WAV сюди не потрапляє: він нестиснений, його завжди конвертуємо.
    if (mime !== 'audio/wav' && outMime === mime && !mono) {
        try {
            const meta = await ffprobe(tmpInPath);
            const a = meta.streams?.find(s => s.codec_type === 'audio');
            const srcKbps = Number(a?.bit_rate || meta.format?.bit_rate || 0) / 1000;
            if (srcKbps > 0 && srcKbps <= targetKbps * 1.05) {
                console.log(`⏭️  audio already ≤ ${targetKbps}k (${Math.round(srcKbps)}k) — re-encode skipped`);
                return { buffer: await fs.readFile(tmpInPath), mime };
            }
        } catch { /* ffprobe недоступний — просто кодуємо */ }
    }

    await new Promise((resolve, reject) => {
        const cmd = ffmpeg(tmpInPath)
            .audioCodec(codec)
            .audioBitrate(`${targetKbps}k`);
        if (mono) cmd.audioChannels(1);   // --audioMono: -ac 1
        cmd.save(tmpOut)
            .on('end', resolve)
            .on('error', reject);
    });

    const buffer = await fs.readFile(tmpOut);
    await fs.remove(tmpOut).catch(() => { });

    return { buffer, mime: outMime };
};
