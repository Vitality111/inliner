// FILE: src/state.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Глобальний стан збірки: лічильники, кеші, корінь проєкту.
//
// Чому глобальний стан: всі модулі (encoder, optimizers, processors)
// потребують доступу до спільних кешів і статистики. Замість prop drilling
// використовуємо shared singleton модуль.
//
// Кеші:
//   fileCache    — уникає повторного читання/оптимізації тих самих файлів
//   dataUriCache — уникає повторної обробки тих самих data:URI
//
// Лічильники:
//   stats — підсумкова статистика для звіту в кінці збірки
// ─────────────────────────────────────────────────────────────────────────────

/** Статистика збірки */
export const stats = {
    originalHtmlSize: 0,       // Розмір оригінального HTML файлу (bytes)
    totalAssetsOriginalSize: 0, // Сума розмірів оригінальних ассетів (bytes)
    totalAssetsFinalSize: 0,    // Сума розмірів ассетів після оптимізації (bytes)
    finalFileSize: 0           // Розмір фінального зібраного файлу (bytes)
};

/**
 * Кеш для локальних файлів: абсолютний шлях → data:URI.
 * Якщо один і той самий файл згадується кілька разів у HTML/CSS/JS —
 * він читається і оптимізується тільки один раз.
 */
export const fileCache = new Map();

/**
 * In-flight cache for local files: absolute path -> Promise<data:URI>.
 * This prevents parallel CSS/HTML replacements from optimizing the same asset
 * multiple times before fileCache has a chance to be populated.
 */
export const filePromiseCache = new Map();

/**
 * Кеш для data:URI: оригінальний data:URI → оптимізований data:URI.
 * Запобігає повторній обробці data:URI, які вже зустрічались.
 */
export const dataUriCache = new Map();

/**
 * In-flight cache for data URIs: original data:URI -> Promise<optimized data:URI>.
 */
export const dataUriPromiseCache = new Map();

/** Глобальний стан проєкту */
export const state = {
    /**
     * Корінь проєкту — директорія де лежить вхідний HTML файл.
     * Використовується для:
     *   - Override логіки (шукає dir/ папку тут)
     *   - Fallback резолвінгу шляхів (якщо файл не знайдений відносно baseDir)
     */
    projectRoot: null
};

/**
 * Встановлює корінь проєкту. Викликається один раз з pipeline.mjs
 * після знаходження вхідного HTML файлу.
 *
 * @param {string} root — абсолютний шлях до кореневої директорії
 */
export const setProjectRoot = (root) => {
    state.projectRoot = root;
};
