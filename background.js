// background.js — MV3 service worker for PHDownloader.
// Extraction mirrors yt-dlp's PH premium extractor:
//   page HTML (session cookies) -> flashvars mediaDefinitions ->
//   get_media JSON (progressive MP4) / HLS masters -> downloads.
//
// CDN media requests require the Origin/Referer of the site host (the CDN
// answers 410/471 + an HTML error page otherwise), so every CDN request
// below carries explicit Origin/Referer headers.

import { extractPageData, cleanUrl, urlKind, heightFromUrl, bitrateKFromUrl } from './lib/page-parse.js';
import { parseM3U8, pickVariant } from './lib/m3u8.js';
import { parseMPD } from './lib/mpd.js';
import { buildFilename, qualityToken } from './lib/names.js';

const CDNS = ['phncdn.com', 'phprcdn.com', 'pornhost.com'];
// Production always shows the native Save-as dialog. Debug builds flip this
// to false so automated E2E runs can save without a human clicking the dialog.
const SAVE_AS = true;
const MSG = {
  GET_INFO: 'PHD:GET_INFO',
  DOWNLOAD: 'PHD:DOWNLOAD',
  CANCEL: 'PHD:CANCEL',
  SET_HOST: 'PHD:SET_HOST',
  GET_STATE: 'PHD:GET_STATE',
  EVENT: 'PHD:EVENT',
  PING: 'PHD:PING',
};

const jobs = new Map(); // jobId -> job
const downloadJobs = new Map(); // chrome.downloads item id -> job

// ------------------------------------------------------- job persistence
// An MV3 service worker can be terminated mid-download. chrome.storage.session
// survives SW restarts (within a browser session), so we mirror active jobs
// there and re-adopt them on startup: the in-flight download and the offscreen
// document keep living, and the panel (which polls the SW) keeps working.
const JOBS_KEY = 'phpdActiveJobs';
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistJobs(); }, 1500);
}
async function persistJobs() {
  const data = {};
  for (const [id, j] of jobs) {
    if (j.state === 'working' || j.state === 'assembling' || j.state === 'downloading') {
      data[id] = {
        jobId: j.jobId, state: j.state, received: j.received, total: j.total,
        title: j.title, ext: j.ext, format: j.format, pageUrl: j.pageUrl, host: j.host,
        template: j.template, videoId: j.videoId,
        retryDone: !!j.retryDone, downloadId: j.downloadId != null ? j.downloadId : null,
        blobUrl: j.blobUrl || null, blobSize: j.blobSize || null, tabId: j.tabId != null ? j.tabId : null,
        saveName: j.saveName || null, error: j.error || null,
        part: j.part || null, partsTotal: j.partsTotal || null,
      };
    }
  }
  try { await chrome.storage.session.set({ [JOBS_KEY]: data }); } catch { /* SW going down */ }
}
async function restoreJobs() {
  try {
    const data = (await chrome.storage.session.get(JOBS_KEY))[JOBS_KEY] || {};
    let n = 0;
    for (const id of Object.keys(data)) {
      const j = data[id];
      jobs.set(id, { ...j, cancelled: false });
      if (j.downloadId != null) downloadJobs.set(j.downloadId, jobs.get(id));
      if (j.state === 'downloading' && j.downloadId != null) {
        const jj = jobs.get(id);
        jj.downloadPoll = setInterval(() => reconcileDownload(jj), 2000);
      }
      if (j.state === 'working') {
        // A 'working' job (still pre-pump: token refresh / manifest fetch)
        // cannot resume on its own after an SW restart — nothing will ever
        // advance it. Give it a grace window, then fail it cleanly so the
        // panel offers a retry.
        chrome.alarms.create('phpd-stuck-' + id, { when: Date.now() + 90000 });
      }
      n++;
    }
    if (n) {
      console.log('phpd: restored ' + n + ' active job(s) after SW restart');
      ensureKeepAlive();
    }
  } catch { /* first start */ }
}
let activeHost = 'pornhubpremium.com';
let lastTabId = null; // tab that owns the panel (page-context fetch host)

// ---------------------------------------------------------------- media headers
// The premium CDN checks the Origin header and answers 410/471 plus a small
// HTML error page when it is missing or stale. Extensions with host
// permissions may set forbidden headers explicitly, so every CDN request
// below carries the originating site's Origin/Referer.
const CDN_HOST_RE = /(^|\.)(phncdn|phprcdn|phcdn)\.com$/;
function mediaHeadersForUrl(url, host) {
  try {
    const h = new URL(url).hostname;
    if (CDN_HOST_RE.test(h)) {
      const origin = `https://www.${host || activeHost}`;
      return { Origin: origin, Referer: `${origin}/` };
    }
  } catch { /* not a URL */ }
  return {};
}

