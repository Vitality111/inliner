// FILE: src/optimizers/gltf.mjs
import fs from 'fs-extra';
import path from 'path';
import { runExternal } from '../utils.mjs';
import { FLAGS, __dirname } from '../config.mjs';

export const optimizeGlbBuffer = async (buf) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpIn = path.join(__dirname, `.tmp-${stamp}.glb`);
    const tmpOut = path.join(__dirname, `.tmp-${stamp}.opt.glb`);

    await fs.writeFile(tmpIn, buf);

    const baseArgs = [
        '-i', tmpIn,
        '-o', tmpOut,

        // mesh compression (requires meshopt decoder at runtime)
        '-cc',

        // keep names/materials (safer for animations / debugging)
        '-kn',
        '-km',

        // mild simplification by default; override via CLI if needed later
        '-si', String(FLAGS.glbSi ?? 1.0),

        // avoid quantizing animations (reduces artifacts)
        '-noq'
    ];

    try {
        // Try with texture compression if available (BasisU). If not, retry without -tc.
        try {
            await runExternal('gltfpack', [...baseArgs, '-tc']);
        } catch (e) {
            const msg = String(e?.message || e);
            const basisMissing =
                msg.includes('BasisU support') ||
                msg.includes('texture compression is not available') ||
                msg.includes('built without BasisU');

            if (basisMissing) {
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

        return out.length && out.length < buf.length ? out : buf;
    } catch (e) {
        console.error('gltfpack failed:', e?.message || e);
        await fs.remove(tmpIn).catch(() => { });
        await fs.remove(tmpOut).catch(() => { });
        return buf;
    }
};
