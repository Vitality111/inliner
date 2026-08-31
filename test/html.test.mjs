import test from 'node:test';
import assert from 'node:assert/strict';

import { inlineHtmlMediaAttrs } from '../src/processors/html.mjs';

const svg = (color) =>
    `data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20fill%3D%22${color}%22%2F%3E%3C%2Fsvg%3E`;

test('promotes an inlined img data-src when src is missing', async () => {
    const output = await inlineHtmlMediaAttrs(
        `<img class="card" data-src="${svg('red')}" alt="">`,
        process.cwd()
    );

    assert.match(output, /^<img src="data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(output, /\sdata-src=/i);
    assert.equal((output.match(/\ssrc=/gi) || []).length, 1);
});

test('replaces an empty img src with the inlined data-src', async () => {
    const output = await inlineHtmlMediaAttrs(
        `<img src="" data-src="${svg('blue')}" alt="">`,
        process.cwd()
    );

    assert.match(output, /\ssrc="data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(output, /\sdata-src=/i);
    assert.equal((output.match(/\ssrc=/gi) || []).length, 1);
});

test('keeps data-src when img already has a non-empty src', async () => {
    const output = await inlineHtmlMediaAttrs(
        `<img src="${svg('green')}" data-src="${svg('yellow')}" alt="">`,
        process.cwd()
    );

    assert.match(output, /\ssrc="data:image\/svg\+xml;base64,/);
    assert.match(output, /\sdata-src="data:image\/svg\+xml;base64,/);
});

test('inlines data-port and data-land without changing their names', async () => {
    const output = await inlineHtmlMediaAttrs(
        `<video data-port="${svg('black')}" data-land="${svg('white')}"></video>`,
        process.cwd()
    );

    assert.match(output, /\sdata-port="data:image\/svg\+xml;base64,/);
    assert.match(output, /\sdata-land="data:image\/svg\+xml;base64,/);
});