// Offscreen media engine: multi-GB media bytes are streamed there (a full
// renderer process) and returned as a blob URL for chrome.downloads.
let offscreenReady = false;
const offMsg = (m) => {
  try { chrome.runtime.sendMessage(m).catch(() => {}); } catch { /* offscreen gone */ }
};
async function ensureOffscreen() {
  if (offscreenReady) return;
  const base = { url: 'offscreen.html', justification: 'accumulate multi-GB media blobs from page-context fetches' };
  for (const reasons of [['BLOBS'], ['DOM_SCRAPING'], ['TESTING']]) {
    try {
      console.log('phpd: offscreen createDocument trying', JSON.stringify(reasons));
      await chrome.offscreen.createDocument({ ...base, reasons });
      break;
    } catch (e) {
      const m = (e && e.message) || '';
      if (/already exists/i.test(m)) break;
      // invalid reason on this Chrome build — try the next one
    }
  }
  // createDocument resolves before offscreen.js registers its message
  // listener — wait for a PING round-trip before sending a job.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'PHD:OFF_PING' });
      if (r && r.ok) { console.log('phpd: offscreen ready at ping', i); offscreenReady = true; return; }
    } catch { /* not ready yet */ }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  throw new Error('offscreen media document did not become ready');
}
const VERSION = '1.2.3';
console.log(`phpd: service worker started (v${VERSION})`);

// ---------------------------------------------------------------- utilities

function broadcast(msg) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* no listeners */ }
}

async function fetchWithTimeout(url, { timeout = 20000, headers = null, host: h2 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const init = { credentials: 'include', signal: ctrl.signal };
    const merged = { ...mediaHeadersForUrl(url, h2), ...(headers || {}) };
    if (Object.keys(merged).length) {
      // Chrome throws on an explicit `headers: null` and on non-string values in the
      // record, so normalize: drop missing/empty entries, keep plain string values.
      const clean = {};
      for (const [k, v] of Object.entries(merged)) {
        if (typeof v === 'string' && v.length) clean[k] = v;
      }
      init.headers = clean;
    }
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
    return res;
  } catch (e) {
    // Make network failures diagnosable: append the failing host to the message.
    let host;
    try { host = new URL(url).host; } catch { host = String(url).slice(0, 80); }
    const err = (e instanceof Error) ? e : new Error(String(e));
    err.message = `${err.message} [${host}]`;
    throw err;
  } finally {
    clearTimeout(t);
  }
}

const fetchText = async (url, opts) => (await fetchWithTimeout(url, opts)).text();

// A direct (progressive) MP4 from get_media may be a dead link — premium top
// qualities often 410/471 even though the player serves the same quality via
// HLS. HEAD each one so we only recommend URLs the CDN actually serves.
// (The SW fetches with Chrome's real TLS fingerprint, so a live file answers 200.)
// Availability probe: the CDN rejects extension-context requests
// (Sec-Fetch-Site: none), so the HEAD must come from the page context too.
async function probeDirect(url, host) {
  const tabId = lastTabId;
  if (tabId == null) return false;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PHD:PAGE_PROBE', url });
    return !!(r && r.ok && (r.status === 200 || r.status === 206) && !(r.ct || '').startsWith('text/html'));
  } catch {
    return false;
  }
}

function dedupeAndRank(formats) {
  const seen = new Set();
  const seenDirect = new Set(); // (kind,height) for direct mp4s
  const out = [];
  for (const f of formats) {
    const key = `${f.kind}|${f.url}|${f.trackId || ''}`;
    if (seen.has(key)) continue;
    if (f.kind === 'direct') {
      const dk = `direct|${f.height ?? 'n'}`;
      if (seenDirect.has(dk)) continue;
      seenDirect.add(dk);
    }
    seen.add(key);
    out.push(f);
  }
  const rank = (f) => ({ direct: 0, hls: 1, mpd: 2, 'mpd-audio': 3 }[f.kind] ?? 9) * 1e12 -
    ((f.height || f.bandwidth || 0));
  out.sort((a, b) => rank(a) - rank(b));
  if (out.length) {
    const best = out.find((f) => f.kind === 'direct') || out[0];
    best.recommended = true;
  }
  return out;
}

