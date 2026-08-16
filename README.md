# PHDownloader

A Chrome extension (Manifest V3) that downloads premium videos from the PH
premium site while you are logged in. It reads the video page's player data,
offers every quality **720p and up**, and saves the video with the browser's
native **Save-as** dialog.

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
3. Pick a quality — the highest direct MP4 is preselected (★).
4. Click **Download** and choose the save location in the native dialog.

Status: `Assembling… X / ~Y (N%)` → `Saving file… writing to disk (size)` → `✔ Done`.

## Files and formats

| Source      | Output | Notes                                             |
|-------------|--------|---------------------------------------------------|
| Direct MP4  | `.mp4` | Primary path. Seekable, plays anywhere.           |
| HLS fallback| `.ts`  | Only if the CDN rejects the direct link even with a fresh token. Linear container — some players cannot seek it. Remux when needed: `ffmpeg -i in.ts -c copy in.mp4` (a few seconds, no re-encode). |

The suggested filename follows `{title} - {quality}` (e.g.
`My Video - 2160p.mp4`); the native dialog lets you change it.

## Why the download works the way it does (short version)

The premium CDN checks the request's origin. Requests made *by the extension*
(service worker or offscreen document) are rejected (`Sec-Fetch-Site: none`),
so the media bytes are fetched by the **content script inside the page** and
streamed to an offscreen document that assembles the blob the browser saves.

## Repository layout

```
manifest.json     MV3 manifest (permissions: downloads, storage, alarms, offscreen, scripting, tabs)
background.js     service worker: orchestration, token refresh, save pipeline
content.js        page panel + media pump (fetches in page context)
popup.html/js     toolbar popup: status for the active tab
offscreen.html/js offscreen document: multi-GB blob accumulator
lib/page-parse.js player page / flashvars parsing
lib/m3u8.js       HLS parser (master + media playlists)
lib/mpd.js        DASH MPD parser (best-effort)
lib/names.js      quality labels + filename building
```

## Troubleshooting

- **Panel missing** — reload the video page (content scripts need a page load).
- **"No media found"** — press **↻** in the panel (fresh page read), or re-login.
- **404 / 410 errors** — the link token expired mid-download; the extension
  re-fetches the page and retries automatically. If it fails twice, the error
  is shown in the panel. A network-level failure of a direct link (CDN flap)
  falls back to HLS of the same quality on its own.
- **`.ts` plays jerkily / cannot seek** — that is a container property of
  MPEG-TS, not data corruption. Remux: `ffmpeg -i in.ts -c copy in.mp4`.
- **Very large files** — 4K files can exceed 1.5 GB; the extension keeps the
  bytes in one preallocated buffer in a dedicated offscreen process.

