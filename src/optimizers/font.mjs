// FILE: src/optimizers/font.mjs
import Fontmin from 'fontmin';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { CONFIG, __dirname } from '../config.mjs';

export const optimizeFontBuffer = async (buf) => {
    // Fontmin працює з файлами
    const tmpIn = path.join(__dirname, `.font-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const tmpOutDir = path.join(__dirname, `.font-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.writeFile(tmpIn, buf);
    const fontmin = new Fontmin()
        .src(tmpIn)
        .use(Fontmin.glyph({ text: CONFIG.font.subset }))
        .dest(tmpOutDir);
    await promisify(fontmin.run.bind(fontmin))();
    const outFiles = await fs.readdir(tmpOutDir);
    let out = buf;
    if (outFiles.length) {
        const first = path.join(tmpOutDir, outFiles[0]);
        out = await fs.readFile(first);
    }
    await fs.remove(tmpIn).catch(() => { });
    await fs.remove(tmpOutDir).catch(() => { });
    return out.length && out.length <= buf.length ? out : buf;
};
