// m3u8.test.js — unit tests for lib/m3u8.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U8, parseAttrs, pickVariant } from '../lib/m3u8.js';

// --- parseAttrs ------------------------------------------------------------

test('parseAttrs: quoted values may contain commas/spaces', () => {
  const a = parseAttrs('BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.640020, mp4a.40.2"');
  assert.equal(a.BANDWIDTH, '3000000');
  assert.equal(a.RESOLUTION, '1280x720');
  assert.equal(a.CODECS, 'avc1.640020, mp4a.40.2');
});

// --- master playlist --------------------------------------------------------

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.640020"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,URI="1080p/index.m3u8?token=abc"
#EXT-X-STREAM-INF:BANDWIDTH=1000000
low.m3u8
`;
const MASTER_BASE = 'https://cdn.example.com/hls/master.m3u8';

test('parseM3U8: master with next-line and attribute URIs, relative resolution', () => {
  const p = parseM3U8(MASTER, MASTER_BASE);
  assert.equal(p.isMaster, true);
  assert.equal(p.variants.length, 3);

  const v0 = p.variants[0];
  assert.equal(v0.url, 'https://cdn.example.com/hls/720p/index.m3u8');
  assert.equal(v0.bandwidth, 3000000);
  assert.equal(v0.width, 1280);
  assert.equal(v0.height, 720);
  assert.equal(v0.codecs, 'avc1.640020');

  const v1 = p.variants[1];
  assert.equal(v1.url, 'https://cdn.example.com/hls/1080p/index.m3u8?token=abc');
  assert.equal(v1.bandwidth, 5000000);
  assert.equal(v1.height, 1080);

  const v2 = p.variants[2];
  assert.equal(v2.url, 'https://cdn.example.com/hls/low.m3u8');
  assert.equal(v2.bandwidth, 1000000);
  assert.equal(v2.height, null);
});

// --- media playlist ----------------------------------------------------------

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:5.996,
seg-00001.mp4
#EXTINF:6.000,
seg-00002.mp4
#EXT-X-ENDLIST
`;

test('parseM3U8: media playlist with fMP4 init, segments, endlist', () => {
  const p = parseM3U8(MEDIA, 'https://cdn.example.com/vod/720p/index.m3u8');
  assert.equal(p.isMaster, false);
  assert.equal(p.isFmp4, true);
  assert.equal(p.initUrl, 'https://cdn.example.com/vod/720p/init.mp4');
  assert.equal(p.targetDuration, 6);
  assert.equal(p.endList, true);
  assert.equal(p.segments.length, 2);
  assert.equal(p.segments[0].url, 'https://cdn.example.com/vod/720p/seg-00001.mp4');
  assert.ok(Math.abs(p.segments[0].duration - 5.996) < 1e-9);
  assert.equal(p.segments[1].url, 'https://cdn.example.com/vod/720p/seg-00002.mp4');
  assert.equal(p.segments[1].duration, 6);
});

test('parseM3U8: bare URI line without tags is a segment', () => {
  const p = parseM3U8('#EXTM3U\nseg1.ts\nseg2.ts\n', 'https://cdn.example.com/v/');
  assert.equal(p.segments.length, 2);
  assert.equal(p.segments[0].url, 'https://cdn.example.com/v/seg1.ts');
});

test('parseM3U8: non-playlist input yields empty result', () => {
  const p = parseM3U8('<html>not a playlist</html>', 'https://x/');
  assert.equal(p.isMaster, false);
  assert.equal(p.variants.length, 0);
  assert.equal(p.segments.length, 0);
});

// --- pickVariant -------------------------------------------------------------

const VARIANTS = [
  { url: 'a.m3u8', bandwidth: 1000000, width: 854, height: 480, codecs: null, frameRate: null },
  { url: 'b.m3u8', bandwidth: 3000000, width: 1280, height: 720, codecs: null, frameRate: null },
  { url: 'c.m3u8', bandwidth: 5000000, width: 1920, height: 1080, codecs: null, frameRate: null },
];
const ParsedMaster = { isMaster: true, variants: VARIANTS };

test('pickVariant: by exact URL', () => {
  assert.equal(pickVariant(ParsedMaster, 'c.m3u8').url, 'c.m3u8');
});

test('pickVariant: by format descriptor (bandwidth first)', () => {
  assert.equal(pickVariant(ParsedMaster, { bandwidth: 3000000 }).url, 'b.m3u8');
});

test('pickVariant: by format descriptor (height when no bandwidth)', () => {
  assert.equal(pickVariant(ParsedMaster, { height: 480 }).url, 'a.m3u8');
});

test('pickVariant: closest height when nothing matches exactly', () => {
  // 960p requested: |1080-960|=120 < |720-960|=240 < |480-960|=480
  assert.equal(pickVariant(ParsedMaster, { bandwidth: 999, height: 960 }).url, 'c.m3u8');
});

test('pickVariant: falls back to highest bandwidth', () => {
  assert.equal(pickVariant(ParsedMaster, null).url, 'c.m3u8');
  assert.equal(pickVariant(ParsedMaster, { bandwidth: 1 }).url, 'c.m3u8');
});

test('pickVariant: no variants -> null', () => {
  assert.equal(pickVariant({ isMaster: true, variants: [] }, 'x'), null);
  assert.equal(pickVariant(null, 'x'), null);
});

// Regression: a user-selected quality from a multi-variant master must map
// back to THAT variant — never silently upgrade to the highest bandwidth.
test('pickVariant: selected 720p/3000kbps format resolves to the 720p variant', () => {
  const chosen = { kind: 'hls', masterUrl: MASTER_BASE, variantUrl: null, bandwidth: 3000000, height: 720 };
  const v = pickVariant(ParsedMaster, chosen);
  assert.equal(v.url, 'b.m3u8');
  assert.equal(v.height, 720);
});
