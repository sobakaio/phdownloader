// page-parse.js
// Port of the page-level parsing from yt-dlp's PornHubIE
// (https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/pornhub.py).
// Pure functions: no browser APIs, unit-testable in Node.

const HTML_UNESCAPE = [['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#039;', "'"], ['&#39;', "'"]];

export function cleanUrl(url) {
  if (!url) return null;
  let out = String(url).trim();
  for (const [from, to] of HTML_UNESCAPE) out = out.split(from).join(to);
  try { out = decodeURIComponent(out); } catch { /* keep raw */ }
  return /^https?:\/\//i.test(out) ? out : null;
}

/**
 * Parse a JS assignment block like yt-dlp's extract_js_vars():
 *   var media_123 = "a";var quality_1 = 'b' + media_123;
 * Handles string concatenation with '+' and references to previously
 * declared variables in the same block.
 */
export function extractJsVars(block) {
  const jsVars = {};
  for (const rawAssn of String(block).split(';')) {
    const assn = rawAssn.trim().replace(/^var\s+/, '');
    if (!assn || !assn.includes('=')) continue;
    const eq = assn.indexOf('=');
    const vname = assn.slice(0, eq).trim();
    const value = assn.slice(eq + 1);
    jsVars[vname] = parseJsValue(value, jsVars);
  }
  return jsVars;
}

