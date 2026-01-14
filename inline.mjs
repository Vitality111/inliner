// FILE: inline.mjs
// 🧰 One-file HTML5 playable builder — v2 (Refactored Modular)
// Вимоги: Node 18+, ffmpeg у PATH, пакети: fs-extra, sharp, fluent-ffmpeg, fontmin
// Запуск: node inline.mjs index.html --fetchExternals=true --minifyHtml=false

import { inlineHtml } from './src/pipeline.mjs';

// -------------------- RUN --------------------
inlineHtml().catch((e) => {
  console.error('❌ Build failed:', e);
  process.exitCode = 1;
});