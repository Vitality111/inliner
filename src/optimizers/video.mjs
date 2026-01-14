// FILE: src/optimizers/video.mjs
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs-extra';
import { CONFIG } from '../config.mjs';

export const ffprobe = (file) =>
    new Promise((res, rej) =>
        ffmpeg.ffprobe(file, (err, data) => (err ? rej(err) : res(data)))
    );

export const optimizeVideoFileToBuffer = async (tmpInPath) => {
    const {
        codec, crf, preset, tune, maxWidth, fps, twoPass,
        targetMbps, maxRateFactor, audioKbps, faststart
    } = CONFIG.video;

    // Дізнаємось ширину вхідного відео
    let inW = 0;
    try {
        const meta = await ffprobe(tmpInPath);
        const v = meta.streams?.find(s => s.codec_type === 'video');
        inW = v?.width || 0;
    } catch { }

    const needScale = maxWidth && inW && inW > maxWidth;
    const scaleFilter = needScale
        ? `scale=${maxWidth}:-2`
        : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

    const tmpOut = `${tmpInPath}.${Date.now()}.min.mp4`;
    const base = [
        '-pix_fmt yuv420p',
        `-c:v ${codec}`,
        `-preset ${preset}`,
        `-crf ${crf}`,
        '-profile:v high',
        '-level 4.1',
        `-vf ${scaleFilter}`
    ];
    if (tune) base.push(`-tune ${tune}`);
    if (Number.isFinite(fps)) base.push(`-r ${fps}`);
    if (faststart) base.push('-movflags +faststart');

    const vb = Number.isFinite(targetMbps) ? `${targetMbps}M` : null;
    const maxrate =
        Number.isFinite(targetMbps) && Number.isFinite(maxRateFactor)
            ? `${(targetMbps * maxRateFactor).toFixed(2)}M`
            : null;
    const bufsize =
        Number.isFinite(targetMbps) && Number.isFinite(maxRateFactor)
            ? `${(targetMbps * maxRateFactor * 2).toFixed(2)}M`
            : null;
    if (vb) base.push(`-b:v ${vb}`, `-minrate ${vb}`, `-maxrate ${maxrate}`, `-bufsize ${bufsize}`);

    const aopts = ['-c:a aac', `-b:a ${audioKbps}k`];

    if (twoPass && vb) {
        const passlog = `${tmpInPath}.2pass`;
        await new Promise((resolve, reject) => {
            ffmpeg(tmpInPath)
                .outputOptions([...base, '-an', '-pass 1', `-passlogfile ${passlog}`])
                .save(tmpOut)
                .on('end', resolve).on('error', reject);
        });
        await new Promise((resolve, reject) => {
            ffmpeg(tmpInPath)
                .outputOptions([...base, ...aopts, '-pass 2', `-passlogfile ${passlog}`])
                .save(tmpOut)
                .on('end', resolve).on('error', reject);
        });
        await Promise.all([
            fs.remove(`${passlog}-0.log`).catch(() => { }),
            fs.remove(`${passlog}.log`).catch(() => { }),
            fs.remove(`${passlog}.log.mbtree`).catch(() => { })
        ]);
    } else {
        await new Promise((resolve, reject) => {
            ffmpeg(tmpInPath)
                .outputOptions([...base, ...aopts])
                .save(tmpOut)
                .on('end', resolve).on('error', reject);
        });
    }

    const out = await fs.readFile(tmpOut);
    await fs.remove(tmpOut).catch(() => { });
    return out;
};
