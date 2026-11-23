import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { one, run } from './db.js';
import { parseCookies, cookie, HttpError } from './http.js';

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
export async function verifyPassword(pw, stored) {
  const [alg, n, r, p, salt, hash] = (stored || DUMMY).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const h = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(h, expected) && !!stored;
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'password_too_short';
  if (pw.length > 200) return 'password_too_long';
  return null;
}
export function normalizeEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

export function createSession(res, userId) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.sessionDays * 86400_000).toISOString();
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), userId);
  res.setHeader('Set-Cookie', cookie('sid', token, { maxAge: config.sessionDays * 86400 }));
}

export function destroySession(req, res) {
  const t = parseCookies(req).sid;
  if (t) run('DELETE FROM sessions WHERE token_hash = ?', sha256(t));
  res.setHeader('Set-Cookie', cookie('sid', '', { maxAge: 0 }));
}

export function currentUser(req) {
  if (req._user !== undefined) return req._user;
  const t = parseCookies(req).sid;
  let u = null;
  if (t && t.length < 100) {
    u = one(`SELECT u.id, u.name, u.email, u.role, u.grade, u.email_verified_at FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(t), new Date().toISOString()) || null;
  }
  req._user = u;
  return u;
}

export function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, 'auth_required', 'Please sign in.');
  return u;
}
// Server-side role check for every admin action.
export function requireAdmin(req) {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new HttpError(403, 'forbidden', 'Teacher access only.');
  return u;
}

export function issueAuthToken(userId, type, hours) {
  const token = randomToken(32);
  run(`UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND type = ? AND used_at IS NULL`, new Date().toISOString(), userId, type); // only the newest link works
  run('INSERT INTO auth_tokens (user_id, type, token_hash, expires_at) VALUES (?, ?, ?, ?)', userId, type, sha256(token), new Date(Date.now() + hours * 3600_000).toISOString());
  return token;
}
export function consumeAuthToken(token, type) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const row = one(`SELECT * FROM auth_tokens WHERE token_hash = ? AND type = ? AND used_at IS NULL AND expires_at > ?`, sha256(token), type, new Date().toISOString());
  if (!row) return null;
  run('UPDATE auth_tokens SET used_at = ? WHERE id = ?', new Date().toISOString(), row.id);
  return row;
}

setInterval(() => {
  const n = new Date().toISOString();
  run('DELETE FROM sessions WHERE expires_at < ?', n);
  run('DELETE FROM auth_tokens WHERE expires_at < ?', n);
}, 3600_000).unref();
