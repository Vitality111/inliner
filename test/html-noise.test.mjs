import test from 'node:test';
import assert from 'node:assert/strict';

import { addDecoyHtmlClasses } from '../src/processors/html-noise.mjs';

const tokens = (...values) => {
    let index = 0;
    return () => values[index++];
};

test('adds decoy classes without replacing real classes', () => {
    const input = '<div class="card active"><span class="title">Hi</span></div>';
    const result = addDecoyHtmlClasses(input, {
        count: 2,
        tokenFactory: tokens('md:u-a1-p2', 'hover:u-b2-m3', 'lg:u-c3-gap4', 'sm:u-d4-row1')
    });

    assert.equal(
        result.html,
        '<div class="card active md:u-a1-p2 hover:u-b2-m3"><span class="title lg:u-c3-gap4 sm:u-d4-row1">Hi</span></div>'
    );
    assert.equal(result.addedClasses, 4);
    assert.equal(result.changedElements, 2);
});

test('does not add classes to elements without an existing class', () => {
    const input = '<main><div class="card"></div><p class="">Text</p></main>';
    const result = addDecoyHtmlClasses(input, {
        count: 1,
        tokenFactory: tokens('md:u-a1-p2')
    });

    assert.equal(result.html, '<main><div class="card md:u-a1-p2"></div><p class="">Text</p></main>');
});

test('does not modify JavaScript, CSS, comments, or HTML-looking JS strings', () => {
    const input = `<!-- class="comment" --><style>.card{color:red}</style><script>const html='<div class="runtime">';</script><div class="card"></div>`;
    const result = addDecoyHtmlClasses(input, {
        count: 1,
        tokenFactory: tokens('md:u-a1-p2')
    });

    assert.equal(
        result.html,
        `<!-- class="comment" --><style>.card{color:red}</style><script>const html='<div class="runtime">';</script><div class="card md:u-a1-p2"></div>`
    );
});

test('skips class noise when JavaScript reads className', () => {
    const input = `<script>if (card.className === 'card active') run();</script><div class="card active"></div>`;
    const result = addDecoyHtmlClasses(input, {
        count: 1,
        tokenFactory: tokens('md:u-a1-p2')
    });

    assert.equal(result.html, input);
    assert.match(result.skippedReason, /className/);
});

test('allows simple className assignments because they overwrite the noise safely', () => {
    const input = `<script>card.className = 'card active';</script><div class="card"></div>`;
    const result = addDecoyHtmlClasses(input, {
        count: 1,
        tokenFactory: tokens('md:u-a1-p2')
    });

    assert.equal(result.html, `<script>card.className = 'card active';</script><div class="card md:u-a1-p2"></div>`);
    assert.equal(result.skippedReason, null);
});

test('skips noise when CSS depends on the complete class attribute', () => {
    const input = `<style>[class="card active"]{color:red}</style><div class="card active"></div>`;
    const result = addDecoyHtmlClasses(input, {
        count: 1,
        tokenFactory: tokens('md:u-a1-p2')
    });

    assert.equal(result.html, input);
    assert.match(result.skippedReason, /CSS/);
});
