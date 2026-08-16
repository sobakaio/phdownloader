// mpd.js — compact MPEG-DASH MPD parser (best-effort).
// Supports the cases needed for direct downloading:
//   1. Static MPD: Representation with a plain BaseURL (one whole file)  -> 'static'
//   2. SegmentTemplate with $Number$/$Time$ (+ SegmentTimeline)          -> 'segments'
//   3. SegmentList with explicit SegmentURL entries                      -> 'segments'
// Pure: testable in Node.

export function parseAttrs(str) {
  const out = {};
  const re = /([A-Za-z_][\w:-]*)=["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(str)) !== null) out[m[1]] = m[2];
  return out;
}

/** Find all occurrences of <tag ...> (boundary-safe) with their attribute strings. */
function findTags(xml, tag) {
  const out = [];
  const open = '<' + tag;
  let i = xml.indexOf(open);
  while (i !== -1) {
    const c = xml[i + open.length];
    if (c === undefined || /[\s>]/.test(c)) {
      const close = xml.indexOf('>', i + open.length);
      if (close !== -1) {
        const body = xml.slice(i + open.length, close);
        out.push({
          attrs: parseAttrs(body),
          selfClosed: body.endsWith('/'),
          start: i,
          close,
        });
      }
    }
    i = xml.indexOf(open, i + 1);
  }
  return out;
}

/** Inner content of the FIRST non-self-closed <tag> found from (or before) `from`. */
function innerContent(xml, tag, from = 0) {
  for (const t of findTags(xml.slice(from), tag)) {
    if (t.selfClosed) continue;
    const absClose = from + t.close;
    const end = xml.indexOf('</' + tag, absClose);
    if (end === -1) return null;
    return xml.slice(absClose + 1, end);
  }
  return null;
}

function fillTpl(tpl, vars, baseUrl) {
  let out = String(tpl);
  for (const [k, v] of Object.entries(vars)) out = out.split(k).join(v);
  out = out.split('$RepresentationID$').join(vars.id || '');
  try { return new URL(out, baseUrl).toString(); } catch { return out; }
}

function adaptContentType(attrs) {
  if (attrs.contentType) return attrs.contentType;
  if (attrs.mimeType) return attrs.mimeType.split(';')[0];
  return '';
}

function makeTrack(attrs, contentType) {
  const codecs = attrs.codecs || '';
  return {
    id: attrs.id || null,
    contentType: contentType || 'unknown',
    codecs: codecs || null,
    width: attrs.width ? parseInt(attrs.width, 10) : null,
    height: attrs.height ? parseInt(attrs.height, 10) : null,
    bandwidth: attrs.bandwidth ? parseInt(attrs.bandwidth, 10) : null,
    mode: 'unsupported',
    url: null,
    init: null,
    segments: null,
    hasVideo: contentType.includes('video') || /^(avc1|hvc1|hev1|av01|vp09)/.test(codecs) || !!attrs.width,
    hasAudio: contentType.includes('audio') || /^(mp4a|ac-?3|ec-?3|opus)/.test(codecs),
  };
}

/**
 * @param {string} xml MPD document
 * @param {string} baseUrl URL the MPD was fetched from
 * @returns {{kind:'dash', video:object[], audio:object[], error:?string}}
 */
export function parseMPD(xml, baseUrl) {
  const res = { kind: 'dash', video: [], audio: [], error: null };
  if (typeof xml !== 'string' || !/<MPD[\s>]/.test(xml)) {
    res.error = 'Not an MPD document';
    return res;
  }
  const mpdTag = findTags(xml, 'MPD')[0] || { attrs: {} };
  const durationS = parseFloat(mpdTag.attrs.duration) || null;

  for (const ad of findTags(xml, 'AdaptationSet')) {
    const adAttrs = ad.attrs;
    let adInner = '';
    if (!ad.selfClosed) {
      const end = xml.indexOf('</AdaptationSet>', ad.close);
      adInner = end === -1 ? '' : xml.slice(ad.close + 1, end);
    }
    const adContent = adaptContentType(adAttrs);
    const reps = findTags(adInner, 'Representation');
    const sources = reps.length
      ? reps
      : [{ attrs: adAttrs, selfClosed: false, start: ad.start, close: ad.close, isAd: true }];

    for (const rep of sources) {
      const track = makeTrack(rep.attrs, adaptContentType(rep.attrs) || adContent);
      (track.hasVideo ? res.video : track.hasAudio ? res.audio : []).push(track);

      let repInner = '';
      if (!rep.isAd) {
        if (rep.selfClosed) repInner = '';
        else {
          // rep.start/rep.close are relative to adInner
          const end = adInner.indexOf('</Representation>', rep.start);
          repInner = end === -1 ? '' : adInner.slice(rep.close + 1, end);
        }
      } else {
        repInner = adInner;
      }
      const scope = repInner + adInner; // templates may live at either level

      // 1) static BaseURL (whole file, no segmentation)
      const hasSegmentation = /<SegmentTemplate[\s>]|<SegmentList[\s>]|<SegmentBase[\s>]/.test(scope);
      const baseM = repInner.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/) || adInner.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/);
      if (baseM && !hasSegmentation) {
        try { track.mode = 'static'; track.url = new URL(baseM[1].trim(), baseUrl).toString(); } catch { /* ignore */ }
      }

      // 2) SegmentTemplate (may be self-closing, at Representation or AdaptationSet level)
      if (track.mode !== 'static') {
        const stTag = findTags(repInner, 'SegmentTemplate')[0] || findTags(adInner, 'SegmentTemplate')[0];
        if (stTag) {
          const stAttrs = stTag.attrs;
          const initTpl = stAttrs.initialization || null;
          const mediaTpl = stAttrs.media || null;
          const startNumber = stAttrs.startNumber ? parseInt(stAttrs.startNumber, 10) : 1;
          let times = [];
          // SegmentTimeline: per-Representation first, then AdaptationSet level
          const tl = innerContent(repInner, 'SegmentTimeline') ?? innerContent(adInner, 'SegmentTimeline');
          if (tl) {
            for (const s of tl.matchAll(/<S\b([^>]*?)\/?>/g)) {
              const a = parseAttrs(s[1]);
              const t = a.t != null ? parseInt(a.t, 10) : null;
              const d = a.d != null ? parseInt(a.d, 10) : 0;
              const r = a.r != null ? parseInt(a.r, 10) : 0;
              if (t == null) continue;
              for (let k = 0; k <= r; k++) times.push(t + k * d);
            }
          }
          if (mediaTpl && mediaTpl.includes('$Time$') && times.length) {
            track.mode = 'segments';
            track.init = initTpl ? fillTpl(initTpl, { id: track.id }, baseUrl) : null;
            track.segments = times.map((t) => fillTpl(mediaTpl, { id: track.id, $Time$: String(t) }, baseUrl));
          } else if (mediaTpl && mediaTpl.includes('$Number$')) {
            const tickDur = stAttrs.duration ? parseFloat(stAttrs.duration) : null;
            const timescale = stAttrs.timescale ? parseInt(stAttrs.timescale, 10) : 1;
            const perSegS = tickDur ? tickDur / timescale : null;
            if (durationS && perSegS) {
              const count = Math.max(1, Math.ceil(durationS / perSegS));
              track.mode = 'segments';
              track.init = initTpl ? fillTpl(initTpl, { id: track.id }, baseUrl) : null;
              track.segments = Array.from({ length: count }, (_, k) =>
                fillTpl(mediaTpl, { id: track.id, $Number$: String(startNumber + k) }, baseUrl));
            }
          }
        }
      }

      // 3) SegmentList
      if (track.mode !== 'static' && track.mode !== 'segments') {
        const slXml = innerContent(repInner, 'SegmentList') ?? innerContent(adInner, 'SegmentList');
        if (slXml != null) {
          const urls = [];
          for (const u of slXml.matchAll(/<SegmentURL\b([^>]*?)\/?>/g)) {
            const a = parseAttrs(u[1]);
            if (a.media) { try { urls.push(new URL(a.media, baseUrl).toString()); } catch { /* ignore */ } }
          }
          const initM = slXml.match(/initialization="([^"]*)"/);
          if (initM) { try { track.init = new URL(initM[1], baseUrl).toString(); } catch { /* ignore */ } }
          if (urls.length) { track.mode = 'segments'; track.segments = urls; }
        }
      }
    }
  }

  if (!res.video.length && !res.audio.length) res.error = res.error || 'No usable AdaptationSets found';
  return res;
}
