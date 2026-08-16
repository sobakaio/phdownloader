// popup.js — small status/launcher for the active tab.
async function main() {
  const status = document.getElementById('status');
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { return; }
  if (!tab) { status.textContent = 'No active tab.'; return; }
  if (!tab.url) { status.textContent = 'Cannot read the tab URL.'; return; }

  const host = new URL(tab.url).hostname;
  const hostOk = /(^|\.)(pornhubpremium|pornhub)\.com$/.test(host);
  const videoPage = /view_video\.php|video\/show|\/embed\//.test((tab.url || '').split('?')[0]);

  if (!hostOk) {
    status.textContent = 'Open a PH video page (while logged in).';
    return;
  }
  if (!videoPage) {
    status.textContent = 'This is not a video page. Open the video you want to download.';
    return;
  }

  let st = null;
  try {
    st = await chrome.tabs.sendMessage(tab.id, { type: 'PHD:POPUP_STATE' });
  } catch (e) {
    status.textContent = 'Panel not ready on this page — reload the video page.';
    return;
  }
  if (!st?.ok) { status.textContent = 'No response from the page panel.'; return; }

  const bits = [];
  if (st.title) bits.push(`“${st.title.slice(0, 60)}${st.title.length > 60 ? '…' : ''}”`);
  bits.push(`${st.formats || 0} formats found`);
  if (st.jobState === 'assembling') bits.push('assembling segments…');
  else if (st.jobState === 'downloading') bits.push(`saving ${Math.round((st.progress || 0) * 100)}%`);
  else if (st.jobState === 'complete') bits.push('last download: done ✔');
  else if (st.jobState === 'error') bits.push(`error: ${st.error}`);
  status.textContent = bits.join(' · ');

  document.getElementById('toggle').onclick = () => {
    chrome.tabs.sendMessage(tab.id, { type: 'PHD:TOGGLE_PANEL' }).catch(() => {});
    window.close();
  };
}
main();