function parseJsValue(input, jsVars = {}) {
  let inp = String(input).replace(/\/\*(?:(?!\*\/).)*?\*\//g, '').trim();
  if (inp.includes('+')) {
    // Concatenation of literals / variable refs (yt-dlp behaviour)
    return inp.split('+').map((p) => parseJsValue(p, jsVars)).join('');
  }
  if (inp.length >= 2 && (inp[0] === '"' || inp[0] === "'") && inp[inp.length - 1] === inp[0]) {
    return inp.slice(1, -1);
  }
  if (jsVars[inp] !== undefined) return jsVars[inp];
  return inp;
}

/**
 * Extract everything the downloader needs from a PornHub(Premium) video page.
 * @param {string} html  Full page HTML (as served to the logged-in user).
 * @returns {{
 *   videoTitle: ?string, duration: ?number, hasFlashvars: boolean,
 *   candidates: {url:string, quality:?number, format:?string, source:string}[],
 *   getMediaUrl: ?string,
 *   downloadUrls: string[],
 *   unavailable: ?string
 * }}
 */
export function extractPageData(html) {
  const out = {
    videoTitle: null,
    duration: null,
    hasFlashvars: false,
    candidates: [],
    getMediaUrl: null,
    downloadUrls: [],
    unavailable: null,
  };
  if (typeof html !== 'string' || !html) return out;

  // --- error / geo blocks (yt-dlp checks) ---
  const noVideo = html.match(/<section[^>]+class="noVideo"[^>]*>([\s\S]+?)<\/section>/i)
    || html.match(/<div[^>]+class="[^"]*(?:removed|userMessageSection)[^"]*"[^>]*>([\s\S]+?)<\/div>/i);
  if (noVideo) {
    out.unavailable = noVideo[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  if (/<[^>]+class="geoBlocked"/.test(html)) out.unavailable = 'This content is unavailable in your country (geo-blocked).';

  // --- flashvars_N = { ... } (primary source, single-line JSON) ---
  const fm = html.match(/var\s+flashvars_\d+\s*=\s*(\{.+\});/);
  if (fm) {
    try {
      const fv = JSON.parse(fm[1]);
      out.hasFlashvars = true;
      if (fv.video_title) out.videoTitle = String(fv.video_title);
      const dur = parseInt(fv.video_duration, 10);
      if (Number.isFinite(dur)) out.duration = dur;
      if (Array.isArray(fv.mediaDefinitions)) {
        for (const def of fv.mediaDefinitions) {
          if (!def || typeof def !== 'object') continue;
          const url = cleanUrl(def.videoUrl);
          if (!url) continue;
          if (url.includes('/video/get_media')) {
            if (!out.getMediaUrl) out.getMediaUrl = url;
          } else {
            pushCandidate(out, url, def.quality, def.format, 'mediaDefinitions');
          }
        }
      }
    } catch { /* fall through to fallbacks */ }
  }

  // --- fallback JS vars: var media_* / quality_* / qualityItems_* (yt-dlp) ---
  const jm = html.match(/\bvar\s+(?:media|quality|qualityItems)\w*=[^\n]*/);
  if (jm) {
    const vars = extractJsVars(jm[0]);
    for (const [key, value] of Object.entries(vars)) {
      if (key.startsWith('qualityItems')) {
        try {
          const items = JSON.parse(value);
          if (Array.isArray(items)) {
            for (const it of items) {
              const url = cleanUrl(it && it.url);
              if (url) pushCandidate(out, url, null, null, 'qualityItems');
            }
          }
        } catch { /* ignore */ }
      } else if (key.startsWith('media') || key.startsWith('quality')) {
        const url = cleanUrl(value);
        if (url && !url.includes('/video/get_media')) pushCandidate(out, url, null, null, 'jsVars');
        else if (url && url.includes('/video/get_media')) out.getMediaUrl ||= url;
      }
    }
  }

  // --- <a class="downloadBtn" href="..."> (premium download button) ---
  for (const m of html.matchAll(/<a[^>]+\bclass=["']downloadBtn\b[^>]+\bhref=["']([^"']+)["']/gi)) {
    const url = cleanUrl(m[1]);
    if (url && !out.downloadUrls.includes(url)) out.downloadUrls.push(url);
  }

  // --- og:video meta (240p progressive mp4, present even in minimal pages) ---
  const ogm = html.match(/<meta[^>]+(?:property|name)=["']og:video(?:_url|:secure_url)?["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:video(?:_url|:secure_url)?["']/i);
  if (ogm) {
    const url = cleanUrl(ogm[1] || ogm[2]);
    if (url) pushCandidate(out, url, null, null, 'og:video');
  }

  // --- generic scan for manifest URLs (last resort / A-B page variants) ---
  for (const m of html.matchAll(/https?:[^"'\\\s<>]+?\.m3u8[^"'\\\s<>]*/gi)) {
    const url = cleanUrl(m[0]);
    if (url) pushCandidate(out, url, null, null, 'scan');
  }
  for (const m of html.matchAll(/https?:[^"'\\\s<>]+?\.mpd[^"'\\\s<>]*/gi)) {
    const url = cleanUrl(m[0]);
    if (url) pushCandidate(out, url, null, null, 'scan');
  }

  return out;
}

function pushCandidate(out, url, quality, format, source) {
  const existing = out.candidates.find((c) => c.url === url);
  if (existing) {
    if (existing.quality == null && quality != null && quality !== '') existing.quality = Number(quality);
    return;
  }
  let q = null;
  if (quality != null && quality !== '') q = Number(quality);
  out.candidates.push({ url, quality: q == null || !Number.isFinite(q) ? null : q, format: format || null, source });
}

/** Classify a candidate URL by its path extension (yt-dlp add_format logic). */
export function urlKind(url) {
  const path = String(url).split(/[?#]/)[0];
  if (path.endsWith('.mpd')) return 'mpd';
  if (path.endsWith('.m3u8')) return 'm3u8';
  return 'direct';
}

/** Guess a height from a PH url such as .../1080P_4000K_123.mp4 or ?height=1080 */
export function heightFromUrl(url) {
  const m = String(url).match(/(\d{3,5})[pP](?:_|$|[?.])/) || String(url).match(/[?&]height=(\d{3,5})/);
  return m ? parseInt(m[1], 10) : null;
}

/** Guess a target bitrate (kbps) from a PH url such as .../1080P_4000K_123.mp4 */
export function bitrateKFromUrl(url) {
  const m = String(url).match(/(\d{2,6})[kK](?:_|$|[?.])/);
  return m ? parseInt(m[1], 10) : null;
}
