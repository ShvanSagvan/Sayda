// End-to-end + responsive test run across phone, tablet and desktop profiles.
// Uses Playwright's Chromium with device emulation (viewport, touch, user agent, orientation).
// NOTE: this is emulation — it does not replace a pass on real iPhone/iPad Safari (see TESTING.md).
// Usage: npm run test:devices      (needs ffmpeg + playwright)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const pw = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.mjs'));
const { chromium, devices } = pw;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.TEST_DATA_DIR || '/tmp/adabi-test';
const PORT = 3200, BASE = `http://localhost:${PORT}`;
const OUT = path.join(ROOT, 'tests', 'output');
const env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), QUIET: '1', PLAYBACK_TOKEN_TTL: '600', RATE_LIMIT_SCALE: '50' };
const node = (args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { env, cwd: ROOT, stdio: 'pipe' });

fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'screens'), { recursive: true });
node(['scripts/seed-demo.js']);
execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/create-admin.js', 'teacher@example.com', 'Teacher'], { env: { ...env, ADMIN_PASSWORD: 'teacher-pass-1' }, cwd: ROOT });
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { env, cwd: ROOT, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1200));
const db = new DatabaseSync(path.join(DATA, 'site.db'));
const q1 = (sql, ...p) => db.prepare(sql).get(...p);

// A real MP4 for the teacher upload test.
const uploadFile = path.join(DATA, 'upload-test.mp4');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=12', '-f', 'lavfi', '-i', 'sine=duration=12', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', uploadFile]);

const results = [];
function check(device, name, ok, detail = '') {
  results.push({ device, name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${device}] ${name}${detail ? ' — ' + detail : ''}`);
}
async function step(device, name, fn) {
  try { const r = await fn(); check(device, name, r !== false, typeof r === 'string' ? r : ''); return r; }
  catch (e) { check(device, name, false, e.message.split('\n')[0]); return false; }
}
const H = { Origin: BASE };

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

async function newCtx(desc) {
  const ctx = await browser.newContext({ ...desc, baseURL: BASE, permissions: ['clipboard-read', 'clipboard-write'] });
  ctx.waHits = [];
  await ctx.route(/https:\/\/(wa\.me|web\.whatsapp\.com|api\.whatsapp\.com)\//, (r) => { ctx.waHits.push(r.request().url()); r.fulfill({ status: 200, contentType: 'text/html', body: '<title>WhatsApp (stub)</title><h1>WhatsApp stub</h1>' }); });
  return ctx;
}
async function login(ctx, email, password) {
  const r = await ctx.request.post('/api/auth/login', { data: { email, password }, headers: H });
  if (!r.ok()) throw new Error('login failed ' + r.status());
}
async function makeStudent(tag, { approve = false } = {}) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const email = `${tag}-${Date.now()}@example.com`;
  await ctx.request.post('/api/auth/register', { data: { name: `Student ${tag}`, email, password: 'student-pass-1', grade: 10 }, headers: H });
  if (approve) {
    const e = await (await ctx.request.post('/api/me/enrollment', { data: { open_whatsapp: false }, headers: H })).json();
    const id = q1('SELECT id FROM enrollments WHERE reference = ?', e.enrollment.reference).id;
    await teacherApi.post(`/api/admin/enrollments/${id}/approve`, { data: { expires_date: '' }, headers: H });
  }
  await ctx.close();
  return email;
}
const teacherCtx0 = await browser.newContext({ baseURL: BASE });
await login(teacherCtx0, 'teacher@example.com', 'teacher-pass-1');
const teacherApi = teacherCtx0.request;

// ---------------- 1. Responsive sweep ----------------
const MATRIX = [
  ['iPhone SE', devices['iPhone SE']],
  ['iPhone 13', devices['iPhone 13']],
  ['iPhone 13 landscape', devices['iPhone 13 landscape']],
  ['iPhone 15 Pro Max', devices['iPhone 15 Pro Max'] || devices['iPhone 14 Pro Max']],
  ['iPad (gen 7)', devices['iPad (gen 7)']],
  ['iPad (gen 7) landscape', devices['iPad (gen 7) landscape']],
  ['iPad Pro 11 landscape', devices['iPad Pro 11 landscape']],
  ['iPad Mini', devices['iPad Mini']],
  ['Pixel 7', devices['Pixel 7']],
  ['Pixel 7 landscape', devices['Pixel 7 landscape']],
  ['Galaxy S9+', devices['Galaxy S9+']],
  ['Galaxy Tab S4 landscape', devices['Galaxy Tab S4 landscape']],
  ['Desktop Chrome 1366', { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } }],
  ['Desktop Edge 1920', { ...devices['Desktop Edge'], viewport: { width: 1920, height: 1080 } }],
  ['Desktop Safari 1440 (Mac UA)', { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } }],
];
const studentEmail = await makeStudent('sweep', { approve: true });
const pendingEmail = await makeStudent('sweep-pending');
{ const c = await browser.newContext({ baseURL: BASE }); await login(c, pendingEmail, 'student-pass-1'); await c.request.post('/api/me/enrollment', { data: { open_whatsapp: false }, headers: H }); await c.close(); }

const PAGES_STUDENT = ['/', '/grade/10', '/grade/12', '/lesson/1', '/textbooks', '/account'];
const PAGES_PENDING = ['/enroll'];
const PAGES_GUEST = ['/register', '/login', '/lesson/2'];
const PAGES_TEACHER = ['/admin', '/admin/enrollments', '/admin/course', '/admin/lessons/1', '/admin/textbooks', '/admin/settings'];

async function audit(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - vw;
    const wide = [...document.querySelectorAll('main *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1 && !el.closest('.table-wrap,.admin-nav,.filter-chips,.math-block'); }).slice(0, 3).map((el) => el.tagName + '.' + el.className);
    const small = [...document.querySelectorAll('main a, main button, main input:not([type=checkbox]):not([type=radio]):not([type=file]), main select, main summary, header a, header button')]
      .filter((el) => { const r = el.getBoundingClientRect(); if (!r.width || el.closest('p, .muted, .ref, .small, td, .lesson-body, pre, h3, legend')) return false; return r.height < 36 || r.width < 36; })
      .slice(0, 4).map((el) => `${el.tagName}"${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
    return { overflow, wide, small };
  });
}

