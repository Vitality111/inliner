// FILE: src/constants.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Маппінг розширень файлів → MIME типів.
// Використовується для:
//   - Визначення MIME при кодуванні в data:URI
//   - Вибору оптимізатора за MIME (image/ → sharp, video/ → ffmpeg, тощо)
//   - Визначення розширення за MIME (для зворотного перетворення)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Маппінг розширення файлу → MIME тип.
 * Якщо розширення немає в списку — використовується 'application/octet-stream'.
 */
export const MIME = {
    // ──── Зображення ────
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',

    // ──── Відео ────
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',

    // ──── Аудіо ────
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',

    // ──── Шрифти ────
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',

    // ──── Дані ────
    '.json': 'application/json',
    '.wasm': 'application/wasm',

    // ──── 3D моделі ────
    '.glb': 'model/gltf-binary',

    // ──── Текст ────
    '.txt': 'text/plain',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html'
};

/**
 * Зворотний пошук: MIME тип → розширення файлу.
 * Повертає перше знайдене розширення або null.
 *
 * ⚠️ Для MIME типів з кількома розширеннями (image/jpeg → .jpg, .jpeg)
 *    повертає перше знайдене в порядку об'єкта MIME.
 *
 * @param {string} mime — MIME тип
 * @returns {string|null} розширення (з крапкою) або null
 */
export const extFromMime = (mime) => {
    for (const [ext, m] of Object.entries(MIME)) {
        if (m === mime) return ext;
    }
    return null;
};
