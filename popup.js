// popup.js — small status/launcher for the active tab.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const status = document.getElementById('status');
  const toggle = document.getElementById('toggle');
  toggle.disabled = true;
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { status.textContent = 'Could not inspect the active tab.'; return; }
  if (!tab) { status.textContent = 'No active tab.'; return; }
  if (!tab.url) { status.textContent = 'Cannot read the tab URL.'; return; }

  let parsed;
  try { parsed = new URL(tab.url); } catch { status.textContent = 'Cannot read the tab URL.'; return; }
  const hostOk = /(^|\.)(pornhubpremium|pornhub)\.com$/.test(parsed.hostname);
  const videoPage = /view_video\.php|video\/show|\/embed\//.test(parsed.pathname + parsed.search);

  if (!hostOk) {
    status.textContent = 'Open a PH video page (while logged in).';
    return;
  }
  if (!videoPage) {
    status.textContent = 'This is not a video page. Open the video you want to download.';
    return;
  }

  let st = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      st = await chrome.tabs.sendMessage(tab.id, { type: 'PHD:POPUP_STATE' });
      if (st?.ready) break;
    } catch { /* content script may still be initializing */ }
    if (attempt < 4) await sleep(250);
  }
  if (!st?.ok || !st.ready) {
    status.textContent = 'Panel is still initializing — reload the video page if it does not appear.';
    toggle.textContent = 'Panel not ready';
    return;
  }

  toggle.disabled = false;
  const bits = [];
  if (st.title) bits.push(`“${st.title.slice(0, 60)}${st.title.length > 60 ? '…' : ''}”`);
  bits.push(st.infoReady ? `${st.formats || 0} formats found` : 'Reading video data…');
  if (st.jobState === 'queued') bits.push('queued');
  else if (st.jobState === 'working') bits.push('starting…');
  else if (st.jobState === 'assembling') bits.push('assembling segments…');
  else if (st.jobState === 'paused') bits.push('paused');
  else if (st.jobState === 'downloading') bits.push(`saving ${Math.round((st.progress || 0) * 100)}%`);
  else if (st.jobState === 'complete') bits.push('last download: done ✔');
  else if (st.jobState === 'cancelled') bits.push('cancelled — restart available');
  else if (st.jobState === 'error') bits.push(`error: ${st.error}`);
  status.textContent = bits.join(' · ');

  toggle.onclick = () => {
    chrome.tabs.sendMessage(tab.id, { type: 'PHD:TOGGLE_PANEL' }).catch(() => {});
    window.close();
  };
}
main();