for (const [name, desc] of process.env.SKIP_SWEEP ? [] : MATRIX) {
  const runs = [['guest', null, PAGES_GUEST], ['student', studentEmail, PAGES_STUDENT], ['pending', pendingEmail, PAGES_PENDING], ['teacher', 'teacher@example.com', PAGES_TEACHER]];
  for (const [role, email, pages] of runs) {
    const ctx = await newCtx(desc);
    if (email) await login(ctx, email, email.startsWith('teacher') ? 'teacher-pass-1' : 'student-pass-1');
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    for (const p of pages) {
      await page.goto(p); await page.locator('main .view').first().waitFor({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(150);
      const a = await audit(page);
      check(name, `${role} ${p}: no horizontal overflow`, a.overflow <= 1 && !a.wide.length, a.overflow > 1 ? `overflow ${a.overflow}px ${a.wide.join(', ')}` : a.wide.join(', '));
      if (a.small.length && desc.hasTouch) check(name, `${role} ${p}: touch targets ≥ 36px`, false, a.small.join('; '));
      await page.screenshot({ path: path.join(OUT, 'screens', `${name.replace(/[^\w]+/g, '_')}__${role}${p.replace(/\//g, '_')}.png`), fullPage: false });
    }
    check(name, `${role}: no JavaScript errors`, !errors.length, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }
}

// ---------------- 2. Full student + teacher flow per device class ----------------
const FLOW = [
  ['iPhone 13 (iOS Safari profile)', devices['iPhone 13']],
  ['iPad (gen 7) landscape', devices['iPad (gen 7) landscape']],
  ['Pixel 7 (Android Chrome profile)', devices['Pixel 7']],
  ['Desktop Chrome', { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } }],
  ['Desktop Edge', { ...devices['Desktop Edge'], viewport: { width: 1600, height: 900 } }],
  ['Desktop Safari (Mac UA)', { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } }],
];
const videoTime = (p) => p.evaluate(() => document.querySelector('.player video')?.currentTime || 0);
const videoPlaying = (p) => p.evaluate(() => { const v = document.querySelector('.player video'); return !!v && !v.paused && v.readyState >= 2; });

let flowIndex = 0;
for (const [dev, desc] of FLOW) {
  const i = flowIndex++;
  const ctx = await newCtx(desc);
  const p = await ctx.newPage();
  const email = `flow${i}-${Date.now()}@example.com`;
  const touch = !!desc.hasTouch;

  await step(dev, 'register with name, email, grade and password — no verification email needed', async () => {
    await p.goto('/lesson/3');
    await p.locator('main .notice').getByRole('link', { name: 'Create account' }).click();
    await p.getByLabel('Full name').fill(`Flow Student ${i}`);
    await p.getByLabel('Email').fill(email);
    await p.locator('input[name=password]').fill('flow-pass-123');
    await p.locator('main form').getByRole('button', { name: 'Create account' }).click(); // without a grade → error
    await p.getByText('Choose your grade.').first().waitFor();
    await p.locator('.grade-opt', { hasText: 'Grade 10' }).click();
    if (touch) await p.locator('main form').getByRole('button', { name: 'Create account' }).tap(); else await p.locator('input[name=password]').press('Enter');
    await p.waitForURL(/\/enroll/);
    await p.getByRole('button', { name: 'Pay via WhatsApp' }).waitFor();
    const u = q1('SELECT grade FROM users WHERE email = ?', email);
    const mail = q1(`SELECT COUNT(*) n FROM email_outbox WHERE to_email = ?`, email).n;
    return (u.grade === 10 && mail === 0) || JSON.stringify({ u, mail });
  });
  await step(dev, 'after signing in, return to the lesson the student was viewing', async () => {
    // Sign out and back in with ?next= to confirm the return path.
    await p.request.post('/api/auth/logout', { headers: H });
    await p.goto('/lesson/3');
    await p.locator('main .notice').getByRole('link', { name: 'Sign in' }).click();
    await p.getByLabel('Email').fill(email);
    await p.locator('input[name=password]').fill('flow-pass-123');
    await p.locator('input[name=password]').press('Enter');
    await p.waitForURL(/\/lesson\/3$/);
  });

  let ref;
  await step(dev, 'enroll page shows price, the student’s own grade, terms and the teacher’s WhatsApp number before paying', async () => {
    await p.goto('/enroll');
    await p.getByText('75,000').first().waitFor();
    await p.locator('main .chip', { hasText: 'Grade 10' }).first().waitFor();
    if (await p.locator('main .chip', { hasText: 'Grade 11' }).count()) return 'shows other grades';
    await p.getByText('Ongoing access').first().waitFor();
    await p.getByText('+964 750 000 0000').waitFor();
  });
  await step(dev, '“Pay via WhatsApp” creates a pending request and opens WhatsApp in a new tab (site stays open)', async () => {
    const btn = p.getByRole('button', { name: 'Pay via WhatsApp' });
    const [popup] = await Promise.all([ctx.waitForEvent('page'), touch ? btn.tap() : btn.click()]);
    await popup.waitForURL(/wa\.me/, { timeout: 10000 });
    const waUrl = popup.url();
    await popup.close();
    if (!p.url().endsWith('/enroll')) return 'site tab navigated away: ' + p.url();
    const e = q1(`SELECT e.* FROM enrollments e JOIN users u ON u.id = e.user_id WHERE u.email = ?`, email);
    ref = e.reference;
    const text = decodeURIComponent(new URL(waUrl).searchParams.get('text') || '');
    if (!waUrl.startsWith('https://wa.me/9647500000000')) return false;
    if (!text.includes(ref) || !text.includes('75,000') || !text.includes('FIB') || !text.includes(email) || !text.includes(`Flow Student ${i}`) || !text.includes('Grade 10')) return `message: ${text}`;
    return e.status === 'pending' || 'status ' + e.status;
  });
  await step(dev, 'status shows “Awaiting confirmation”; number and reference always visible', async () => {
    await p.getByRole('heading', { name: 'Awaiting confirmation' }).waitFor();
    await p.getByText(ref, { exact: true }).first().waitFor();
    await p.getByText('+964 750 000 0000').waitFor();
    await p.getByText('No WhatsApp on this device?').waitFor();
  });
  await step(dev, 'reference can be copied (for another device or a parent)', async () => {
    await p.getByRole('button', { name: 'Copy: Your enrollment reference' }).click();
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    return clip === ref || `clipboard=${clip}`;
  });
  await step(dev, 'reopening WhatsApp reuses the same reference', async () => {
    const link = p.getByRole('link', { name: 'Open WhatsApp again' });
    const href = await link.getAttribute('href');
    const [popup] = await Promise.all([ctx.waitForEvent('page'), link.click()]);
    await popup.close();
    await p.waitForTimeout(400);
    const rows = db.prepare(`SELECT e.* FROM enrollments e JOIN users u ON u.id = e.user_id WHERE u.email = ?`).all(email);
    if (rows.length !== 1) return `${rows.length} enrollments`;
    if (!decodeURIComponent(href).includes(ref)) return 'href lacks ref';
    return rows[0].whatsapp_open_count >= 2 || 'open count ' + rows[0].whatsapp_open_count;
  });
  await step(dev, 'paid video stays locked before approval (page + API)', async () => {
    await p.goto('/lesson/1');
    await p.getByText('This lesson is part of the paid course').waitFor();
    await p.getByText('awaiting the teacher’s confirmation').waitFor();
    const r = await p.request.post('/api/lessons/1/playback', { headers: H });
    return r.status() === 403 || 'status ' + r.status();
  });

  // Teacher approves on a tablet for the iPad flow, on desktop otherwise.
  const tDesc = i === 1 ? devices['iPad (gen 7) landscape'] : { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } };
  const tName = i === 1 ? 'Teacher on iPad' : 'Teacher on desktop';
  const tctx = await newCtx(tDesc);
  await login(tctx, 'teacher@example.com', 'teacher-pass-1');
  const tp = await tctx.newPage();
  await step(`${dev} → ${tName}`, 'teacher finds the request by reference (parent paid from another phone) and approves', async () => {
    await tp.goto('/admin/enrollments');
    const box = tp.getByRole('searchbox', { name: 'Search enrollments' });
    await box.fill(ref.slice(0, 7));
    await tp.getByText(ref).first().waitFor();
    await box.fill(ref);
    await tp.getByRole('dialog').getByText(`Flow Student ${i}`).first().waitFor();
    const approve = tp.getByRole('button', { name: /approve access/ });
    await approve.click();
    await tp.getByText('Confirm the student’s name or email matches').waitFor(); // must confirm identity first
    await tp.getByRole('dialog').getByText('I checked the payment in FIB').click();
    if (tDesc.hasTouch) await approve.tap(); else await approve.click();
    await tp.getByRole('dialog', { name: 'Approve access?' }).getByRole('button', { name: 'Approve' }).click();
    await tp.getByText('Access granted ✓').waitFor();
    const e = q1('SELECT status, approved_by FROM enrollments WHERE reference = ?', ref);
    const ev = q1(`SELECT * FROM enrollment_events WHERE enrollment_id = (SELECT id FROM enrollments WHERE reference = ?) AND action = 'approved'`, ref);
    return (e.status === 'active' && ev && ev.actor_id) || JSON.stringify(e);
  });
  await step(dev, 'approval email has a direct course link', async () => {
    const m = q1(`SELECT body FROM email_outbox WHERE to_email = ? AND subject LIKE 'Access granted%'`, email);
    return (m && m.body.includes('/course')) || 'missing';
  });
  await tctx.close();

  await step(dev, 'status changes to “Access granted”', async () => {
    await p.goto('/account');
    await p.getByRole('heading', { name: 'Access granted' }).waitFor();
  });
  await step(dev, 'lesson plays after approval (private, token-protected stream)', async () => {
    await p.goto('/lesson/1');
    await p.locator('.player').getByRole('button', { name: /Watch|Resume/ }).click();
    await p.waitForFunction(() => (document.querySelector('.player video')?.currentTime || 0) > 2, null, { timeout: 15000 });
    const src = await p.evaluate(() => document.querySelector('.player video').currentSrc);
    return /\/media\/v\/lesson\.1\.\d+\.\d+\./.test(src) || src;
  });
  await step(dev, 'full screen works', async () => {
    await p.getByRole('button', { name: 'Full screen' }).click();
    await p.waitForTimeout(400);
    const fs1 = await p.evaluate(() => !!(document.fullscreenElement || document.webkitFullscreenElement));
    await p.evaluate(() => document.exitFullscreen?.().catch(() => {}));
    return fs1 || 'no fullscreen element';
  });
  let saved = 0;
  await step(dev, 'progress saves and the lesson resumes from the same point', async () => {
    await p.waitForFunction(() => (document.querySelector('.player video')?.currentTime || 0) > 6, null, { timeout: 15000 });
    await p.goto('/grade/10'); // navigating away saves progress
    await p.waitForTimeout(500);
    saved = q1(`SELECT position_seconds FROM progress WHERE user_id = (SELECT id FROM users WHERE email = ?) AND lesson_id = 1`, email)?.position_seconds || 0;
    await p.goto('/lesson/1');
    const btn = p.locator('.player').getByRole('button', { name: /Resume from 0:0/ });
    await btn.waitFor();
    await btn.click();
    await p.waitForFunction(() => { const v = document.querySelector('.player video'); return v && !v.paused && v.currentTime > 0; }, null, { timeout: 15000 });
    const t = await videoTime(p);
    return (saved > 5 && t >= saved - 1) || `saved=${saved} t=${t}`;
  });
  await step(dev, 'after a lost connection the video resumes at the same point', async () => {
    const before = await videoTime(p);
    await ctx.setOffline(true);
    try {
      await p.locator('.player .overlay').getByText('Connection lost').waitFor({ timeout: 10000 });
      await p.waitForTimeout(1500);
    } finally { await ctx.setOffline(false); }
    await p.waitForFunction((b) => { const v = document.querySelector('.player video'); return v && !v.paused && v.currentTime >= b - 1; }, before, { timeout: 20000 });
    const after = await videoTime(p);
    return after >= before - 1 || `before=${before} after=${after}`;
  });
  if (!touch) {
    await step(dev, 'keyboard: Space pauses/plays, → seeks when the player is focused', async () => {
      await p.locator('.player').focus();
      await p.keyboard.press('Space');
      await p.waitForTimeout(200);
      const paused = await p.evaluate(() => document.querySelector('.player video').paused);
      const t0 = await videoTime(p);
      await p.keyboard.press('ArrowRight');
      await p.waitForTimeout(200);
      const t1 = await videoTime(p);
      return (paused && t1 >= t0 + 5) || `paused=${paused} ${t0}->${t1}`;
    });
  }
  await step(dev, 'a Grade 10 student cannot unlock Grade 11 videos (page + API)', async () => {
    const l11 = q1(`SELECT l.id FROM lessons l JOIN chapters c ON c.id = l.chapter_id WHERE c.grade = 11 AND l.published = 1 AND c.published = 1 LIMIT 1`).id;
    const r = await p.request.post(`/api/lessons/${l11}/playback`, { headers: H });
    await p.goto(`/lesson/${l11}`);
    await p.getByText('This lesson is for Grade 11').waitFor();
    return r.status() === 403 || 'status ' + r.status();
  });
  await step(dev, 'video has no download button, right-click save or picture-in-picture', async () => {
    await p.goto('/lesson/1');
    await p.locator('.player').getByRole('button', { name: /Watch|Resume/ }).click();
    await p.locator('.player video').waitFor();
    const a = await p.evaluate(() => { const v = document.querySelector('.player video'); return { cl: v.getAttribute('controlslist'), pip: v.disablePictureInPicture, ctx: !v.dispatchEvent(new MouseEvent('contextmenu', { cancelable: true, bubbles: true })) }; });
    await p.evaluate(() => document.querySelector('.player video').pause());
    return (a.cl.includes('nodownload') && a.pip && a.ctx) || JSON.stringify(a);
  });
  await step(dev, 'textbook page lists the grade’s textbook', async () => {
    await p.goto('/textbooks');
    await p.getByText('[DEMO] Grade 10 Literary Mathematics').waitFor();
  });

  if (i === 0) {
    await step(dev, 'revoking access stops new playback tokens and the open stream', async () => {
      await p.goto('/lesson/1');
      await p.locator('.player').getByRole('button', { name: /Watch|Resume/ }).click();
      await p.waitForFunction(() => (document.querySelector('.player video')?.currentTime || 0) > 0.5, null, { timeout: 15000 });
      const src = await p.evaluate(() => document.querySelector('.player video').currentSrc);
      const id = q1('SELECT id FROM enrollments WHERE reference = ?', ref).id;
      await teacherApi.post(`/api/admin/enrollments/${id}/revoke`, { data: { reason: 'test' }, headers: H });
      const tok = await p.request.post('/api/lessons/1/playback', { headers: H });
      const media = await p.request.get(src, { headers: { Range: 'bytes=0-100' } });
      await p.goto('/account');
      await p.getByRole('heading', { name: 'Access revoked' }).waitFor();
      return (tok.status() === 403 && media.status() === 403) || `token=${tok.status()} media=${media.status()}`;
    });
  }
  if (i === 2) {
    await step(dev, 'expired access is enforced on the server and shown to the student', async () => {
      db.prepare(`UPDATE enrollments SET expires_at = '2020-01-01T00:00:00.000Z' WHERE reference = ?`).run(ref);
      const tok = await p.request.post('/api/lessons/1/playback', { headers: H });
      await p.goto('/account');
      await p.getByRole('heading', { name: 'Access expired' }).waitFor();
      return tok.status() === 403 || 'token ' + tok.status();
    });
  }
  await ctx.close();
}

