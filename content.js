// content.js — in-page download panel for PH(Premium) video pages.
// Classic script (no modules): UI only; all network work happens in the SW.
(() => {
  'use strict';
  if (window.__phpdLoaded) return;
  window.__phpdLoaded = true;

  const MSG = { GET_INFO: 'PHD:GET_INFO', DOWNLOAD: 'PHD:DOWNLOAD', CANCEL: 'PHD:CANCEL', PAUSE: 'PHD:PAUSE', RESUME: 'PHD:RESUME', SET_HOST: 'PHD:SET_HOST', EVENT: 'PHD:EVENT', GET_QUEUE: 'PHD:GET_QUEUE', RESTART: 'PHD:RESTART', DELETE_JOB: 'PHD:DELETE_JOB', CLEAR_QUEUE: 'PHD:CLEAR_QUEUE' };
  const QUEUE_TERMINAL = new Set(['complete', 'error', 'cancelled']);
  const QUEUE_ACTIVE = new Set(['queued', 'working', 'assembling', 'downloading', 'paused']);
  const QUEUE_RUNNING = new Set(['working', 'assembling', 'downloading']);
  const host = location.hostname.endsWith('pornhubpremium.com') ? 'pornhubpremium.com' : 'pornhub.com';
  const isVideoPage = /view_video\.php|video\/show|\/embed\//.test(location.pathname + location.search);

  const state = {
    settings: {
      filenameTemplate: '{title} - {quality}', autoShowPanel: true, saveAs: true, hideHls: false,
      rememberQuality: true, lastQualityKey: null, qualityProfile: 'remembered', notifications: true, maxParallel: 3,
    },
    info: null,          // {ok,title,duration,formats,notes,error}
    jobId: null,         // the job THIS tab started (drives the main status area)
    jobState: 'idle',    // idle|working|assembling|downloading|complete|error|cancelled
    received: 0, total: null, progress: null, error: null, part: null, partsTotal: null,
    queue: {},           // jobId -> job snapshot (all tabs' jobs, synced from the SW)
    panelOpen: false,
    queueOpen: false,
    queueQuery: '',
    queueFilter: 'all',
  };

  let root = null;       // shadow root
  const el = {};         // element refs

  function send(msg) { return chrome.runtime.sendMessage(msg); }

  // ------------------------------------------------------------------ UI

  const CSS = `
    :host {
      all: initial;
      --accent: rgb(255, 153, 0);
      --accent-hover: rgb(255, 153, 0);
      --accent-soft: rgb(255, 153, 0);
      --panel: rgb(16, 16, 16);
      --panel-raised: #1b1c22;
      --surface: #101116;
      --line: #30313a;
      --muted: #92939e;
      --text: #f1f1f4;
    }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    .chip {
      position: fixed; top: 68px; right: 14px; z-index: 2147483647; cursor: pointer;
      background: #15161b; color: var(--text); border: 1px solid var(--line); border-radius: 999px;
      padding: 6px 12px; font-size: 12px; font-weight: 600; user-select: none;
      box-shadow: 0 4px 16px rgba(0,0,0,.42); transition: border-color .15s, background .15s;
    }
    .chip:hover { background: #202128; border-color: var(--accent); }
    .panel {
      position: fixed; top: 104px; right: 14px; z-index: 2147483647; width: 344px; max-width: calc(100vw - 28px);
      background: var(--panel); color: var(--text); border: 1px solid #383942; border-radius: 14px;
      box-shadow: 0 14px 38px rgba(0,0,0,.62), 0 2px 8px rgba(0,0,0,.35);
      font-size: 13px; overflow: hidden;
    }
    .head {
      display:flex; align-items:center; justify-content:space-between; padding: 9px 11px;
      background: linear-gradient(135deg, #202128, #191a20); border-bottom: 1px solid #2c2d35; cursor:pointer;
    }
    .head b { font-size: 12px; letter-spacing:.25px; }
    .x { cursor:pointer; color:#9697a2; font-size:14px; line-height:1; padding:0 5px; transition:color .15s; }
    .acts { display:flex; align-items:center; }
    .x.refresh:hover { color:var(--accent); }
    .body { padding: 10px; display:flex; flex-direction:column; gap:8px; }
    .title { font-size:13px; font-weight:650; line-height:1.3; max-height:3.9em; overflow:hidden; }
    .meta { color:var(--muted); font-size:11px; line-height:1.3; }
    .preview { color:#777985; font-size:10px; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    label.fld { display:flex; flex-direction:column; gap:4px; color:#c1c2ca; font-size:11px; }
    select, input[type=text], input[type=search] {
      background:var(--surface); color:var(--text); border:1px solid var(--line); border-radius:7px;
      padding:6px 8px; font-size:12px; width:100%; transition:border-color .15s, box-shadow .15s;
    }
    select:focus, input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 2px rgba(255,153,0,.16); }
    .row { display:flex; gap:7px; align-items:center; }
    .btns { display:flex; gap:7px; }
    button {
      flex:1; cursor:pointer; border:none; border-radius:8px; padding:8px 9px; font-size:12px; font-weight:650;
      transition:filter .15s, transform .1s, opacity .15s;
    }
    button:not(:disabled):active { transform:translateY(1px); }
    .dl {
      background:var(--accent); color:#fff;
      box-shadow:0 4px 12px rgba(255,153,0,.22);
    }
    .dl:hover { filter:brightness(1.1); }
    .dl:disabled { opacity:.42; cursor:default; box-shadow:none; }
    .cancel { background:#2a2b32; color:var(--text); flex:0 0 auto; padding:8px 12px; display:none; }
    .cancel:hover { background:#35363f; }
    .note { color:#fdcb6e; font-size:11px; line-height:1.35; }
    .chk { display:flex; gap:7px; align-items:center; color:#bfc0c8; font-size:11px; cursor:pointer; }
    .chk input[type=checkbox] { accent-color:var(--accent); margin:0; }
    .sect {
      display:flex; align-items:center; justify-content:space-between; padding:6px 9px; cursor:pointer;
      background:var(--surface); border:1px solid #292a32; border-radius:8px;
      color:#bfc0c8; font-size:11px; user-select:none; transition:border-color .15s, color .15s;
    }
    .sect:hover { color:var(--text); border-color:#454650; }
    .sect .chev { color:var(--accent); font-size:10px; }
    .sectblock { display:none; padding:8px 9px; flex-direction:column; gap:7px; background:#111217; border:1px solid #292a32; border-top:0; border-radius:0 0 8px 8px; }
    .qrow { display:flex; flex-direction:column; gap:4px; padding:7px; background:var(--panel-raised); border:1px solid #2b2c34; border-radius:8px; }
    .qrow + .qrow { margin-top:5px; }
    .qtop { display:flex; align-items:center; gap:7px; }
    .qtitle { flex:1; font-size:11px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .qcancel, .qpause { cursor:pointer; color:#9697a2; font-size:12px; padding:2px 4px; min-width:20px; text-align:center; flex:0 0 auto; transition:color .15s, background .15s; border-radius:5px; }
    .qcancel:hover { color:#ff7675; background:rgba(255,118,117,.1); }
    .qpause:hover { color:var(--accent); background:rgba(255,153,0,.1); }
    .qbarwrap { height:4px; background:#0c0d11; border-radius:4px; overflow:hidden; }
    .qbar { height:100%; width:0%; background:var(--accent); transition:width .25s; }
    .qbar.done { background:#00b894; }
    .qstat { color:var(--muted); font-size:10px; display:flex; justify-content:space-between; gap:7px; }
    .qstat .err { color:#ff7675; }
    .qstat .ok { color:#55efc4; }
    .qacts { display:flex; align-items:center; gap:8px; }
    .qclear { cursor:pointer; color:#9697a2; font-size:10px; padding:2px 6px; border:1px solid #393a43; border-radius:5px; transition:color .15s, border-color .15s; }
    .qclear:hover { color:var(--text); border-color:var(--accent); }
    .qstat .l { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .qdetail { color:#777985; font-size:10px; min-height:12px; }
    .qfallback { color:#fdcb6e; font-size:10px; line-height:1.2; }
    .qtools { display:none; flex-direction:row; gap:6px; }
    .qtools input { min-width:0; flex:1; }
    .qtools select { width:88px; flex:0 0 88px; }
    .queueList { max-height:calc(100vh - 230px); overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; }
    .qempty { color:#777985; font-size:11px; padding:8px 2px; text-align:center; }
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
    el.templatePreview = document.createElement('div'); el.templatePreview.className = 'preview';
    tLabel.appendChild(el.templatePreview);

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

    const rememberLabel = document.createElement('label'); rememberLabel.className = 'chk';
    el.rememberQualityChk = document.createElement('input'); el.rememberQualityChk.type = 'checkbox';
    el.rememberQualityChk.checked = state.settings.rememberQuality !== false;
    rememberLabel.append(el.rememberQualityChk, document.createTextNode('Remember last quality'));

    const notifyLabel = document.createElement('label'); notifyLabel.className = 'chk';
    el.notificationsChk = document.createElement('input'); el.notificationsChk.type = 'checkbox';
    el.notificationsChk.checked = state.settings.notifications !== false;
    notifyLabel.append(el.notificationsChk, document.createTextNode('Desktop notifications'));

    const profileLabel = document.createElement('label'); profileLabel.className = 'fld';
    profileLabel.append(document.createTextNode('Quality profile'));
    el.profileSelect = document.createElement('select');
    for (const [value, label] of [['remembered', 'Remembered quality'], ['highest', 'Highest available'], ['highest-direct', 'Highest direct MP4'], ['highest-hls', 'Highest HLS fallback']]) {
      const opt = document.createElement('option'); opt.value = value; opt.textContent = label; el.profileSelect.appendChild(opt);
    }
    el.profileSelect.value = state.settings.qualityProfile || 'remembered';
    profileLabel.appendChild(el.profileSelect);

    const parallelLabel = document.createElement('label'); parallelLabel.className = 'fld';
    parallelLabel.append(document.createTextNode('Maximum parallel downloads'));
    el.parallelSelect = document.createElement('select');
    for (const [value, label] of [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['0', 'Unlimited']]) {
      const opt = document.createElement('option'); opt.value = value; opt.textContent = label; el.parallelSelect.appendChild(opt);
    }
    el.parallelSelect.value = String(state.settings.maxParallel ?? 3);
    parallelLabel.appendChild(el.parallelSelect);

    el.settingsBlock.append(tLabel, aShow, sAs, hlsLabel, rememberLabel, notifyLabel, profileLabel, parallelLabel);

    // --- Queue (collapsible): all downloads across tabs ---
    el.queueHead = document.createElement('div'); el.queueHead.className = 'sect';
    el.queueCount = document.createElement('span');
    const ql = document.createElement('span');
    ql.append(document.createTextNode('⬇ Queue'), el.queueCount);
    el.clearBtn = document.createElement('span'); el.clearBtn.className = 'qclear';
    el.clearBtn.textContent = 'Clear finished'; el.clearBtn.style.display = 'none';
    el.clearBtn.title = 'Remove all done / failed / cancelled entries (active downloads keep running)';
    const qChev = document.createElement('span'); qChev.className = 'chev'; qChev.textContent = '▾';
    el.queueChev = qChev;
    const qr = document.createElement('span'); qr.className = 'qacts';
    qr.append(el.clearBtn, qChev);
    el.queueHead.append(ql, qr);
    el.queueTools = document.createElement('div'); el.queueTools.className = 'qtools';
    el.queueSearch = document.createElement('input'); el.queueSearch.type = 'search'; el.queueSearch.placeholder = 'Search queue…';
    el.queueFilter = document.createElement('select');
    for (const [value, label] of [['all', 'All'], ['active', 'Active'], ['done', 'Done'], ['errors', 'Errors']]) {
      const opt = document.createElement('option'); opt.value = value; opt.textContent = label; el.queueFilter.appendChild(opt);
    }
    el.queueTools.append(el.queueSearch, el.queueFilter);
    el.queueList = document.createElement('div'); el.queueList.className = 'sectblock queueList';
    el.clearBtn.addEventListener('click', (e) => { e.stopPropagation(); clearFinished(); });

    body.append(el.titleEl, el.meta, qLabel, el.btns,
      el.settingsHead, el.settingsBlock, el.queueHead, el.queueTools, el.queueList);
    el.panel.append(head, body);
    root.appendChild(el.panel);

    el.chip.addEventListener('click', () => setPanelOpen(!state.panelOpen));
    el.quality.addEventListener('change', () => {
      const f = selectedFormat();
      if (f && state.settings.rememberQuality !== false) {
        state.settings.lastQualityKey = qualityKey(f);
        persistSettings();
      }
      updateFilenamePreview();
    });
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
    el.templateInput.addEventListener('input', () => {
      state.settings.filenameTemplate = el.templateInput.value.trim() || '{title} - {quality}';
      updateFilenamePreview();
    });
    el.rememberQualityChk.addEventListener('change', () => {
      state.settings.rememberQuality = el.rememberQualityChk.checked;
      persistSettings();
      renderInfo();
    });
    el.notificationsChk.addEventListener('change', () => {
      state.settings.notifications = el.notificationsChk.checked;
      persistSettings();
    });
    el.parallelSelect.addEventListener('change', () => {
      state.settings.maxParallel = Number(el.parallelSelect.value);
      persistSettings();
    });
    el.profileSelect.addEventListener('change', () => {
      state.settings.qualityProfile = el.profileSelect.value;
      persistSettings();
      renderInfo();
    });
    el.queueSearch.addEventListener('input', () => {
      state.queueQuery = el.queueSearch.value.trim().toLowerCase();
      renderQueue();
    });
    el.queueFilter.addEventListener('change', () => {
      state.queueFilter = el.queueFilter.value;
      renderQueue();
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
        rememberQuality: state.settings.rememberQuality !== false,
        lastQualityKey: state.settings.lastQualityKey || null,
        qualityProfile: state.settings.qualityProfile || 'remembered',
        notifications: state.settings.notifications !== false,
        maxParallel: Number.isInteger(Number(state.settings.maxParallel)) ? Number(state.settings.maxParallel) : 3,
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

  function qualityKey(f) {
    if (!f) return '';
    return [f.kind, f.height ?? '', f.quality ?? '', f.width ?? '', f.bitrateK ?? '', f.trackId ?? '', f.container ?? ''].join('|');
  }

  function resolutionRank(f) {
    if (!f || f.kind === 'mpd-audio') return 0;
    return Number(f.height || f.quality || f.width || f.bandwidth || f.bitrateK || 0) || 0;
  }

  function formatKindRank(f) {
    return ({ direct: 0, hls: 1, mpd: 2, 'mpd-audio': 3 }[f?.kind] ?? 9);
  }

  function compareFormats(a, b) {
    const resolution = resolutionRank(b.f) - resolutionRank(a.f);
    return resolution || formatKindRank(a.f) - formatKindRank(b.f);
  }

  function selectedFormat() {
    if (!state.info?.formats || !el.quality) return null;
    const index = Number(el.quality.value);
    return Number.isInteger(index) ? state.info.formats[index] || null : null;
  }

  function updateFilenamePreview() {
    if (!el.templatePreview) return;
    const f = selectedFormat();
    const template = el.templateInput?.value.trim() || '{title} - {quality}';
    const title = state.info?.title || 'Video';
    const quality = f ? qualityLabel(f) : 'quality';
    const id = (location.search.match(/viewkey=([\w]+)/) || [])[1] || 'video';
    const ext = f?.kind === 'hls' ? (f.container === 'fmp4' ? 'mp4' : 'ts') : f?.kind === 'mpd-audio' ? 'm4a' : 'mp4';
    const preview = template.replace(/\{title\}/gi, title).replace(/\{quality\}/gi, quality).replace(/\{id\}/gi, id) + '.' + ext;
    el.templatePreview.textContent = 'Preview: ' + preview;
    el.templatePreview.title = preview;
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
      syncDownloadBtn();
      return;
    }
    el.titleEl.textContent = info.title || 'Video';
    const visible = info.formats.map((f, index) => ({ f, index }))
      .filter(({ f }) => !state.settings.hideHls || f.kind !== 'hls')
      .sort(compareFormats);
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
      const deadTag = f.kind === 'direct' && f.available === false ? ' · (probe failed)' : '';
      opt.textContent = bits.filter(Boolean).join(' · ') + srcTag + deadTag;
      el.quality.appendChild(opt);
    }
    if (!visible.length && info.formats.length) {
      const opt = document.createElement('option');
      opt.textContent = 'No visible formats — enable HLS in Settings';
      opt.disabled = true;
      opt.selected = true;
      el.quality.appendChild(opt);
    }
    // Choose the remembered quality or the selected quality profile.
    const remembered = state.settings.rememberQuality !== false
      ? visible.find(({ f }) => qualityKey(f) === state.settings.lastQualityKey) : null;
    const direct = visible.filter(({ f }) => f.kind === 'direct' && f.available !== false);
    const hls = visible.filter(({ f }) => f.kind === 'hls');
    const usable = visible.filter(({ f }) => f.kind !== 'direct' || f.available !== false);
    const highestAvailable = usable[0] || visible[0];
    const profile = state.settings.qualityProfile || 'remembered';
    const preferred = profile === 'highest-direct' ? (direct[0] || highestAvailable)
      : profile === 'highest-hls' ? (hls[0] || highestAvailable)
      : profile === 'highest' ? highestAvailable
      : direct[0] || highestAvailable;
    // The checkbox gates remembered-quality selection. Explicit profiles always
    // win; with Remember last quality off, the remembered profile falls back to
    // the highest usable direct format (then the first visible format).
    if (remembered && state.settings.rememberQuality !== false && profile === 'remembered') el.quality.value = String(remembered.index);
    else if (preferred) el.quality.value = String(preferred.index);
    updateFilenamePreview();
    syncDownloadBtn();
  }

  // Job progress/status is rendered ONLY in the queue cards below — this
  // function just toggles the Cancel button for the local job.
  function renderJob() {
    const s = state.jobState;
    el.cancelBtn.style.display = (s === 'queued' || s === 'assembling' || s === 'downloading' || s === 'paused' || s === 'working') ? '' : 'none';
  }
  // Download is disabled only while the start of THIS tab's job is pending
  // (state 'working'). Once the job is running (or failed/done) the button
  // comes back — a long or stuck save must not disable it forever.
  // Double-starts of the same video are rejected by the SW (one active job
  // per videoId), so re-enabling early is safe.
  function currentVideoId() {
    return (location.search.match(/viewkey=([\w]+)/) || [])[1] || '';
  }

  function currentQueueJob() {
    const id = currentVideoId();
    if (state.jobId && state.queue[state.jobId]) {
      const local = state.queue[state.jobId];
      if (!local.videoId || !id || local.videoId === id) return local;
    }

    if (!id) return null;
    return Object.values(state.queue).find((j) => j.videoId === id) || null;
  }

  function syncDownloadBtn() {
    if (!el.dlBtn) return;
    const q = currentQueueJob();
    if (q && ['queued', 'working', 'assembling', 'downloading'].includes(q.state)) {
      el.dlBtn.disabled = true;
      el.dlBtn.textContent = 'In queue';
      return;
    }
    if (q?.state === 'paused') {
      el.dlBtn.disabled = !el.quality?.options?.length || !Array.from(el.quality.options).some((o) => !o.disabled);
      el.dlBtn.textContent = 'Resume';
      return;
    }
    if (q?.state === 'cancelled') {
      el.dlBtn.disabled = !el.quality?.options?.length || !Array.from(el.quality.options).some((o) => !o.disabled);
      el.dlBtn.textContent = 'Restart';
      return;
    }
    const hasFormats = !!el.quality?.options?.length && Array.from(el.quality.options).some((o) => !o.disabled);
    el.dlBtn.disabled = !hasFormats || ['queued', 'working'].includes(state.jobState);
    el.dlBtn.textContent = 'Download';
  }

  // Global queue: every job across all tabs (data synced from the SW via
  // PHD:EVENT broadcasts + PHD:GET_QUEUE polls). Rendered in start order.
  function queueStateText(j) {
    switch (j.state) {
      case 'queued': return 'Queued';
      case 'working': return 'Starting…';
      case 'assembling': return j.partsTotal ? `Assembling ${j.part || 0}/${j.partsTotal}` : 'Assembling…';
      case 'downloading': return j.mode === 'direct' ? 'Downloading…' : 'Saving file…';
      case 'paused': return 'Paused';
      case 'complete': return '✔ Done';
      case 'error': return '✖ ' + (j.error || 'Error');
      case 'cancelled': return 'Cancelled';
      default: return j.state;
    }
  }

  function queueMatches(j) {
    const query = state.queueQuery;
    const haystack = [j.title, j.quality, j.state, j.fallback, j.error].filter(Boolean).join(' ').toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (state.queueFilter === 'active') return QUEUE_ACTIVE.has(j.state);
    if (state.queueFilter === 'done') return j.state === 'complete';
    if (state.queueFilter === 'errors') return j.state === 'error' || j.state === 'cancelled';
    return true;
  }

  function fmtRate(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    return fmtBytes(n) + '/s';
  }

  function fmtEta(s) {
    if (!Number.isFinite(s) || s < 0) return '';
    s = Math.round(s);
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); const sec = s % 60;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
    return `${sec}s`;
  }

  function renderQueue() {
    const all = Object.values(state.queue);
    const list = all.filter(queueMatches);
    const activeN = all.filter((j) => QUEUE_ACTIVE.has(j.state)).length;
    el.queueCount.textContent = all.length ? ` (${activeN ? activeN + ' active · ' : ''}${all.length})` : '';
    el.clearBtn.style.display = all.some((j) => QUEUE_TERMINAL.has(j.state)) ? '' : 'none';
    el.queueChev.textContent = state.queueOpen ? '▴' : '▾';
    el.queueTools.style.display = state.queueOpen && all.length ? 'flex' : 'none';
    el.queueList.style.display = state.queueOpen && all.length ? 'flex' : 'none';
    el.queueList.innerHTML = '';
    if (state.queueOpen && all.length && !list.length) {
      const empty = document.createElement('div'); empty.className = 'qempty'; empty.textContent = 'No matching downloads';
      el.queueList.appendChild(empty);
      return;
    }
    for (const j of list) {
      const row = document.createElement('div'); row.className = 'qrow';
      row.dataset.jobId = j.jobId;

      const top = document.createElement('div'); top.className = 'qtop';
      const t = document.createElement('div'); t.className = 'qtitle';
      t.textContent = j.title || 'Video'; t.title = j.title || '';
      top.appendChild(t);
      if (j.mode === 'direct' && (j.state === 'downloading' || j.state === 'paused')) {
        const p = document.createElement('span'); p.className = 'qpause'; p.textContent = j.state === 'paused' ? '▶' : 'Ⅱ';
        p.title = j.state === 'paused' ? 'Resume download' : 'Pause download';
        p.addEventListener('click', (e) => { e.stopPropagation(); togglePauseJob(j); });
        top.appendChild(p);
      }
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
      // Blob -> disk copies report no progress; direct downloads report live bytes.
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
      if ((j.state === 'assembling' || j.state === 'downloading' || j.state === 'paused') && j.total)
        right.textContent = `${fmtBytes(j.received || 0)} / ${fmtBytes(j.total)} · ${pct}%`;
      else if (j.state === 'assembling' && j.received) right.textContent = fmtBytes(j.received) + ' · ' + pct + '%';
      else if (j.state === 'complete' && j.total) right.textContent = fmtBytes(j.total);
      st.append(left, right);
      row.appendChild(st);

      if (j.fallback) {
        const fallback = document.createElement('div'); fallback.className = 'qfallback';
        fallback.textContent = '↪ ' + j.fallback;
        row.appendChild(fallback);
      }
      const detail = document.createElement('div'); detail.className = 'qdetail';
      const metrics = [];
      if (j.state === 'paused') metrics.push('Paused — resume when ready');
      else if (j.speed > 0 && (j.state === 'downloading' || j.state === 'assembling')) metrics.push(fmtRate(j.speed));
      if (j.etaSeconds != null && j.state !== 'paused') metrics.push('ETA ' + fmtEta(j.etaSeconds));
      detail.textContent = metrics.join(' · ');
      row.appendChild(detail);

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
          if (j.state === 'queued' && !['complete', 'error', 'cancelled'].includes(s)) state.jobState = 'queued';
          else if (j.state === 'working' && !['complete', 'error', 'cancelled'].includes(s)) state.jobState = 'working';
          else if (j.state === 'assembling' && !['complete', 'error', 'cancelled'].includes(s)) state.jobState = 'assembling';
          else if ((j.state === 'downloading' || j.state === 'paused') && !['complete', 'error', 'cancelled'].includes(s)) state.jobState = j.state;
          else if (j.state === 'error') state.jobState = 'error';
          else if (j.state === 'complete') state.jobState = 'complete';
          else if (j.state === 'cancelled') state.jobState = 'cancelled';
          if (state.jobState !== s) syncDownloadBtn();
          renderJob();
        }
      }
      for (const id of Object.keys(state.queue)) {
        if (!seen.has(id)) {
          delete state.queue[id];
          forgetCurrentJob(id);
        }
      }
      renderQueue();
      syncDownloadBtn();
    }
    const busy = QUEUE_RUNNING.has(state.jobState) || state.jobState === 'paused' || state.jobState === 'queued';
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
    const existing = currentQueueJob();
    if (existing && ['queued', 'working', 'assembling', 'downloading'].includes(existing.state)) {
      syncDownloadBtn();
      return;
    }
    if (existing?.state === 'paused') {
      state.jobId = existing.jobId;
      existing.state = 'downloading'; existing.paused = false;
      state.jobState = 'downloading';
      renderQueue(); renderJob(); syncDownloadBtn();
      const res = await send({ type: MSG.RESUME, jobId: existing.jobId }).catch((e) => ({ ok: false, error: e.message }));
      if (!res?.ok) {
        existing.state = 'paused'; existing.paused = true; state.jobState = 'paused';
        existing.error = res?.error || 'Could not resume download';
        renderQueue(); renderJob(); syncDownloadBtn();
      }
      kickPoll();
      return;
    }
    if (existing?.state === 'cancelled') {
      state.jobId = existing.jobId;
      await restartJobById(existing.jobId);
      return;
    }
    if (!state.info?.ok || !el.quality.value) return;
    const format = state.info.formats[Number(el.quality.value)];
    if (!format) return;
    const jobId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    state.jobId = jobId;
    state.jobState = 'queued';
    state.received = 0; state.total = null; state.progress = null; state.error = null; state.part = null; state.partsTotal = null;
    if (state.settings.rememberQuality !== false) {
      state.settings.lastQualityKey = qualityKey(format);
      persistSettings();
    }
    // Optimistic queue entry (the SW's queue poll completes it with quality).
    state.queue[jobId] = { jobId, videoId: currentVideoId(), title: state.info.title || 'Video', quality: qualityLabel(format), state: 'queued', received: 0, total: null, progress: null };
    state.queueOpen = true;
    syncDownloadBtn();
    renderJob();
    renderQueue();
    kickPoll();
    try {
      const res = await send({
        type: MSG.DOWNLOAD, jobId, format,
        pageUrl: location.href, host,
        template: state.settings.filenameTemplate,
        saveAs: state.settings.saveAs !== false,
        notify: state.settings.notifications !== false,
        title: state.info.title || 'video',
        id: currentVideoId(),
      });
      if (!res?.ok) {
        state.jobState = /cancel/i.test(res?.error || '') ? 'cancelled' : 'error';
        state.error = res?.error || 'Download failed to start';
        syncDownloadBtn();
      }
      // on success: keep the queue state until the first progress event.
    } catch (e) {
      state.jobState = 'error';
      state.error = e.message;
      syncDownloadBtn();
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

  async function togglePauseJob(job) {
    if (!job || job.mode !== 'direct' || !['downloading', 'paused'].includes(job.state)) return;
    const type = job.state === 'paused' ? MSG.RESUME : MSG.PAUSE;
    const res = await send({ type, jobId: job.jobId }).catch((e) => ({ ok: false, error: e.message }));
    if (!res?.ok) {
      job.error = res?.error || 'Could not change download state';
      renderQueue();
    }
    kickPoll();
  }

  // Queue management (queue rows, any job — including jobs from other tabs).

  async function restartJobById(jobId) {
    const q = state.queue[jobId];
    if (q) {
      q.state = 'queued'; q.error = null; q.received = 0; q.progress = null; q.part = null; q.partsTotal = null; q.paused = false; q.speed = 0; q.etaSeconds = null;
      if (q.videoId === currentVideoId() || jobId === state.jobId) {
        state.jobId = jobId; state.jobState = 'queued';
      }
      renderQueue(); renderJob(); syncDownloadBtn();
    }
    try {
      const res = await send({ type: MSG.RESTART, jobId });
      if (!res?.ok && q) {
        q.state = 'cancelled'; q.error = res?.error || 'Restart failed';
        if (jobId === state.jobId) state.jobState = 'cancelled';
        renderQueue(); renderJob(); syncDownloadBtn();
      }
    } catch (e) {
      if (q) {
        q.state = 'cancelled'; q.error = e.message || 'Restart failed';
        if (jobId === state.jobId) state.jobState = 'cancelled';
        renderQueue(); renderJob(); syncDownloadBtn();
      }
    }
    kickPoll();
  }

  function forgetCurrentJob(jobId) {
    if (state.jobId !== jobId) return;
    state.jobId = null;
    state.jobState = 'idle';
    state.received = 0; state.total = null; state.progress = null;
    state.error = null; state.part = null; state.partsTotal = null;
    renderJob();
    syncDownloadBtn();
  }

  async function deleteJobById(jobId) {
    try { await send({ type: MSG.DELETE_JOB, jobId }); } catch { /* ignore */ }
    delete state.queue[jobId];
    forgetCurrentJob(jobId);
    renderQueue();
    syncDownloadBtn();
    kickPoll();
  }

  async function clearFinished() {
    try { await send({ type: MSG.CLEAR_QUEUE }); } catch { /* ignore */ }
    for (const id of Object.keys(state.queue)) {
      if (QUEUE_TERMINAL.has(state.queue[id].state)) {
        delete state.queue[id];
        forgetCurrentJob(id);
      }
    }
    renderQueue();
    syncDownloadBtn();
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
          const r = await fetch(msg.url, { cache: 'no-store', headers: { Range: 'bytes=0-1' } });
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
          videoId: msg.videoId != null ? msg.videoId : prev.videoId,
          title: msg.title || prev.title || 'Video',
          state: msg.state,
          received: typeof msg.received === 'number' ? msg.received : prev.received,
          total: msg.total != null ? msg.total : prev.total,
          progress: msg.progress != null ? msg.progress : prev.progress,
          error: msg.error || prev.error,
          part: msg.part != null ? msg.part : prev.part,
          partsTotal: msg.partsTotal != null ? msg.partsTotal : prev.partsTotal,
          mode: msg.mode != null ? msg.mode : prev.mode,
          paused: msg.paused != null ? !!msg.paused : !!prev.paused,
          speed: msg.speed != null ? msg.speed : (prev.speed || 0),
          etaSeconds: msg.etaSeconds != null ? msg.etaSeconds : prev.etaSeconds,
          fallback: msg.fallback != null ? msg.fallback : prev.fallback,
        };
        renderQueue();
        syncDownloadBtn();
        kickPoll(); // reconcile full details (quality label) shortly
      }
      if (msg.jobId === state.jobId) {
        if (typeof msg.received === 'number') state.received = msg.received;
        if (msg.total != null) state.total = msg.total;
        if (msg.progress != null) state.progress = msg.progress;
        if (msg.error) state.error = msg.error;
        if (msg.part != null) state.part = msg.part;
        if (msg.partsTotal != null) state.partsTotal = msg.partsTotal;
        if (msg.event === 'progress' && !['complete', 'error', 'cancelled'].includes(state.jobState)) {
          state.jobState = msg.state === 'queued' ? 'queued' : msg.state === 'working' ? 'working' : msg.state === 'assembling' ? 'assembling' : msg.state === 'paused' ? 'paused' : 'downloading';
          if (msg.jobId === state.jobId) syncDownloadBtn();
        } else if (msg.event === 'complete') state.jobState = 'complete';
        else if (msg.event === 'error') state.jobState = 'error';
        else if (msg.event === 'cancelled') state.jobState = 'cancelled';
        renderJob();
        syncDownloadBtn();
      }
    } else if (msg.type === 'PHD:TOGGLE_PANEL') {
      setPanelOpen(!state.panelOpen);
    } else if (msg.type === 'PHD:SHOW_PANEL') {
      setPanelOpen(true);
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
    state.settings.maxParallel = Number.isInteger(Number(state.settings.maxParallel)) && Number(state.settings.maxParallel) >= 0
      ? Number(state.settings.maxParallel) : 3;
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