async function expandCandidates(page, host = activeHost) {
  const formats = [];
  const notes = [];

  if (page.getMediaUrl) {
    try {
      const raw = await fetchText(page.getMediaUrl, { timeout: 15000, host });
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const m of list) {
          const u = cleanUrl(m && m.videoUrl);
          if (!u) continue;
          formats.push({
            kind: 'direct', url: u,
            quality: m.quality != null ? Number(m.quality) || null : null,
            height: m.height ? Number(m.height) : (m.quality ? Number(m.quality) : heightFromUrl(u)),
            width: m.width ? Number(m.width) : null,
            bitrateK: bitrateKFromUrl(u),
            source: 'get_media',
          });
        }
        if (!list.length) notes.push('The site returned an empty MP4 list — check that you are logged in.');
      }
    } catch (e) {
      notes.push(`MP4 list request failed: ${e.message}`);
    }
  }

  await Promise.allSettled(page.candidates.map(async (c) => {
    const kind = urlKind(c.url);
    if (kind === 'm3u8') {
      try {
        const text = await fetchText(c.url, { timeout: 15000, host });
        const parsed = parseM3U8(text, c.url);
        if (parsed.isMaster && parsed.variants.length) {
          for (const v of parsed.variants) {
            formats.push({
              kind: 'hls', url: c.url, masterUrl: c.url,
              variantUrl: parsed.variants.length === 1 ? v.url : null,
              quality: c.quality || v.height || null,
              height: v.height, width: v.width, bandwidth: v.bandwidth,
              codecs: v.codecs, source: c.source,
            });
          }
        } else {
          formats.push({
            kind: 'hls', url: c.url, masterUrl: null, variantUrl: c.url,
            quality: c.quality, height: null, bandwidth: null,
            segCount: parsed.segments.length, source: c.source,
          });
        }
      } catch (e) {
        notes.push(`HLS manifest fetch failed: ${e.message}`);
      }
    } else if (kind === 'mpd') {
      try {
        const text = await fetchText(c.url, { timeout: 15000, host });
        const parsed = parseMPD(text, c.url);
        if (parsed.error) { notes.push(`MPD: ${parsed.error}`); return; }
        const separateAudio = parsed.audio.length > 0;
        for (const t of parsed.video) {
          formats.push({
            kind: 'mpd', url: c.url, trackId: t.id,
            height: t.height, width: t.width, bandwidth: t.bandwidth,
            mode: t.mode, includesAudio: !separateAudio, source: c.source,
          });
        }
        for (const t of parsed.audio) {
          formats.push({
            kind: 'mpd-audio', url: c.url, trackId: t.id,
            bandwidth: t.bandwidth, source: c.source,
          });
        }
      } catch (e) {
        notes.push(`MPD fetch failed: ${e.message}`);
      }
    } else {
      formats.push({
        kind: 'direct', url: c.url, quality: c.quality,
        height: c.quality || heightFromUrl(c.url),
        bitrateK: bitrateKFromUrl(c.url), source: c.source,
      });
    }
  }));

  for (const u of page.downloadUrls) {
    const kind = urlKind(u);
    if (kind === 'm3u8') formats.push({ kind: 'hls', url: u, masterUrl: u, variantUrl: null, source: 'downloadBtn' });
    else formats.push({ kind: 'direct', url: u, height: heightFromUrl(u), bitrateK: bitrateKFromUrl(u), source: 'downloadBtn' });
  }

  // Only 720p and up are offered (lower tiers dropped by design).
  const MIN_HEIGHT = 720;
  const kept = formats.filter((f) => {
    const h = f.height != null ? f.height : (f.quality ? Number(f.quality) : null);
    return !h || h >= MIN_HEIGHT;
  });
  const deduped = dedupeAndRank(kept);
  // Validate the un-checked direct URLs (get_media / downloadBtn / og:video).
  await Promise.allSettled(deduped.filter((f) => f.kind === 'direct').map(async (f) => {
    f.available = await probeDirect(f.url, host);
  }));
  // Unavailable direct links sink below HLS; recommend the best that is alive.
  const rank2 = (f) => {
    const prio = f.kind === 'direct' ? (f.available ? 0 : 4)
      : ({ hls: 1, mpd: 2, 'mpd-audio': 3 })[f.kind] ?? 9;
    return prio * 1e12 - ((f.height || f.bandwidth || 0));
  };
  deduped.sort((a, b) => rank2(a) - rank2(b));
  for (const f of deduped) f.recommended = false;
  const best = deduped.find((f) => f.kind === 'direct' && f.available)
    || deduped.find((f) => f.kind !== 'direct')
    || deduped[0];
  if (best) best.recommended = true;
  return { formats: deduped, notes };
}

async function handleGetInfo(msg) {
  const { url, host } = msg;
  if (host && host !== activeHost) activeHost = host;
  const html = await fetchText(url, { timeout: 25000, host });
  const page = extractPageData(html);
  if (page.unavailable) return { ok: false, error: page.unavailable };
  if (!page.candidates.length && !page.getMediaUrl && !page.downloadUrls.length) {
    return {
      ok: false,
      error: 'No media found on this page. If you are logged in, press Refresh (the page may have served a variant without player data).',
    };
  }
  const { formats, notes } = await expandCandidates(page, host);
  return {
    ok: true,
    title: page.videoTitle || (msg.title || null),
    duration: page.duration,
    formats,
    notes,
  };
}

// ------------------------------------------------------------ downloads