// ---------------- 3. Teacher uploads (desktop + iPad) ----------------
for (const [dev, desc] of [['Teacher on desktop', { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } }], ['Teacher on iPad', devices['iPad (gen 7)']]]) {
  const ctx = await newCtx(desc);
  await login(ctx, 'teacher@example.com', 'teacher-pass-1');
  const p = await ctx.newPage();
  let lessonId;
  await step(dev, 'create a lesson, upload a video with progress, auto thumbnail + duration', async () => {
    await p.goto('/admin/course/11');
    await p.getByRole('button', { name: '+ Lesson' }).first().click();
    await p.getByRole('dialog').getByLabel('Title').fill(`Upload test ${dev}`);
    await p.getByRole('button', { name: 'Create and add video' }).click();
    await p.waitForURL(/\/admin\/lessons\/\d+/);
    lessonId = Number(p.url().match(/(\d+)$/)[1]);
    await p.getByLabel('Upload video').setInputFiles(uploadFile);
    await p.getByText('Video uploaded ✓').first().waitFor({ timeout: 30000 });
    await p.waitForTimeout(1500);
    const l = q1('SELECT * FROM lessons WHERE id = ?', lessonId);
    return (l.video_id && l.duration_seconds >= 11 && l.thumbnail) || JSON.stringify({ v: l.video_id, d: l.duration_seconds, t: l.thumbnail });
  });
  await step(dev, 'teacher can preview the draft lesson; students cannot', async () => {
    await p.goto(`/lesson/${lessonId}`);
    await p.getByText('Draft — only you can see this preview').waitFor();
    const c = await browser.newContext({ baseURL: BASE }); await login(c, studentEmail, 'student-pass-1');
    const a = await c.request.get(`/api/lessons/${lessonId}`); const b = await c.request.post(`/api/lessons/${lessonId}/playback`, { headers: H });
    await c.close();
    return (a.status() === 404 && b.status() === 404) || `${a.status()} ${b.status()}`;
  });
  await step(dev, 'map the lesson to textbook chapter/pages and publish it', async () => {
    await p.goto(`/admin/lessons/${lessonId}`);
    const fsEl = p.locator('fieldset').first();
    await fsEl.getByLabel('Chapter').fill('2');
    await fsEl.getByLabel('Pages').fill('30–33');
    await fsEl.getByLabel('I checked these references').check();
    await fsEl.getByRole('button', { name: 'Save reference' }).click();
    await p.getByText('Saved ✓').first().waitFor();
    await p.getByRole('button', { name: 'Publish lesson' }).click();
    await p.getByText('Published ✓').first().waitFor();
    return q1('SELECT published FROM lessons WHERE id = ?', lessonId).published === 1;
  });
  await ctx.close();
}

