// FILE: src/processors/js.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Обробка JavaScript: інлайн ассетів у JS коді, бандлінг ES модулів,
// мініфікація, та інлайн <script src="..."> в HTML.
//
// Два режими бандлінгу:
//   1. esbuild bundle (пріоритет) — підтримує import/export, tree-shaking
//   2. Simple inline (fallback) — якщо esbuild впав, просто читає файл
//
// Ассети в JS знаходяться за розширенням файлу в рядках:
//   "image.png", 'audio.mp3', `model.glb`
// Кожен знайдений шлях обробляється через processUri → data:URI
//
// Залежності: esbuild (npm)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs-extra';
import path from 'path';
import esbuild from 'esbuild';
import { replaceAsync, decodeLocalPath, isHttp } from '../utils.mjs';
import { processUri } from '../encoder.mjs';
import { CONFIG } from '../config.mjs';

// ========================== JS CONTENT PROCESSING ==========================

/**
 * Обробляє JS контент: знаходить рядкові шляхи до ассетів і замінює
 * їх на data:URI.
 *
 * Regex шукає рядки в "", '', `` що:
 *   - Закінчуються на розширення ресурсу (.png, .mp3, .glb, тощо)
 *   - Або починаються з data: (існуючі data:URI для re-encoding)
 *
 * ⚠️ Regex може матчити false positives (наприклад, "error: file.png not found").
 *    Це безпечно — processUri просто поверне оригінальний рядок якщо файл
 *    не існує. Але може спричинити зайві Warning-и в консолі.
 *
 * @param {string} jsText — JavaScript код
 * @param {string} baseDir — базова директорія для відносних шляхів
 * @returns {Promise<string>} JS з інлайненими ассетами
 */
