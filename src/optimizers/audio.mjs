// FILE: src/optimizers/audio.mjs
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs-extra';
import { CONFIG } from '../config.mjs';

export const optimizeAudioFileToBuffer = async (tmpInPath) => {
    const tmpOut = `${tmpInPath}.${Date.now()}.min.mp3`;
    await new Promise((resolve, reject) => {
        ffmpeg(tmpInPath)
            .audioCodec('libmp3lame')
            .audioBitrate(`${CONFIG.audio.mp3Kbps}k`)
            .save(tmpOut)
            .on('end', resolve).on('error', reject);
    });
    const buf = await fs.readFile(tmpOut);
    await fs.remove(tmpOut).catch(() => { });
    return buf;
};
