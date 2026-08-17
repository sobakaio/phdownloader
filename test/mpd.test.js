// mpd.test.js — unit tests for lib/mpd.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMPD } from '../lib/mpd.js';

const BASE = 'https://dash.example.com/vod/';

test('parseMPD: static BaseURL (whole file)', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" duration="60">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>v1080.mp4?token=tok</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const p = parseMPD(xml, BASE);
  assert.equal(p.error, null);
  assert.equal(p.video.length, 1);
  assert.equal(p.audio.length, 0);
  const t = p.video[0];
  assert.equal(t.id, 'v1080');
  assert.equal(t.mode, 'static');
  assert.equal(t.url, 'https://dash.example.com/vod/v1080.mp4?token=tok');
  assert.equal(t.height, 1080);
  assert.equal(t.bandwidth, 5000000);
  assert.equal(t.hasVideo, true);
});

test('parseMPD: SegmentTemplate $Number$ with timescale/duration', () => {
  const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" duration="60">
  <Period>
    <AdaptationSet contentType="video">
      <SegmentTemplate timescale="1000" duration="2000" startNumber="2"
                       initialization="init_$RepresentationID$.mp4"
                       media="seg_$RepresentationID$_$Number$.m4s"/>
      <Representation id="r1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const p = parseMPD(xml, BASE);
  assert.equal(p.error, null);
  const t = p.video[0];
  assert.equal(t.mode, 'segments');
  assert.equal(t.init, 'https://dash.example.com/vod/init_r1080.mp4');
  // 60 s / (2000 ticks / 1000 timescale = 2 s) = 30 segments, starting at 2
  assert.equal(t.segments.length, 30);
  assert.equal(t.segments[0], 'https://dash.example.com/vod/seg_r1080_2.m4s');
  assert.equal(t.segments[29], 'https://dash.example.com/vod/seg_r1080_31.m4s');
});

test('parseMPD: SegmentTemplate $Time$ with SegmentTimeline repeats', () => {
  const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" duration="10">
  <Period>
    <AdaptationSet contentType="video">
      <SegmentTemplate timescale="90000" initialization="init.m4s" media="seg_$Time$.m4s">
        <SegmentTimeline>
          <S t="0" d="90000" r="4"/>
          <S t="450000" d="45000"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="r720" bandwidth="3000000" width="1280" height="720" codecs="avc1.640020"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const p = parseMPD(xml, BASE);
  assert.equal(p.error, null);
  const t = p.video[0];
  assert.equal(t.mode, 'segments');
  assert.equal(t.init, 'https://dash.example.com/vod/init.m4s');
  assert.deepEqual(t.segments.map((s) => s.split('/').pop()), [
    'seg_0.m4s', 'seg_90000.m4s', 'seg_180000.m4s', 'seg_270000.m4s',
    'seg_360000.m4s', 'seg_450000.m4s',
  ]);
});

test('parseMPD: SegmentList with explicit SegmentURLs', () => {
  const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <SegmentList>
        <SegmentURL media="https://dash.example.com/vod/audio/1.m4s"/>
        <SegmentURL media="https://dash.example.com/vod/audio/2.m4s"/>
      </SegmentList>
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const p = parseMPD(xml, BASE);
  assert.equal(p.error, null);
  assert.equal(p.video.length, 0);
  assert.equal(p.audio.length, 1);
  const t = p.audio[0];
  assert.equal(t.id, 'a1');
  assert.equal(t.mode, 'segments');
  assert.equal(t.hasAudio, true);
  assert.equal(t.init, null);
  assert.deepEqual(t.segments, [
    'https://dash.example.com/vod/audio/1.m4s',
    'https://dash.example.com/vod/audio/2.m4s',
  ]);
});

test('parseMPD: video + audio adaptation sets split correctly', () => {
  const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <AdaptationSet contentType="video" mimeType="video/mp4">
    <Representation id="v" bandwidth="2500000" width="1280" height="720" codecs="avc1.64001f">
      <BaseURL>v.mp4</BaseURL>
    </Representation>
  </AdaptationSet>
  <AdaptationSet contentType="audio" mimeType="audio/mp4">
    <Representation id="a" bandwidth="128000" codecs="mp4a.40.2">
      <BaseURL>a.m4a</BaseURL>
    </Representation>
  </AdaptationSet>
</MPD>`;
  const p = parseMPD(xml, BASE);
  assert.equal(p.error, null);
  assert.equal(p.video.length, 1);
  assert.equal(p.audio.length, 1);
  assert.equal(p.video[0].mode, 'static');
  assert.equal(p.video[0].url, 'https://dash.example.com/vod/v.mp4');
  assert.equal(p.audio[0].mode, 'static');
  assert.equal(p.audio[0].url, 'https://dash.example.com/vod/a.m4a');
});

test('parseMPD: non-MPD input', () => {
  const p = parseMPD('<html><body>nope</body></html>', BASE);
  assert.equal(p.error, 'Not an MPD document');
});

test('parseMPD: MPD without usable adaptation sets', () => {
  const p = parseMPD('<MPD><Period/></MPD>', BASE);
  assert.equal(p.error, 'No usable AdaptationSets found');
});
