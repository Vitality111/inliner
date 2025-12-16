// 🧰 One-file HTML5 playable builder — v2 (повторне стиснення навіть уже інлайнених data:)
// Вимоги: Node 18+, ffmpeg у PATH, пакети: fs-extra, sharp, fluent-ffmpeg, fontmin
// Запуск: node build.mjs index.html --fetchExternals=true --minifyHtml=false

// -------------------- Імпорти --------------------
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import Fontmin from 'fontmin';
import crypto from 'crypto'; import { execFile } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -------------------- CLI --------------------
const argv = process.argv.slice(2);
const INPUT_FILE = argv.find(a => !a.startsWith('--')) || 'index.html';
const FLAGS = Object.fromEntries(
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

const OPTIMIZE_ONLY = !!FLAGS.optimizeOnly;
const ASSETS_DIR_RAW = FLAGS.assetsDir || null;
const OPT_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
  '.mp3', '.m4a', '.wav', '.ogg',
  '.mp4', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.glb'
]);

const walkFiles = async (dir) => {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkFiles(p));
    else out.push(p);
  }
  return out;
};

const optimizeAssetsFolderInPlace = async (assetsDirAbs) => {
  if (!assetsDirAbs) throw new Error('❌ Missing --assetsDir. Example: --assetsDir=assets');
  if (!await fs.pathExists(assetsDirAbs)) {
    throw new Error(`❌ assetsDir not found: ${assetsDirAbs}`);
  }

  const files = await walkFiles(assetsDirAbs);

  for (const fileAbsPath of files) {
    const ext = path.extname(fileAbsPath).toLowerCase();
    if (!OPT_EXTS.has(ext)) continue;

    const mime = MIME[ext] || 'application/octet-stream';
    const original = await fs.readFile(fileAbsPath);
    const before = original.length;

    let outBuf = original;
    try {
      outBuf = await optimizeByMime(original, mime);
    } catch { outBuf = original; }

    // ✅ перезапис тільки якщо реально менше
    if (outBuf && outBuf.length && outBuf.length < before) {
      await fs.writeFile(fileAbsPath, outBuf);
      logSaving(path.relative(assetsDirAbs, fileAbsPath), before, outBuf.length);
    } else {
      logSaving(path.relative(assetsDirAbs, fileAbsPath), before, before);
    }
  }

  console.log(`\n✅ Assets optimized in-place: ${assetsDirAbs}`);
};


// -------------------- Конфіг --------------------
const CONFIG = {
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
    audioKbps: FLAGS.audioKbps ?? 192,
    faststart: FLAGS.faststart !== false
  },
  audio: {
    mp3Kbps: FLAGS.mp3Kbps ?? 92
  },
  font: {
    subset: FLAGS.fontSubset || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  },
  html: {
    minify: !!FLAGS.minifyHtml
  },
  externals: {
    fetch: !!FLAGS.fetchExternals // тягнути http(s) і вшивати
  }
};
const execFileAsync = promisify(execFile);


// -------------------- Cross-platform external runner --------------------
// On Windows, many npm-installed CLIs are .cmd shims; running via `cmd.exe /c` avoids spawn EINVAL.
const runExternal = async (bin, args, options = {}) => {
  const isWin = process.platform === 'win32';
  if (isWin) {
    return await execFileAsync('cmd.exe', ['/c', bin, ...args], { windowsHide: true, ...options });
  }
  return await execFileAsync(bin, args, options);
};

const optimizeGifBuffer = async (buf) => {
  const tmpIn = path.join(__dirname, `.tmp-gif-${Date.now()}-${Math.random().toString(36).slice(2)}.gif`);
  const tmpOut = `${tmpIn}.out.gif`;

  await fs.writeFile(tmpIn, buf);

  const lossy = CONFIG.image.gifLossy;
  const colors = CONFIG.image.gifColors;

  // gifsicle args
  const args = ['-O3'];
  if (Number.isFinite(lossy) && lossy > 0) args.push(`--lossy=${lossy}`);
  if (Number.isFinite(colors) && colors > 0 && colors <= 256) args.push('--colors', String(colors));
  args.push(tmpIn, '-o', tmpOut);

  try {
    await runExternal('gifsicle', args);
    const outBuf = await fs.readFile(tmpOut);

    await fs.remove(tmpIn).catch(() => { });
    await fs.remove(tmpOut).catch(() => { });

    // беремо тільки якщо реально менше
    return outBuf.length && outBuf.length < buf.length ? outBuf : buf;
  } catch (e) {
    // If gifsicle is missing, keep original GIF
    console.error('gifsicle failed:', e?.message || e);
    await fs.remove(tmpIn).catch(() => { });
    await fs.remove(tmpOut).catch(() => { });
    return buf;
  }
};

