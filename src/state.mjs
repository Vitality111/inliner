// FILE: src/state.mjs
// -------------------- Лічильники/кеші --------------------

export const stats = {
    totalOriginalSize: 0,
    totalFinalSize: 0
};

// Кеш для локальних файлів: absPath -> dataURI
export const fileCache = new Map();

// Кеш для уже інлайнених data: рядків: originalDataUri -> optimizedDataUri
export const dataUriCache = new Map();

export const state = {
    projectRoot: null
};

export const setProjectRoot = (root) => {
    state.projectRoot = root;
};
