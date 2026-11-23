import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './lib/config.js';
import './lib/db.js';
import { createRouter } from './lib/router.js';
import { sendJson, serveFile, HttpError } from './lib/http.js';
import { registerPublic } from './routes/public.js';
import { registerAdmin } from './routes/admin.js';

if (config.production && !process.env.EMAIL_PROVIDER) {
  console.error('EMAIL_PROVIDER is not set. Set EMAIL_PROVIDER=resend (or =console to knowingly keep test mode).');
  process.exit(1);
}
const router = createRouter();
registerPublic(router);
registerAdmin(router);

const publicDir = path.join(config.root, 'public');
const indexHtml = () => fs.readFileSync(path.join(publicDir, 'index.html'));

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://embed.cloudflarestream.com",
  "style-src 'self'",
  "img-src 'self' data: blob: https://*.cloudflarestream.com https://videodelivery.net",
  "media-src 'self' blob:",
  "frame-src https://*.cloudflarestream.com https://iframe.videodelivery.net",
  "connect-src 'self' https://upload.cloudflarestream.com https://upload.videodelivery.net https://*.cloudflarestream.com",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), fullscreen=(self "https://iframe.videodelivery.net" "https://*.cloudflarestream.com")');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// CSRF defence for state-changing requests: the request must come from our own origin.
function sameOrigin(req) {
  const origin = req.headers.origin;
  const allowed = new Set([config.baseUrl]);
  const host = req.headers.host;
  if (!config.production && host) { allowed.add(`http://${host}`); allowed.add(`https://${host}`); }
  if (origin) return allowed.has(origin);
  return req.headers['sec-fetch-site'] === 'same-origin';
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  const pathname = url.pathname;
  try {
    if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) throw new HttpError(403, 'bad_origin', 'Cross-site request blocked.');
    const m = router.match(req.method, pathname);
    if (m?.methodNotAllowed) throw new HttpError(405, 'method_not_allowed');
    if (m?.badRequest) throw new HttpError(400, 'bad_request');
    if (m) return await m.handler(req, res, m.params);
    if (pathname.startsWith('/api/') || pathname.startsWith('/media/')) throw new HttpError(404, 'not_found', 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    // Static assets
    let rel; try { rel = decodeURIComponent(pathname).slice(1); } catch { throw new HttpError(400, 'bad_request'); }
    if (pathname !== '/' && serveFile(req, res, publicDir, rel, {
      cache: /\.(js|css|svg|png|webmanifest)$/.test(pathname) ? 'public, max-age=300, must-revalidate' : 'no-cache',
    })) return;
    if (/\.[a-z0-9]{2,5}$/i.test(pathname)) throw new HttpError(404, 'not_found');
    // SPA fallback
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : indexHtml());
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    const status = e instanceof HttpError ? e.status : e.status && e.status < 600 ? e.status : 500;
    if (status >= 500) console.error(e);
    const headers = e.extra?.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {};
    sendJson(res, status, { error: e.code || 'server_error', message: status >= 500 && !(e instanceof HttpError) ? 'Something went wrong. Please try again.' : e.message, ...(e.extra || {}) }, headers);
  }
});

// requestTimeout stays off so long teacher uploads on slow connections can finish; small request
// bodies have their own 30 s deadline (readBody) and uploads require a teacher session first.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(config.port, config.host, () => {
  console.log(`Math course site on ${config.baseUrl} (video: ${config.video.provider}, email: ${config.email.provider})`);
});
export default server;
