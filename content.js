// content.js — in-page download panel for PH(Premium) video pages.
// Classic script (no modules): UI only; all network work happens in the SW.
(() => {
  'use strict';
  if (window.__phpdLoaded) return;
  window.__phpdLoaded = true;

  const MSG = { GET_INFO: 'PHD:GET_INFO', DOWNLOAD: 'PHD:DOWNLOAD', CANCEL: 'PHD:CANCEL', SET_HOST: 'PHD:SET_HOST', EVENT: 'PHD:EVENT', GET_QUEUE: 'PHD:GET_QUEUE', RESTART: 'PHD:RESTART', DELETE_JOB: 'PHD:DELETE_JOB', CLEAR_QUEUE: 'PHD:CLEAR_QUEUE' };
  const QUEUE_TERMINAL = new Set(['complete', 'error', 'cancelled']);
  const host = location.hostname.endsWith('pornhubpremium.com') ? 'pornhubpremium.com' : 'pornhub.com';
  const isVideoPage = /view_video\.php|video\/show|\/embed\//.test(location.pathname + location.search);

  const state = {
    settings: { filenameTemplate: '{title} - {quality}', autoShowPanel: true, saveAs: true, hideHls: false },
    info: null,          // {ok,title,duration,formats,notes,error}
    jobId: null,         // the job THIS tab started (drives the main status area)
    jobState: 'idle',    // idle|working|assembling|downloading|complete|error|cancelled
    received: 0, total: null, progress: null, error: null, part: null, partsTotal: null,
    queue: {},           // jobId -> job snapshot (all tabs' jobs, synced from the SW)
    panelOpen: false,
    queueOpen: false,
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
    .note { color:#fdcb6e; font-size:12px; line-height:1.4; }
    .chk { display:flex; gap:7px; align-items:center; color:#b9b9c4; font-size:12px; cursor:pointer; }
    .chk input[type=checkbox] { accent-color:#6c5ce7; }
    .sect { display:flex; align-items:center; justify-content:space-between; padding:7px 12px; cursor:pointer;
      background:#101016; color:#b9b9c4; font-size:12px; user-select:none; }
    .sect:hover { color:#e8e8ee; }
    .sect .chev { color:#6c5ce7; font-size:11px; }
    .sectblock { display:none; padding:10px 12px; flex-direction:column; gap:9px; background:#101016; }
    .qrow { display:flex; flex-direction:column; gap:5px; padding:8px; background:#16161d; border:1px solid #2a2a33; border-radius:9px; }
    .qrow + .qrow { margin-top:6px; }
    .qtop { display:flex; align-items:center; gap:8px; }
    .qtitle { flex:1; font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .qcancel { cursor:pointer; color:#8a8a96; font-size:13px; padding:0 5px; flex:0 0 auto; }
    .qcancel:hover { color:#ff7675; }
    .qbarwrap { height:5px; background:#0f0f13; border-radius:4px; overflow:hidden; }
    .qbar { height:100%; width:0%; background:linear-gradient(90deg,#6c5ce7,#a29bfe); transition:width .25s; }
    .qbar.done { background:#00b894; }
    .qstat { color:#8a8a96; font-size:11px; display:flex; justify-content:space-between; gap:8px; }
    .qstat .err { color:#ff7675; }
    .qstat .ok { color:#55efc4; }
    .qacts { display:flex; align-items:center; gap:10px; }
    .qclear { cursor:pointer; color:#8a8a96; font-size:11px; padding:2px 7px; border:1px solid #34343f; border-radius:6px; }
    .qclear:hover { color:#e8e8ee; border-color:#6c5ce7; }
    .qstat .l { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  `;

  function buildUI() {
    const hostEl = document.createElement('div');
    hostEl.id = 'phpd-host';
    // 'open' shadow root: still fully style-isolated, but reachable from the
    // page's JS/automation tools (the panel keeps a stable id for that).
    root = hostEl.attachShadow({ mode: 'open' });
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

    // No progress bar or status line in this area: every job has its own
    // card with bar + status in the queue below (status lives there only).
    // Page-level problems are folded into the meta line.

    // --- Settings (collapsible): filename template, panel, save dialog ---
    el.settingsHead = document.createElement('div'); el.settingsHead.className = 'sect';
    el.settingsHead.innerHTML = '<span>⚙ Settings</span><span class="chev">▾</span>';
    el.settingsBlock = document.createElement('div'); el.settingsBlock.className = 'sectblock';

    const tLabel = document.createElement('label'); tLabel.className = 'fld';
    tLabel.append(document.createTextNode('Filename template'));
    el.templateInput = document.createElement('input'); el.templateInput.type = 'text';
    el.templateInput.value = state.settings.filenameTemplate;
    el.templateInput.placeholder = '{title} - {quality}';
    tLabel.appendChild(el.templateInput);

    const aShow = document.createElement('label'); aShow.className = 'chk';
    el.autoShowChk = document.createElement('input'); el.autoShowChk.type = 'checkbox';
    el.autoShowChk.checked = !!state.settings.autoShowPanel;
    aShow.append(el.autoShowChk, document.createTextNode('Show panel automatically'));

    // 'Ask where to save' — per-download Save As dialog (default ON).
    // OFF = no dialog, the file goes to Chrome's default downloads folder;
    // this mode needs Chrome's global "Ask where to save each file"
    // setting off (otherwise dialog-less saves hang — see background.js).
    const sAs = document.createElement('label'); sAs.className = 'chk';
    el.saveAsChk = document.createElement('input'); el.saveAsChk.type = 'checkbox';
    el.saveAsChk.checked = state.settings.saveAs !== false;
    sAs.append(el.saveAsChk, document.createTextNode('Ask where to save (Save As dialog)'));
    sAs.title = 'OFF: save without a dialog to Chrome\u2019s default downloads folder (Chrome\u2019s global \u201cAsk where to save each file\u201d setting must be off for this mode)';

    const hlsLabel = document.createElement('label'); hlsLabel.className = 'chk';
    el.hideHlsChk = document.createElement('input'); el.hideHlsChk.type = 'checkbox';
    el.hideHlsChk.checked = !!state.settings.hideHls;
    hlsLabel.append(el.hideHlsChk, document.createTextNode('Hide HLS streams'));
    hlsLabel.title = 'Hide HLS fallback streams from the quality list; direct MP4 downloads are unaffected.';

    el.settingsBlock.append(tLabel, aShow, sAs, hlsLabel);

    // --- Queue (collapsible): all downloads across tabs ---
    el.queueHead = document.createElement('div'); el.queueHead.className = 'sect';
    el.queueCount = document.createElement('span');
    const ql = document.createElement('span');
    ql.append(document.createTextNode('⬇ Queue'), el.queueCount);
    el.clearBtn = document.createElement('span'); el.clearBtn.className = 'qclear';
    el.clearBtn.textContent = 'Clear finished'; el.clearBtn.style.display = 'none';
    el.clearBtn.title = 'Remove all done / failed / cancelled entries (active downloads keep running)';
    const qChev = document.createElement('span'); qChev.className = 'chev'; qChev.textContent = '▾';
    const qr = document.createElement('span'); qr.className = 'qacts';
    qr.append(el.clearBtn, qChev);
    el.queueHead.append(ql, qr);
    el.queueList = document.createElement('div'); el.queueList.className = 'sectblock';
    el.clearBtn.addEventListener('click', (e) => { e.stopPropagation(); clearFinished(); });

    body.append(el.titleEl, el.meta, qLabel, el.btns,
      el.settingsHead, el.settingsBlock, el.queueHead, el.queueList);
    el.panel.append(head, body);
    root.appendChild(el.panel);

    el.chip.addEventListener('click', () => setPanelOpen(!state.panelOpen));
    el.dlBtn.addEventListener('click', startDownload);
    el.cancelBtn.addEventListener('click', cancelJob);
    el.settingsHead.addEventListener('click', () => {
      const open = el.settingsBlock.style.display !== 'flex';
      el.settingsBlock.style.display = open ? 'flex' : 'none';
      el.settingsHead.querySelector('.chev').textContent = open ? '▴' : '▾';
    });
    el.queueHead.addEventListener('click', () => {
      state.queueOpen = !state.queueOpen;
      renderQueue();
    });
    el.templateInput.addEventListener('change', () => {
      const v = el.templateInput.value.trim() || '{title} - {quality}';
      el.templateInput.value = v;
      state.settings.filenameTemplate = v;
      persistSettings();
    });
    el.autoShowChk.addEventListener('change', () => {
      state.settings.autoShowPanel = el.autoShowChk.checked;
      persistSettings();
    });
    el.saveAsChk.addEventListener('change', () => {
      state.settings.saveAs = el.saveAsChk.checked;
      persistSettings();
    });
    el.hideHlsChk.addEventListener('change', () => {
      state.settings.hideHls = el.hideHlsChk.checked;
      persistSettings();
      renderInfo();
    });
    document.documentElement.appendChild(hostEl);
  }

  function persistSettings() {
    try {
      chrome.storage.sync.set({
        filenameTemplate: state.settings.filenameTemplate,
        autoShowPanel: !!state.settings.autoShowPanel,
        saveAs: state.settings.saveAs !== false,
        hideHls: !!state.settings.hideHls,
      });
    } catch { /* storage unavailable */ }
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
    if (open) kickPoll();
  }

  function renderInfo() {
    const info = state.info;
    if (!info) return;
    if (!info.ok) {
      el.titleEl.textContent = 'Could not read this video';
      el.meta.textContent = info.error || 'Unknown error';
      el.quality.innerHTML = '';
      el.dlBtn.disabled = true;
      return;
    }
    el.titleEl.textContent = info.title || 'Video';
    const visible = info.formats.map((f, index) => ({ f, index }))
      .filter(({ f }) => !state.settings.hideHls || f.kind !== 'hls');
    const hiddenHls = info.formats.length - visible.length;
    el.meta.textContent = [info.duration ? fmtDur(info.duration) : null,
      `${visible.length} formats${hiddenHls ? ` · ${hiddenHls} HLS hidden` : ''}`,
      ...(info.notes || [])].filter(Boolean).join(' · ');
    el.quality.innerHTML = '';
    for (const { f, index } of visible) {
      const opt = document.createElement('option');
      opt.value = String(index);
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
    if (!visible.length && info.formats.length) {
      const opt = document.createElement('option');
      opt.textContent = 'No visible formats — enable HLS in Settings';
      opt.disabled = true;
      opt.selected = true;
      el.quality.appendChild(opt);
    }
    // Default selection: recommended visible format, otherwise the first one.
    const rec = visible.find(({ f }) => f.recommended);
    if (rec) el.quality.value = String(rec.index);
    else if (visible.length) el.quality.value = String(visible[0].index);
    el.dlBtn.disabled = !visible.length;
  }

  // Job progress/status is rendered ONLY in the queue cards below — this
  // function just toggles the Cancel button for the local job.
  function renderJob() {
    const s = state.jobState;
    el.cancelBtn.style.display = (s === 'assembling' || s === 'downloading' || s === 'working') ? '' : 'none';
  }
  // Download is disabled only while the start of THIS tab's job is pending
  // (state 'working'). Once the job is running (or failed/done) the button
  // comes back — a long or stuck save must not disable it forever.
  // Double-starts of the same video are rejected by the SW (one active job
  // per videoId), so re-enabling early is safe.
  function syncDownloadBtn() {
    el.dlBtn.disabled = state.jobState === 'working' || !state.info?.formats?.length;
  }

  // Global queue: every job across all tabs (data synced from the SW via
  // PHD:EVENT broadcasts + PHD:GET_QUEUE polls). Rendered in start order.
  const QUEUE_ACTIVE = new Set(['working', 'assembling', 'downloading']);
  function queueStateText(j) {
    switch (j.state) {
      case 'working': return 'Starting…';
      case 'assembling': return j.partsTotal ? `Assembling ${j.part || 0}/${j.partsTotal}` : 'Assembling…';
      case 'downloading': return j.mode === 'direct' ? 'Downloading…' : 'Saving file…';
      case 'complete': return '✔ Done';
      case 'error': return '✖ ' + (j.error || 'Error');
      case 'cancelled': return 'Cancelled';
      default: return j.state;
    }
  }
  function renderQueue() {
    const list = Object.values(state.queue);
    const activeN = list.filter((j) => QUEUE_ACTIVE.has(j.state)).length;
    el.queueCount.textContent = list.length ? ` (${activeN ? activeN + ' active · ' : ''}${list.length})` : '';
    el.clearBtn.style.display = list.some((j) => QUEUE_TERMINAL.has(j.state)) ? '' : 'none';
    el.queueList.style.display = state.queueOpen && list.length ? 'flex' : 'none';
    el.queueList.innerHTML = '';
    for (const j of list) {
      const row = document.createElement('div'); row.className = 'qrow';
      row.dataset.jobId = j.jobId;

      const top = document.createElement('div'); top.className = 'qtop';
      const t = document.createElement('div'); t.className = 'qtitle';
      t.textContent = j.title || 'Video'; t.title = j.title || '';
      top.appendChild(t);
      if (QUEUE_ACTIVE.has(j.state)) {
        const x = document.createElement('span'); x.className = 'qcancel'; x.textContent = '✕';
        x.title = 'Cancel this download';
        x.addEventListener('click', (e) => { e.stopPropagation(); cancelJobById(j.jobId); });
        top.appendChild(x);
      } else {
        // Terminal entries: cancelled ones can be restarted from scratch,
        // any terminal entry can be removed from the queue.
        if (j.state === 'cancelled') {
          const r = document.createElement('span'); r.className = 'qcancel'; r.textContent = '↻';
          r.title = 'Restart this download (from the beginning)';
          r.addEventListener('click', (e) => { e.stopPropagation(); restartJobById(j.jobId); });
          top.appendChild(r);
        }
        const d = document.createElement('span'); d.className = 'qcancel'; d.textContent = '✕';
        d.title = 'Remove from queue';
        d.addEventListener('click', (e) => { e.stopPropagation(); deleteJobById(j.jobId); });
        top.appendChild(d);
      }
      row.appendChild(top);

      const bw = document.createElement('div'); bw.className = 'qbarwrap';
      const bar = document.createElement('div'); bar.className = 'qbar' + (j.state === 'complete' ? ' done' : '');
      let pct = j.progress != null ? Math.round(j.progress * 100) : 0;
      // Blob -> disk copies report no progress (the browser doesn't track
      // blob saves), so they show full-width; direct CDN downloads stream
      // real per-second progress (reconcileDownload mirrors bytesReceived/total).
      if (j.state === 'complete' || (j.state === 'downloading' && j.mode !== 'direct')) pct = 100;
      if (j.state === 'error' || j.state === 'cancelled') pct = j.progress != null ? Math.round(j.progress * 100) : 0;
      bar.style.width = pct + '%';
      bw.appendChild(bar);
      row.appendChild(bw);

      const st = document.createElement('div'); st.className = 'qstat';
      const left = document.createElement('span'); left.className = 'l';
      left.textContent = [j.quality, queueStateText(j)].filter(Boolean).join(' · ');
      if (j.state === 'error' || j.state === 'cancelled') left.className = 'l err';
      else if (j.state === 'complete') left.className = 'l ok';
      const right = document.createElement('span');
      if (j.state === 'assembling' && j.total) right.textContent = `${fmtBytes(j.received)} / ${fmtBytes(j.total)} · ${pct}%`;
      else if (j.state === 'assembling' && j.received) right.textContent = fmtBytes(j.received) + ' · ' + pct + '%';
      else if (j.state === 'downloading' && j.mode === 'direct' && j.total)
        right.textContent = `${fmtBytes(j.received || 0)} / ${fmtBytes(j.total)} · ${pct}%`;
      else if (j.state === 'downloading' && j.total) right.textContent = fmtBytes(j.total);
      else if (j.state === 'complete' && j.total) right.textContent = fmtBytes(j.total);
      st.append(left, right);
      row.appendChild(st);

      el.queueList.appendChild(row);
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

  // Queue sync: the SW is the single source of truth for ALL jobs (any tab).
  // PHD:EVENT broadcasts give instant low-latency updates; this 1 s poll
  // reconciles the full queue (jobs started in other tabs, SW restarts, and
  // jobs the SW has released). One small message per second while the panel
  // is open — cheap.
  let pollTimer = null;
  let queueInitialized = false;
  async function pollQueue() {
    pollTimer = null;
    let jobs = null;
    try {
      const r = await send({ type: MSG.GET_QUEUE });
      if (r && r.ok) jobs = r.jobs || [];
    } catch { /* SW busy — retry next tick */ }
    if (jobs) {
      // On first queue sync, show existing entries immediately. Later polls
      // must not reopen a section the user deliberately collapsed.
      if (!queueInitialized) {
        queueInitialized = true;
        state.queueOpen = jobs.length > 0;
      }
      const seen = new Set();
      for (const j of jobs) {
        seen.add(j.jobId);
        state.queue[j.jobId] = { ...(state.queue[j.jobId] || {}), ...j };
        if (j.jobId === state.jobId) {
          if (j.received != null) state.received = j.received;
          if (j.total != null) state.total = j.total;
          if (j.progress != null) state.progress = j.progress;
          if (j.error) state.error = j.error;
          if (j.part != null) state.part = j.part;
          if (j.partsTotal != null) state.partsTotal = j.partsTotal;
          const s = state.jobState;
          if (j.state === 'assembling' && (s === 'working' || s === 'idle')) state.jobState = 'assembling';
          else if (j.state === 'downloading' && s !== 'downloading') state.jobState = 'downloading';
          else if (j.state === 'error') state.jobState = 'error';
          else if (j.state === 'complete') state.jobState = 'complete';
          else if (j.state === 'cancelled') state.jobState = 'cancelled';
          if (state.jobState !== s) syncDownloadBtn();
          renderJob();
        }
      }
      for (const id of Object.keys(state.queue)) if (!seen.has(id)) delete state.queue[id];
      renderQueue();
    }
    const busy = ['working', 'assembling', 'downloading'].includes(state.jobState);
    if (state.panelOpen || busy) pollTimer = setTimeout(pollQueue, 1000);
  }
  function kickPoll() {
    if (!pollTimer) pollTimer = setTimeout(pollQueue, 400);
  }

  function qualityLabel(f) {
    if (f.height) return `${f.height}p`;
    if (f.width) return `${f.width}x${f.height || '?'}`;
    if (f.kind === 'direct') return 'mp4';
    return f.kind;
  }

  async function startDownload() {
    if (!state.info?.ok || !el.quality.value) return;
    const format = state.info.formats[Number(el.quality.value)];
    if (!format) return;
    const jobId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    state.jobId = jobId;
    state.jobState = 'working';
    state.received = 0; state.total = null; state.progress = null; state.error = null; state.part = null; state.partsTotal = null;
    // Optimistic queue entry (the SW's queue poll completes it with quality).
    state.queue[jobId] = { jobId, title: state.info.title || 'Video', quality: qualityLabel(format), state: 'working', received: 0, total: null, progress: null };
    state.queueOpen = true;
    el.dlBtn.disabled = true;
    renderJob();
    renderQueue();
    kickPoll();
    try {
      const res = await send({
        type: MSG.DOWNLOAD, jobId, format,
        pageUrl: location.href, host,
        template: state.settings.filenameTemplate,
        saveAs: state.settings.saveAs !== false,
        title: state.info.title || 'video',
        id: (location.search.match(/viewkey=([\w]+)/) || [])[1] || '',
      });
      if (!res?.ok) {
        state.jobState = /cancel/i.test(res?.error || '') ? 'cancelled' : 'error';
        state.error = res?.error || 'Download failed to start';
        el.dlBtn.disabled = !state.info?.formats?.length;
      }
      // on success: keep 'working' until the first progress event tells us
      // whether we are assembling segments or saving a direct file.
    } catch (e) {
      state.jobState = 'error';
      state.error = e.message;
      el.dlBtn.disabled = !state.info?.formats?.length;
    }
    renderJob();
  }

  async function cancelJobById(jobId) {
    try { await send({ type: MSG.CANCEL, jobId }); } catch { /* ignore */ }
    const q = state.queue[jobId];
    if (q) { q.state = 'cancelled'; q.error = 'Cancelled.'; renderQueue(); }
    if (jobId === state.jobId) {
      state.jobState = 'cancelled';
      state.error = 'Cancelled.';
      renderJob();
    }
  }
  function cancelJob() {
    if (state.jobId) cancelJobById(state.jobId);
  }

  // Queue management (queue rows, any job — including jobs from other tabs).

  async function restartJobById(jobId) {
    const q = state.queue[jobId];
    if (q) {
      q.state = 'working'; q.error = null; q.received = 0; q.progress = null; q.part = null; q.partsTotal = null;
      renderQueue();
    }
    try {
      const res = await send({ type: MSG.RESTART, jobId });
      if (!res?.ok && q) { q.state = 'cancelled'; q.error = res?.error || 'Restart failed'; renderQueue(); }
    } catch (e) {
      if (q) { q.state = 'cancelled'; q.error = e.message || 'Restart failed'; renderQueue(); }
    }
    kickPoll();
  }

  async function deleteJobById(jobId) {
    try { await send({ type: MSG.DELETE_JOB, jobId }); } catch { /* ignore */ }
    delete state.queue[jobId];
    renderQueue();
  }

  async function clearFinished() {
    try { await send({ type: MSG.CLEAR_QUEUE }); } catch { /* ignore */ }
    for (const id of Object.keys(state.queue)) {
      if (QUEUE_TERMINAL.has(state.queue[id].state)) delete state.queue[id];
    }
    renderQueue();
    kickPoll();
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
  // One controller per job so parallel pumps in this tab don't clobber each
  // other (a single shared controller made canceling one job abort the rest).
  const pumpCtrls = new Map(); // jobId -> AbortController
  const pumpSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function b64FromU8(u8) {
    let bin = '';
    const N = 0x8000;
    for (let i = 0; i < u8.length; i += N) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + N));
    }
    return btoa(bin);
  }

  async function runPump({ jobId, url, offset }) {
    const ctrl = new AbortController();
    pumpCtrls.set(jobId, ctrl);
    let lastData = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > 45000) ctrl.abort();
    }, 5000);
    const host = new URL(url).host;
    // `offset` lets a re-injected pump (after its tab navigated) continue from
    // the bytes the offscreen accumulator already holds, instead of restarting.
    let sent = offset || 0; // raw bytes delivered before this pump (resume)
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
        // Verify a resume actually starts where we expect: if the server
        // ignored our Range header (plain 200 from byte 0), continuing would
        // duplicate the bytes already delivered. Reset the accumulator and
        // start over instead. Checked whenever this pump resumes mid-file
        // (sent > 0), including its very first attempt.
        if (sent > 0) {
          let bodyStart = (res.status === 206) ? sent : 0;
          const cr0 = res.headers.get('content-range');
          if (cr0) { const m0 = cr0.match(/^bytes (\d+)-/); if (m0) bodyStart = Number(m0[1]); }
          if (bodyStart !== sent) {
            try { chrome.runtime.sendMessage({ type: 'PHD:PAGE_RESET', jobId }); } catch { /* SW gone */ }
            sent = 0; metaSent = false;
          }
        }
        if (!totalBytes) {
          const cr = res.headers.get('content-range'); // "bytes a-b/TOTAL"
          if (cr) { const m = cr.match(/\/(\d+)\s*$/); if (m) totalBytes = Number(m[1]); }
          if (!totalBytes && sent === 0) totalBytes = Number(res.headers.get('content-length')) || 0;
        }
        if (totalBytes && !metaSent) {
          // `sent` is the true start of this stream (0 fresh, or the resume
          // offset; 0 again if a reset above restarted it).
          try { chrome.runtime.sendMessage({ type: 'PHD:PAGE_META', jobId, startOffset: sent, totalBytes }); } catch { /* SW gone */ }
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
        if (!streamError) return { ok: true, size: sent, totalBytes };
        lastError = streamError;
        await pumpSleep(500 * attempt);
      }
      return { ok: false, error: lastError || 'media fetch failed', size: sent };
    } finally {
      clearInterval(watchdog);
      pumpCtrls.delete(jobId);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'PHD:PAGE_FETCH') {
      return runPump(msg);
    }
    if (msg.type === 'PHD:PAGE_CANCEL') {
      if (msg.jobId) {
        // Cancel ONE job's pump; if it has no active pump, nothing to abort
        // (other jobs' pumps in this tab must keep running).
        const c2 = pumpCtrls.get(msg.jobId);
        if (c2) c2.abort();
      } else {
        for (const c2 of pumpCtrls.values()) c2.abort();
      }
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
    if (msg.type === MSG.EVENT && msg.jobId) {
      // Queue view: broadcasts reach EVERY tab's panel, so each one keeps a
      // live view of all downloads (cross-tab sync).
      if (msg.state) {
        const prev = state.queue[msg.jobId] || {};
        state.queue[msg.jobId] = {
          ...prev,
          jobId: msg.jobId,
          title: msg.title || prev.title || 'Video',
          state: msg.state,
          received: typeof msg.received === 'number' ? msg.received : prev.received,
          total: msg.total != null ? msg.total : prev.total,
          progress: msg.progress != null ? msg.progress : prev.progress,
          error: msg.error || prev.error,
          part: msg.part != null ? msg.part : prev.part,
          partsTotal: msg.partsTotal != null ? msg.partsTotal : prev.partsTotal,
          mode: msg.mode != null ? msg.mode : prev.mode,
        };
        renderQueue();
        kickPoll(); // reconcile full details (quality label) shortly
      }
      if (msg.jobId === state.jobId) {
        if (typeof msg.received === 'number') state.received = msg.received;
        if (msg.total != null) state.total = msg.total;
        if (msg.progress != null) state.progress = msg.progress;
        if (msg.error) state.error = msg.error;
        if (msg.part != null) state.part = msg.part;
        if (msg.partsTotal != null) state.partsTotal = msg.partsTotal;
        if (msg.event === 'progress' && (state.jobState === 'idle' || state.jobState === 'working')) {
          state.jobState = msg.state === 'assembling' ? 'assembling' : 'downloading';
          if (msg.jobId === state.jobId) syncDownloadBtn();
        } else if (msg.event === 'complete') state.jobState = 'complete';
        else if (msg.event === 'error') state.jobState = 'error';
        else if (msg.event === 'cancelled') state.jobState = 'cancelled';
        if (state.jobState === 'complete' || state.jobState === 'error' || state.jobState === 'cancelled') {
          el.dlBtn.disabled = !state.info?.formats?.length;
        }
        renderJob();
      }
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
    if (state.panelOpen) kickPoll();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else window.addEventListener('DOMContentLoaded', init);
})();
