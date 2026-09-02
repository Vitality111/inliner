# Inline Assets Builder

Build single-file HTML5 playables by bundling ES modules and inlining all assets as optimized data URIs.

## Features

- **ES Module Bundling** — Bundle JavaScript modules using esbuild
- **Asset Inlining** — Inline CSS, JS, images, fonts, video, audio, WASM, JSON, GLB as data URIs
- **Per-MIME Optimization** — Compress assets using sharp, pngquant, ffmpeg, subset-font, gltfpack, gifsicle
- **Interactive Mode** — Choose which files to compress with `--interactive` flag
- **Data URI Re-encoding** — Re-optimize existing data URIs in your HTML
- **External Resource Fetching** — Optionally fetch and inline HTTP/HTTPS resources
- **Asset Overrides** — Replace assets from a `dir/` folder with relative-path priority
- **Optimize-Only Mode** — Compress assets in-place without building HTML
- **Warn-Only Preflight** — Report static asset URLs that remain non-inlined without blocking the build
- **Asset Report & Budget** — Per-asset size table after every build; `--budget=<KB>` warns when the output exceeds the network limit
- **Lossy Re-encode Guard** — JPEG/WebP/audio are only re-encoded when the gain is real (`--minGain`), so rebuilds don't degrade quality generation after generation

## Requirements

- Node.js 18+
- **ffmpeg** in PATH (required for video/audio optimization)

### Optional System Dependencies

For advanced optimization, install these tools:

**gifsicle** (for GIF optimization):

```bash
# Windows (via Chocolatey)
choco install gifsicle

# macOS
brew install gifsicle

# Linux (Ubuntu/Debian)
sudo apt-get install gifsicle
```

**gltfpack** (for GLB/GLTF optimization):

```bash
# Download from: https://github.com/zeux/meshoptimizer/releases
# Extract and add to PATH
```

## Installation

```bash
npm install
```

## Usage

### Basic Build

```bash
node inline.mjs index.html
```

### With Minification

```bash
node inline.mjs index.html --minifyJs --minifyCss --minifyHtml
```

### Minification With HTML Class Noise

Adds random inactive classes to elements that already have classes. Existing
HTML classes, CSS rules, and JavaScript are not renamed or rewritten.

```bash
npm run codeCSS index.html
```

### Fetch External Resources

```bash
node inline.mjs index.html --fetchExternals
```

### Optimize Assets Only (No HTML Build)

```bash
node inline.mjs --optimizeOnly --assetsDir=assets
```

## CLI Flags

### General

- `--fetchExternals` — Fetch and inline HTTP/HTTPS resources
- `--optimizeOnly` — Only optimize assets in `--assetsDir`, skip HTML build
- `--assetsDir=<path>` — Path to assets folder (for optimize-only mode)
- `--interactive` or `--i` — Interactive mode: choose which files to compress
- `--codeCSS` — Add two random inactive classes to each element that already has a class
- `--budget=<KB>` — Size budget for the final HTML; prints a warning with the biggest asset when exceeded (default: none)
- `--minGain=<0-100>` — Minimum % saving required to accept a lossy re-encode of JPEG/WebP/audio (default: 10). `0` = accept any smaller result

> The input HTML is searched recursively from the parent of the `inliner/` folder. `node_modules`, `.git`, `dist` and `bin` are skipped, so a previous build in `dist/` can never be picked up as the source.

### Interactive Mode

Enable interactive mode to manually select which assets to compress:

```bash
npm run minify index.html -- --interactive
```

You'll be prompted for each file:
```
🎛️  Interactive mode enabled. Options: [y]es, [n]o, [a]ll auto, [s]kip all

🖼️  bg.png (448 KB) - Compress? [y/n/a/s]: y
✅ bg.png: 458375 → 40332 bytes (91.2% saved)

🎵  music.mp3 (1.2 MB) - Compress? [y/n/a/s]: n
✅ music.mp3: 1258000 → 1258000 bytes (0.0% saved)

🎬  video.mp4 (2.5 MB) - Compress? [y/n/a/s]: a
   ➡️  Auto mode: compressing all remaining files
```

**Options:**
- `y` (or Enter) — Compress this file
- `n` — Skip compression, keep original
- `a` — Auto: compress all remaining files automatically
- `s` — Skip: don't compress any remaining files

**File type icons:**
- 🖼️ Images (PNG, JPG, WebP)
- 🎞️ GIF animations
- 🎵 Audio (MP3, WAV, M4A, OGG)
- 🎬 Video (MP4, WebM)
- 🔤 Fonts (WOFF, TTF, OTF)
- 🎮 3D models (GLB)
- 📦 Other files

### Minification

- `--minifyHtml` — Minify HTML output
- `--minifyCss` — Minify CSS
- `--minifyJs` — Minify JavaScript

### Image Optimization

