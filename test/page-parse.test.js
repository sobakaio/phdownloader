// page-parse.test.js — unit tests for lib/page-parse.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPageData, extractJsVars, cleanUrl, urlKind,
  heightFromUrl, bitrateKFromUrl,
} from '../lib/page-parse.js';

// --- cleanUrl -------------------------------------------------------------

test('cleanUrl unescapes HTML entities and percent-encoding', () => {
  assert.equal(
    cleanUrl('https://cdn.example.com/v/1080P_a&amp;b%20c.mp4?x=1'),
    'https://cdn.example.com/v/1080P_a&b c.mp4?x=1');
});

test('cleanUrl rejects non-http and empty input', () => {
  assert.equal(cleanUrl('ftp://cdn.example.com/x.mp4'), null);
  assert.equal(cleanUrl(''), null);
  assert.equal(cleanUrl(null), null);
});

// --- extractJsVars ---------------------------------------------------------

test('extractJsVars handles concatenation and variable references', () => {
  const vars = extractJsVars(
    'var a = "foo";var b = a + "-bar";var c = \'x\' + \'y\';');
  assert.equal(vars.a, 'foo');
  assert.equal(vars.b, 'foo-bar');
  assert.equal(vars.c, 'xy');
});

test('extractJsVars skips non-assignments', () => {
  const vars = extractJsVars('var x = 1; if (y) { } var z = "q";');
  assert.equal(vars.x, '1');
  assert.equal(vars.z, 'q');
  assert.equal('if' in vars, false);
});

// --- extractPageData: flashvars (primary source) ---------------------------

const PREMIUM_PAGE = `<!doctype html>
<html><head>
<meta property="og:video" content="https://video1.phncdn.com/videos2/240P_480K_v1.mp4?validto=123">
</head><body>
<script>
var flashvars_42 = {"video_title":"My & Cool Video","video_duration":"420","mediaDefinitions":[{"videoUrl":"https://video1.phncdn.com/videos/1080P_5000K_aa.mp4?validto=999","quality":"1080","format":"mp4"},{"videoUrl":"https://video2.phncdn.com/videos/720P_3000K_bb.mp4","quality":"720","format":"mp4"},{"videoUrl":"https://site.pornhubpremium.com/video/get_media?videoId=abc","quality":"720"}]};
</script>
<script>
var media_1 = 'https://video3.phncdn.com/videos/540P_' + '1500K_cc.mp4';
var hlsMaster = "https://hls.phncdn.com/m/master.m3u8?tok=1";
</script>
<a class="downloadBtn" href="https://video1.phncdn.com/videos/dl_1080P.mp4?x=1">Download</a>
</body></html>`;

test('extractPageData reads flashvars mediaDefinitions + get_media', () => {
  const p = extractPageData(PREMIUM_PAGE);
  assert.equal(p.videoTitle, 'My & Cool Video');
  assert.equal(p.duration, 420);
  assert.equal(p.hasFlashvars, true);
  assert.equal(p.unavailable, null);
  assert.equal(p.getMediaUrl, 'https://site.pornhubpremium.com/video/get_media?videoId=abc');

  const cands = p.candidates;
  const c1080 = cands.find((c) => c.url.includes('1080P_5000K_aa'));
  const c720 = cands.find((c) => c.url.includes('720P_3000K_bb'));
  assert.ok(c1080 && c720);
  assert.equal(c1080.quality, 1080);
  assert.equal(c1080.source, 'mediaDefinitions');
  assert.equal(c720.quality, 720);
  // the get_media URL must NOT be a direct candidate
  assert.equal(cands.some((c) => c.url.includes('get_media')), false);
});

test('extractPageData picks up jsVars fallback, downloadBtn and og:video', () => {
  const p = extractPageData(PREMIUM_PAGE);
  const c540 = p.candidates.find((c) => c.url.includes('540P_1500K_cc'));
  assert.ok(c540, 'jsVars concat url present');
  assert.equal(c540.source, 'jsVars');
  assert.deepEqual(p.downloadUrls, ['https://video1.phncdn.com/videos/dl_1080P.mp4?x=1']);
  const cog = p.candidates.find((c) => c.url.includes('240P_480K_v1'));
  assert.ok(cog && cog.source === 'og:video');
  const cm3u8 = p.candidates.find((c) => c.url.includes('master.m3u8'));
  assert.ok(cm3u8 && cm3u8.source === 'scan');
});

test('extractPageData: noVideo section marks the page unavailable', () => {
  const html = '<html><body><section class="noVideo"><p>Video removed for violating our Terms of Service</p></section></body></html>';
  const p = extractPageData(html);
  assert.ok(p.unavailable.includes('Video removed'));
});

test('extractPageData: geoBlocked page', () => {
  const p = extractPageData('<html><div class="geoBlocked">blocked</div></html>');
  assert.ok(p.unavailable.includes('geo-blocked'));
});

test('extractPageData: empty input', () => {
  const p = extractPageData('');
  assert.equal(p.hasFlashvars, false);
  assert.equal(p.candidates.length, 0);
  assert.equal(p.unavailable, null);
});

// --- url helpers ------------------------------------------------------------

test('urlKind classifies by path extension', () => {
  assert.equal(urlKind('https://x.example.com/a.m3u8?token=1'), 'm3u8');
  assert.equal(urlKind('https://x.example.com/a.mpd?x=2#f'), 'mpd');
  assert.equal(urlKind('https://x.example.com/a.mp4'), 'direct');
});

test('heightFromUrl / bitrateKFromUrl parse PH-style URLs', () => {
  const u = 'https://cdn.example.com/v/1080P_4000K_abc.mp4';
  assert.equal(heightFromUrl(u), 1080);
  assert.equal(bitrateKFromUrl(u), 4000);
  assert.equal(heightFromUrl('https://x/a.mp4?height=720'), 720);
  assert.equal(heightFromUrl('https://x/a.mp4'), null);
  assert.equal(bitrateKFromUrl('https://x/240P_a.mp4'), null);
});
