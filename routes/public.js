import path from 'node:path';
import { config } from '../lib/config.js';
import { db, one, all, run, tx, getSettings, nowIso } from '../lib/db.js';
import { sendJson, readJson, bad, HttpError, rateLimit, checkLimit, hit, clientIp, serveFile } from '../lib/http.js';
import {
  hashPassword, verifyPassword, validatePassword, normalizeEmail, createSession, destroySession,
  currentUser, requireUser, issueAuthToken, consumeAuthToken,
} from '../lib/auth.js';
import { emails } from '../lib/email.js';
import {
  newReference, enrollmentState, currentEnrollment, activeGrades, lessonWithGrade, isLessonPublic,
  canWatch, logEvent, courseTerms, whatsappMessage, waDigits, parseGrades,
} from '../lib/access.js';
import { playbackFor, verifyLocalToken } from '../lib/video.js';

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, grade: u.grade || null });

export function enrollmentView(e, s = getSettings(), student = {}) {
  const state = enrollmentState(e);
  const number = waDigits(s.whatsapp_number);
  const terms = courseTerms();
  const view = {
    state, // ready | pending | active | expired | revoked
    whatsapp_number: number,
    terms,
  };
  if (e && (e.status !== 'cancelled')) {
    const msg = whatsappMessage(s.whatsapp_message, e.status === 'pending' ? terms.price_iqd : e.price_iqd, e.reference, { ...student, grade: parseGrades(e.grades)[0] || student.grade });
    Object.assign(view, {
      reference: e.reference,
      price_iqd: e.price_iqd,
      grades: parseGrades(e.grades),
      access_mode: e.access_mode,
      access_end_date: e.access_end_date,
      requested_at: e.requested_at,
      approved_at: e.approved_at,
      expires_at: e.expires_at,
      revoked_at: e.revoked_at,
      message: msg,
      wa_url: number ? `https://wa.me/${number}?text=${encodeURIComponent(msg)}` : null,
    });
  }
  return view;
}

// Textbook record as shown publicly: download only when an approved link or permitted PDF exists.
export function publicTextbook(t) {
  if (!t) return null;
  return {
    id: t.id, grade: t.grade, title: t.title, track: t.track, language: t.language, edition: t.edition,
    publication_year: t.publication_year, academic_year: t.academic_year, is_active: !!t.is_active,
    source_url: t.source_kind && /^https:\/\//.test(t.source_url) ? t.source_url : null,
    source_kind: t.source_kind || null,
    pdf_url: t.pdf_file ? `/media/pdf/${t.id}` : null,
  };
}
const activeTextbook = (grade) => one('SELECT * FROM textbooks WHERE grade = ? AND is_active = 1 AND published = 1', grade);
const refFor = (lessonId, tb) => {
  if (!tb) return null;
  const r = one('SELECT chapter, section, pages, exercises FROM lesson_refs WHERE lesson_id = ? AND textbook_id = ?', lessonId, tb.id);
  return r && (r.chapter || r.section || r.pages || r.exercises) ? { ...r, textbook_id: tb.id, edition: tb.edition } : null;
};

