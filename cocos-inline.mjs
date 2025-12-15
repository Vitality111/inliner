#!/usr/bin/env node
/**
 * cocos-inline.mjs
 * ----------------
 * A Cocos Creator (Web Mobile) post-build packer focused on playable-ads style output.
 *
 * What it does:
 * 1) Reads build output folder (Cocos Web Mobile).
 * 2) Inlines local CSS and JS referenced by index.html (keeps order).
 * 3) Builds an asset manifest (url -> data URI) for Cocos-relevant asset types.
 * 4) Injects a runtime hook that intercepts fetch() + XMLHttpRequest to serve inlined assets.
 * 5) Optionally compresses images/audio/fonts BEFORE inlining (best-effort; requires tools installed).
 *
 * Output:
 * - By default generates ONE HTML file (everything inlined).
 *
 * Usage:
 *   node cocos-inline.mjs --input ./build/web-mobile --output ./playable.html
 *
 * Optional flags:
 *   --no-inline-js           Do not inline JS tags (keeps script src)
 *   --no-inline-css          Do not inline CSS links (keeps link href)
 *   --no-inline-assets       Do not inline assets (manifest hook not injected)
 *   --compress-images        Try compress images via sharp (if installed)
 *   --compress-audio         Try compress audio via ffmpeg (if available)
 *   --compress-fonts         Try subset/compress fonts via fontmin (if installed)
 *   --assets-include ".png,.jpg,.webp,.mp3,.ogg,.json,.bin,.wasm,.ttf,.woff2,.atlas,.skel"
 *   --verbose
 *
 * Notes:
 * - This script intentionally does NOT minify JS (you can do that upstream if you want).
 * - It assumes ALL referenced paths are local within the build folder.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_ASSET_EXTS = [
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".mp3", ".ogg", ".wav", ".m4a",
  ".json", ".bin", ".dat",
  ".wasm",
  ".ttf", ".otf", ".woff", ".woff2",
  ".atlas", ".skel",
  ".glb", ".gltf",
  ".txt"
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".dat": "application/octet-stream",
  ".atlas": "text/plain; charset=utf-8",
  ".skel": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".txt": "text/plain; charset=utf-8",
};

function parseArgs(argv) {
  const out = {
    input: null,
    output: "playable.html",
    inlineJs: true,
    inlineCss: true,
    inlineAssets: true,
    compressImages: false,
    compressAudio: false,
    compressFonts: false,
    assetsInclude: DEFAULT_ASSET_EXTS,
    verbose: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];

    if (a === "--input" && next) { out.input = next; i++; continue; }
    if (a === "--output" && next) { out.output = next; i++; continue; }

    if (a === "--no-inline-js") { out.inlineJs = false; continue; }
    if (a === "--no-inline-css") { out.inlineCss = false; continue; }
    if (a === "--no-inline-assets") { out.inlineAssets = false; continue; }

    if (a === "--compress-images") { out.compressImages = true; continue; }
    if (a === "--compress-audio") { out.compressAudio = true; continue; }
    if (a === "--compress-fonts") { out.compressFonts = true; continue; }

    if (a === "--assets-include" && next) {
      out.assetsInclude = next.split(",").map(s => s.trim()).filter(Boolean).map(s => s.startsWith(".") ? s : "." + s);
      i++;
      continue;
    }

    if (a === "--verbose") { out.verbose = true; continue; }
  }

  return out;
}

function log(opts, ...args) {
  if (opts.verbose) console.log(...args);
}

function normalizeUrl(u) {
  // Remove query/hash + convert backslashes to slashes
  let s = (u || "").trim();
  // ignore remote URLs and data URIs
  if (/^(https?:)?\/\//i.test(s) || /^data:/i.test(s)) return null;
  // ignore blob:
  if (/^blob:/i.test(s)) return null;

  const q = s.indexOf("?");
  const h = s.indexOf("#");
  const cut = Math.min(q === -1 ? Infinity : q, h === -1 ? Infinity : h);
  if (cut !== Infinity) s = s.slice(0, cut);

  s = s.replaceAll("\\", "/");

  // Strip leading /
  if (s.startsWith("/")) s = s.slice(1);

  // Vite-like './'
  if (s.startsWith("./")) s = s.slice(2);

  if (!s) return null;
  return s;
}

async function fileExists(p) {
  try { await fsp.access(p, fs.constants.F_OK); return true; }
  catch { return false; }
}

async function readText(p) {
  return await fsp.readFile(p, "utf8");
}

async function readBin(p) {
  return await fsp.readFile(p);
}

function toDataUri(ext, buf) {
  const mime = MIME[ext.toLowerCase()] || "application/octet-stream";
  const b64 = Buffer.from(buf).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await fsp.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

/**
 * Best-effort compressions.
 * These are optional and only run if dependencies are available.
 */
