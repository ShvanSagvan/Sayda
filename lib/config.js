// Central configuration, read from environment variables (see .env.example).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency). Real environment variables win.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;
const dataDir = path.resolve(root, env.DATA_DIR || 'data');
fs.mkdirSync(path.join(dataDir, 'private', 'videos'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'private', 'pdfs'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'public', 'img'), { recursive: true });

// Secret used to sign local playback URLs. Persisted so restarts don't break links.
function loadSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  const f = path.join(dataDir, 'private', '.app-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('base64url'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

const baseUrl = (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, '');

export const config = {
  root,
  dataDir,
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  baseUrl,
  production: env.NODE_ENV === 'production',
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy: env.TRUST_PROXY === 'cloudflare' ? 'cloudflare' : env.TRUST_PROXY === '1' ? '1' : '',
  secret: loadSecret(),
  rateScale: Math.max(1, Number(env.RATE_LIMIT_SCALE || 1)), // tests only: multiplies every rate limit
  sessionDays: Number(env.SESSION_DAYS || 30),
  playbackTtlSeconds: Number(env.PLAYBACK_TOKEN_TTL || 600),
  timezoneOffset: env.SITE_TZ_OFFSET || '+03:00', // Asia/Baghdad, no DST
  maxVideoBytes: Number(env.MAX_VIDEO_MB || 4096) * 1024 * 1024,
  email: {
    provider: env.EMAIL_PROVIDER || 'console', // console | resend
    from: env.EMAIL_FROM || 'Mathematics Course <no-reply@example.com>',
    resendKey: env.RESEND_API_KEY || '',
  },
  video: {
    provider: env.VIDEO_PROVIDER || 'local', // local | cloudflare
    cf: {
      accountId: env.CF_ACCOUNT_ID || '',
      apiToken: env.CF_STREAM_API_TOKEN || '',
      customerCode: env.CF_STREAM_CUSTOMER_CODE || '', // from customer-<code>.cloudflarestream.com
      keyId: env.CF_STREAM_KEY_ID || '',
      keyPem: env.CF_STREAM_KEY_PEM || '', // base64-encoded PEM as returned by /stream/keys
    },
  },
};
