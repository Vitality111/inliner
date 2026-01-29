// FILE: inline.mjs
// 🧰 One-file HTML5 playable builder — v2 (Refactored Modular)
// Вимоги: Node 18+, ffmpeg у PATH, пакети: fs-extra, sharp, fluent-ffmpeg, fontmin
// Запуск: node inline.mjs index.html --fetchExternals=true --minifyHtml=false

import { inlineHtml } from './src/pipeline.mjs';
import { initInteractive, closeInteractive, setInteractiveFlag } from './src/utils.mjs';
import { INTERACTIVE } from './src/config.mjs';

// -------------------- RUN --------------------
async function main() {
  if (INTERACTIVE) {
    console.log('🎛️  Interactive mode enabled. Options: [y]es, [n]o, [a]ll auto, [s]kip all\n');
    setInteractiveFlag(true);
    // Налаштувати stdin для інтерактивного режиму
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