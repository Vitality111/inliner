// FILE: src/optimizers/gltf.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Оптимізатор 3D моделей GLB/GLTF через gltfpack (meshoptimizer).
//
// gltfpack виконує:
//   - Стиснення мешів (mesh compression) через meshopt кодек
//   - Текстурне стиснення через BasisU (якщо підтримується)
//   - Спрощення геометрії (simplification ratio)
//   - Збереження імен і матеріалів для дебагу
//
// ⚠️ Meshopt decoder потрібен у runtime для декодування стиснених мешів!
//    Підключи meshopt_decoder.js у свій проєкт.
//
// ⚠️ BasisU текстурне стиснення може бути недоступне в деяких білдах gltfpack.
//    В такому разі автоматично повторюється без -tc.
//
// Залежності: gltfpack (опціональна npm залежність або в PATH)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs-extra';
import path from 'path';
import { runExternal } from '../utils.mjs';
import { FLAGS, __dirname } from '../config.mjs';

/**
 * Оптимізує GLB буфер через gltfpack.
 *
 * @param {Buffer} buf — оригінальний GLB буфер
 * @returns {Promise<Buffer>} оптимізований буфер (або оригінал при помилці/збільшенні)
 */
export const optimizeGlbBuffer = async (buf) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpIn = path.join(__dirname, `.tmp-${stamp}.glb`);
    const tmpOut = path.join(__dirname, `.tmp-${stamp}.opt.glb`);

    await fs.writeFile(tmpIn, buf);

    const baseArgs = [
        '-i', tmpIn,           // вхідний файл
        '-o', tmpOut,          // вихідний файл

        '-cc',                 // mesh compression (meshopt codec)
                               // ⚠️ Потребує meshopt_decoder.js у runtime!

        '-kn',                 // keep names — зберігає назви нодів/мешів
        '-km',                 // keep materials — зберігає матеріали

        /**
         * Коефіцієнт спрощення геометрії (simplification ratio).
         *   1.0 = без спрощення (оригінальна геометрія)
         *   0.5 = зменшити кількість трикутників вдвічі
         *   0.1 = агресивне спрощення (для LOD)
         * CLI: --glbSi=1.0
         */
        '-si', String(FLAGS.glbSi ?? 1.0),

        '-noq'                 // не квантизувати анімації (зменшує артефакти)
    ];

    try {
        // Спершу пробуємо з текстурним стисненням BasisU (-tc)
        try {
            await runExternal('gltfpack', [...baseArgs, '-tc']);
        } catch (e) {
            const msg = String(e?.message || e);
            const basisMissing =
                msg.includes('BasisU support') ||
                msg.includes('texture compression is not available') ||
                msg.includes('built without BasisU');

            if (basisMissing) {
                // BasisU недоступне — повторюємо без текстурного стиснення
                console.warn('⚠️ gltfpack: BasisU not available, retrying without -tc');
                await runExternal('gltfpack', baseArgs);
            } else {
                throw e;
            }
        }

        if (!await fs.pathExists(tmpOut)) {
            console.error('gltfpack finished but output file not found:', tmpOut);
            return buf;
        }

        const out = await fs.readFile(tmpOut);

        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });

        // Повертаємо тільки якщо менший за оригінал
        return out.length && out.length < buf.length ? out : buf;
    } catch (e) {
        console.warn('⚠️ gltfpack skipped:', e?.message || e);
        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });
        return buf;
    }
};
