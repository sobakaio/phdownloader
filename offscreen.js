// offscreen.js — media accumulator for PHDownloader.
//
// Why the media bytes are NOT fetched here: the premium CDN validates the
// request's site relationship (Sec-Fetch-Site). Requests from extension
// contexts (service worker, offscreen document) always carry
// Sec-Fetch-Site: none and are rejected with 404, while requests made from
// the page context (the content script, which shares the page's network
// identity) are served normally.
//
// So the CONTENT SCRIPT performs the fetches and streams the bytes here in
// 1 MB chunks. This document is a full renderer process with enough memory
// to accumulate multi-GB files (chunk list, then one Blob whose URL the
// service worker hands to chrome.downloads). The file NAME is supplied by
// the SW's chrome.downloads.onDeterminingFilename handler (see
// background.js) — a bare blob: URL carries no filename of its own.
//
// There is ONE accumulator per active job (Map by jobId), so several
// downloads can run in parallel in this document.
//
// Protocol (all messages carry jobId):
//   PHD:OFF_INIT    {jobId, fresh}        start (or reset) accumulating
//   PHD:OFF_MARK    {jobId}               mark position (per-part rollback)
//   PHD:OFF_REVERT  {jobId}               discard bytes since the mark
//   PHD:OFF_CHUNK   {jobId, b64, n}        append n bytes (base64 payload)
//   PHD:OFF_FINISH  {jobId, mime}         build blob, post PHD:OFF_DONE
//   PHD:OFF_RELEASE {jobId}               free the blob/accumulator memory
//   PHD:OFF_PING    {}                    readiness handshake
//   PHD:OFF_DONE    {jobId, ok, blobUrl?, size?, error?}  (offscreen -> SW)
//
// Note: kept blobs are released ONLY when the SW sends PHD:OFF_RELEASE — the
// SW is the one that knows when the download service has finished reading.
// (An internal cap would evict a blob whose save is still running.)

// Active accumulators, one per job: jobId -> { chunks, offset, mark, lastPost }
const accs = new Map();
// Finished blobs not yet released: jobId -> { blob, blobUrl, size }
const kept = new Map();
// Finished blobs are saved by the SW via chrome.downloads (Save As dialog);
// nothing to do here except keep the blob alive until PHD:OFF_RELEASE.

const post = (msg) => { try { chrome.runtime.sendMessage(msg); } catch { /* SW asleep */ } };

function newAcc() {
  return { chunks: [], offset: 0, mark: null, lastPost: 0 };
}

function appendBytes(jobId, u8) {
  const acc = accs.get(jobId);
  if (!acc) return;
  acc.chunks.push(u8);
  acc.offset += u8.length;
  const now = Date.now();
  if (now - acc.lastPost > 300) {
    acc.lastPost = now;
    post({ type: 'PHD:OFF_PROGRESS', jobId, received: acc.offset, total: null });
  }
}

async function finishAcc(jobId, mime) {
  const acc = accs.get(jobId);
  if (!acc) throw new Error('no active accumulation for job');
  accs.delete(jobId);
  const parts = acc.chunks.length ? acc.chunks : [new Uint8Array(0)];
  const blob = new Blob(parts, { type: mime || 'application/octet-stream' });
  const blobUrl = URL.createObjectURL(blob);
  // Keep the blob itself: the SW may later stream it back for the save.
  // Release is driven by the SW (PHD:OFF_RELEASE) — it knows when the
  // download service is done reading.
  kept.set(jobId, { blob, blobUrl, size: blob.size });
  post({ type: 'PHD:OFF_DONE', jobId, ok: true, blobUrl, size: blob.size });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'PHD:OFF_INIT') {
    if (msg.fresh || !accs.has(msg.jobId)) accs.set(msg.jobId, newAcc());
    return;
  }
  if (msg?.type === 'PHD:OFF_MARK') {
    const acc = accs.get(msg.jobId);
    if (acc) acc.mark = { offset: acc.offset, idx: acc.chunks.length };
    return;
  }
  if (msg?.type === 'PHD:OFF_REVERT') {
    const acc = accs.get(msg.jobId);
    if (acc && acc.mark) {
      acc.chunks.length = acc.mark.idx;
      acc.offset = acc.mark.offset;
      acc.mark = null;
    }
    return;
  }
  if (msg?.type === 'PHD:OFF_CHUNK') {
    if (accs.has(msg.jobId)) {
      // Bytes arrive base64-encoded: binary payloads do not survive
      // content->SW->offscreen extension messaging (they degrade to {}),
      // strings do. Decode here, in the renderer where memory lives.
      const bin = atob(msg.b64);
      const u8 = new Uint8Array(msg.n || bin.length);
      for (let i = 0; i < u8.length; i++) u8[i] = bin.charCodeAt(i);
      appendBytes(msg.jobId, u8);
    }
    return;
  }
  if (msg?.type === 'PHD:OFF_FINISH') {
    finishAcc(msg.jobId, msg.mime).catch((e) => post({ type: 'PHD:OFF_DONE', jobId: msg.jobId, ok: false, error: (e && e.message) || String(e) }));
    return;
  }
  if (msg?.type === 'PHD:OFF_RELEASE') {
    const b = kept.get(msg.jobId);
    if (b) { URL.revokeObjectURL(b.blobUrl); kept.delete(msg.jobId); }
    accs.delete(msg.jobId);
    return;
  }
  if (msg?.type === 'PHD:OFF_PING') {
    return Promise.resolve({ ok: true });
  }
});
