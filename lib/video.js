// Private video providers.
//  - cloudflare: Cloudflare Stream with requireSignedURLs; we sign short-lived RS256 tokens locally.
//  - local: files kept outside the web root and streamed through /media/v/... with an HMAC-signed,
//    short-lived URL; access is re-checked on every range request. Good for testing and small sites.
import crypto from 'node:crypto';
import { config } from './config.js';

const b64u = (b) => Buffer.from(b).toString('base64url');

export function signLocalUrl(kind, id, userId) {
  const exp = Math.floor(Date.now() / 1000) + config.playbackTtlSeconds;
  const payload = `${kind}.${id}.${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', config.secret).update(payload).digest('base64url');
  return { url: `/media/v/${payload}.${sig}`, exp };
}
export function verifyLocalToken(tok) {
  const parts = String(tok).split('.');
  if (parts.length !== 5) return null;
  const [kind, id, userId, exp, sig] = parts;
  const payload = `${kind}.${id}.${userId}.${exp}`;
  const want = crypto.createHmac('sha256', config.secret).update(payload).digest();
  let got; try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  if (Number(exp) < Date.now() / 1000) return { expired: true };
  return { kind, id: Number(id), userId: Number(userId), exp: Number(exp) };
}

// ---- Cloudflare Stream ----
const cf = config.video.cf;
const cfApi = (p) => `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/stream${p}`;
async function cfFetch(p, opts = {}) {
  const r = await fetch(cfApi(p), { ...opts, headers: { Authorization: `Bearer ${cf.apiToken}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) { const e = new Error('Cloudflare Stream error: ' + JSON.stringify(j.errors || r.status)); e.status = 502; throw e; }
  return j.result;
}

export function signCloudflareToken(uid) {
  const pem = Buffer.from(cf.keyPem, 'base64').toString('utf8');
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.playbackTtlSeconds;
  const header = b64u(JSON.stringify({ alg: 'RS256', kid: cf.keyId }));
  const body = b64u(JSON.stringify({ sub: uid, kid: cf.keyId, exp, nbf: now - 30 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), pem).toString('base64url');
  const token = `${header}.${body}.${sig}`;
  return { token, exp, iframe: `https://customer-${cf.customerCode}.cloudflarestream.com/${token}/iframe` };
}

export const cloudflare = {
  configured: () => !!(cf.accountId && cf.apiToken && cf.customerCode && cf.keyId && cf.keyPem),
  // One-time upload URL the teacher's browser posts the file to (basic uploads up to 200 MB).
  async createDirectUpload(name) {
    const r = await cfFetch('/direct_upload', { method: 'POST', body: JSON.stringify({ maxDurationSeconds: 4 * 3600, requireSignedURLs: true, meta: { name } }) });
    return { uploadURL: r.uploadURL, uid: r.uid };
  },
  async get(uid) {
    if (!/^[a-f0-9]{32}$/i.test(uid)) { const e = new Error('Invalid video ID'); e.status = 400; throw e; }
    const v = await cfFetch(`/${uid}`);
    if (!v.requireSignedURLs) await cfFetch(`/${uid}`, { method: 'POST', body: JSON.stringify({ uid, requireSignedURLs: true }) });
    return { ready: !!v.readyToStream, duration: Math.round(v.duration > 0 ? v.duration : 0), status: v.status?.state || '' };
  },
};

// Playback descriptor handed to the browser.
export function playbackFor(kind, id, userId, provider, videoId) {
  if (provider === 'cloudflare') {
    const t = signCloudflareToken(videoId);
    return { provider, iframe: t.iframe, exp: t.exp };
  }
  const s = signLocalUrl(kind, id, userId);
  return { provider: 'local', src: s.url, exp: s.exp };
}
