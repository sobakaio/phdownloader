# PHDownloader

A Chrome extension (Manifest V3) that downloads premium videos from the PH
premium site while you are logged in. It reads the video page's player data,
offers every quality **720p and up**, and saves the video with the browser's
native **Save-as** dialog.

Several videos can download **in parallel** — from different tabs — and the
panel's **queue** shows every active download (with per-download progress and
a cancel button), synced across all tabs.

Extraction mirrors the proven logic of yt-dlp's PH premium extractor:
page HTML (your session) → `get_media` JSON (direct MP4s) / HLS masters →
media bytes → a local file.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Log in to the premium site in the same browser profile.

## Use

1. Open a premium video page.
2. The **⬇ Download video** chip appears (top right). Click it for the panel.
3. Pick a quality — the available formats are listed from highest to lowest resolution.
4. Click **Download** and choose the save location in the native dialog.
5. To download more videos, open their pages in other tabs and press
   **Download** there — both run in parallel. The panel's **⬇ Queue** section
   lists every download in the browser with its own progress bar and a ✕ to
   cancel it (the queue is the same in every tab).

Queue management (per row / bulk):

- Direct MP4 rows show live **speed** and **ETA**; the **Ⅱ / ▶** control pauses
  and resumes them through Chrome's download service.
- **✕** on an active row cancels that download.
- **↻** on a *cancelled* row restarts that download from the beginning.
- **✕** on a finished / failed / cancelled row removes that row from the queue.
- Search and the **All / Active / Done / Errors** filter narrow the queue without
  deleting hidden rows. The queue grows to the viewport and then scrolls inside.
- **Clear finished** removes all non-active rows at once; active downloads
  keep running. Finished rows auto-purge after an hour if left alone.

Status: `Queued` → `Assembling… X / ~Y (N%)` → `Downloading… size · speed · ETA`
→ `✔ Done`. Direct failures explicitly show `Direct MP4 failed → HLS fallback`.

**⚙ Settings** (in the panel, persisted per profile):

- *Filename template* — default `{title} - {quality}`.
- *Show panel automatically* — open the panel on every video page.
- *Ask where to save (Save As dialog)* — checked (default): the native dialog
  appears (for direct MP4 up front; for HLS after assembly) and the save
  always completes reliably. Unchecked: the file goes straight to Chrome's
  default downloads folder with the generated name. This mode additionally
  requires Chrome's global *"Ask where to save each file before downloading"*
  to be **off** (`chrome://settings/downloads`); with it on, dialog-less
  downloads hang after writing all bytes. (Known bad combo: on at least one
  machine — Chrome 151 + macOS 27 beta — *all* dialog-less saves hang, even
  plain page downloads; there, keep the dialog on.)
- *Hide HLS streams* — unchecked (default): show HLS fallback qualities in the
  picker. Check it to hide them; direct MP4 and DASH entries remain visible.
  Automatic HLS fallback is still available if a direct link fails.
- *Remember last quality* and *Quality profile* — remember a specific quality,
  or always choose the highest available, highest direct MP4, or highest HLS.
- *Desktop notifications* — notify on completion or failure; clicking a
  notification returns to the source video tab.
- *Maximum parallel downloads* — choose 1–4 or Unlimited (default: 3).

You can also right-click a PH video page and choose **Download with PHDownloader**
to open the panel.

## License and legal notice

The source code is released under the [MIT License](LICENSE). This license
covers only the PHDownloader source code; it does not grant rights to any
videos, website content, PH/Pornhub trademarks, accounts, or services. PHDownloader
is an independent project and is not affiliated with or endorsed by Pornhub.
Use it only with content you are authorized to access and save, and follow the
applicable website terms and copyright laws.

## Files and formats

| Source      | Output | Notes                                             |
|-------------|--------|---------------------------------------------------|
| Direct MP4  | `.mp4` | Primary path. Seekable, plays anywhere.           |
| HLS fallback| `.ts`  | Only if the CDN rejects the direct link even with a fresh token. Linear container — some players cannot seek it. Remux when needed: `ffmpeg -i in.ts -c copy in.mp4` (a few seconds, no re-encode). |

The suggested filename follows `{title} - {quality}` (e.g.
`My Video - 2160p.mp4`); the native dialog lets you change it.

## Why the download works the way it does (short version)

**Direct MP4** (primary path): the page's `get_media` JSON returns a *signed*
CDN URL (bound to your IP, valid ~2 h) that authenticates itself — no page
cookies or Origin header needed. The download item is created with that URL
immediately and **Chrome's own download service fetches the bytes** — no
intermediate blob, no RAM copy of the file. With the Save As dialog enabled
(default) the dialog shows up front, so you can queue several videos and leave.

**HLS / DASH fallback**: the premium CDN rejects requests made *by the
extension* (`Sec-Fetch-Site: none`), so the media bytes are fetched by the
**content script inside the page** and streamed to an offscreen document that
assembles the blob the browser saves at the end.

## Repository layout

```
manifest.json     MV3 manifest (permissions: downloads, storage, alarms, offscreen, scripting, tabs)
background.js     service worker: orchestration, token refresh, save pipeline
content.js        page panel + media pump (fetches in page context)
popup.html/js     toolbar popup: status for the active tab
offscreen.html/js offscreen document: multi-GB blob accumulators (one per job)
lib/page-parse.js player page / flashvars parsing
lib/m3u8.js       HLS parser (master + media playlists)
lib/mpd.js        DASH MPD parser (best-effort)
lib/names.js      quality labels + filename building
test/             unit tests for the lib/ parsers (plain Node, no deps)
```

## Development

Unit tests for the page / HLS / MPD parsers and filename helpers run on
plain Node (no dependencies):

```bash
node --test
```

## Troubleshooting

- **Panel missing** — reload the video page (content scripts need a page load).
- **"No media found"** — press **↻** in the panel (fresh page read), or re-login.
- **404 / 410 errors** — the link token expired mid-download; the extension
  re-fetches the page and retries automatically. If it fails twice, the error
  is shown in the panel. A network-level failure of a direct link (CDN flap)
  falls back to HLS of the same quality on its own.
- **Download stopped after I navigated the tab** — usually automatic: the
  extension resumes interrupted page pumps (up to 3 times per job). If the
  source tab was closed, or the navigation left the premium site, the job
  stops with an error — restart it from the queue (↻).
- **`.ts` plays jerkily / cannot seek** — that is a container property of
  MPEG-TS, not data corruption. Remux: `ffmpeg -i in.ts -c copy in.mp4`.
- **Very large files** — 4K files can exceed 1.5 GB; the extension keeps the
  bytes in one preallocated buffer in a dedicated offscreen process.
- **Parallel downloads** — each active job keeps its bytes in the offscreen
  process until the file is on disk (a few most-recent finished blobs are
  kept briefly). Two or three parallel 4K downloads are the realistic
  ceiling on modest RAM; 720p–1080p parallel is comfortable.

