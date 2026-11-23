import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}
export const bad = (code, msg, extra) => new HttpError(400, code, msg, extra);

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// Small bodies must arrive within 30 s (slow-drip protection; big uploads use streamToFile).
export async function readBody(req, limit = 1024 * 1024, deadlineMs = 30_000) {
  const chunks = []; let size = 0;
  const timer = setTimeout(() => req.destroy(new HttpError(408, 'timeout', 'Request took too long')), deadlineMs);
  try {
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'too_large', 'Request body too large');
      chunks.push(c);
    }
  } finally { clearTimeout(timer); }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const ct = req.headers['content-type'] || '';
  const buf = await readBody(req);
  if (!buf.length) return {};
  // sendBeacon posts text/plain; accept it but still require JSON.
  if (!ct.includes('application/json') && !ct.includes('text/plain')) throw bad('bad_content_type');
  try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : {}; }
  catch { throw bad('bad_json', 'Invalid JSON'); }
}

// Stream a request body to disk with a byte limit; removes the partial file on failure.
export function streamToFile(req, dest, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > limit) return reject(new HttpError(413, 'too_large', 'File too large'));
    const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    let size = 0; let failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fs.rm(dest, { force: true }, () => reject(e)); };
    req.on('data', (c) => { size += c.length; if (size > limit) { req.unpipe(out); req.resume(); fail(new HttpError(413, 'too_large', 'File too large')); } });
    req.on('aborted', () => fail(new HttpError(400, 'aborted', 'Upload interrupted')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (!failed) { if (size === 0) fail(bad('empty_file', 'Empty file')); else resolve(size); } });
    req.pipe(out);
  });
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ }
  }
  return out;
}

export function cookie(name, value, { maxAge, httpOnly = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (httpOnly) c += '; HttpOnly';
  if (config.secureCookies) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

// Client IP for rate limits. Proxy headers are only trusted when configured:
//  TRUST_PROXY=cloudflare -> CF-Connecting-IP (set the origin firewall to accept Cloudflare IPs only)
//  TRUST_PROXY=1          -> right-most X-Forwarded-For entry (the one added by your own proxy)
export function clientIp(req) {
  if (config.trustProxy === 'cloudflare' && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']).slice(0, 64);
  if (config.trustProxy === '1' && req.headers['x-forwarded-for']) {
    const parts = String(req.headers['x-forwarded-for']).split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return req.socket.remoteAddress || 'unknown';
}

// Simple fixed-window in-memory rate limiter.
const buckets = new Map();
function bucket(key, windowSec) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowSec * 1000 }; buckets.set(key, b); }
  return b;
}
const limited = (b) => new HttpError(429, 'rate_limited', 'Too many attempts. Please wait and try again.', { retryAfter: Math.ceil((b.reset - Date.now()) / 1000) });
export function rateLimit(key, max, windowSec) {
  const b = bucket(key, windowSec);
  b.n++;
  if (b.n > max * config.rateScale) throw limited(b);
}
// Check without counting (count separately with hit(), e.g. only failed logins).
export function checkLimit(key, max, windowSec) { const b = bucket(key, windowSec); if (b.n >= max * config.rateScale) throw limited(b); }
export function hit(key, windowSec) { bucket(key, windowSec).n++; }
setInterval(() => { const n = Date.now(); for (const [k, b] of buckets) if (b.reset < n) buckets.delete(k); }, 60_000).unref();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};
export const mimeFor = (f) => TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream';

// Serve a file from `baseDir` only (no traversal). Supports HTTP Range for media.
export function serveFile(req, res, baseDir, rel, { cache = 'no-cache', extraHeaders = {}, download } = {}) {
  const full = path.resolve(baseDir, '.' + path.sep + rel);
  if (!full.startsWith(path.resolve(baseDir) + path.sep)) return false;
  let st;
  try { st = fs.statSync(full); } catch { return false; }
  if (!st.isFile()) return false;
  const type = mimeFor(full);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes', ETag: etag, 'Last-Modified': st.mtime.toUTCString(), ...extraHeaders };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download.replace(/[^\w.\- ]/g, '_')}"`;
  if (req.headers['if-none-match'] === etag && !req.headers.range) { res.writeHead(304, headers); res.end(); return true; }
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start, end;
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, st.size - Number(m[2])); end = st.size - 1; }
      else { start = Number(m[1]); end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1); }
    }
    if (!m || isNaN(start) || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return true;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  return true;
}
