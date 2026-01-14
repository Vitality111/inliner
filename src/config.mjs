// FILE: src/config.mjs
import { fileURLToPath } from 'url';
import path from 'path';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -------------------- CLI --------------------
export const argv = process.argv.slice(2);
export const INPUT_FILE = argv.find(a => !a.startsWith('--')) || 'index.html';
export const FLAGS = Object.fromEntries(
    argv
        .filter(a => a.startsWith('--'))
        .map(a => {
            const [k, v] = a.replace(/^--/, '').split('=');
            if (v === undefined) return [k, true];
            if (v === 'true') return [k, true];
            if (v === 'false') return [k, false];
            const n = Number(v);
            return [k, Number.isFinite(n) ? n : v];
        })
);

export const OPTIMIZE_ONLY = !!FLAGS.optimizeOnly;
export const ASSETS_DIR_RAW = FLAGS.assetsDir || null;
export const OVERRIDE_DIR_NAME = 'dir';
export const OPT_EXTS = new Set([
    '.jpg', '.jpeg', '.png', '.webp', '.gif',
    '.mp3', '.m4a', '.wav', '.ogg',
    '.mp4', '.webm',
    '.woff', '.woff2', '.ttf', '.otf', '.glb'
]);

// -------------------- Конфіг --------------------
export const CONFIG = {
    image: {
        jpegQ: FLAGS.jpegQ ?? 50,
        webpQ: FLAGS.webpQ ?? 50,
        pngLevel: FLAGS.pngLevel ?? 1,
        pngQuality: FLAGS.pngQuality ?? 50,
        pngPalette: FLAGS.pngPalette ?? true,
        gifLossy: FLAGS.gifLossy ?? 180,
        gifColors: FLAGS.gifColors ?? 48
    },
    video: {
        codec: FLAGS.codec || 'libx264',
        crf: FLAGS.crf ?? 26,
        preset: FLAGS.preset || 'slow',
        tune: FLAGS.tune,                 // 'film' | 'animation' | 'grain'
        maxWidth: FLAGS.maxWidth ?? 540, // масштаб із збереженням пропорцій
        fps: FLAGS.fps,                   // якщо не задано — оригінал
        twoPass: !!FLAGS.twoPass,
        targetMbps: FLAGS.targetMbps,
        maxRateFactor: FLAGS.maxRateFactor ?? 2.0,
        audioKbps: FLAGS.audioKbps ?? 160,
        faststart: FLAGS.faststart !== false
    },
    audio: {
        mp3Kbps: FLAGS.mp3Kbps ?? 128
    },
    font: {
        subset: FLAGS.fontSubset || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    },
    html: {
        minify: !!FLAGS.minifyHtml
    },
    externals: {
        fetch: !!FLAGS.fetchExternals // тягнути http(s) і вшивати
    },
    css: { minify: !!FLAGS.minifyCss },
    js: { minify: !!FLAGS.minifyJs },
};
