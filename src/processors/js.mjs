// FILE: src/processors/js.mjs
import fs from 'fs-extra';
import path from 'path';
import esbuild from 'esbuild';
import { replaceAsync, decodeLocalPath, isHttp } from '../utils.mjs';
import { processUri } from '../encoder.mjs';
import { CONFIG } from '../config.mjs';

// Обробка JS-контенту: перетворюємо рядкові шляхи/URI до ресурсів у data:
export const processJsContent = async (jsText, baseDir) => {
    // Пошук у лапках "...", '...', `...` для типових ресурсів і data:
    // Підтримка backticks `...` і query/hash в файлах
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

// Custom esbuild plugin to inline assets (images, etc.) inside JS modules
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

            // ✅ інлайнимо ассети відносно поточного модуля
            text = await processJsContent(text, path.dirname(args.path));

            return {
                contents: text,
                loader,
                resolveDir: path.dirname(args.path), // ✅ ВАЖЛИВО для import "./x.js"
            };
        });
    },
});

export const maybeMinifyJs = async (js) => {
    if (!CONFIG.js?.minify) return js;
    // "безпечний" режим: без агресивного переписування логіки
    try {
        const out = await esbuild.transform(js, {
            minify: true,
            // target під мобілки/плейбли
            target: 'es2017',
        });
        return out.code;
    } catch {
        return js;
    }
};

// Bundle JS using esbuild
export const bundleJs = async (entryPath, format = 'iife') => {
    try {
        const result = await esbuild.build({
            entryPoints: [entryPath],
            bundle: true,
            write: false,
            format: format,
            // globalName: 'BundledModule', // ❌ Removed to avoid collisions
            plugins: [inlineAssetsPlugin()],
            minify: CONFIG.js.minify,
            target: ['es2017'],
            logLevel: 'silent',
        });
        return result.outputFiles[0].text;
    } catch (e) {
        console.warn(`⚠️ Bundling failed for ${entryPath}:`, e.message);
        throw e;
    }
};

// <script src="..."> (зберігаємо атрибути), обробляємо рядки-ресурси всередині JS
export const inlineJsScripts = async (html, basePath) => {
    return await replaceAsync(
        html,
        /<script([^>]*?)\s+src=["']([^"']+)["']([^>]*)>(?:\s*<\/script>)?/gi,
        async (_, pre, src, post) => {
            // CDN залишимо або стягнемо (залежить від --fetchExternals)
            if (isHttp(src)) {
                if (!CONFIG.externals.fetch) {
                    return `<script${pre} src="${src}"${post}></script>`;
                } else {
                    // стягнемо і вставимо код як inline
                    const fetched = await fetch(src).then(r => r.ok ? r.text() : null).catch(() => null);
                    if (!fetched) return `<script${pre} src="${src}"${post}></script>`;
                    let js = fetched;
                    js = await processJsContent(js, basePath);
                    // Minify fetched code too
                    js = await maybeMinifyJs(js);
                    return `<script${pre}${post}>${js}</script>`;
                }
            }

            // Локальний файл
            const cleanSrc = decodeLocalPath(src);
            const file = path.resolve(basePath, cleanSrc);
            if (!await fs.pathExists(file)) {
                return `<script${pre} src="${src}"${post}></script>`;
            }

            // Try bundling first (supports imports)
            try {
                const isModule = /\stype=["']module["']/i.test(`${pre} ${post}`);
                const format = isModule ? 'esm' : 'iife';

                const bundled = await bundleJs(file, format);

                // Remove type="module" from attributes (if we want to strip it) 
                // BUT user asked to keep it for defer behavior if it was module.
                // Also if we use format: 'esm', we MUST keep type="module" for top-level await to work.

                const newPre = pre.replace(/\stype=["']module["']/i, '');
                const newPost = post.replace(/\stype=["']module["']/i, '');

                // Re-add type="module" if it was there
                return `<script${newPre}${newPost}${isModule ? ' type="module"' : ''}>${bundled}</script>`;
            } catch (e) {
                console.warn('Bundling failed, falling back to simple inline:', e.message);
                let js = await fs.readFile(file, 'utf8');
                js = await processJsContent(js, path.dirname(file));
                js = await maybeMinifyJs(js);
                return `<script${pre}${post}>${js}</script>`;
            }
        }
    );
};