function formatExt(f) {
  if (f.kind === 'hls') return f.container === 'fmp4' ? 'mp4' : 'ts';
  if (f.kind === 'mpd-audio') return 'm4a';
  const path = String(f.url || '').split(/[?#]/)[0];
  const m = path.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : (f.kind === 'mpd' ? 'mp4' : 'mp4');
}

// ------------------------------------------------------------ token refresh
// CDN tokens embedded in media URLs expire (the site issues ~2h windows).
// Expired/invalidated tokens make the CDN answer 401/403/404/410/471 with an
// HTML error page (chrome.downloads would save it as ".mp4"). Recovery:
// re-fetch the video page (fresh token) and retry the same format once.

function tokenValidTo(url) {
  try { return Number(new URL(url).searchParams.get('validto')) || 0; } catch { return 0; }
}

const RETRYABLE_HTTP = new Set([401, 403, 404, 410, 471]);
function isRetryableHttpError(e) {
  const msg = (e && e.message) || '';
  const m = /^\s*HTTP (\d{3})/.exec(msg);
  return !!(m && RETRYABLE_HTTP.has(Number(m[1])))
    || /HTML page, not media/.test(msg)
    || /network stalled|media part|media fetch timed out/i.test(msg);
}

async function refreshAll(pageUrl, host) {
  if (host && host !== activeHost) activeHost = host;
  const html = await fetchText(pageUrl, { timeout: 25000, host });
  const page = extractPageData(html);
  if (page.unavailable) throw new Error(page.unavailable);
  return expandCandidates(page, host);
}

async function refreshFormat(pageUrl, host, wanted) {
  const { formats } = await refreshAll(pageUrl, host);
  const key = (f) => `${f.kind}|${f.height ?? f.quality ?? ''}|${f.trackId ?? ''}`;
  const match = formats.find((f) => key(f) === key(wanted))
    || formats.find((f) => f.kind === wanted.kind && (f.height === wanted.height || f.quality === wanted.quality));
  if (!match) throw new Error('Link was refreshed, but the selected quality is no longer listed on the page');
  return match;
}

function failJob(job, message) {
  console.error('phpd: job ' + job.jobId + ' FAILED: ' + message);
  job.state = 'error';
  job.error = message;
  broadcastEvent(job, 'error');
  scheduleRelease(job);
}

// The CDN can also kill the link mid-download (chrome.downloads gets
// interrupted with FILE_NOT_AVAILABLE / an HTTP error). In that case
// re-fetch the page once and re-issue the download with a fresh URL.
const RETRYABLE_DL_ERRORS = new Set([
  'FILE_NOT_AVAILABLE', 'SERVER_HTTP_ERROR', 'SERVER_BUSY', 'NETWORK_CHANGED', 'NETWORK_TIMEOUT',
]);

async function retryDirectAfterInterrupt(job, reason) {
  // If the media was already fully fetched into the offscreen blob, re-issue
  // the LOCAL disk copy only — do NOT re-download gigabytes from the CDN.
  if (job.blobUrl && job.blobSize) {
    console.log('phpd: interrupted (' + reason + ') but the blob is ready — re-issuing the local save');
    const name = job.saveName || 'video.mp4';
    // Blob URL: the name rides in the fragment (Chrome ignores `filename`).
    const id = await chrome.downloads.download({
      url: job.blobUrl, filename: name, saveAs: true, conflictAction: 'uniquify',
    });
    job.downloadId = id;
    downloadJobs.set(id, job);
    job.state = 'downloading';
    job.received = 0;
    job.total = job.blobSize;
    job.downloadPoll = setInterval(() => reconcileDownload(job), 2000);
    sendProgress(job);
    persistJobs();
    return;
  }
  console.log('phpd: download interrupted (' + reason + ') — refreshing page for a new token');
  const fmt = await refreshFormat(job.pageUrl, job.host, job.format);
  job.format = fmt;
  try {
    if (!job.rerun) throw new Error('job has no rerun');
    await job.rerun(fmt);
  } catch (e) {
    // Even the fresh token was rejected — try HLS of the same quality.
    if (job.onFallback) {
      console.log('phpd: retry failed (' + ((e && e.message) || e) + ') — falling back to HLS');
      await job.onFallback((e && e.message) || String(e));
    } else {
      throw e;
    }
  }
}

async function handleDownload(msg, sender) {
  const { jobId, format: format0, pageUrl, host, template, title, id } = msg;
  const tabId = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : lastTabId;
  let format = format0;

  // The container (and thus the extension) is only known once the manifest is
  // resolved, so the filename is built lazily via makeSave().
  const job = {
    jobId, state: 'working', cancelled: false,
    received: 0, total: null, error: null,
    downloadId: null, blobUrl: null,
    title: title || 'video', ext: 'mp4',
    // retry context: expired-token recovery for direct CDN downloads
    format: format0, pageUrl: pageUrl || null, host: host || null,
    template: template || '{title} - {quality}',
    videoId: id || '', retryDone: false, tabId,
  };
  jobs.set(jobId, job);

  const makeSave = (ext) => buildFilename(template, { title, quality: qualityToken(format), id }, ext);

  // Save a blob (created in the offscreen media document) to disk.
  const saveBlob = async (blobUrl, ext, size) => {
    job.ext = ext;
    job.blobUrl = blobUrl;
    return saveBlobForJob(job, size);
  };

  // Stream the media bytes in the offscreen document (explicit Origin/Referer
  // — the CDN rejects requests without them) and save the resulting blob.
  // The content script fetches the media in the PAGE context (correct
  // Sec-Fetch-Site) and streams 8 MB chunks to this SW, which relays them
  // to the offscreen accumulator. The blob save is driven by PHD:OFF_DONE.
  const pumpViaPage = (url) => {
    if (job.tabId == null) throw new Error('The video tab is gone — reload the video page and retry');
    return chrome.tabs.sendMessage(job.tabId, { type: 'PHD:PAGE_FETCH', jobId: job.jobId, url });
  };

  const pumpDirect = async (url, mime, ext) => {
    job.ext = ext;
    job.mime = mime;
    job.state = 'assembling';
    job.received = 0;
    job.total = null;
    job.part = null;
    job.partsTotal = null;
    sendProgress(job);
    ensureKeepAlive();
    await ensureOffscreen();
    offMsg({ type: 'PHD:OFF_INIT', jobId: job.jobId, fresh: true });
    const res = await pumpViaPage(url);
    if (job.cancelled) { offMsg({ type: 'PHD:OFF_RELEASE', jobId: job.jobId }); return { ok: false, error: 'Cancelled by user' }; }
    if (!res || !res.ok) throw new Error((res && res.error) || 'media fetch failed in page');
    offMsg({ type: 'PHD:OFF_FINISH', jobId: job.jobId, mime });
    return { ok: true }; // the save itself is driven by PHD:OFF_DONE
  };

  const pumpParts = async (urls, mime, ext) => {
    job.ext = ext;
    job.mime = mime;
    job.state = 'assembling';
    job.received = 0;
    job.total = null;
    job.partsTotal = urls.length;
    sendProgress(job);
    ensureKeepAlive();
    await ensureOffscreen();
    offMsg({ type: 'PHD:OFF_INIT', jobId: job.jobId, fresh: true });
    for (let i = 0; i < urls.length; i++) {
      if (job.cancelled) throw new Error('Cancelled by user');
      job.part = i + 1;
      sendProgress(job);
      offMsg({ type: 'PHD:OFF_MARK', jobId: job.jobId });
      let lastErr = null;
      for (let t = 0; t < 3; t++) {
        try {
          const res = await pumpViaPage(urls[i]);
          if (!res || !res.ok) throw new Error((res && res.error) || 'media part fetch failed');
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await new Promise((r2) => setTimeout(r2, 400 * (t + 1)));
        }
      }
      if (lastErr) {
        offMsg({ type: 'PHD:OFF_REVERT', jobId: job.jobId });
        throw lastErr;
      }
    }
    offMsg({ type: 'PHD:OFF_FINISH', jobId: job.jobId, mime });
    return { ok: true };
  };

  // The actual work. Throws on failure so the caller can retry with a
  // fresh token.
  const run = async (fmt) => {
    if (fmt.kind === 'direct') {
      const ext = formatExt(fmt);
      const mime = ext === 'ts' ? 'video/mp2t' : 'video/mp4';
      const res = await pumpDirect(fmt.url, mime, ext);
      return { ...res, mode: 'direct' };
    }

    // ---- assembly (HLS or DASH) ----
    let parts = [];
    let container = 'ts';
    if (fmt.kind === 'hls') {
      let variantUrl = fmt.variantUrl;
      if (!variantUrl && fmt.masterUrl) {
        const masterText = await fetchText(fmt.masterUrl, { timeout: 20000, host });
        const master = parseM3U8(masterText, fmt.masterUrl);
        const v = pickVariant(master, fmt);
        if (!v) throw new Error('HLS master has no variants');
        variantUrl = v.url;
      }
      const mediaText = await fetchText(variantUrl, { timeout: 20000, host });
      const media = parseM3U8(mediaText, variantUrl);
      if (!media.segments.length) throw new Error('HLS playlist has no segments');
      if (media.initUrl) { container = 'fmp4'; parts.push({ url: media.initUrl }); }
      parts.push(...media.segments.map((s) => ({ url: s.url })));
    } else if (fmt.kind === 'mpd' || fmt.kind === 'mpd-audio') {
      const mpdText = await fetchText(fmt.url, { timeout: 20000, host });
      const parsed = parseMPD(mpdText, fmt.url);
      const pool = fmt.kind === 'mpd-audio' ? parsed.audio : parsed.video;
      const track = pool.find((t) => t.id === fmt.trackId) || pool[0];
      if (!track) throw new Error('DASH track not found');
      if (track.mode === 'static' && track.url) {
        const ext = fmt.kind === 'mpd-audio' ? 'm4a' : 'mp4';
        const mime = ext === 'm4a' ? 'audio/mp4' : 'video/mp4';
        const res = await pumpDirect(track.url, mime, ext);
        return { ...res, mode: 'direct' };
      }
      if (track.mode !== 'segments' || !track.segments?.length) throw new Error('DASH track not downloadable (unsupported segment layout)');
      container = fmt.kind === 'mpd-audio' ? 'm4a' : 'mp4';
      if (track.init) parts.push({ url: track.init });
      parts.push(...track.segments.map((u) => ({ url: u })));
    } else {
      throw new Error(`Unsupported format kind: ${fmt.kind}`);
    }

    if (!parts.length) throw new Error('No media segments found');
    const mime = container === 'fmp4' || container === 'mp4' ? 'video/mp4'
      : container === 'm4a' ? 'audio/mp4' : 'video/mp2t';
    const ext = container === 'fmp4' ? 'mp4' : container === 'm4a' ? 'm4a' : 'ts';
    const res = await pumpParts(parts.map((p) => p.url), mime, ext);
    return { ...res, mode: 'assemble' };
  };
  job.rerun = run;

  // Fallback: if the CDN keeps rejecting the DIRECT link (even with a fresh
  // token), assemble the same quality via HLS instead — SW fetch + local
  // blob, so the download stack never touches the CDN.
  job.onFallback = async (reason) => {
    const { formats } = await refreshAll(pageUrl, host);
    const hls = formats.find((f) => f.kind === 'hls'
      && (f.height === format0.height || f.quality === format0.height || f.quality === format0.quality));
    if (!hls) throw new Error(`CDN rejected the direct link (${reason}) and no HLS variant of ${format0.height || format0.quality}p is available`);
    console.log('phpd: direct link rejected by CDN — falling back to HLS ' + (hls.height || hls.quality));
    job.received = 0;
    job.blobUrl = null; // previous offscreen blob (if any) is released via PHD:OFF_RELEASE
    return run(hls);
  };

  // Retry loop: if the CDN rejects the link with an expired/invalid-token
  // status, re-fetch the page once (fresh token) and retry the same format.
  let refreshed = false;
  try {
    const vt = tokenValidTo(format.url);
    if (pageUrl && vt && Date.now() / 1000 > vt - 120) {
      console.log('phpd: link token expired/expiring — refreshing page for a new token');
      format = await refreshFormat(pageUrl, host, format);
      refreshed = true;
    }
    try {
      return await run(format);
    } catch (e) {
      if (!pageUrl) throw e;
      if (!isRetryableHttpError(e)) {
        // Network-level failure (CORS flap, connection drop) — a fresh
        // token will not help. For a direct link, the HLS variant lives on
        // a different edge host and usually works: fall back to it.
        if (format0.kind === 'direct') {
          console.log('phpd: direct pump network failure (' + (e.message || e) + ') — falling back to HLS');
          return await job.onFallback(e.message || String(e));
        }
        throw e;
      }
      if (!refreshed) {
        console.log('phpd: dead link (' + e.message + ') — refreshing page for a new token');
        job.received = 0;
        if (job.blobUrl) { try { URL.revokeObjectURL(job.blobUrl); } catch {} job.blobUrl = null; }
        format = await refreshFormat(pageUrl, host, format);
        refreshed = true;
        try {
          return await run(format);
        } catch (e2) {
          // Still rejected with a fresh token: if the user picked a direct
          // link, try HLS assembly of the same quality instead.
          if (format0.kind === 'direct' && isRetryableHttpError(e2)) {
            return await job.onFallback(e2.message);
          }
          throw e2;
        }
      }
      // Fresh token was already used and the direct link is still rejected:
      // try HLS assembly of the same quality.
      if (format0.kind === 'direct') {
        return await job.onFallback(e.message);
      }
      throw e;
    }
  } catch (e) {
    if (job.cancelled) {
      job.state = 'cancelled';
      job.error = 'Cancelled by user.';
      broadcastEvent(job, 'cancelled');
      return { ok: false, error: 'cancelled' };
    }
    job.state = 'error';
    job.error = e.message || String(e);
    broadcastEvent(job, 'error');
    return { ok: false, error: job.error };
  }
}

// Save a finished blob to disk via chrome.downloads (always the native
// Save-as dialog). Module-level so restored jobs (after an SW restart) can
// reuse it.
async function saveBlobForJob(job, size) {
  const name = job.saveName || buildFilename(job.template || '{title} - {quality}', { title: job.title, quality: qualityToken(job.format), id: job.videoId }, job.ext);
  job.saveName = name;
  console.log('phpd: chrome.downloads.download blob', size != null ? size + 'B' : '?', 'as', name, '(saveAs=' + SAVE_AS + ')');
  job.downloadId = await chrome.downloads.download({
    url: job.blobUrl,
    filename: name, saveAs: SAVE_AS, conflictAction: 'uniquify',
  }).catch((e) => { console.error('phpd: downloads.download rejected:', (e && e.message) || e); throw e; });
  downloadJobs.set(job.downloadId, job);
  job.state = 'downloading';
  // The bytes already exist in the blob; the save phase is a local disk copy.
  job.received = 0;
  job.total = size || null;
  job.part = null; job.partsTotal = null;
  // Blob-to-disk writes emit no progress and can even lose the terminal
  // chrome.downloads event, so poll the download item until it settles.
  job.downloadPoll = setInterval(() => reconcileDownload(job), 2000);
  sendProgress(job);
  persistJobs();
  return { filename: name };
}

function sendProgress(job) {
  broadcastEvent(job, 'progress');
}

function broadcastEvent(job, event) {
  schedulePersist();
  broadcast({
    type: MSG.EVENT,
    jobId: job.jobId,
    event, // progress | complete | error | cancelled
    state: job.state,
    received: job.received,
    total: job.total,
    progress: job.total ? Math.min(1, job.received / job.total) : null,
    downloadId: job.downloadId,
    error: job.error,
    title: job.title,
    part: job.part || null,
    partsTotal: job.partsTotal || null,
  });
}

// ------------------------------------------------------ job lifecycle

function ensureKeepAlive() {
  // 24 s period: must stay BELOW the 30 s service-worker idle timeout.
  chrome.alarms.create('phpd-keepalive', { periodInMinutes: 0.4 });
}

// Terminal states (complete/error/cancelled) are KEPT for 2 minutes so the
// panel's 1s polling can still read them; the blob memory is released sooner.
function scheduleRelease(job, holdMs = 120000) {
  setTimeout(() => { releaseJob(job); }, holdMs);
}

async function releaseJob(job) {
  if (job.downloadPoll) { clearInterval(job.downloadPoll); job.downloadPoll = null; }
  if (job.blobUrl) {
    // The blob lives in the offscreen document — ask it to release the memory
    // shortly after (the download itself is already done).
    job.blobUrl = null;
    setTimeout(() => broadcast({ type: 'PHD:OFF_RELEASE', jobId: job.jobId }), 60000);
  }
  jobs.delete(job.jobId);
  for (const [id, j] of downloadJobs) if (j === job) downloadJobs.delete(id);
  if (![...jobs.values()].some((j) => j.state === 'assembling' || j.state === 'downloading')) {
    await chrome.alarms.clear('phpd-keepalive');
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'phpd-keepalive') {
    if (![...jobs.values()].some((j) => j.state === 'assembling' || j.state === 'downloading')) {
      chrome.alarms.clear('phpd-keepalive');
    }
  } else if (alarm.name.startsWith('phpd-stuck-')) {
    const id = alarm.name.slice('phpd-stuck-'.length);
    const cur = jobs.get(id);
    if (cur && cur.state === 'working') {
      failJob(cur, 'The extension restarted while preparing this download. Press Download again.');
    }
  }
});

// Terminal handling for a download item, shared by the onChanged event and
// the reconciler (the blob-download 'complete' event can be lost).
function handleDownloadTerminal(job, st, error, fileSize) {
  if (job.downloadPoll) { clearInterval(job.downloadPoll); job.downloadPoll = null; }
  if (st === 'complete') {
    const size = fileSize != null ? fileSize : (job.total || job.received || null);
    if (size != null && size < 1024 * 1024) {
      // A real PH video is always > 1 MB. A tiny file means the CDN stored
      // its HTML error page as ".mp4" — surface it instead of pretending.
      const kb = Math.max(1, Math.round(size / 1024));
      const sizeTxt = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
      job.state = 'error';
      job.error = `The CDN saved an error page instead of video (file is only ${sizeTxt}). Delete the file, press Refresh (↻) and retry.`;
      broadcastEvent(job, 'error');
      scheduleRelease(job);
    } else {
      console.log('phpd: download complete — ' + (size != null ? size + 'B' : '?'));
      job.state = 'complete';
      broadcastEvent(job, 'complete');
      scheduleRelease(job);
    }
  } else { // interrupted
    const canRetry = job.pageUrl && job.format?.kind === 'direct'
      && RETRYABLE_DL_ERRORS.has(error);
    if (canRetry && !job.retryDone) {
      // First strike: re-issue the direct download with a fresh token.
      job.retryDone = true;
      job.state = 'working';
      job.error = null;
      broadcastEvent(job, 'progress');
      retryDirectAfterInterrupt(job, error).catch((e) => failJob(job, e.message || String(e)));
    } else if (canRetry && job.onFallback) {
      // Second strike: direct rejected even with a fresh token — assemble
      // the same quality via HLS.
      job.state = 'working';
      job.error = null;
      broadcastEvent(job, 'progress');
      job.onFallback(error).then((res) => {
        if (res?.ok) { job.state = 'downloading'; sendProgress(job); }
        else failJob(job, res?.error || 'HLS fallback failed');
      }).catch((e2) => failJob(job, e2.message || String(e2)));
    } else {
      job.state = 'error';
      job.error = error || 'Download interrupted';
      broadcastEvent(job, 'error');
      scheduleRelease(job);
    }
  }
}

// Polls the download item while a blob is being written to disk. Blob
// downloads report no progress and their terminal event can be missed (e.g.
// if the SW restarts mid-write), so this is the guaranteed completion path.
async function reconcileDownload(job) {
  if (!job.downloadId || !job.downloadPoll) return;
  let items = [];
  try { items = await chrome.downloads.search({ id: job.downloadId }); } catch { return; }
  if (!items.length) return;
  const item = items[0];
  if (item.state === 'complete' || item.state === 'interrupted') {
    handleDownloadTerminal(job, item.state, item.error || null, item.fileSize != null ? item.fileSize : null);
  }
}

// Some Chromium builds (notably headless) do not auto-inject the content
// script. Self-heal: watch tabs for video pages and inject content.js into
// the extension's isolated world when it is not already running there.
// In normal (headed) Chrome the flag is already set and this is a no-op.
const VIDEO_TAB_RE = /pornhub(premium)?\.com/;
const VIDEO_PATH_RE = /view_video\.php|video\/show|\/embed\//;
async function selfHealScan() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  for (const t of tabs) {
    const u = t.url || '';
    if (!VIDEO_TAB_RE.test(u) || !VIDEO_PATH_RE.test(u)) continue;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: () => window.__phpdLoaded === true,
      });
      if (!res || res.result !== true) {
        console.log('phpd: injecting content script into tab ' + t.id + ' (self-heal)');
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
      }
    } catch { /* tab not injectable */ }
  }
}
// Run once now (catches tabs that were open before the SW started) and
// periodically (catches navigations and SW restarts).
setInterval(() => { selfHealScan().catch(() => {}); }, 2500);
selfHealScan().catch(() => {});