export function registerPublic(r) {
  // ---------- site + catalog ----------
  r.get('/api/site', (req, res) => {
    const s = getSettings();
    const u = currentUser(req);
    const lang = s.site_language === 'ku' ? 'ku' : 'en';
    sendJson(res, 200, {
      teacher_name: s.teacher_name, teacher_intro: s.teacher_intro, teacher_photo: s.teacher_photo, city: s.city,
      course_title: s.course_title, course_subtitle: s.course_subtitle,
      whatsapp_number: waDigits(s.whatsapp_number),
      language: lang, wording: (s.wording && s.wording[lang]) || {}, wordings: { en: s.wording?.en || {}, ku: s.wording?.ku || {} },
      demo: s.demo && s.demo.published && s.demo.video_id ? { title: s.demo.title || '', duration_seconds: s.demo.duration_seconds || 0, thumbnail: s.demo.thumbnail || '' } : null,
      terms: courseTerms(),
      video_provider: config.video.provider,
      user: publicUser(u),
      enrollment: u && u.role !== 'admin' ? enrollmentView(currentEnrollment(u.id), s, u) : null,
    });
  });

  r.get('/api/catalog', (req, res) => {
    const u = currentUser(req);
    const granted = u ? (u.role === 'admin' ? [10, 11, 12] : activeGrades(u.id)) : [];
    const prog = u ? Object.fromEntries(all('SELECT lesson_id, position_seconds, duration_seconds, completed FROM progress WHERE user_id = ?', u.id).map((p) => [p.lesson_id, p])) : {};
    const grades = [10, 11, 12].map((g) => {
      const tb = activeTextbook(g);
      const chapters = all('SELECT id, title, description FROM chapters WHERE grade = ? AND published = 1 ORDER BY sort, id', g).map((c) => ({
        ...c,
        lessons: all('SELECT id, title, duration_seconds, thumbnail FROM lessons WHERE chapter_id = ? AND published = 1 ORDER BY sort, id', c.id).map((l) => ({
          ...l, locked: !granted.includes(g), ref: refFor(l.id, tb), progress: prog[l.id] || null,
        })),
      }));
      return { grade: g, textbook: publicTextbook(tb), chapters, has_access: granted.includes(g) };
    });
    sendJson(res, 200, { grades });
  });

  r.get('/api/lessons/:id', (req, res, { id }) => {
    const u = currentUser(req);
    const l = lessonWithGrade(id);
    const admin = u?.role === 'admin';
    if (!l || (!admin && !isLessonPublic(l))) throw new HttpError(404, 'not_found', 'Lesson not found');
    const tb = activeTextbook(l.grade);
    const gate = u ? canWatch(u, l) : { ok: false, code: 'auth_required' };
    const siblings = all(`SELECT id, title, duration_seconds FROM lessons WHERE chapter_id = ? ${admin ? '' : 'AND published = 1'} ORDER BY sort, id`, l.chapter_id);
    const p = u ? one('SELECT position_seconds, duration_seconds, completed FROM progress WHERE user_id = ? AND lesson_id = ?', u.id, l.id) : null;
    sendJson(res, 200, {
      lesson: {
        id: l.id, title: l.title, description: l.description, duration_seconds: l.duration_seconds, thumbnail: l.thumbnail,
        grade: l.grade, chapter_id: l.chapter_id, chapter_title: l.chapter_title, published: !!l.published && !!l.chapter_published,
        has_video: !!l.video_id,
      },
      ref: refFor(l.id, tb), textbook: publicTextbook(tb), siblings,
      access: gate.ok ? 'ok' : gate.code, enrollment_state: gate.state || null,
      progress: p || null,
    });
  });

  r.post('/api/lessons/:id/playback', (req, res, { id }) => {
    const u = requireUser(req);
    rateLimit('play:' + u.id, 120, 600);
    const l = lessonWithGrade(id);
    const gate = canWatch(u, l);
    if (!gate.ok) throw new HttpError(gate.code === 'not_found' ? 404 : 403, gate.code, 'No access', { state: gate.state });
    if (!l.video_id) throw new HttpError(409, 'no_video', 'This lesson has no video yet.');
    const p = one('SELECT position_seconds FROM progress WHERE user_id = ? AND lesson_id = ?', u.id, l.id);
    sendJson(res, 200, { ...playbackFor('lesson', l.id, u.id, l.video_provider, l.video_id), resume_at: p?.position_seconds || 0, ttl: config.playbackTtlSeconds });
  });

  r.post('/api/lessons/:id/progress', async (req, res, { id }) => {
    const u = requireUser(req);
    const b = await readJson(req);
    const l = lessonWithGrade(id);
    if (!canWatch(u, l).ok) throw new HttpError(403, 'no_access');
    const pos = Math.max(0, Math.min(Number(b.position) || 0, 24 * 3600));
    const dur = Math.max(0, Math.min(Number(b.duration) || l.duration_seconds || 0, 24 * 3600));
    const done = dur > 0 && pos >= dur - 15 ? 1 : 0;
    run(`INSERT INTO progress (user_id, lesson_id, position_seconds, duration_seconds, completed, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, lesson_id) DO UPDATE SET position_seconds = excluded.position_seconds, duration_seconds = excluded.duration_seconds,
         completed = MAX(progress.completed, excluded.completed), updated_at = excluded.updated_at`, u.id, l.id, done ? 0 : pos, dur, done, nowIso());
    sendJson(res, 200, { ok: true, completed: !!done });
  });

  r.post('/api/demo/playback', (req, res) => {
    rateLimit('demo:' + clientIp(req), 60, 600);
    const s = getSettings();
    const u = currentUser(req);
    const d = s.demo;
    if (!d || !d.video_id || (!d.published && u?.role !== 'admin')) throw new HttpError(404, 'not_found');
    sendJson(res, 200, { ...playbackFor('demo', 0, 0, d.provider, d.video_id), resume_at: 0, ttl: config.playbackTtlSeconds });
  });

  r.get('/api/textbooks', (req, res) => {
    const rows = all('SELECT * FROM textbooks WHERE published = 1 ORDER BY grade, is_active DESC, id DESC');
    sendJson(res, 200, { grades: [10, 11, 12].map((g) => ({ grade: g, textbooks: rows.filter((t) => t.grade === g).map(publicTextbook) })) });
  });

  // ---------- private media ----------
  r.get('/media/v/:tok', (req, res, { tok }) => {
    const t = verifyLocalToken(tok);
    if (!t) throw new HttpError(403, 'bad_token');
    if (t.expired) throw new HttpError(410, 'token_expired');
    let file;
    if (t.kind === 'demo') {
      const d = getSettings().demo;
      const u = currentUser(req);
      if (!d || d.provider !== 'local' || (!d.published && u?.role !== 'admin')) throw new HttpError(404, 'not_found');
      file = d.video_id;
    } else if (t.kind === 'lesson') {
      const u = currentUser(req);
      if (!u || u.id !== t.userId) throw new HttpError(403, 'bad_token');
      const l = lessonWithGrade(t.id);
      if (!canWatch(u, l).ok || l.video_provider !== 'local') throw new HttpError(403, 'no_access'); // revocation/expiry take effect immediately
      file = l.video_id;
    } else throw new HttpError(403, 'bad_token');
    const ok = serveFile(req, res, path.join(config.dataDir, 'private', 'videos'), file, {
      cache: 'private, no-store', extraHeaders: { 'X-Robots-Tag': 'noindex', 'Content-Disposition': 'inline' },
    });
    if (!ok) throw new HttpError(404, 'not_found');
  });

  r.get('/media/img/:file', (req, res, { file }) => {
    if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(file)) throw new HttpError(404, 'not_found');
    if (!serveFile(req, res, path.join(config.dataDir, 'public', 'img'), file, { cache: 'public, max-age=31536000, immutable' })) throw new HttpError(404, 'not_found');
  });

  r.get('/media/pdf/:id', (req, res, { id }) => {
    const t = one('SELECT * FROM textbooks WHERE id = ? AND published = 1 AND pdf_file IS NOT NULL', Number(id));
    const u = currentUser(req);
    const tt = t || (u?.role === 'admin' ? one('SELECT * FROM textbooks WHERE id = ? AND pdf_file IS NOT NULL', Number(id)) : null);
    if (!tt) throw new HttpError(404, 'not_found');
    const name = `Grade-${tt.grade}-Literary-Mathematics-${(tt.edition || 'textbook').replace(/[^\w-]+/g, '-')}.pdf`;
    if (!serveFile(req, res, path.join(config.dataDir, 'private', 'pdfs'), tt.pdf_file, { cache: 'private, max-age=300', download: name })) throw new HttpError(404, 'not_found');
  });

  // ---------- auth ----------
  r.post('/api/auth/register', async (req, res) => {
    rateLimit('reg:' + clientIp(req), 10, 3600);
    const b = await readJson(req);
    const name = str(b.name, 100).replace(/\s+/g, ' '); // one line: names go into the WhatsApp message
    const email = normalizeEmail(b.email);
    if (name.length < 2) throw bad('name_required');
    if (/https?:|www\.|:\/\/|[<>{}[\]]/i.test(name) || /\.[a-z]{2,}\b/i.test(name)) throw bad('name_invalid', 'Please enter only your name.');
    if (!email) throw bad('email_invalid');
    const grade = Number(b.grade);
    if (![10, 11, 12].includes(grade)) throw bad('grade_required', 'Choose your grade.');
    const pwErr = validatePassword(b.password);
    if (pwErr) throw bad(pwErr);
    if (one('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'email_taken', 'An account with this email already exists.');
    const hash = await hashPassword(b.password);
    // No email verification step: the teacher confirms the student's name and email when approving payment.
    const info = run(`INSERT INTO users (name, email, password_hash, role, grade) VALUES (?, ?, ?, 'student', ?)`, name, email, hash, grade);
    const u = one('SELECT * FROM users WHERE id = ?', Number(info.lastInsertRowid));
    createSession(res, u.id);
    sendJson(res, 201, { user: publicUser(u) });
  });

  r.post('/api/auth/login', async (req, res) => {
    const b = await readJson(req);
    const email = normalizeEmail(b.email) || '';
    const ip = clientIp(req);
    // Only failed attempts count, per IP+email, so nobody can lock the teacher out from elsewhere.
    checkLimit('login-ip:' + ip, 30, 900);
    checkLimit(`login-ie:${ip}:${email}`, 8, 900);
    checkLimit('login-em:' + email, 100, 900);
    const u = email ? one('SELECT * FROM users WHERE email = ?', email) : null;
    const ok = await verifyPassword(String(b.password || ''), u?.password_hash);
    if (!u || !ok) {
      hit('login-ip:' + ip, 900); hit(`login-ie:${ip}:${email}`, 900); hit('login-em:' + email, 900);
      throw new HttpError(401, 'bad_credentials', 'Email or password is incorrect.');
    }
    createSession(res, u.id);
    sendJson(res, 200, { user: publicUser(u) });
  });

  r.post('/api/auth/logout', (req, res) => { destroySession(req, res); sendJson(res, 200, { ok: true }); });

  r.post('/api/auth/forgot', async (req, res) => {
    rateLimit('forgot-ip:' + clientIp(req), 10, 3600);
    const b = await readJson(req);
    const email = normalizeEmail(b.email);
    if (email) {
      rateLimit('forgot-em:' + email, 3, 3600);
      const u = one('SELECT * FROM users WHERE email = ?', email);
      // Not awaited: the response time must not reveal whether the account exists.
      if (u) emails.reset(u, issueAuthToken(u.id, 'reset', 1), getSettings().course_title).catch((e) => console.error(e));
    }
    sendJson(res, 200, { ok: true }); // same answer whether or not the account exists
  });

  r.post('/api/auth/reset', async (req, res) => {
    rateLimit('reset:' + clientIp(req), 20, 3600);
    const b = await readJson(req);
    const pwErr = validatePassword(b.password);
    if (pwErr) throw bad(pwErr);
    const row = consumeAuthToken(b.token, 'reset');
    if (!row) throw bad('token_invalid', 'This link is invalid or has expired.');
    const hash = await hashPassword(b.password);
    tx(() => {
      run('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', hash, nowIso(), row.user_id);
      run('DELETE FROM sessions WHERE user_id = ?', row.user_id); // sign out everywhere
    });
    createSession(res, row.user_id);
    sendJson(res, 200, { ok: true });
  });

  // ---------- student enrollment ----------
  r.get('/api/me', (req, res) => {
    const u = requireUser(req);
    sendJson(res, 200, { user: publicUser(u), enrollment: u.role === 'admin' ? null : enrollmentView(currentEnrollment(u.id), getSettings(), u) });
  });

  // "Pay via WhatsApp": create or reuse ONE pending request. Opening WhatsApp never grants access.
  r.post('/api/me/enrollment', async (req, res) => {
    const u = requireUser(req);
    if (u.role === 'admin') throw new HttpError(403, 'admin_cannot_enroll', 'Teacher accounts cannot enroll.');
    const b = await readJson(req);
    const opening = b.open_whatsapp !== false;
    rateLimit('enroll:' + u.id, 30, 3600);
    const s = getSettings();
    const terms = courseTerms();
    if (!terms.open) throw new HttpError(409, 'course_not_ready', 'Enrollment is not open right now.');
    if (!u.grade) throw new HttpError(409, 'grade_required', 'Choose your grade first.');
    if (!terms.grades.includes(u.grade)) throw new HttpError(409, 'grade_not_offered', 'Your grade is not open for enrollment.');
    const myGrades = JSON.stringify([u.grade]);
    const e = tx(() => {
      const cur = currentEnrollment(u.id);
      const state = enrollmentState(cur);
      if (state === 'active') return cur;
      let p = one(`SELECT * FROM enrollments WHERE user_id = ? AND status = 'pending'`, u.id);
      if (p) {
        // Keep the same reference; refresh the terms shown so the student sees the current price.
        run(`UPDATE enrollments SET price_iqd = ?, grades = ?, access_mode = ?, access_end_date = ?, updated_at = ? WHERE id = ?`,
          terms.price_iqd, myGrades, terms.access_mode, terms.access_end_date, nowIso(), p.id);
      } else {
        const ref = newReference();
        const info = run(`INSERT INTO enrollments (user_id, reference, status, price_iqd, grades, access_mode, access_end_date) VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
          u.id, ref, terms.price_iqd, myGrades, terms.access_mode, terms.access_end_date);
        p = { id: Number(info.lastInsertRowid) };
        logEvent(p.id, u.id, 'requested', `Price ${terms.price_iqd} IQD; Grade ${u.grade}`);
      }
      if (opening) {
        run(`UPDATE enrollments SET whatsapp_opened_at = ?, whatsapp_open_count = whatsapp_open_count + 1 WHERE id = ?`, nowIso(), p.id);
        logEvent(p.id, u.id, 'whatsapp_opened');
      }
      return one('SELECT * FROM enrollments WHERE id = ?', p.id);
    });
    sendJson(res, 200, { enrollment: enrollmentView(e, s, u) });
  });

  // Students set their grade at sign-up; they can change it only while nothing is pending or active.
  r.post('/api/me/grade', async (req, res) => {
    const u = requireUser(req);
    if (u.role === 'admin') throw new HttpError(403, 'forbidden');
    const b = await readJson(req);
    const grade = Number(b.grade);
    if (![10, 11, 12].includes(grade)) throw bad('grade_required', 'Choose your grade.');
    const st = enrollmentState(currentEnrollment(u.id));
    if (st === 'pending' || st === 'active') throw new HttpError(409, 'grade_locked', 'Ask the teacher to change your grade.');
    run('UPDATE users SET grade = ? WHERE id = ?', grade, u.id);
    sendJson(res, 200, { ok: true, grade });
  });
}
