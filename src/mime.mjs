// FILE: src/mime.mjs
// Визначення MIME за сигнатурою (magic bytes) з fallback на тип із розширення.

const hasBytes = (buf, offset, bytes) => {
    if (!Buffer.isBuffer(buf) || buf.length < offset + bytes.length) return false;
    return bytes.every((byte, index) => buf[offset + index] === byte);
};

const hasAscii = (buf, offset, text) =>
    Buffer.isBuffer(buf) &&
    buf.length >= offset + text.length &&
    buf.subarray(offset, offset + text.length).toString('ascii') === text;

const detectTextMime = (buf, fallbackMime) => {
    const text = buf.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();

    // Дозволяємо XML declaration, коментарі та SVG doctype перед кореневим тегом.
    if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+svg[\s\S]*?>\s*)?<svg(?:\s|>)/i.test(text)) {
        return 'image/svg+xml';
    }

    if (/^(?:<!doctype\s+html(?:\s[^>]*)?>\s*)?<html(?:\s|>)/i.test(text)) {
        return 'text/html';
    }

    // JSON визначаємо лише коли розширення вже натякає на JSON або тип невідомий:
    // JavaScript теж може починатися з { чи [, тому його не можна перевизначати.
    if (fallbackMime === 'application/json' || fallbackMime === 'application/octet-stream') {
        if (text.startsWith('{') || text.startsWith('[')) {
            try {
                JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
                return 'application/json';
            } catch { }
        }
    }

    return null;
};

/**
 * Повертає MIME, визначений за вмістом буфера. Якщо формат неоднозначний або
 * невідомий — повертає fallbackMime, отриманий із розширення/HTTP-заголовка.
 *
 * @param {Buffer} buf
 * @param {string} fallbackMime
 * @returns {string}
 */
export const detectMimeFromBuffer = (buf, fallbackMime = 'application/octet-stream') => {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return fallbackMime;

    // Images
    if (hasBytes(buf, 0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
    if (hasBytes(buf, 0, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
    if (hasAscii(buf, 0, 'GIF87a') || hasAscii(buf, 0, 'GIF89a')) return 'image/gif';
    if (hasAscii(buf, 0, 'RIFF') && hasAscii(buf, 8, 'WEBP')) return 'image/webp';
    if (hasAscii(buf, 0, 'BM')) return 'image/bmp';
    if (hasBytes(buf, 0, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';

    // ISO Base Media containers: AVIF, M4A and MP4 all use an ftyp box.
    if (hasAscii(buf, 4, 'ftyp')) {
        const brand = buf.subarray(8, 12).toString('ascii');
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
        if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
        if (fallbackMime === 'audio/mp4') return 'audio/mp4';
        return 'video/mp4';
    }

    // Video/audio
    if (hasBytes(buf, 0, [0x1A, 0x45, 0xDF, 0xA3])) {
        return fallbackMime.startsWith('audio/') ? fallbackMime : 'video/webm';
    }
    if (hasAscii(buf, 0, 'RIFF') && hasAscii(buf, 8, 'WAVE')) return 'audio/wav';
    if (hasAscii(buf, 0, 'OggS')) return fallbackMime.startsWith('video/') ? fallbackMime : 'audio/ogg';
    if (hasAscii(buf, 0, 'ID3') || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) return 'audio/mpeg';

    // Fonts
    if (hasAscii(buf, 0, 'wOFF')) return 'font/woff';
    if (hasAscii(buf, 0, 'wOF2')) return 'font/woff2';
    if (hasAscii(buf, 0, 'OTTO')) return 'font/otf';
    if (hasBytes(buf, 0, [0x00, 0x01, 0x00, 0x00]) || hasAscii(buf, 0, 'true') || hasAscii(buf, 0, 'ttcf')) {
        return 'font/ttf';
    }

    // Binary application/model formats
    if (hasBytes(buf, 0, [0x00, 0x61, 0x73, 0x6D])) return 'application/wasm';
    if (hasAscii(buf, 0, 'glTF')) return 'model/gltf-binary';

    return detectTextMime(buf, fallbackMime) || fallbackMime;
};
