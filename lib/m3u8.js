// m3u8.js — minimal M3U8 (HLS) parser for VOD playlists.
// Handles the shapes served by the PH CDN:
//   * master: #EXT-X-STREAM-INF attributes, variant URI as attribute OR on the next line
//   * media:  #EXT-X-MAP (fMP4 init), #EXTINF + URI on next line, #EXT-X-ENDLIST
// Pure: testable in Node.

export function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    let v = m[2];
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function nextNonComment(lines, i) {
  for (let j = i; j < lines.length; j++) {
    const l = lines[j].trim();
    if (l && !l.startsWith('#')) return l;
  }
  return null;
}

function resolveUri(uri, baseUrl) {
  if (!uri) return null;
  if (/^https?:\/\//i.test(uri)) return uri;
  try { return new URL(uri, baseUrl).toString(); } catch { return null; }
}

/**
 * @param {string} text playlist text
 * @param {string} baseUrl URL the playlist was fetched from
 * @returns {{isMaster:boolean,
 *            variants:{url:string, bandwidth:?number, width:?number, height:?number,
 *                      codecs:?string, frameRate:?number}[],
 *            segments:{url:string, duration:number}[],
 *            initUrl:?string, targetDuration:?number, endList:boolean, isFmp4:boolean}}
 */
export function parseM3U8(text, baseUrl) {
  const result = {
    isMaster: false, variants: [], segments: [],
    initUrl: null, targetDuration: null, endList: false, isFmp4: false,
  };
  if (typeof text !== 'string') return result;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#EXT')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        result.isMaster = true;
        const a = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
        const uri = a.URI || nextNonComment(lines, i + 1);
        if (uri) {
          const v = { url: resolveUri(uri, baseUrl), bandwidth: null, width: null, height: null, codecs: null, frameRate: null };
          if (a.BANDWIDTH) v.bandwidth = parseInt(a.BANDWIDTH, 10) || null;
          if (a.RESOLUTION) {
            const [w, h] = a.RESOLUTION.split('x');
            v.width = parseInt(w, 10) || null;
            v.height = parseInt(h, 10) || null;
          }
          if (a.CODECS) v.codecs = a.CODECS;
          if (a['FRAME-RATE']) v.frameRate = parseFloat(a['FRAME-RATE']) || null;
          result.variants.push(v);
          if (!a.URI) i++; // URI was on the next line: don't process it again
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(line.slice('#EXT-X-MAP:'.length));
        const u = resolveUri(a.URI, baseUrl);
        if (u) { result.initUrl = u; result.isFmp4 = true; }
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        result.targetDuration = parseInt(line.slice(21), 10) || null;
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        result.endList = true;
      }
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const dur = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
      const uri = nextNonComment(lines, i + 1);
      if (uri) {
        result.segments.push({ url: resolveUri(uri, baseUrl), duration: dur });
        i++;
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    // Bare URI line: variant in a master (no attrs) or a lone media segment.
    if (result.isMaster) {
      result.variants.push({ url: resolveUri(line, baseUrl), bandwidth: null, width: null, height: null, codecs: null, frameRate: null });
    } else {
      result.segments.push({ url: resolveUri(line, baseUrl), duration: result.targetDuration || 0 });
    }
  }
  return result;
}

/** Pick the variant matching a previously-listed format (by url), else the highest bandwidth. */
export function pickVariant(parsed, preferredUrl) {
  if (!parsed || !parsed.variants.length) return null;
  if (preferredUrl) {
    const hit = parsed.variants.find((v) => v.url === preferredUrl);
    if (hit) return hit;
  }
  return [...parsed.variants].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}
