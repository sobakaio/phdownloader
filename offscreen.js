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
// 8 MB chunks. This document is a full renderer process with enough memory
// to accumulate multi-GB files (chunk list, then one Blob whose URL the
// service worker passes to chrome.downloads).
//
// Protocol (all messages carry jobId):
//   PHD:OFF_INIT    {jobId, fresh}        start (or reset) accumulating
//   PHD:OFF_MARK    {jobId}               mark position (per-part rollback)
//   PHD:OFF_REVERT  {jobId}               discard bytes since the mark
//   PHD:OFF_CHUNK   {jobId, b64, n}        append n bytes (base64 payload)
//   PHD:OFF_FINISH  {jobId, mime}         build blob, post PHD:OFF_DONE
//   PHD:OFF_RELEASE {jobId}               free the blob memory
//   PHD:OFF_PING    {}                    readiness handshake
//   PHD:OFF_DONE    {jobId, ok, blobUrl?, size?, error?}

let acc = null; // active accumulator: { jobId, chunks, offset, mark, lastPost }
const kept = new Map(); // jobId -> { blobUrl, size }

const post = (msg) => { try { chrome.runtime.sendMessage(msg); } catch { /* SW asleep */ } };

function newAcc(jobId) {
  acc = { jobId, chunks: [], offset: 0, mark: null, lastPost: 0 };
}

function appendBytes(u8) {
  if (!acc) return;
  acc.chunks.push(u8);
  acc.offset += u8.length;
  const now = Date.now();
  if (now - acc.lastPost > 300) {
    acc.lastPost = now;
    post({ type: 'PHD:OFF_PROGRESS', jobId: acc.jobId, received: acc.offset, total: null });
  }
}

async function finishAcc(mime) {
  if (!acc) throw new Error('no active accumulation');
  const jobId = acc.jobId;
  const parts = acc.chunks.length ? acc.chunks : [new Uint8Array(0)];
  const blob = new Blob(parts, { type: mime || 'application/octet-stream' });
  const blobUrl = URL.createObjectURL(blob);
  acc = null;
  kept.set(jobId, { blobUrl, size: blob.size });
  // Bound retained blobs (3 most recent) — older ones are released here.
  let n = kept.size;
  for (const [id, b] of [...kept]) {
    if (n-- <= 3) break;
    URL.revokeObjectURL(b.blobUrl);
    kept.delete(id);
  }
  post({ type: 'PHD:OFF_DONE', jobId, ok: true, blobUrl, size: blob.size });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'PHD:OFF_INIT') {
    if (msg.fresh || !acc || acc.jobId !== msg.jobId) newAcc(msg.jobId);
    return;
  }
  if (msg?.type === 'PHD:OFF_MARK') {
    if (acc && acc.jobId === msg.jobId) acc.mark = { offset: acc.offset, idx: acc.chunks.length };
    return;
  }
  if (msg?.type === 'PHD:OFF_REVERT') {
    if (acc && acc.jobId === msg.jobId && acc.mark) {
      acc.chunks.length = acc.mark.idx;
      acc.offset = acc.mark.offset;
      acc.mark = null;
    }
    return;
  }
  if (msg?.type === 'PHD:OFF_CHUNK') {
    if (acc && acc.jobId === msg.jobId) {
      // Bytes arrive base64-encoded: binary payloads do not survive
      // content->SW->offscreen extension messaging (they degrade to {}),
      // strings do. Decode here, in the renderer where memory lives.
      const bin = atob(msg.b64);
      const u8 = new Uint8Array(msg.n || bin.length);
      for (let i = 0; i < u8.length; i++) u8[i] = bin.charCodeAt(i);
      appendBytes(u8);
    }
    return;
  }
  if (msg?.type === 'PHD:OFF_FINISH') {
    finishAcc(msg.mime).catch((e) => post({ type: 'PHD:OFF_DONE', jobId: msg.jobId, ok: false, error: (e && e.message) || String(e) }));
    return;
  }
  if (msg?.type === 'PHD:OFF_RELEASE') {
    const b = kept.get(msg.jobId);
    if (b) { URL.revokeObjectURL(b.blobUrl); kept.delete(msg.jobId); }
    if (acc && acc.jobId === msg.jobId) acc = null;
    return;
  }
  if (msg?.type === 'PHD:OFF_PING') {
    return Promise.resolve({ ok: true });
  }
});
