import test from 'node:test';
import assert from 'node:assert/strict';

import { findUninlinedAssetReferences } from '../src/validation.mjs';

const png = 'data:image/png;base64,iVBORw0KGgo=';

test('accepts inlined assets and ignores navigation URLs', () => {
    const html = `
        <a href="https://apps.apple.com/app/example">Install</a>
        <img src="${png}">
        <video data-port="data:video/mp4;base64,AAAA" data-land="data:video/mp4;base64,BBBB"></video>
        <style>.hero { background: url("${png}") }</style>
        <script>window.open('https://play.google.com/store/apps/details?id=test')</script>
    `;

    assert.deepEqual(findUninlinedAssetReferences(html), []);
});

test('reports unresolved HTML and CSS asset references', () => {
    const html = `
        <img src="assets/hero.png">
        <video data-port="https://cdn.example.com/portrait.mp4"></video>
        <link rel="stylesheet" href="styles/main.css">
        <div style="background-image:url('assets/card.webp')"></div>
        <style>@import "theme.css"; .icon { background: url(icons/a.svg) }</style>
    `;

    const issues = findUninlinedAssetReferences(html);
    assert.deepEqual(
        issues.map(({ location, attribute, value }) => ({ location, attribute, value })),
        [
            { location: '<style>', attribute: 'url()', value: 'icons/a.svg' },
            { location: '<style>', attribute: '@import', value: 'theme.css' },
            { location: '<img>', attribute: 'src', value: 'assets/hero.png' },
            { location: '<video>', attribute: 'data-port', value: 'https://cdn.example.com/portrait.mp4' },
            { location: '<link>', attribute: 'href', value: 'styles/main.css' },
            { location: '<div style>', attribute: 'url()', value: 'assets/card.webp' }
        ]
    );
});

test('checks each srcset candidate without splitting a base64 data URI', () => {
    const html = `<img srcset="${png} 1x, assets/hero@2x.png 2x">`;
    const issues = findUninlinedAssetReferences(html);

    assert.equal(issues.length, 1);
    assert.equal(issues[0].attribute, 'srcset');
    assert.equal(issues[0].value, 'assets/hero@2x.png');
});

test('does not scan HTML-looking strings inside scripts', () => {
    const html = `<script>const card = '<img src="assets/runtime.png">';</script>`;
    assert.deepEqual(findUninlinedAssetReferences(html), []);
});

test('reports empty static asset attributes but allows fragment and blob URLs', () => {
    const html = `<img src=""><svg><use src="#icon"></use></svg><video src="blob:runtime"></video>`;
    const issues = findUninlinedAssetReferences(html);

    assert.equal(issues.length, 1);
    assert.equal(issues[0].reason, 'empty');
});