async function tryLoadSharp() {
  try {
    const mod = await import("sharp");
    return mod.default || mod;
  } catch {
    return null;
  }
}

async function tryLoadFontmin() {
  try {
    const mod = await import("fontmin");
    return mod.default || mod;
  } catch {
    return null;
  }
}

async function canRun(cmd) {
  try {
    const { stdout } = await execFileAsync(cmd, ["-version"]);
    return !!stdout;
  } catch {
    return false;
  }
}

async function compressImageIfPossible(opts, sharp, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!sharp) return false;
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return false;

  const input = await readBin(filePath);
  const s = sharp(input, { failOn: "none" });

  let outBuf = null;

  if (ext === ".png") {
    // Lossless-ish PNG optimization
    outBuf = await s.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  } else if (ext === ".jpg" || ext === ".jpeg") {
    outBuf = await s.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  } else if (ext === ".webp") {
    outBuf = await s.webp({ quality: 82 }).toBuffer();
  }

  if (outBuf && outBuf.length && outBuf.length < input.length) {
    await fsp.writeFile(filePath, outBuf);
    log(opts, `🖼️  Compressed image: ${path.basename(filePath)} (${input.length} -> ${outBuf.length})`);
    return true;
  }
  return false;
}

async function compressAudioIfPossible(opts, ffmpegOk, filePath) {
  if (!ffmpegOk) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (![".mp3", ".ogg", ".wav", ".m4a"].includes(ext)) return false;

  // Re-encode to mp3/ogg with modest bitrate (playable-friendly). Keep original extension by default.
  // We'll output to temp file, then replace if smaller.
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, ext);
  const tmp = path.join(dir, `${base}.__tmp${ext}`);

  const inputSize = (await fsp.stat(filePath)).size;

  try {
    if (ext === ".mp3" || ext === ".m4a" || ext === ".wav") {
      await execFileAsync("ffmpeg", ["-y", "-i", filePath, "-vn", "-b:a", "96k", "-ar", "44100", tmp], { windowsHide: true });
    } else if (ext === ".ogg") {
      await execFileAsync("ffmpeg", ["-y", "-i", filePath, "-vn", "-c:a", "libvorbis", "-q:a", "4", tmp], { windowsHide: true });
    }
    const outSize = (await fsp.stat(tmp)).size;
    if (outSize > 0 && outSize < inputSize) {
      await fsp.rename(tmp, filePath);
      log(opts, `🔊 Compressed audio: ${path.basename(filePath)} (${inputSize} -> ${outSize})`);
      return true;
    }
  } catch (e) {
    log(opts, `⚠️  Audio compress failed for ${filePath}: ${String(e?.message || e)}`);
  }

  // cleanup temp
  try { if (await fileExists(tmp)) await fsp.unlink(tmp); } catch {}
  return false;
}

async function compressFontsIfPossible(opts, Fontmin, fontFiles) {
  if (!Fontmin) return false;
  const ttf = fontFiles.filter(f => [".ttf", ".otf"].includes(path.extname(f).toLowerCase()));
  if (!ttf.length) return false;

  // Font subsetting needs text; we keep it simple and only minify container if possible.
  // If you want aggressive subsetting, extend this to accept a charset file/string.
  let did = false;
  await Promise.all(ttf.map(async (f) => {
    try {
      const dir = path.dirname(f);
      const outDir = dir; // in-place
      const fm = new Fontmin().src(f).dest(outDir);
      // Some Fontmin plugins are optional; we try common ones.
      try {
        const ttf2woff2 = (await import("fontmin-ttf2woff2")).default;
        fm.use(ttf2woff2());
      } catch {}
      try {
        const ttf2woff = (await import("fontmin-ttf2woff")).default;
        fm.use(ttf2woff());
      } catch {}
      await new Promise((resolve, reject) => fm.run((err) => err ? reject(err) : resolve()));
      did = true;
      log(opts, `🔤 Processed font: ${path.basename(f)}`);
    } catch (e) {
      log(opts, `⚠️  Font process failed for ${f}: ${String(e?.message || e)}`);
    }
  }));
  return did;
}

