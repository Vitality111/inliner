# Inline Assets Builder

Build single-file HTML5 playables by bundling ES modules and inlining all assets as optimized data URIs.

## Features

- **ES Module Bundling** — Bundle JavaScript modules using esbuild
- **Asset Inlining** — Inline CSS, JS, images, fonts, video, audio, WASM, JSON, GLB as data URIs
- **Per-MIME Optimization** — Compress assets using sharp, ffmpeg, fontmin, gltfpack, gifsicle
- **Data URI Re-encoding** — Re-optimize existing data URIs in your HTML
- **External Resource Fetching** — Optionally fetch and inline HTTP/HTTPS resources
- **Asset Overrides** — Replace assets from a `dir/` folder with relative-path priority
- **Optimize-Only Mode** — Compress assets in-place without building HTML

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

### Minification

- `--minifyHtml` — Minify HTML output
- `--minifyCss` — Minify CSS
- `--minifyJs` — Minify JavaScript

### Image Optimization

- `--jpegQ=<0-100>` — JPEG quality (default: 50)
- `--webpQ=<0-100>` — WebP quality (default: 50)
- `--pngLevel=<0-9>` — PNG compression level (default: 1)
- `--pngQuality=<0-100>` — PNG quality (default: 50)
- `--pngPalette=<true|false>` — Use palette for PNG (default: true)
- `--gifLossy=<number>` — GIF lossy compression (default: 180)
- `--gifColors=<1-256>` — GIF color count (default: 48)

### Video Optimization

- `--codec=<codec>` — Video codec (default: libx264)
- `--crf=<0-51>` — Constant Rate Factor (default: 26)
- `--preset=<preset>` — Encoding preset (default: slow)
- `--tune=<film|animation|grain>` — Encoding tune
- `--maxWidth=<pixels>` — Max video width (default: 540)
- `--fps=<number>` — Target framerate
- `--twoPass` — Enable two-pass encoding
- `--targetMbps=<number>` — Target bitrate in Mbps
- `--maxRateFactor=<number>` — Max rate factor (default: 2.0)
- `--audioKbps=<number>` — Audio bitrate (default: 160)
- `--faststart=<true|false>` — Enable faststart (default: true)

### Audio Optimization

- `--mp3Kbps=<number>` — MP3 bitrate (default: 128)

### Font Optimization

- `--fontSubset=<string>` — Character subset for font optimization

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
npm run build <file>     # Build without minification
npm run optimize         # Optimize assets in ./assets folder
```

## License

MIT