// -------------------- MIME --------------------
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html'
};

// -------------------- Лічильники/кеші --------------------
let totalOriginalSize = 0;
let totalFinalSize = 0;

// Кеш для локальних файлів: absPath -> dataURI
const fileCache = new Map();
// Кеш для уже інлайнених data: рядків: originalDataUri -> optimizedDataUri
const dataUriCache = new Map();

// -------------------- Хелпери --------------------
const isHttp = (p) => /^https?:\/\//i.test(p);
const isDataUri = (p) => /^data:/i.test(p);
const isSkippableScheme = (p) => /^data:|^blob:/i.test(p);
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const extFromMime = (mime) => {
  for (const [ext, m] of Object.entries(MIME)) {
    if (m === mime) return ext;
  }
  return null;
};
const optimizeGlbBuffer = async (buf) => {
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

// Безпечний replaceAsync
const replaceAsync = async (str, regex, asyncFn) => {
  const matches = [...str.matchAll(regex)];
  if (matches.length === 0) return str;
  const parts = [];
  let lastIndex = 0;
  const replacements = await Promise.all(matches.map((m) => asyncFn(...m)));
  matches.forEach((m, i) => {
    parts.push(str.slice(lastIndex, m.index), replacements[i]);
    lastIndex = m.index + m[0].length;
  });
  parts.push(str.slice(lastIndex));
  return parts.join('');
};

// Пошук файлу в проекті (можна додати --root для обмеження)
const findFileRecursive = async (targetFile, startDir = path.resolve(__dirname, '..')) => {
  const entries = await fs.readdir(startDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      const result = await findFileRecursive(targetFile, fullPath);
      if (result) return result;
    } else if (entry.name === targetFile) {
      return { basePath: path.dirname(fullPath), fullPath };
    }
  }
  return null;
};

// -------------------- Оптимізація буферів за MIME --------------------
const optimizeImageBuffer = async (buf, mime) => {
  try {
    if (mime === 'image/jpeg') {
      return await sharp(buf).jpeg({ quality: CONFIG.image.jpegQ }).toBuffer();
    }
    if (mime === 'image/webp') {
      return await sharp(buf).webp({ quality: CONFIG.image.webpQ }).toBuffer();
    }
    if (mime === 'image/png') {
      return await sharp(buf).png({
        compressionLevel: CONFIG.image.pngLevel,
        palette: !!CONFIG.image.pngPalette,
        quality: CONFIG.image.pngQuality
      }).toBuffer();
    }
    if (mime === 'image/gif') {
      return await optimizeGifBuffer(buf); // ← тут
    }
    if (mime === 'image/svg+xml') {
      return buf;
    }
    return buf;
  } catch {
    return buf;
  }
};



const ffprobe = (file) =>
  new Promise((res, rej) =>
    ffmpeg.ffprobe(file, (err, data) => (err ? rej(err) : res(data)))
  );

