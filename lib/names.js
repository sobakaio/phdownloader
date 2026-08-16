// names.js — quality labels and filename construction.

const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

export function sanitizeFilename(s) {
  return String(s ?? '')
    .replace(BAD_CHARS, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[_\s]+|[_\s]+$/g, '')
    .slice(0, 180);
}

/**
 * Build a filename from a template with placeholders:
 *   {title} {quality} {id}
 * @param {string} template
 * @param {{title?:string, quality?:string, id?:string}} ctx
 * @param {string} ext  file extension without dot
 */
export function buildFilename(template, ctx, ext) {
  const t = String(template || '{title} - {quality}');
  let name = t
    .replace(/\{title\}/g, ctx.title || 'video')
    .replace(/\{quality\}/g, ctx.quality || 'unknown')
    .replace(/\{id\}/g, ctx.id || 'id');
  name = sanitizeFilename(name);
  return name ? `${name}.${ext}` : `video.${ext}`;
}

/** Human label for a format entry (used in the quality dropdown). */
export function formatLabel(f) {
  const bits = [];
  if (f.height) bits.push(`${f.height}p`);
  else if (f.width) bits.push(`${f.width}x${f.height || '?'}`);
  if (f.kind === 'hls') {
    bits.push(f.bandwidth ? `${Math.round(f.bandwidth / 1000)} kbps` : 'HLS');
    bits.push(f.isFmp4 ? 'fMP4' : 'TS');
  } else if (f.kind === 'mpd') {
    bits.push('DASH');
    if (!f.includesAudio) bits.push('video only');
  } else if (f.kind === 'direct') {
    bits.push('MP4 direct');
    if (f.bitrateK) bits.push(`${f.bitrateK} kbps`);
  }
  let label = bits.join(' · ') || 'unknown';
  if (f.recommended) label += '  (recommended)';
  return label;
}

/** Compact quality token for {quality} in filenames. */
export function qualityToken(f) {
  if (f.height) return `${f.height}p`;
  if (f.width) return `${f.width}x${f.height || '?'}`;
  if (f.kind === 'direct') return 'mp4';
  return f.kind;
}
