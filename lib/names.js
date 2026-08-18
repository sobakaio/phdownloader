// names.js — filename construction and compact quality tokens.

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
    .replace(/\{title\}/gi, ctx.title || 'video')
    .replace(/\{quality\}/gi, ctx.quality || 'unknown')
    .replace(/\{id\}/gi, ctx.id || 'id');
  name = sanitizeFilename(name);
  return name ? `${name}.${ext}` : `video.${ext}`;
}

/** Compact quality token for {quality} in filenames. */
export function qualityToken(f) {
  if (f.height) return `${f.height}p`;
  if (f.width) return `${f.width}x${f.height || '?'}`;
  if (f.kind === 'direct') return 'mp4';
  return f.kind;
}
