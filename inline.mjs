#!/usr/bin/env node
// FILE: inline.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 🧰 Inline Assets Builder — v2.1
// Збирає single-file HTML5 playable: бандлить ES модулі (esbuild),
// інлайнить CSS/JS/ассети (зображення, шрифти, відео, аудіо, WASM, GLB)
// як оптимізовані data:URI.
//
// Вимоги: Node 18+, ffmpeg у PATH
// Пакети:  fs-extra, sharp, fluent-ffmpeg, fontmin, esbuild, lightningcss
//
// Запуск:
//   node inline.mjs index.html
//   node inline.mjs index.html --minifyJs --minifyCss --minifyHtml
//   node inline.mjs --optimizeOnly --assetsDir=assets
//   node inline.mjs index.html --interactive
//
// Всі параметри конфігу дивись у src/config.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { inlineHtml } from './src/pipeline.mjs';
import { initInteractive, closeInteractive, setInteractiveFlag } from './src/utils.mjs';
import { INTERACTIVE } from './src/config.mjs';

// ========================== ENTRY POINT ==========================

async function main() {
    // ──── Інтерактивний режим: налаштування stdin ────
    if (INTERACTIVE) {
        console.log('🎛️  Interactive mode enabled. Options: [y]es, [n]o, [a]ll auto, [s]kip all\n');
        setInteractiveFlag(true);

        // stdin для інтерактивних промптів
        process.stdin.setEncoding('utf8');
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        process.stdin.resume();
        initInteractive();
    }

    try {
        await inlineHtml();
    } finally {
        // Cleanup: завжди закриваємо stdin і interactive
        if (INTERACTIVE) {
            process.stdin.pause();
            setInteractiveFlag(false);
        }
        closeInteractive();
    }
}

main().catch((e) => {
    closeInteractive();
    console.error('❌ Build failed:', e);
    process.exitCode = 1;
});