function buildFetchHook(manifestJson) {
  // Intercepts fetch + XHR for URLs present in manifest.
  // Returns a Response with correct content-type; supports arrayBuffer, text, json, etc.
  // Also supports .wasm / .bin via arrayBuffer.
  return `
<script>
/** COCOS INLINE MANIFEST HOOK **/
(() => {
  const __MANIFEST = ${manifestJson};

  const normalize = (url) => {
    try {
      // url may be Request, absolute URL, or relative path
      const u = (typeof url === "string") ? url : (url && url.url) ? url.url : String(url);
      // strip origin
      const noOrigin = u.replace(location.origin, "");
      // drop query/hash
      const q = noOrigin.indexOf("?");
      const h = noOrigin.indexOf("#");
      const cut = Math.min(q === -1 ? 1e9 : q, h === -1 ? 1e9 : h);
      let p = (cut >= 1e9) ? noOrigin : noOrigin.slice(0, cut);
      p = p.replace(/\\\\/g, "/");
      if (p.startsWith("/")) p = p.slice(1);
      if (p.startsWith("./")) p = p.slice(2);
      return p;
    } catch {
      return null;
    }
  };

  const dataUriToResponse = async (dataUri, key) => {
    const comma = dataUri.indexOf(",");
    const header = dataUri.slice(0, comma);
    const b64 = dataUri.slice(comma + 1);
    const mimeMatch = /data:([^;]+);base64/i.exec(header);
    const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
    return new Response(bin, { status: 200, headers: { "Content-Type": mime, "X-Inline": "1", "X-Inline-Key": key }});
  };

  // fetch hook
  const _fetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const key = normalize(input);
    if (key && __MANIFEST[key]) {
      return dataUriToResponse(__MANIFEST[key], key);
    }
    return _fetch(input, init);
  };

  // XHR hook (covers some older Cocos loaders)
  const XHR = window.XMLHttpRequest;
  function InlineXHR() {
    const xhr = new XHR();
    let _url = null;
    const _open = xhr.open;
    xhr.open = function(method, url, ...rest) {
      _url = url;
      return _open.call(this, method, url, ...rest);
    };
    const _send = xhr.send;
    xhr.send = function(body) {
      const key = normalize(_url);
      if (key && __MANIFEST[key]) {
        // emulate async XHR
        const self = this;
        const responseType = self.responseType;
        Promise.resolve().then(async () => {
          const res = await dataUriToResponse(__MANIFEST[key], key);
          const buf = await res.arrayBuffer();
          Object.defineProperty(self, "status", { value: 200 });
          Object.defineProperty(self, "readyState", { value: 4 });
          Object.defineProperty(self, "responseURL", { value: _url });
          if (responseType === "arraybuffer" || responseType === "blob") {
            Object.defineProperty(self, "response", { value: buf });
          } else {
            const text = new TextDecoder("utf-8").decode(new Uint8Array(buf));
            Object.defineProperty(self, "responseText", { value: text });
            Object.defineProperty(self, "response", { value: text });
          }
          if (typeof self.onload === "function") self.onload();
          if (typeof self.onreadystatechange === "function") self.onreadystatechange();
        });
        return;
      }
      return _send.call(this, body);
    };
    return xhr;
  }
  window.XMLHttpRequest = InlineXHR;
})();
</script>
`.trim();
}

