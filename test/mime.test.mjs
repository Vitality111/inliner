import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detectMimeFromBuffer } from '../src/mime.mjs';
import { encodeFile, reencodeDataUri } from '../src/encoder.mjs';

const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);

test('corrects an extension MIME when magic bytes identify PNG', () => {
    assert.equal(detectMimeFromBuffer(onePixelPng, 'image/jpeg'), 'image/png');
});

test('detects SVG after an XML declaration and comment', () => {
    const svg = Buffer.from('<?xml version="1.0"?><!-- icon --><svg xmlns="http://www.w3.org/2000/svg"></svg>');
    assert.equal(detectMimeFromBuffer(svg, 'application/octet-stream'), 'image/svg+xml');
});

test('distinguishes an M4A brand from video MP4', () => {
    const m4a = Buffer.alloc(16);
    m4a.writeUInt32BE(16, 0);
    m4a.write('ftyp', 4, 'ascii');
    m4a.write('M4A ', 8, 'ascii');
    assert.equal(detectMimeFromBuffer(m4a, 'video/mp4'), 'audio/mp4');
});

test('keeps fallback MIME for unknown content', () => {
    assert.equal(detectMimeFromBuffer(Buffer.from('plain text'), 'text/plain'), 'text/plain');
});

test('repairs a wrong MIME in an existing data URI', async () => {
    const wrong = `data:image/jpeg;base64,${onePixelPng.toString('base64')}`;
    const output = await reencodeDataUri(wrong);
    assert.match(output, /^data:image\/png;base64,/);
});

test('encodes a local file using its content MIME instead of a wrong extension', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inliner-mime-test-'));
    const misleadingPath = path.join(tempDir, 'pixel.jpg');

    try {
        await fs.writeFile(misleadingPath, onePixelPng);
        const output = await encodeFile(misleadingPath);
        assert.match(output, /^data:image\/png;base64,/);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