// ---------------- 4. Textbook link, RTL wording, access-control checks ----------------
await step('API', 'official textbook link appears for students only once published with a link type', async () => {
  const tb = q1('SELECT id FROM textbooks WHERE grade = 10');
  await teacherApi.put(`/api/admin/textbooks/${tb.id}`, { data: { source_url: 'https://parwarda.edu.krd/', source_kind: 'official' }, headers: H });
  const r = await (await teacherCtx0.request.get('/api/textbooks')).json();
  const g = r.grades.find((x) => x.grade === 10).textbooks[0];
  const cands = await (await browser.newContext({ baseURL: BASE })).request.get('/api/textbooks').then((x) => x.text());
  return (g.source_url === 'https://parwarda.edu.krd/' && !cands.includes('t.me')) || JSON.stringify(g);
});
{
  const ctx = await newCtx(devices['iPhone 13']);
  const p = await ctx.newPage();
  await step('iPhone 13', 'textbook link opens in a new tab with noopener', async () => {
    await p.goto('/textbooks');
    const a = p.getByRole('link', { name: 'Open official link' }).first();
    return ((await a.getAttribute('target')) === '_blank' && (await a.getAttribute('rel')).includes('noopener')) || 'bad attrs';
  });
  await ctx.close();
}
for (const [name, desc] of [['iPhone 13', devices['iPhone 13']], ['Desktop Chrome', { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } }]]) {
  const ctx = await newCtx(desc); const p = await ctx.newPage();
  await step(name, 'language button switches English ⇄ Kurdish (Badini) and remembers the choice', async () => {
    await p.goto('/');
    await p.locator('.lang-btn:visible').first().click();
    await p.waitForFunction(() => document.documentElement.dir === 'rtl');
    await p.getByText('پۆلا خۆ هەلبژێرە').waitFor();
    await p.goto('/register');
    await p.getByText('ناڤێ تەمام').waitFor();
    await p.screenshot({ path: path.join(OUT, 'screens', `${name.replace(/[^\w]+/g, '_')}_KU_register.png`), fullPage: true });
    await p.goto('/');
    await p.screenshot({ path: path.join(OUT, 'screens', `${name.replace(/[^\w]+/g, '_')}_KU_home.png`), fullPage: true });
    await p.locator('.lang-btn:visible').first().click();
    await p.waitForFunction(() => document.documentElement.dir === 'ltr');
  });
  await ctx.close();
}
await teacherApi.put('/api/admin/settings', { data: { wording_confirmed: { en: true, ku: true }, site_language: 'ku' }, headers: H });
for (const [name, desc] of [['iPhone 13 RTL', devices['iPhone 13']], ['iPhone 13 landscape RTL', devices['iPhone 13 landscape']], ['iPad RTL', devices['iPad (gen 7)']], ['Desktop RTL', { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } }]]) {
  const ctx = await newCtx(desc);
  await login(ctx, studentEmail, 'student-pass-1');
  const p = await ctx.newPage();
  for (const path_ of ['/', '/grade/10', '/lesson/1', '/account']) {
    await step(name, `${path_}: right-to-left layout, equations stay left-to-right, no overflow`, async () => {
      await p.goto(path_); await p.waitForLoadState('networkidle'); await p.waitForTimeout(200);
      const r = await p.evaluate(() => ({ dir: document.documentElement.dir, math: [...document.querySelectorAll('.math')].every((m) => getComputedStyle(m).direction === 'ltr'), ov: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
      await p.screenshot({ path: path.join(OUT, 'screens', `${name.replace(/[^\w]+/g, '_')}${path_.replace(/\//g, '_')}.png`) });
      return (r.dir === 'rtl' && r.math && r.ov <= 1) || JSON.stringify(r);
    });
  }
  await ctx.close();
}
await teacherApi.put('/api/admin/settings', { data: { site_language: 'en' }, headers: H });

// Keyboard-only navigation on desktop
{
  const ctx = await newCtx({ ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } });
  const p = await ctx.newPage();
  await step('Desktop keyboard', 'skip link, menu and sign-in form work with the keyboard only', async () => {
    await p.goto('/');
    await p.keyboard.press('Tab');
    const first = await p.evaluate(() => document.activeElement.textContent);
    if (!first.includes('Skip to content')) return 'first tab: ' + first;
    await p.goto('/login');
    await p.locator('input[name=email]:focus').waitFor();
    await p.keyboard.type(studentEmail);
    await p.keyboard.press('Tab');
    await p.keyboard.type('student-pass-1');
    await p.keyboard.press('Enter');
    await p.waitForURL(/\/(course|grade|enroll)/);
  });
  await step('Desktop keyboard', 'chapters expand/collapse with Enter', async () => {
    await p.goto('/grade/10');
    const d = p.locator('details.chapter').nth(1);
    const before = await d.evaluate((x) => x.open);
    await d.locator('summary').focus(); await p.keyboard.press('Enter');
    const after = await d.evaluate((x) => x.open);
    return before !== after || `open stayed ${after}`;
  });
  await ctx.close();
}
{
  const ctx = await newCtx(devices['iPhone 13']);
  const p = await ctx.newPage();
  await step('iPhone 13', 'menu opens by tap and links are reachable', async () => {
    await p.goto('/');
    await p.getByRole('button', { name: 'Menu' }).tap();
    await p.locator('#drawer').getByRole('link', { name: 'Textbooks' }).tap();
    await p.waitForURL(/textbooks/);
  });
  await ctx.close();
}

// Access-control checks
const sctx = await browser.newContext({ baseURL: BASE });
await login(sctx, studentEmail, 'student-pass-1');
await step('API', 'students cannot use any teacher action', async () => {
  const codes = [];
  for (const [m, u] of [['get', '/api/admin/overview'], ['get', '/api/admin/enrollments'], ['post', '/api/admin/enrollments/1/approve'], ['put', '/api/admin/settings'], ['get', '/api/admin/textbooks'], ['post', '/api/admin/chapters']]) {
    codes.push((await sctx.request[m](u, { data: {}, headers: H })).status());
  }
  return codes.every((c) => c === 403) || codes.join(',');
});
await step('API', 'students opening /admin see “Page not found”', async () => {
  const c = await browser.newContext({ baseURL: BASE }); await login(c, studentEmail, 'student-pass-1');
  const p = await c.newPage(); await p.goto('/admin/enrollments'); await p.getByText('Page not found.').waitFor(); await c.close();
});
await step('API', 'guests cannot get playback tokens; demo is public', async () => {
  const g = await browser.newContext({ baseURL: BASE });
  const a = await g.request.post('/api/lessons/1/playback', { headers: H });
  const d = await g.request.post('/api/demo/playback', { headers: H });
  await g.close();
  return (a.status() === 401 && d.status() === 200) || `${a.status()} ${d.status()}`;
});
await step('API', 'forged or tampered media URLs are refused', async () => {
  const r = await (await sctx.request.post('/api/lessons/1/playback', { headers: H })).json();
  const bad = r.src.replace(/\.(\d+)\.([^.]+)$/, (m0, exp, sig) => `.${Number(exp) + 9999}.${sig}`);
  const other = await browser.newContext({ baseURL: BASE }); // someone else using a copied link
  const s1 = (await sctx.request.get(bad)).status(); const s2 = (await other.request.get(r.src)).status();
  await other.close();
  return (s1 === 403 && s2 === 403) || `${s1} ${s2}`;
});
await step('API', 'cross-site POSTs are blocked (CSRF)', async () => {
  const r = await sctx.request.post('/api/me/enrollment', { data: {}, headers: { Origin: 'https://evil.example' } });
  return r.status() === 403 || 'status ' + r.status();
});
await step('API', 'registration requires a grade; grade is locked while a request is pending', async () => {
  const c = await browser.newContext({ baseURL: BASE });
  const r0 = await c.request.post('/api/auth/register', { data: { name: 'No Grade', email: `ng-${Date.now()}@example.com`, password: 'student-pass-1' }, headers: H });
  const em = `g-${Date.now()}@example.com`;
  await c.request.post('/api/auth/register', { data: { name: 'Grade Twelve', email: em, password: 'student-pass-1', grade: 12 }, headers: H });
  const e = await (await c.request.post('/api/me/enrollment', { data: { open_whatsapp: false }, headers: H })).json();
  const ch = await c.request.post('/api/me/grade', { data: { grade: 11 }, headers: H });
  await c.close();
  return (r0.status() === 400 && JSON.stringify(e.enrollment.grades) === '[12]' && ch.status() === 409) || `${r0.status()} ${JSON.stringify(e.enrollment.grades)} ${ch.status()}`;
});
await step('API', 'teacher can move a student to another grade', async () => {
  const em = await makeStudent('move', { approve: true });
  const id = q1(`SELECT e.id FROM enrollments e JOIN users u ON u.id = e.user_id WHERE u.email = ?`, em).id;
  const r = await teacherApi.post(`/api/admin/enrollments/${id}/grade`, { data: { grade: 11 }, headers: H });
  const u = q1('SELECT grade FROM users WHERE email = ?', em); const e = q1('SELECT grades FROM enrollments WHERE id = ?', id);
  return (r.status() === 200 && u.grade === 11 && e.grades === '[11]') || `${r.status()} ${u.grade} ${e.grades}`;
});
await step('API', 'password reset: link works once, old sessions are signed out', async () => {
  const em = await makeStudent('reset');
  const c = await browser.newContext({ baseURL: BASE }); await login(c, em, 'student-pass-1');
  await c.request.post('/api/auth/forgot', { data: { email: em }, headers: H });
  const body = q1(`SELECT body FROM email_outbox WHERE to_email = ? AND subject LIKE 'Reset%'`, em).body;
  const token = body.match(/token=([\w-]+)/)[1];
  const g = await browser.newContext({ baseURL: BASE });
  const r1 = await g.request.post('/api/auth/reset', { data: { token, password: 'new-pass-456' }, headers: H });
  const r2 = await g.request.post('/api/auth/reset', { data: { token, password: 'new-pass-789' }, headers: H });
  const me = await c.request.get('/api/me');
  await c.close(); await g.close();
  return (r1.status() === 200 && r2.status() === 400 && me.status() === 401) || `${r1.status()} ${r2.status()} ${me.status()}`;
});

await step('API', 'malformed URLs return 400, not 500', async () => {
  const r = await fetch(`${BASE}/api/lessons/%E0%A4%A`); const r2 = await fetch(`${BASE}/%E0%A4%A.js`);
  return (r.status === 400 && r2.status === 400) || `${r.status} ${r2.status}`;
});
await step('API', 'renewal after expiry: one pending request, approving it keeps a single current enrollment', async () => {
  const em = await makeStudent('renew', { approve: true });
  const uid = q1('SELECT id FROM users WHERE email = ?', em).id;
  db.prepare(`UPDATE enrollments SET expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?`).run(uid);
  const c = await browser.newContext({ baseURL: BASE }); await login(c, em, 'student-pass-1');
  const a = await (await c.request.post('/api/me/enrollment', { data: { open_whatsapp: true }, headers: H })).json();
  const b = await (await c.request.post('/api/me/enrollment', { data: { open_whatsapp: true }, headers: H })).json();
  if (a.enrollment.reference !== b.enrollment.reference) return 'reference changed';
  const old = q1(`SELECT id FROM enrollments WHERE user_id = ? AND status = 'active'`, uid).id;
  const reOld = await teacherApi.post(`/api/admin/enrollments/${old}/approve`, { data: { expires_date: '' }, headers: H });
  const id = q1('SELECT id FROM enrollments WHERE reference = ?', b.enrollment.reference).id;
  await teacherApi.post(`/api/admin/enrollments/${id}/approve`, { data: { expires_date: '' }, headers: H });
  const me = await (await c.request.get('/api/me')).json(); await c.close();
  return (reOld.status() === 409 && me.enrollment.state === 'active' && me.enrollment.reference === b.enrollment.reference) || `${reOld.status()} ${me.enrollment.state}`;
});
await step('API', 'when the access end date has passed, new enrollment requests are refused', async () => {
  db.prepare(`INSERT INTO settings(key, value) VALUES ('access_mode', '"end_date"'), ('access_end_date', '"2020-06-30"') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  const em = await makeStudent('closed');
  const c = await browser.newContext({ baseURL: BASE }); await login(c, em, 'student-pass-1');
  const r = await c.request.post('/api/me/enrollment', { data: {}, headers: H });
  const site = await (await c.request.get('/api/site')).json(); await c.close();
  db.prepare(`UPDATE settings SET value = '"ongoing"' WHERE key = 'access_mode'`).run();
  return (r.status() === 409 && site.terms.open === false) || `${r.status()} ${site.terms.open}`;
});
await step('API', 'login lock-out cannot be forced from another IP on the teacher account', async () => {
  const g = await browser.newContext({ baseURL: BASE });
  for (let k = 0; k < 9; k++) await g.request.post('/api/auth/login', { data: { email: 'teacher@example.com', password: 'wrong' }, headers: H });
  await g.close();
  const c = await browser.newContext({ baseURL: BASE });
  const r = await c.request.post('/api/auth/login', { data: { email: 'teacher@example.com', password: 'teacher-pass-1' }, headers: { ...H, 'X-Forwarded-For': '9.9.9.9' } });
  await c.close();
  return r.status() === 200 || 'status ' + r.status(); // note: tests share one IP; scale=50 keeps this from tripping
});

await browser.close();
server.kill();
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) { console.log('Failures:'); for (const f of failed) console.log(` - [${f.device}] ${f.name}: ${f.detail}`); }
process.exit(failed.length ? 1 : 0);
