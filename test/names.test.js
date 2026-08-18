// names.test.js — unit tests for lib/names.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFilename, buildFilename, qualityToken } from '../lib/names.js';

test('sanitizeFilename: strips reserved characters', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('sanitizeFilename: collapses whitespace and trims', () => {
  assert.equal(sanitizeFilename('  My   Video\t\n  '), 'My Video');
});

test('sanitizeFilename: caps at 180 chars', () => {
  assert.equal(sanitizeFilename('x'.repeat(300)).length, 180);
});

test('sanitizeFilename: all-junk input -> empty string', () => {
  assert.equal(sanitizeFilename('  ///  '), '');
});

test('buildFilename: template substitution', () => {
  assert.equal(
    buildFilename('{title} - {quality}', { title: 'My Video', quality: '1080p', id: 'abc' }, 'mp4'),
    'My Video - 1080p.mp4');
  assert.equal(
    buildFilename('{id} - {title}', { title: 'My & Video', quality: '720p', id: 'x1' }, 'mp4'),
    'x1 - My & Video.mp4');
});

test('buildFilename: default template and empty-name fallback', () => {
  assert.equal(buildFilename(null, {}, 'mp4'), 'video - unknown.mp4');
  assert.equal(buildFilename('///', { title: '', quality: '', id: '' }, 'mp4'), 'video.mp4');
});

test('buildFilename: placeholders are case-insensitive and sanitized', () => {
  assert.equal(buildFilename('{TITLE} - {Quality} - {ID}', { title: 'A/B', quality: '720P', id: 'x:y' }, 'mp4'), 'A_B - 720P - x_y.mp4');
});

test('qualityToken: prefers height, then width, then kind', () => {
  assert.equal(qualityToken({ kind: 'hls', height: 1080, width: 1920 }), '1080p');
  assert.equal(qualityToken({ kind: 'mpd', width: 640 }), '640x?');
  assert.equal(qualityToken({ kind: 'direct' }), 'mp4');
  assert.equal(qualityToken({ kind: 'hls' }), 'hls');
});