async function inlineHtml(opts) {
  if (!opts.input) {
    console.error("❌ Missing --input <cocos build dir>");
    process.exit(1);
  }

  const buildDir = path.resolve(process.cwd(), opts.input);
  const indexPath = path.join(buildDir, "index.html");
  if (!(await fileExists(indexPath))) {
    console.error(`❌ index.html not found: ${indexPath}`);
    process.exit(1);
  }

  // Optional compression pass (best-effort)
  const sharp = opts.compressImages ? await tryLoadSharp() : null;
  const ffmpegOk = opts.compressAudio ? await canRun("ffmpeg") : false;
  const Fontmin = opts.compressFonts ? await tryLoadFontmin() : null;

  if (opts.compressImages && !sharp) console.warn("⚠️  sharp not installed; skipping image compression");
  if (opts.compressAudio && !ffmpegOk) console.warn("⚠️  ffmpeg not available; skipping audio compression");
  if (opts.compressFonts && !Fontmin) console.warn("⚠️  fontmin not installed; skipping font compression");

  // Collect files for optional compression & for manifest
  const allFiles = await walk(buildDir);

  // Compression
  if (opts.compressImages && sharp) {
    for (const f of allFiles) await compressImageIfPossible(opts, sharp, f);
  }
  if (opts.compressAudio && ffmpegOk) {
    for (const f of allFiles) await compressAudioIfPossible(opts, ffmpegOk, f);
  }
  if (opts.compressFonts && Fontmin) {
    await compressFontsIfPossible(opts, Fontmin, allFiles);
  }

  // Build manifest
  const includeSet = new Set(opts.assetsInclude.map(e => e.toLowerCase()));
  const manifest = {};

  if (opts.inlineAssets) {
    for (const f of allFiles) {
      const rel = path.relative(buildDir, f).replaceAll("\\", "/");
      const ext = path.extname(f).toLowerCase();
      if (!includeSet.has(ext)) continue;

      // Skip already-inlined output if re-running
      if (rel === path.basename(opts.output)) continue;

      const buf = await readBin(f);
      manifest[rel] = toDataUri(ext, buf);
    }
    log(opts, `🧾 Manifest entries: ${Object.keys(manifest).length}`);
  }

  // Read index.html
  let html = await readText(indexPath);

  // Ensure script paths are relative-friendly (remove leading /)
  html = html.replace(/(<script\b[^>]*\bsrc=["'])\/([^"']+)(["'][^>]*>\s*<\/script>)/gi, "$1$2$3");
  html = html.replace(/(<link\b[^>]*\bhref=["'])\/([^"']+)(["'][^>]*>)/gi, "$1$2$3");

  // Inline CSS links
  if (opts.inlineCss) {
    html = await inlineCssLinks(html, buildDir, opts);
  }

  // Inline script src
  if (opts.inlineJs) {
    html = await inlineScriptSrc(html, buildDir, opts);
  }

  // Inject fetch/XHR hook (before first script tag is safest)
  if (opts.inlineAssets) {
    const hook = buildFetchHook(JSON.stringify(manifest));
    html = injectBeforeFirstScript(html, hook);
  }

  // Write output
  const outPath = path.resolve(process.cwd(), opts.output);
  await fsp.writeFile(outPath, html, "utf8");
  console.log(`✅ Wrote: ${outPath}`);
}

function injectBeforeFirstScript(html, snippet) {
  const idx = html.search(/<script\b/i);
  if (idx === -1) {
    // fallback: inject before </body>
    return html.replace(/<\/body>/i, `${snippet}\n</body>`);
  }
  return html.slice(0, idx) + snippet + "\n" + html.slice(idx);
}

async function inlineCssLinks(html, baseDir, opts) {
  // Replace <link rel="stylesheet" href="..."> with <style>...</style>
  const linkRe = /<link\b([^>]*?)rel=["']stylesheet["']([^>]*?)>/gi;

  let result = "";
  let last = 0;
  let m;

  while ((m = linkRe.exec(html)) !== null) {
    const full = m[0];
    const start = m.index;
    const end = linkRe.lastIndex;

    // find href
    const hrefMatch = /href=["']([^"']+)["']/i.exec(full);
    const hrefRaw = hrefMatch ? hrefMatch[1] : null;
    const href = normalizeUrl(hrefRaw);
    const abs = href ? path.resolve(baseDir, href) : null;

    result += html.slice(last, start);

    if (href && abs && await fileExists(abs)) {
      const css = await readText(abs);
      result += `<style>\n${css}\n</style>`;
      log(opts, `🎨 Inlined CSS: ${href}`);
    } else {
      // keep if can't inline
      result += full;
      if (hrefRaw) log(opts, `⚠️  CSS not found for inline: ${hrefRaw}`);
    }

    last = end;
  }

  result += html.slice(last);
  return result;
}

async function inlineScriptSrc(html, baseDir, opts) {
  // Replace <script src="..."></script> with <script>...</script>, preserving other attributes except src.
  const scriptRe = /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi;

  let result = "";
  let last = 0;
  let m;

  while ((m = scriptRe.exec(html)) !== null) {
    const [full, preAttrs, srcRaw, postAttrs] = m;
    const start = m.index;
    const end = scriptRe.lastIndex;

    const src = normalizeUrl(srcRaw);
    const abs = src ? path.resolve(baseDir, src) : null;

    result += html.slice(last, start);

    if (src && abs && await fileExists(abs)) {
      const js = await readText(abs);

      // Remove type="module" if present (playable-friendly)
      const attrs = `${preAttrs} ${postAttrs}`
        .replace(/\btype=["']module["']/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      result += `<script${attrs ? " " + attrs : ""}>\n${js}\n</script>`;
      log(opts, `📦 Inlined JS: ${src}`);
    } else {
      result += full;
      log(opts, `⚠️  JS not found for inline: ${srcRaw}`);
    }

    last = end;
  }

  result += html.slice(last);
  return result;
}

(async () => {
  const opts = parseArgs(process.argv);
  await inlineHtml(opts);
})();