export const processJsContent = async (jsText, baseDir) => {
    // Замінюємо ВСІ рядкові шляхи до файлів на data:URI
    jsText = await replaceAsync(
        jsText,
        /(["'`])([^"'`]*?\.(?:png|jpe?g|gif|svg|webp|mp4|webm|mp3|m4a|wav|ogg|json|txt|wasm|glb|woff2?|ttf|otf)(?:\?[^"'`#]*)?(?:#[^"'`]*)?|data:[^"'`]+?)\1/gi,
        async (match, quote, pth) => {
            const replaced = await processUri(pth, baseDir);
            return `${quote}${replaced}${quote}`;
        }
    );

    return jsText;
};

// ========================== ESBUILD PLUGIN ==========================

/**
 * Кастомний esbuild плагін для інлайну ассетів всередині JS модулів.
 *
 * При завантаженні кожного .js/.mjs/.jsx/.ts/.tsx файлу:
 *   1. Читає файл
 *   2. Обробляє ассети через processJsContent
 *   3. Повертає оброблений контент esbuild-у для подальшого бандлінгу
 *
 * resolveDir важливий — без нього esbuild не зможе резолвити
 * відносні import-и в оброблених файлах.
 */
const inlineAssetsPlugin = () => ({
    name: 'inline-assets',
    setup(build) {
        build.onLoad({ filter: /\.(js|mjs|jsx|ts|tsx)$/ }, async (args) => {
            const ext = path.extname(args.path).toLowerCase();
            const loader =
                ext === '.ts' ? 'ts' :
                    ext === '.tsx' ? 'tsx' :
                        ext === '.jsx' ? 'jsx' : 'js';

            let text = await fs.readFile(args.path, 'utf8');

            // ⚠️ ВАЖЛИВО: Інлайнимо ассети ПЕРЕД бандлінгом
            // processJsContent замінює рядкові шляхи на data:URI,
            // щоб мініфікація не могла скоротити змінні, які на них посилаються
            text = await processJsContent(text, path.dirname(args.path));

            return {
                contents: text,
                loader,
                resolveDir: path.dirname(args.path), // ✅ для import "./x.js"
            };
        });
    },
});

// ========================== JS MINIFICATION ==========================

/**
 * Мініфікує JS через esbuild (якщо увімкнено --minifyJs).
 * esbuild значно швидший за terser, достатній для плейблів.
 * target: es2017 — сумісність з мобільними браузерами.
 *
 * @param {string} js — JavaScript код
 * @returns {Promise<string>} мініфікований JS (або оригінал)
 */
export const maybeMinifyJs = async (js) => {
    if (!CONFIG.js?.minify) return js;
    try {
        const out = await esbuild.transform(js, {
            minify: true,
            target: 'es2017',
        });
        return out.code;
    } catch {
        return js;
    }
};

// ========================== JS BUNDLING ==========================

/**
 * Бандлить JS файл через esbuild з підтримкою ES модулів.
 *
 * @param {string} entryPath — абсолютний шлях до entry-point
 * @param {string} [format='iife'] — формат виходу:
 *   'iife' — для звичайних <script> (обгортає в IIFE)
 *   'esm'  — для <script type="module"> (зберігає import/export)
 * @returns {Promise<string>} збандлений JS код
 */
export const bundleJs = async (entryPath, format = 'iife') => {
    try {
        const result = await esbuild.build({
            entryPoints: [entryPath],
            bundle: true,
            write: false,              // не писати на диск, повернути в пам'яті
            format: format,
            plugins: [inlineAssetsPlugin()],
            minify: CONFIG.js.minify,
            target: ['es2017'],
            logLevel: 'silent',        // не спамити в консоль
        });
        let bundled = result.outputFiles[0].text;

        // ⚠️ Обробити ассети в JS ПЕРЕД мініфікацією (важливо!)
        // Якщо minify=true, то вже зроблено всередині esbuild.build
        // Але якщо фалбек або зовнішні скрипти - потрібно вручну
        if (!CONFIG.js.minify) {
            bundled = await processJsContent(bundled, path.dirname(entryPath));
        }

        return bundled;
    } catch (e) {
        console.warn(`⚠️ Bundling failed for ${entryPath}:`, e.message);
        throw e;
    }
};

// ========================== SCRIPT TAG INLINING ==========================

/**
 * Знаходить <script src="..."> в HTML і замінює на inline <script>code</script>.
 *
 * Алгоритм для кожного script:
 *   1. HTTP URL + fetchExternals → fetch & inline
 *   2. HTTP URL без fetchExternals → залишити як є
 *   3. Локальний файл → спробувати esbuild bundle
 *   4. Bundle failed → fallback: просто inline файл
 *
 * type="module" обробка:
 *   - Видаляє type="module" з атрибутів
 *   - Бандлить як ESM формат
 *   - Додає type="module" назад (для top-level await)
 *
 * @param {string} html — HTML контент
 * @param {string} basePath — базовий шлях
 * @returns {Promise<string>} HTML з інлайненими скриптами
 */
export const inlineJsScripts = async (html, basePath) => {
    return await replaceAsync(
        html,
        /<script([^>]*?)\s+src=["']([^"']+)["']([^>]*)>(?:\s*<\/script>)?/gi,
        async (_, pre, src, post) => {
            // ──── HTTP(S) ────
            if (isHttp(src)) {
                if (!CONFIG.externals.fetch) {
                    // Не стягувати — залишити зовнішній скрипт
                    return `<script${pre} src="${src}"${post}></script>`;
                } else {
                    // Стягнути і вставити inline
                    const fetched = await fetch(src).then(r => r.ok ? r.text() : null).catch(() => null);
                    if (!fetched) return `<script${pre} src="${src}"${post}></script>`;
                    let js = fetched;
                    js = await processJsContent(js, basePath);
                    js = await maybeMinifyJs(js);
                    return `<script${pre}${post}>${js}</script>`;
                }
            }

            // ──── Локальний файл ────
            const cleanSrc = decodeLocalPath(src);
            const file = path.resolve(basePath, cleanSrc);
            if (!await fs.pathExists(file)) {
                return `<script${pre} src="${src}"${post}></script>`;
            }

            // Спробувати esbuild bundle (підтримує imports)
            try {
                const isModule = /\stype=["']module["']/i.test(`${pre} ${post}`);
                const format = isModule ? 'esm' : 'iife';

                const bundled = await bundleJs(file, format);

                // Прибираємо type="module" з оригінальних атрибутів
                // і додаємо назад якщо він був (для коректної роботи top-level await)
                const newPre = pre.replace(/\stype=["']module["']/i, '');
                const newPost = post.replace(/\stype=["']module["']/i, '');

                return `<script${newPre}${newPost}${isModule ? ' type="module"' : ''}>${bundled}</script>`;
            } catch (e) {
                // Fallback: простий inline без бандлінгу
                console.warn('Bundling failed, falling back to simple inline:', e.message);
                let js = await fs.readFile(file, 'utf8');
                js = await processJsContent(js, path.dirname(file));
                js = await maybeMinifyJs(js);
                return `<script${pre}${post}>${js}</script>`;
            }
        }
    );
};

// ========================== INLINE SCRIPTS PROCESSING ==========================

/**
 * Обробляє вбудовані <script>...</script> (які не мають атрибуту src).
 * Знаходить ассети всередині (processJsContent) та мініфікує код (maybeMinifyJs).
 *
 * @param {string} html — HTML контент
 * @param {string} basePath — базовий шлях
 * @returns {Promise<string>} HTML з обробленими вбудованими скриптами
 */
export const processInlineScripts = async (html, basePath) => {
    return await replaceAsync(
        html,
        /<script([^>]*)>([\s\S]*?)<\/script>/gi,
        async (match, attr, content) => {
            // Ігноруємо зовнішні скрипти, бо їх обробить inlineJsScripts
            if (attr.includes('src=')) return match;
            if (attr.includes('src =')) return match;

            // Ігноруємо шаблони, JSON тощо
            const lowerAttr = attr.toLowerCase();
            if (lowerAttr.includes('type=') && 
               !lowerAttr.includes('text/javascript') && 
               !lowerAttr.includes('module')) {
                return match;
            }

            if (!content.trim()) return match;

            let js = await processJsContent(content, basePath);
            js = await maybeMinifyJs(js);
            return `<script${attr}>${js}</script>`;
        }
    );
};