- `--jpegQ=<0-100>` — JPEG quality with mozjpeg optimization (default: 70)
- `--webpQ=<0-100>` — WebP quality with high-effort encoding (default: 72)
- `--pngLevel=<1-11>` — pngquant speed, 1=best/slow, 11=fast/worse (default: 3)
- `--pngQuality=<0-100>` — **Minimum** acceptable PNG quality (lower bound of pngquant `--quality`). If pngquant can't reach it, a lossless sharp fallback is used. `100` = lossless only (default: 80)
- `--pngTarget=<1-100>` — **Target** PNG quality (upper bound). This is what controls the palette: pngquant keeps the *fewest* colors needed to reach the target, so `80` can collapse a photo to 10–20 colors even with `--pngColors=256`. `100` keeps the palette intact (default: 100)
- `--pngColors=<2-256>` — Hard cap on palette size; use this (not `--pngTarget`) to trade size for color depth (default: 256)
- `--pngPalette=<true|false>` — Disable dithering (`--nofs`) for smaller size (default: false)
- `--gifLossy=<number>` — GIF lossy compression (default: 120)
- `--gifColors=<1-256>` — GIF color count (default: 128)

### Video Optimization

- `--codec=<codec>` — Video codec (default: libx264)
- `--crf=<0-51>` — Constant Rate Factor (default: 26)
- `--preset=<preset>` — Encoding preset (default: slow)
- `--tune=<film|animation|grain>` — Encoding tune
- `--maxWidth=<pixels>` — Max video width (default: 500)
- `--fps=<number>` — Target framerate
- `--twoPass` — Enable two-pass encoding
- `--targetMbps=<number>` — Target bitrate in Mbps
- `--maxRateFactor=<number>` — Max rate factor (default: 2.0)
- `--audioKbps=<number>` — Audio bitrate of the video track (default: 128)
- `--faststart=<true|false>` — Enable faststart (default: true)

### Audio Optimization

Audio is re-encoded in its own container (MP3→MP3, OGG→OGG, M4A→M4A; WAV→MP3). If the source bitrate is already at or below the target, the re-encode is skipped to avoid an extra generation of loss.

- `--mp3Kbps=<number>` — Target audio bitrate (default: 48, paired with mono)
- `--audioMono=<true|false>` — Downmix to mono (`-ac 1`). Mono 48k holds up better on loud intros than hissy stereo 64k and is ~25% smaller, so it is the default. To get stereo back: `--audioMono=false --mp3Kbps=64` (default: on)

### Font Optimization

Fonts are subset to the characters actually used. The character set is collected from **every** text file in the project folder (HTML, CSS, JS/TS modules, JSON locales, TXT, SVG), plus upper/lower-case pairs, basic punctuation/digits and an extended-Latin safety list. `node_modules`, `dist`, `bin` and `dir/` are skipped.

- `--fontSubset=<string>` — Explicit character subset (disables auto-detection)
- `--optimizeFonts=<true|false>` — Enable/disable font subsetting (default: true)
- `--fontFormat=<woff2|woff|preserve>` — Output format when inlining; MIME and `format()` in `@font-face` are updated accordingly (default: woff2)

### GLB Optimization

- `--glbSi=<number>` — GLB simplification ratio (default: 1.0)

## Asset Override System

Place assets in a `dir/` folder next to your HTML file to override originals:

```
project/
├── index.html
├── assets/
│   └── logo.png
└── dir/
    └── logo.png  ← This will be used instead
```

**Priority:**

1. Relative path match: `dir/assets/logo.png`
2. Basename fallback: `dir/logo.png`

## Examples

### Build Playable with Full Optimization

```bash
npm run minify index.html
```

### Optimize Assets Folder

```bash
node inline.mjs --optimizeOnly --assetsDir=./assets
```

### Custom Video Settings

```bash
node inline.mjs index.html --codec=libx264 --crf=28 --maxWidth=720 --twoPass
```

## Output

Generates `dist/<filename>.html` with all assets inlined and optimized.

## NPM Scripts

```bash
npm run minify <file>    # Build with full minification
npm run codeCSS <file>   # Minify and add random inactive HTML classes
npm run build <file>     # Build without minification
npm run optimize         # Optimize assets in ./assets folder
```

## Dependencies

### Required (installed via npm)
- `esbuild` — JavaScript bundling
- `sharp` — Image optimization (JPEG, PNG, WebP)
- `fluent-ffmpeg` — Video/audio processing
- `subset-font` — Font subsetting (harfbuzz)
- `lightningcss` — CSS minification
- `terser` — Used only by the legacy standalone scripts (`jsm.mjs`, `minify-js.mjs`)
- `fs-extra` — File system utilities

### Optional (installed via npm)
- `pngquant-bin` — Lossy PNG compression (great for gradients)
- `gifsicle` — GIF optimization
- `gltfpack` — GLB/GLTF optimization

## License

MIT