chrome.downloads.onChanged.addListener((delta) => {
  const job = jobs.get(delta.id) || downloadJobs.get(delta.id) || null;
  const st = delta.state?.state || null;
  if (job) {
    if (st === 'in_progress') {
      job.state = 'downloading';
      if (delta.bytesReceived != null) job.received = delta.bytesReceived;
      if (delta.totalBytes != null) job.total = delta.totalBytes;
      else if (delta.progress?.progress != null && delta.bytesReceived != null) {
        job.total = Math.round(delta.bytesReceived / Math.max(0.01, delta.progress.progress));
      }
      sendProgress(job);
    } else if (st === 'complete' || st === 'interrupted') {
      handleDownloadTerminal(job, st, delta.error || null, delta.fileSize != null ? delta.fileSize : null);
    }
  } else {
    // Direct download from a previous SW incarnation: relay terminal states.
    if (st === 'complete' || st === 'interrupted') {
      broadcast({ type: MSG.EVENT, event: st === 'complete' ? 'complete' : 'error', downloadId: delta.id, error: delta.error || null, filename: delta.filename || null });
    }
  }
});

// ------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (sender && sender.tab && sender.tab.id != null) lastTabId = sender.tab.id;
  (async () => {
    try {
      switch (msg?.type) {
        case MSG.GET_INFO:
          return await handleGetInfo(msg);
        case 'PHD:OFF_PROGRESS': {
          const pj = jobs.get(msg.jobId);
          if (pj) {
            pj.received = msg.received || 0;
            if (msg.total) pj.total = msg.total;
            if (msg.part != null) pj.part = msg.part;
            if (msg.partsTotal != null) pj.partsTotal = msg.partsTotal;
            if (pj.state === 'working') pj.state = 'assembling';
            sendProgress(pj);
          }
          return { ok: true };
        }
        case 'PHD:OFF_DONE': {
          const job = jobs.get(msg.jobId);
          if (!job) return { ok: true };
          if (job.state !== 'assembling' && job.state !== 'working') return { ok: true };
          if (msg.ok) {
            console.log('phpd: blob ready ' + msg.size + 'B — saving');
            job.blobUrl = msg.blobUrl;
            job.blobSize = msg.size;
            job.received = msg.size;
            if (msg.size) job.total = msg.size;
            sendProgress(job);
            saveBlobForJob(job, msg.size).catch((e) => failJob(job, (e && e.message) || String(e)));
          } else {
            failJob(job, msg.error || 'offscreen accumulation failed');
          }
          return { ok: true };
        }
        case 'PHD:PAGE_META': {
          const job = jobs.get(msg.jobId);
          if (job && msg.totalBytes && job.partsTotal == null) {
            job.total = msg.totalBytes;
            job.received = msg.startOffset || 0;
            sendProgress(job);
          }
          return { ok: true };
        }
        case 'PHD:PAGE_CHUNK': {
          const job = jobs.get(msg.jobId);
          if (job) {
            // Bytes travel as base64: binary payloads are not transferred by
            // extension messaging (they arrive as empty objects), strings are.
            job.received += msg.n;
            offMsg({ type: 'PHD:OFF_CHUNK', jobId: msg.jobId, b64: msg.b64, n: msg.n });
          }
          return { ok: true };
        }
        case 'PHD:GET_JOB': {
          const j = jobs.get(msg.jobId);
          if (!j) return { ok: false, error: 'unknown job' };
          return {
            ok: true, state: j.state,
            received: j.received, total: j.total,
            progress: j.total ? Math.min(1, j.received / j.total) : null,
            error: j.error || null, downloadId: j.downloadId || null,
            part: j.part || null, partsTotal: j.partsTotal || null,
          };
        }
        case MSG.DOWNLOAD:
          return await handleDownload(msg, sender);
        case MSG.CANCEL: {
          const job = jobs.get(msg.jobId);
          if (job) {
            job.cancelled = true;
            if (job.tabId != null) {
              try { chrome.tabs.sendMessage(job.tabId, { type: 'PHD:PAGE_CANCEL', jobId: job.jobId }).catch(() => {}); } catch { /* tab gone */ }
            }
            if (job.state === 'assembling') {
              job.state = 'cancelled';
              job.error = 'Cancelled by user.';
              broadcastEvent(job, 'cancelled');
              scheduleRelease(job);
            } else if (job.downloadId != null) {
              try { await chrome.downloads.cancel(job.downloadId); } catch { /* gone */ }
              job.state = 'cancelled';
              job.error = 'Cancelled by user.';
              broadcastEvent(job, 'cancelled');
              scheduleRelease(job);
            }
            return { ok: true };
          }
          if (msg.downloadId != null) {
            try { await chrome.downloads.cancel(msg.downloadId); return { ok: true }; } catch { return { ok: false, error: 'not found' }; }
          }
          return { ok: false, error: 'unknown job' };
        }
        case MSG.SET_HOST:
          if (msg.host) activeHost = msg.host;
          return { ok: true, host: activeHost };
        case MSG.GET_STATE:
          return {
            ok: true, host: activeHost, version: VERSION,
            jobs: [...jobs.values()].map((j) => ({
              jobId: j.jobId, title: j.title, state: j.state,
              received: j.received, total: j.total, downloadId: j.downloadId, error: j.error,
            })),
          };
        case MSG.PING:
          return { ok: true };
        default:
          return { ok: false, error: 'unknown message' };
      }
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  })().then(sendResponse);
  return true; // async response
});


// Re-adopt active jobs after a service-worker restart.
restoreJobs();
