import esbuild from 'esbuild';
import fs from 'fs-extra';
import path from 'path';

// Ensure output directory exists
await fs.ensureDir('bin');

console.log('📦 Bundling inline.mjs...');

try {
    await esbuild.build({
        entryPoints: ['inline.mjs'],
        bundle: true,
        outfile: 'bin/inline.mjs',
        platform: 'node',
        format: 'esm',
        target: 'node18',
        // Externalize dependencies that should remain as node_modules
        external: [
            'fs-extra',
            'sharp',
            'fluent-ffmpeg',
            'fontmin',
            'lightningcss',
            'esbuild',
            // 'gifsicle' is run via child_process, not imported, but good to note
        ],
        banner: {
            js: `import { createRequire } from 'module';const require = createRequire(import.meta.url);`
        },
        // Fix for __dirname usage in bundled ESM
        define: {
            // We can't easily shim __dirname in ESM bundle without custom plugins or banners
            // But our code uses import.meta.url to derive __dirname.
            // esbuild generally preserves import.meta.url in ESM output.
        },
        logLevel: 'info',
    });

    console.log('✅ Bundled successfully: bin/inline.mjs');
} catch (e) {
    console.error('❌ Bundle failed:', e);
    process.exit(1);
}