const optimizeVideoFileToBuffer = async (tmpInPath) => {
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

const optimizeAudioFileToBuffer = async (tmpInPath) => {
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

// Оптимізація за MIME із буфера (через тимчасовий файл для відео/аудіо/шрифтів)
const optimizeByMime = async (buf, mime) => {
  try {
    if (mime.startsWith('image/')) {
      return await optimizeImageBuffer(buf, mime);
    }
    if (mime.startsWith('video/')) {
      const tmpIn = path.join(__dirname, `.tmp-${Date.now()}-${sha1(buf)}.in`);
      await fs.writeFile(tmpIn, buf);
      const out = await optimizeVideoFileToBuffer(tmpIn);
      await fs.remove(tmpIn).catch(() => { });
      return out.length && out.length < buf.length ? out : buf;
    }
    if (mime.startsWith('audio/')) {
      const tmpIn = path.join(__dirname, `.tmp-${Date.now()}-${sha1(buf)}.in`);
      await fs.writeFile(tmpIn, buf);
      const out = await optimizeAudioFileToBuffer(tmpIn);
      await fs.remove(tmpIn).catch(() => { });
      return out.length && out.length < buf.length ? out : buf;
    }
    if (mime === 'model/gltf-binary') {
      return await optimizeGlbBuffer(buf);
    }
    if (mime.startsWith('font/')) {
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
    }
    // інше — як є
    return buf;
  } catch {
    return buf;
  }
};

// Кодування буфера у data:URI
const toDataUri = (mime, buffer) =>
  `data:${mime};base64,${buffer.toString('base64')}`;

// Розбір data:URI → {mime, buffer}
const fromDataUri = (dataUri) => {
  // приклад: data:image/png;base64,AAAA...
  const m = /^data:([^;,]+)(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(dataUri);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const isB64 = !!m[2];
  const data = m[3];
  try {
    const buffer = isB64 ? Buffer.from(decodeURIComponent(data), 'base64')
      : Buffer.from(decodeURIComponent(data), 'utf8');
    return { mime, buffer };
  } catch { return null; }
};

// Логгер економії
const logSaving = (label, original, final) => {
  totalOriginalSize += original;
  totalFinalSize += final;
  const saved = original - final;
  const pct = original ? ((1 - final / original) * 100).toFixed(1) : '0.0';
  console.log(`✅ ${label}: ${original} → ${final} bytes (${pct}% saved)`);
};

// Перекодувати існуючий data:URI (із кешем)
const reencodeDataUri = async (dataUri) => {
  if (dataUriCache.has(dataUri)) return dataUriCache.get(dataUri);
  const parsed = fromDataUri(dataUri);
  if (!parsed) return dataUri;

  const { mime, buffer } = parsed;
  const before = buffer.length;
  const optimized = await optimizeByMime(buffer, mime);
  const out = toDataUri(mime, optimized);
  logSaving(`data:${mime}`, before, optimized.length);
  dataUriCache.set(dataUri, out);
  return out;
};

// Інлайн файлу на диску (із кешем)
const encodeFile = async (fileAbsPath) => {
  if (!await fs.pathExists(fileAbsPath)) return null;
  if (fileCache.has(fileAbsPath)) return fileCache.get(fileAbsPath);

  const ext = path.extname(fileAbsPath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const original = await fs.readFile(fileAbsPath);
  const before = original.length;
  let outBuf = original;

  try {
    if (mime.startsWith('image/')) {
      outBuf = await optimizeImageBuffer(original, mime);
    } else if (mime.startsWith('video/')) {
      outBuf = await optimizeByMime(original, mime);
    } else if (mime.startsWith('audio/')) {
      outBuf = await optimizeByMime(original, mime);
    } else if (mime.startsWith('font/')) {
      outBuf = await optimizeByMime(original, mime);
    } // інше — як є
  } catch {
    outBuf = original;
  }

  const finalBuf = outBuf.length <= original.length ? outBuf : original;
  logSaving(path.basename(fileAbsPath), before, finalBuf.length);

  const dataUri = toDataUri(mime, finalBuf);
  fileCache.set(fileAbsPath, dataUri);
  return dataUri;
};

// Завантажити http(s) ресурс (якщо дозволено) і закодувати
const fetchAndEncode = async (url) => {
  if (!CONFIG.externals.fetch || typeof fetch !== 'function') return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrBuf);
    // Спробуємо визначити mime
    let mime = res.headers.get('content-type')?.split(';')[0]?.trim() || '';
    if (!mime) {
      const ext = path.extname(new URL(url).pathname).toLowerCase();
      mime = MIME[ext] || 'application/octet-stream';
    }
    const before = buf.length;
    const optimized = await optimizeByMime(buf, mime);
    logSaving(url, before, optimized.length);
    return toDataUri(mime, optimized);
  } catch {
    return null;
  }
};

// Уніфікований процесор URI (локальний шлях, http(s), data:)
const processUri = async (uri, baseDir) => {
  if (!uri) return uri;
  if (isDataUri(uri)) return await reencodeDataUri(uri);
  if (isHttp(uri)) {
    const fetched = await fetchAndEncode(uri);
    return fetched || uri;
  }
  const decoded = decodeLocalPath(uri);
  const full = path.resolve(baseDir, decoded);
  if (!await fs.pathExists(full)) {
    console.warn('❌ Not found:', full, ' (from:', uri, ')');
  }
  const encoded = await encodeFile(full);
  return encoded || uri;
};


// -------------------- Інлайнери --------------------

// <link rel="stylesheet" href="...">
const inlineCssLinks = async (html, basePath) => {
  return await replaceAsync(
    html,
    /<link(?=[^>]*rel=["']?stylesheet["']?)[^>]*href=["']([^"']+\.css)["'][^>]*>/gi,
    async (match, href) => {
      const full = path.resolve(basePath, href);
      if (!await fs.pathExists(full)) return ''; // видалимо битий лінк
      let css = await fs.readFile(full, 'utf8');
      css = await processCssContent(css, path.dirname(full));
      return `<style>${css}</style>`;
    }
  );
};

// Обробити вміст CSS: url(...), в тому числі вже data:
// Обробити вміст CSS: url(...), @import, включно з лапками/пробілами/дужками
const processCssContent = async (cssText, baseDir) => {
  // Допоміжне: безпечне розекейплення css-escape для типових символів
  const unescapeCssPath = (s) =>
    s
      // знімаємо бекслеш перед (), ' ", пробілом і слешем
      .replace(/\\([()'"\s/\\])/g, '$1')
      // normalise подвійні бекслеші
      .replace(/\\\\/g, '\\');

  // 1) url(...) — підтримка 3 варіантів: "…", '…', без лапок
  cssText = await replaceAsync(
    cssText,
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi,
    async (_, g1, g2, g3) => {
      const rawPath = unescapeCssPath((g1 ?? g2 ?? g3 ?? '').trim());
      if (!rawPath) return `url(${g1 !== undefined ? `"${g1}"` : g2 !== undefined ? `'${g2}'` : g3})`;
      const replaced = await processUri(rawPath, baseDir);
      // якщо було в подвійних/одинарних — повертаємо з тим самим типом лапок
      if (g1 !== undefined) return `url("${replaced}")`;
      if (g2 !== undefined) return `url('${replaced}')`;
      return `url(${replaced})`;
    }
  );

  // 2) @import url("...") / @import '...' / @import "..."
  //    ВАЖЛИВО: обробляємо окремо, бо синтаксис інший за звичайні url(...)
  cssText = await replaceAsync(
    cssText,
    /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)|"([^"]+)"|'([^']+)')/gi,
    async (match, u1, u2, u3, q1, q2) => {
      const raw = unescapeCssPath((u1 ?? u2 ?? u3 ?? q1 ?? q2 ?? '').trim());
      if (!raw) return match;
      const replaced = await processUri(raw, baseDir);
      // зберігаємо оригінальний стиль (url(...)/лапки)
      if (u1 !== undefined) return `@import url("${replaced}")`;
      if (u2 !== undefined) return `@import url('${replaced}')`;
      if (u3 !== undefined) return `@import url(${replaced})`;
      if (q1 !== undefined) return `@import "${replaced}"`;
      if (q2 !== undefined) return `@import '${replaced}'`;
      return match;
    }
  );

  return cssText;
};


// <script src="..."> (зберігаємо атрибути), обробляємо рядки-ресурси всередині JS
const inlineJsScripts = async (html, basePath) => {
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
          return `<script${pre}${post}>${js}</script>`;
        }
      }

      // Локальний файл
      const file = path.resolve(basePath, src);
      if (!await fs.pathExists(file)) {
        return `<script${pre} src="${src}"${post}></script>`;
      }
      let js = await fs.readFile(file, 'utf8');
      js = await processJsContent(js, path.dirname(file));
      return `<script${pre}${post}>${js}</script>`;
    }
  );
};

// Обробка JS-контенту: перетворюємо рядкові шляхи/URI до ресурсів у data:
const processJsContent = async (jsText, baseDir) => {
  // Пошук у лапках "...", '...', `...` для типових ресурсів і data:
  jsText = await replaceAsync(
    jsText,
    /(["'`])([^"'`]*?\.(?:png|jpe?g|gif|svg|webp|mp4|webm|mp3|m4a|wav|ogg|json|txt|wasm|glb|woff2?|ttf|otf)|data:[^"'`]+?)\1/gi,
    async (match, quote, pth) => {
      const replaced = await processUri(pth, baseDir);
      return `${quote}${replaced}${quote}`;
    }
  );
  return jsText;
};

// Інлайн медіа-атрибутів у HTML: src, poster, data-src, background
const inlineHtmlMediaAttrs = async (html, basePath) => {
  const attrPatterns = [
    /\s(src)=["']([^"']+)["']/gi,
    /\s(poster)=["']([^"']+)["']/gi,
    /\s(data-src)=["']([^"']+)["']/gi,
    /\s(background)=["']([^"']+)["']/gi
  ];
  for (const pattern of attrPatterns) {
    html = await replaceAsync(html, pattern, async (_, attr, val) => {
      const replaced = await processUri(val, basePath);
      return ` ${attr}="${replaced}"`;
    });
  }
  return html;
};

// srcset
const inlineSrcset = async (html, basePath) => {
  return await replaceAsync(
    html,
    /\s(srcset)=["']([^"']+)["']/gi,
    async (_, attr, list) => {
      const items = list.split(',').map(s => s.trim()).filter(Boolean);
      const mapped = await Promise.all(items.map(async item => {
        const parts = item.split(/\s+/, 2);
        const url = parts[0];
        const descriptor = parts[1] || '';
        const replaced = await processUri(url, basePath);
        return `${replaced}${descriptor ? ' ' + descriptor : ''}`;
      }));
      return ` ${attr}="${mapped.join(', ')}"`;
    }
  );
};

// Інлайн <style>...</style> і style="..."
const inlineStylesEverywhere = async (html, basePath) => {
  // <style>...</style>
  html = await replaceAsync(
    html,
    /<style[^>]*>([\s\S]*?)<\/style>/gi,
    async (match, css) => {
      const newCss = await processCssContent(css, basePath);
      return match.replace(css, newCss);
    }
  );

  // style="..."
  html = await replaceAsync(
    html,
    /\sstyle=["']([^"']+)["']/gi,
    async (match, css) => {
      const newCss = await processCssContent(css, basePath);
      return match.replace(css, newCss);
    }
  );

  return html;
};

// Фінальний прохід: повторно стиснути ВСІ data:URI, що залишились у HTML
const reencodeAllDataUrisInHtml = async (html) => {
  return await replaceAsync(
    html,
    /(data:[^"'()\s<>]+;base64,[A-Za-z0-9+/=%-]+)/gi,
    async (match) => {
      // match — повний data:...
      const recoded = await reencodeDataUri(match);
      return recoded || match;
    }
  );
};

// Обережна «мінімізація» HTML (за бажанням)
const maybeMinifyHtml = (html) => {
  if (!CONFIG.html.minify) return html;
  // ⚠️ Дуже мʼяко: прибираємо HTML-коментарі (не чіпаємо скрипти/стилі), стискаємо проміжні пробіли між тегами
  html = html.replace(/<!--([\s\S]*?)-->/g, ''); // може вплинути на умовні коментарі IE (неактуально)
  html = html.replace(/>\s+</g, '><');
  return html;
};

// -------------------- PIPELINE --------------------
const inlineHtml = async () => {
  const result = await findFileRecursive(INPUT_FILE);
  if (!result) throw new Error(`❌ File "${INPUT_FILE}" not found in any subfolder`);
  const { basePath, fullPath } = result;

  // ✅ 0) Якщо режим optimizeOnly — стискаємо файли в папці і ВИХОДИМО
  if (!!FLAGS.optimizeOnly) {
    // assetsDir можна передавати як relative (відносно index.html) або absolute
    const assetsDirAbs = FLAGS.assetsDir
      ? (path.isAbsolute(FLAGS.assetsDir)
        ? FLAGS.assetsDir
        : path.resolve(basePath, FLAGS.assetsDir))
      : null;

    await optimizeAssetsFolderInPlace(assetsDirAbs);
    return; // 🚫 НЕ робимо інлайн HTML взагалі
  }

  // ---- нижче твій старий код інлайна ----
  const htmlFileName = path.basename(fullPath);
  let html = await fs.readFile(fullPath, 'utf8');

  html = await inlineCssLinks(html, basePath);
  html = await inlineJsScripts(html, basePath);
  html = await inlineHtmlMediaAttrs(html, basePath);
  html = await inlineSrcset(html, basePath);
  html = await inlineStylesEverywhere(html, basePath);
  html = await reencodeAllDataUrisInHtml(html);
  html = maybeMinifyHtml(html);

  await fs.mkdirp('dist');
  await fs.writeFile(path.join('dist', htmlFileName), html);

  const saved = totalOriginalSize - totalFinalSize;
  console.log(`\n🎉 One-file playable created at: dist/${htmlFileName}`);
  console.log(`📦 Total size: ${(totalFinalSize / 1024).toFixed(1)} KB (saved ${(saved / 1024).toFixed(1)} KB)`);
};
const decodeLocalPath = (u) => {
  const clean = String(u).split('#')[0].split('?')[0];
  try { return decodeURI(clean); } catch { return clean; }
};

// -------------------- RUN --------------------
inlineHtml().catch((e) => {
  console.error('❌ Build failed:', e);
  process.exitCode = 1;
});
