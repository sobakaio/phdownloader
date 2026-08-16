// content.js — in-page download panel for PH(Premium) video pages.
// Classic script (no modules): UI only; all network work happens in the SW.
(() => {
  'use strict';
  if (window.__phpdLoaded) return;
  window.__phpdLoaded = true;

  const MSG = { GET_INFO: 'PHD:GET_INFO', DOWNLOAD: 'PHD:DOWNLOAD', CANCEL: 'PHD:CANCEL', SET_HOST: 'PHD:SET_HOST', EVENT: 'PHD:EVENT' };
  const host = location.hostname.endsWith('pornhubpremium.com') ? 'pornhubpremium.com' : 'pornhub.com';
  const isVideoPage = /view_video\.php|video\/show|\/embed\//.test(location.pathname + location.search);

  const state = {
    settings: { filenameTemplate: '{title} - {quality}', autoShowPanel: true },
    info: null,          // {ok,title,duration,formats,notes,error}
    jobId: null,
    jobState: 'idle',    // idle|working|assembling|downloading|complete|error|cancelled
    received: 0, total: null, progress: null, error: null, part: null, partsTotal: null,
    panelOpen: false,
  };

  let root = null;       // shadow root
  const el = {};         // element refs

  function send(msg) { return chrome.runtime.sendMessage(msg); }

  // ------------------------------------------------------------------ UI

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    .chip { position: fixed; top: 68px; right: 14px; z-index: 2147483647; cursor: pointer;
      background: #0f0f13; color: #fff; border: 1px solid #3a3a45; border-radius: 999px;
      padding: 7px 14px; font-size: 13px; user-select: none; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
    .chip:hover { background: #1c1c24; }
    .panel { position: fixed; top: 110px; right: 14px; z-index: 2147483647; width: 360px; max-width: calc(100vw - 28px);
      background: #14141a; color: #e8e8ee; border: 1px solid #34343f; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,.6); font-size: 13px; overflow: hidden; }
    .head { display:flex; align-items:center; justify-content:space-between; padding: 10px 12px; background:#1b1b23; cursor:pointer; }
    .head b { font-size: 13px; letter-spacing:.2px; }
    .x { cursor:pointer; color:#8a8a96; font-size:15px; padding:0 6px; }
    .acts { display:flex; }
    .x.refresh:hover { color:#6c5ce7; }
    .body { padding: 12px; display:flex; flex-direction:column; gap:10px; }
    .title { font-weight:600; line-height:1.35; max-height:3.9em; overflow:hidden; }
    .meta { color:#8a8a96; font-size:12px; }
    label.fld { display:flex; flex-direction:column; gap:4px; color:#b9b9c4; font-size:12px; }
    select, input[type=text] { background:#0f0f13; color:#e8e8ee; border:1px solid #3a3a45; border-radius:7px; padding:7px 8px; font-size:13px; width:100%; }
    select:focus, input:focus { outline:none; border-color:#6c5ce7; }
    .row { display:flex; gap:8px; align-items:center; }
    .btns { display:flex; gap:8px; }
    button { flex:1; cursor:pointer; border:none; border-radius:8px; padding:9px 10px; font-size:13px; font-weight:600; }
    .dl { background:#6c5ce7; color:white; } .dl:hover { background:#7d6ef0; } .dl:disabled { opacity:.45; cursor:default; }
    .cancel { background:#2a2a33; color:#e8e8ee; flex:0 0 auto; padding:9px 14px; display:none; }
    .barwrap { height:8px; background:#0f0f13; border-radius:5px; overflow:hidden; display:none; }
    .bar { height:100%; width:0%; background:linear-gradient(90deg,#6c5ce7,#a29bfe); transition:width .25s; }
    .status { color:#8a8a96; font-size:12px; min-height:1.3em; word-break:break-word; }
    .err { color:#ff7675; }
    .note { color:#fdcb6e; font-size:12px; line-height:1.4; }
    .chk { display:flex; gap:7px; align-items:center; color:#b9b9c4; font-size:12px; cursor:pointer; }
  `;

  function buildUI() {
    const hostEl = document.createElement('div');
    root = hostEl.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    el.chip = document.createElement('div');
    el.chip.className = 'chip';
    el.chip.textContent = '⬇ Download video';
    el.chip.title = 'PHDownloader';
    root.appendChild(el.chip);

    el.panel = document.createElement('div');
    el.panel.className = 'panel';
    el.panel.style.display = 'none';
    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = '<b>PHDownloader</b><span class="acts"><span class="x refresh" title="Re-read video data (fresh tokens)">↻</span><span class="x">✕</span></span>';
    head.addEventListener('click', (e) => {
      if (e.target.closest('.refresh')) { refresh(); return; }
      setPanelOpen(false);
    });

    const body = document.createElement('div');
    body.className = 'body';

    el.titleEl = document.createElement('div'); el.titleEl.className = 'title'; el.titleEl.textContent = 'Loading…';
    el.meta = document.createElement('div'); el.meta.className = 'meta';

    const qLabel = document.createElement('label'); qLabel.className = 'fld';
    qLabel.append(document.createTextNode('Quality'));
    el.quality = document.createElement('select');
    qLabel.appendChild(el.quality);

    el.btns = document.createElement('div'); el.btns.className = 'btns';
    el.dlBtn = document.createElement('button'); el.dlBtn.className = 'dl'; el.dlBtn.textContent = 'Download';
    el.cancelBtn = document.createElement('button'); el.cancelBtn.className = 'cancel'; el.cancelBtn.textContent = 'Cancel';
    el.btns.append(el.dlBtn, el.cancelBtn);

    el.barwrap = document.createElement('div'); el.barwrap.className = 'barwrap';
    el.bar = document.createElement('div'); el.bar.className = 'bar';
    el.barwrap.appendChild(el.bar);

    el.status = document.createElement('div'); el.status.className = 'status';

    body.append(el.titleEl, el.meta, qLabel, el.btns, el.barwrap, el.status);
    el.panel.append(head, body);
    root.appendChild(el.panel);

    el.chip.addEventListener('click', () => setPanelOpen(!state.panelOpen));
    el.dlBtn.addEventListener('click', startDownload);
    el.cancelBtn.addEventListener('click', cancelJob);
    document.documentElement.appendChild(hostEl);
  }

  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n)) return '?';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function fmtDur(s) {
    if (!s) return '';
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function setPanelOpen(open) {
    state.panelOpen = open;
    el.panel.style.display = open ? '' : 'none';
    el.chip.textContent = open ? '⬇ Hide panel' : '⬇ Download video';
  }

  function renderInfo() {
    const info = state.info;
    if (!info) return;
    if (!info.ok) {
      el.titleEl.textContent = 'Could not read this video';
      el.meta.textContent = '';
      el.quality.innerHTML = '';
      el.status.className = 'status err';
      el.status.textContent = info.error || 'Unknown error';
      el.dlBtn.disabled = true;
      return;
    }
    el.titleEl.textContent = info.title || 'Video';
    el.meta.textContent = [info.duration ? fmtDur(info.duration) : null, `${info.formats.length} formats`].filter(Boolean).join(' · ');
    el.quality.innerHTML = '';
    for (const f of info.formats) {
      const opt = document.createElement('option');
      opt.value = String(info.formats.indexOf(f));
      const bits = [];
      if (f.height) bits.push(`${f.height}p`); else if (f.width) bits.push(`${f.width}x${f.height || '?'}`);
      if (f.kind === 'hls') { bits.push(f.bandwidth ? `${Math.round(f.bandwidth / 1000)} kbps` : ''); bits.push('HLS'); }
      else if (f.kind === 'mpd') { bits.push('DASH' + (f.includesAudio ? '' : ' · video only')); }
      else if (f.kind === 'mpd-audio') { bits.push(`audio${f.bandwidth ? ` ${Math.round(f.bandwidth / 1000)}k` : ''}`); }
      else { bits.push('MP4 direct'); if (f.bitrateK) bits.push(`${f.bitrateK} kbps`); }
      const srcTag = f.source && !['get_media', 'mediaDefinitions'].includes(f.source) ? ` (${f.source})` : '';
      const deadTag = f.kind === 'direct' && f.available === false ? ' · (unavailable)' : '';
      opt.textContent = bits.filter(Boolean).join(' · ') + srcTag + deadTag + (f.recommended ? '   ★ recommended' : '');
      el.quality.appendChild(opt);
    }
    // default selection: recommended, else first
    const recIdx = info.formats.findIndex((f) => f.recommended);
    if (recIdx >= 0) el.quality.value = String(recIdx);
    el.dlBtn.disabled = !info.formats.length;
    el.status.className = 'status';
    el.status.textContent = info.notes?.length ? info.notes.join(' ') : '';
  }

  function renderJob() {
    const s = state.jobState;
    el.cancelBtn.style.display = (s === 'assembling' || s === 'downloading' || s === 'working') ? '' : 'none';
    if (s === 'idle') { el.barwrap.style.display = 'none'; return; }
    el.barwrap.style.display = '';
    const pct = state.progress != null ? Math.round(state.progress * 100) : (s === 'complete' ? 100 : 0);
    el.bar.style.width = `${pct}%`;
    if (s === 'working') {
      el.status.className = 'status';
      el.status.textContent = 'Starting…';
    } else if (s === 'assembling') {
      el.status.className = 'status';
      const seg = state.partsTotal ? ` · ${state.part || 0}/${state.partsTotal} seg` : '';
      el.status.textContent = `Assembling… ${fmtBytes(state.received)}${state.total ? ` / ~${fmtBytes(state.total)}` : ''}${seg} (${pct || 0}%)`;
    } else if (s === 'downloading') {
      // Blob-to-disk writes report no byte progress; show a flat status.
      el.status.className = 'status';
      el.status.textContent = `Saving file… writing to disk${state.total ? ` (${fmtBytes(state.total)})` : ''}`;
    } else if (s === 'complete') {
      el.bar.style.width = '100%';
      el.status.className = 'status';
      el.status.textContent = '✔ Done — check your downloads.';
    } else if (s === 'error' || s === 'cancelled') {
      el.status.className = 'status err';
      el.status.textContent = state.error || s;
    }
  }

  // ------------------------------------------------------------- actions

  async function refresh() {
    state.info = null;
    el.titleEl.textContent = 'Reading video data…';
    el.meta.textContent = '';
    el.quality.innerHTML = '<option>…</option>';
    el.dlBtn.disabled = true;
    try {
      const res = await send({ type: MSG.GET_INFO, url: location.href, host, title: document.title });
      state.info = res && res.ok ? res : (res || { ok: false, error: 'No response from extension background' });
    } catch (e) {
      state.info = { ok: false, error: e.message };
    }
    renderInfo();
  }

  // Fallback for environments where SW -> content-script messages are not
  // delivered (some automation/CDP setups): poll the SW for job state while a
  // job is active. Cheap: one small message per second.
  let pollTimer = null;
  async function pollJob() {
    if (!state.jobId) { pollTimer = null; return; }
    const s = state.jobState;
    if (s !== 'working' && s !== 'assembling' && s !== 'downloading') { pollTimer = null; return; }
    try {
      const r = await send({ type: 'PHD:GET_JOB', jobId: state.jobId });
      if (r && r.ok) {
        if (r.received != null) state.received = r.received;
        if (r.total != null) state.total = r.total;
        if (r.progress != null) state.progress = r.progress;
        if (r.error) state.error = r.error;
        if (r.part != null) state.part = r.part;
        if (r.partsTotal != null) state.partsTotal = r.partsTotal;
        if (r.state === 'assembling' && (s === 'working' || s === 'idle')) state.jobState = 'assembling';
        else if (r.state === 'downloading' && s !== 'downloading') state.jobState = 'downloading';
        else if (r.state === 'error') state.jobState = 'error';
        else if (r.state === 'complete') state.jobState = 'complete';
        renderJob();
      }
    } catch { /* SW busy — retry next tick */ }
    if (['working', 'assembling', 'downloading'].includes(state.jobState)) {
      pollTimer = setTimeout(pollJob, 1000);
    } else {
      pollTimer = null;
    }
  }

  async function startDownload() {
    if (!state.info?.ok || !el.quality.value) return;
    const format = state.info.formats[Number(el.quality.value)];
    if (!format) return;
    const jobId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    state.jobId = jobId;
    state.jobState = 'working';
    state.received = 0; state.total = null; state.progress = null; state.error = null; state.part = null; state.partsTotal = null;
    el.dlBtn.disabled = true;
    renderJob();
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    pollTimer = setTimeout(pollJob, 800);
    try {
      const res = await send({
        type: MSG.DOWNLOAD, jobId, format,
        pageUrl: location.href, host,
        template: state.settings.filenameTemplate,
        title: state.info.title || 'video',
        id: (location.search.match(/viewkey=([\w]+)/) || [])[1] || '',
      });
      if (!res?.ok) {
        state.jobState = 'error';
        state.error = res?.error || 'Download failed to start';
      }
      // on success: keep 'working' until the first progress event tells us
      // whether we are assembling segments or saving a direct file.
    } catch (e) {
      state.jobState = 'error';
      state.error = e.message;
    }
    renderJob();
  }

  async function cancelJob() {
    if (!state.jobId) return;
    try { await send({ type: MSG.CANCEL, jobId: state.jobId }); } catch { /* ignore */ }
    state.jobState = 'cancelled';
    state.error = 'Cancelled.';
    renderJob();
  }

  // ------------------------------------------- media pump (page context)
  // The premium CDN rejects requests made from extension contexts (their
  // Sec-Fetch-Site is always "none"). Fetches from the page context (this
  // script shares the page's network identity) are served normally. So the
  // media is fetched here and its bytes are streamed to the service worker.
  //
  // IMPORTANT: binary payloads (ArrayBuffer / TypedArray) do NOT survive
  // chrome.runtime messaging from a content script — verified live, even a
  // 64 KB buffer arrives at the SW as an empty plain object. Strings DO
  // survive. So each 1 MB chunk is base64-encoded here (~1.37 MB string) and
  // decoded in the offscreen accumulator. The pump resumes with a Range
  // request after any transient mid-stream failure.
  const PUMP_CHUNK = 1 * 1024 * 1024;
  const PUMP_MAX_ATTEMPTS = 8;
  let pumpCtrl = null;
  const pumpSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function b64FromU8(u8) {
    let bin = '';
    const N = 0x8000;
    for (let i = 0; i < u8.length; i += N) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + N));
    }
    return btoa(bin);
  }

  async function runPump({ jobId, url }) {
    const ctrl = new AbortController();
    pumpCtrl = ctrl;
    let lastData = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > 45000) ctrl.abort();
    }, 5000);
    const host = new URL(url).host;
    let sent = 0;        // total raw bytes delivered to the SW so far
    let totalBytes = 0;  // full file size (progress denominator), once known
    let metaSent = false;
    let lastError = '';
    try {
      for (let attempt = 1; attempt <= PUMP_MAX_ATTEMPTS; attempt++) {
        const headers = {};
        if (sent > 0) headers.Range = 'bytes=' + sent + '-';
        let res;
        try {
          res = await fetch(url, { signal: ctrl.signal, headers });
        } catch (e) {
          lastError = e.name === 'AbortError' ? 'network stalled while fetching media' : ((e && e.message) || String(e));
          await pumpSleep(500 * attempt);
          continue;
        }
        if (!res.ok && res.status !== 206) return { ok: false, error: 'HTTP ' + res.status + ' for ' + host };
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.startsWith('text/html')) return { ok: false, error: 'Server returned an HTML page, not media [' + host + '] (HTTP ' + res.status + ')' };
        if (!totalBytes) {
          const cr = res.headers.get('content-range'); // "bytes a-b/TOTAL"
          if (cr) { const m = cr.match(/\/(\d+)\s*$/); if (m) totalBytes = Number(m[1]); }
          if (!totalBytes && sent === 0) totalBytes = Number(res.headers.get('content-length')) || 0;
        }
        if (totalBytes && !metaSent) {
          try { chrome.runtime.sendMessage({ type: 'PHD:PAGE_META', jobId, startOffset: 0, totalBytes }); } catch { /* SW gone */ }
          metaSent = true;
        }
        const reader = res.body.getReader();
        let buf = new Uint8Array(PUMP_CHUNK);
        let off = 0;
        let streamError = null;
        for (;;) {
          let r;
          try { r = await reader.read(); } catch (e) { streamError = (e && e.message) || String(e); break; }
          const { done, value } = r;
          if (done) break;
          lastData = Date.now();
          let v = value, vs = 0;
          while (vs < v.length) {
            const space = PUMP_CHUNK - off;
            const take = Math.min(space, v.length - vs);
            buf.set(v.subarray(vs, vs + take), off);
            off += take; vs += take;
            if (off === PUMP_CHUNK) {
              chrome.runtime.sendMessage({ type: 'PHD:PAGE_CHUNK', jobId, b64: b64FromU8(buf), n: PUMP_CHUNK });
              sent += PUMP_CHUNK;
              off = 0;
            }
          }
        }
        if (off > 0) {
          const tail = buf.slice(0, off);
          chrome.runtime.sendMessage({ type: 'PHD:PAGE_CHUNK', jobId, b64: b64FromU8(tail), n: off });
          sent += off;
        }
        if (!streamError) {
          try { chrome.runtime.sendMessage({ type: 'PHD:PAGE_DONE', jobId, size: sent, totalBytes }); } catch { /* SW gone */ }
          return { ok: true, size: sent, totalBytes };
        }
        lastError = streamError;
        await pumpSleep(500 * attempt);
      }
      return { ok: false, error: lastError || 'media fetch failed', size: sent };
    } finally {
      clearInterval(watchdog);
      if (pumpCtrl === ctrl) pumpCtrl = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'PHD:PAGE_FETCH') {
      return runPump(msg);
    }
    if (msg.type === 'PHD:PAGE_CANCEL') {
      if (pumpCtrl) pumpCtrl.abort();
      return;
    }
    if (msg.type === 'PHD:PAGE_PROBE') {
      return (async () => {
        try {
          const r = await fetch(msg.url, { headers: { Range: 'bytes=0-1' } });
          const ct = (r.headers.get('content-type') || '').toLowerCase();
          return { ok: true, status: r.status, ct };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      })();
    }
  });

  // -------------------------------------------------------------- events

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === MSG.EVENT && msg.jobId === state.jobId) {
      if (typeof msg.received === 'number') state.received = msg.received;
      if (msg.total != null) state.total = msg.total;
      if (msg.progress != null) state.progress = msg.progress;
      if (msg.error) state.error = msg.error;
      if (msg.part != null) state.part = msg.part;
      if (msg.partsTotal != null) state.partsTotal = msg.partsTotal;
      if (msg.event === 'progress' && (state.jobState === 'idle' || state.jobState === 'working')) {
        state.jobState = msg.state === 'assembling' ? 'assembling' : 'downloading';
      } else if (msg.event === 'complete') state.jobState = 'complete';
      else if (msg.event === 'error') state.jobState = 'error';
      else if (msg.event === 'cancelled') state.jobState = 'cancelled';
      if (state.jobState === 'complete' || state.jobState === 'error' || state.jobState === 'cancelled') {
        el.dlBtn.disabled = !state.info?.formats?.length;
      }
      renderJob();
    } else if (msg.type === 'PHD:TOGGLE_PANEL') {
      setPanelOpen(!state.panelOpen);
    }
  });

  // popup asks for state — respond synchronously-ish
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'PHD:POPUP_STATE') {
      sendResponse({
        ok: true, isVideoPage, host,
        title: state.info?.title || null,
        jobState: state.jobState, progress: state.progress, error: state.error,
        panelOpen: state.panelOpen, formats: state.info?.formats?.length || 0,
      });
      return true;
    }
  });

  // ---------------------------------------------------------------- init

  async function init() {
    try {
      const s = await chrome.storage.sync.get(Object.keys(state.settings));
      Object.assign(state.settings, s);
    } catch { /* defaults */ }
    if (!isVideoPage) return;
    buildUI();
    setPanelOpen(!!state.settings.autoShowPanel);
    try { await send({ type: MSG.SET_HOST, host }); } catch { /* ignore */ }
    refresh();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else window.addEventListener('DOMContentLoaded', init);
})();
