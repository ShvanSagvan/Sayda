import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../lib/config.js';
import { one, all, run, tx, getSettings, setSetting, nowIso, DEFAULT_SETTINGS } from '../lib/db.js';
import { sendJson, readJson, readBody, streamToFile, bad, HttpError } from '../lib/http.js';
import { requireAdmin } from '../lib/auth.js';
import { emails } from '../lib/email.js';
import { cloudflare } from '../lib/video.js';
import { endOfDayIso, enrollmentState, logEvent, parseGrades, lessonWithGrade, waDigits } from '../lib/access.js';

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const int = (v) => { const n = Number(v); if (!Number.isInteger(n)) throw bad('invalid_id'); return n; };
const GRADES = [10, 11, 12];
const grade = (g) => { const n = Number(g); if (!GRADES.includes(n)) throw bad('invalid_grade'); return n; };
const privVideos = () => path.join(config.dataDir, 'private', 'videos');
const privPdfs = () => path.join(config.dataDir, 'private', 'pdfs');
const pubImg = () => path.join(config.dataDir, 'public', 'img');
const rmQuiet = (dir, f) => { if (f && /^[\w.-]+$/.test(f)) fs.rm(path.join(dir, f), { force: true }, () => {}); };

function chapterOr404(id) { const c = one('SELECT * FROM chapters WHERE id = ?', int(id)); if (!c) throw new HttpError(404, 'not_found'); return c; }
function lessonOr404(id) { const l = lessonWithGrade(int(id)); if (!l) throw new HttpError(404, 'not_found'); return l; }
function textbookOr404(id) { const t = one('SELECT * FROM textbooks WHERE id = ?', int(id)); if (!t) throw new HttpError(404, 'not_found'); return t; }

const gradesText = (gs) => gs.map((g) => `Grade ${g}`).join(', ');

export function registerAdmin(r) {
  // Wrap every admin handler with a server-side role check.
  const A = (fn) => (req, res, params) => { const admin = requireAdmin(req); return fn(req, res, params, admin); };
  const get = (p, f) => r.get(p, A(f)), post = (p, f) => r.post(p, A(f)), put = (p, f) => r.put(p, A(f)), del = (p, f) => r.del(p, A(f));

  get('/api/admin/overview', (req, res) => {
    const c = (s) => one(`SELECT COUNT(*) n FROM enrollments WHERE status = ?`, s).n;
    sendJson(res, 200, {
      pending: c('pending'),
      active: one(`SELECT COUNT(*) n FROM enrollments WHERE status='active' AND (expires_at IS NULL OR expires_at > ?)`, nowIso()).n,
      students: one(`SELECT COUNT(*) n FROM users WHERE role='student'`).n,
      lessons: one(`SELECT COUNT(*) n FROM lessons WHERE published=1`).n,
      drafts: one(`SELECT COUNT(*) n FROM lessons WHERE published=0`).n,
      textbooks_unverified: one(`SELECT COUNT(*) n FROM textbooks WHERE review_status != 'verified'`).n,
      candidates_to_review: one(`SELECT COUNT(*) n FROM candidate_links WHERE status='to_review'`).n,
      settings_missing: ['whatsapp_number', 'price_iqd'].filter((k) => !getSettings()[k]),
      chapters: one(`SELECT COUNT(*) n FROM chapters`).n,
      lessons_with_video: one(`SELECT COUNT(*) n FROM lessons WHERE video_id IS NOT NULL`).n,
      video_provider: config.video.provider,
      cloudflare_configured: cloudflare.configured(),
      email_provider: config.email.provider,
    });
  });

  // ---------- settings ----------
  get('/api/admin/settings', (req, res) => sendJson(res, 200, { settings: getSettings() }));

  put('/api/admin/settings', async (req, res) => {
    const b = await readJson(req);
    const cur = getSettings();
    const out = {};
    const text = { teacher_name: 120, teacher_intro: 4000, city: 80, course_title: 160, course_subtitle: 300 };
    for (const [k, max] of Object.entries(text)) if (k in b) out[k] = str(b[k], max);
    if ('price_iqd' in b) {
      const p = Number(String(b.price_iqd).replace(/[,\s]/g, ''));
      if (!Number.isInteger(p) || p < 0 || p > 100_000_000) throw bad('invalid_price');
      out.price_iqd = p;
    }
    if ('grades_included' in b) {
      const gs = [...new Set((b.grades_included || []).map(Number))].filter((g) => GRADES.includes(g)).sort();
      if (!gs.length) throw bad('grades_required', 'Include at least one grade.');
      out.grades_included = gs;
    }
    if ('access_mode' in b) {
      if (!['ongoing', 'end_date'].includes(b.access_mode)) throw bad('invalid_access_mode');
      out.access_mode = b.access_mode;
    }
    if ('access_end_date' in b) {
      const d = str(b.access_end_date, 10);
      if (d && !endOfDayIso(d)) throw bad('invalid_date');
      out.access_end_date = d;
    }
    if (('access_mode' in b || 'access_end_date' in b) && (out.access_mode ?? cur.access_mode) === 'end_date') {
      const d = out.access_end_date ?? cur.access_end_date;
      if (!d) throw bad('end_date_required', 'Choose the access end date.');
      if (Date.parse(endOfDayIso(d)) < Date.now()) throw bad('end_date_past', 'The access end date is in the past.');
    }
    if ('whatsapp_number' in b) {
      const n = waDigits(b.whatsapp_number);
      if (n && (n.length < 10 || n.length > 15)) throw bad('invalid_whatsapp', 'Use the international format, e.g. 964 750 123 4567.');
      out.whatsapp_number = n;
    }
    if ('whatsapp_message' in b) {
      const m = str(b.whatsapp_message, 1000);
      if (!m.includes('[Reference]')) throw bad('message_needs_reference', 'The message must include [Reference].');
      out.whatsapp_message = m;
    }
    if ('site_language' in b) { if (!['en', 'ku'].includes(b.site_language)) throw bad('invalid_language'); out.site_language = b.site_language; }
    if ('wording' in b) {
      const w = {};
      for (const lang of ['en', 'ku']) {
        w[lang] = {};
        for (const [k, v] of Object.entries((b.wording || {})[lang] || {})) {
          if (/^[a-z0-9_.]{1,60}$/.test(k) && typeof v === 'string' && v.trim()) w[lang][k] = v.slice(0, 1000);
        }
      }
      out.wording = w;
    }
    if ('wording_confirmed' in b) out.wording_confirmed = { en: !!b.wording_confirmed?.en, ku: !!b.wording_confirmed?.ku };
    if ('demo' in b && b.demo) {
      const d = { ...(cur.demo || {}) };
      if ('title' in b.demo) d.title = str(b.demo.title, 160);
      if ('published' in b.demo) {
        if (b.demo.published && !d.video_id) throw bad('demo_needs_video', 'Upload the demo video first.');
        d.published = !!b.demo.published;
      }
      if ('duration_seconds' in b.demo) d.duration_seconds = Math.max(0, Math.round(Number(b.demo.duration_seconds) || 0));
      out.demo = d;
    }
    for (const [k, v] of Object.entries(out)) if (k in DEFAULT_SETTINGS) setSetting(k, v);
    sendJson(res, 200, { settings: getSettings() });
  });

  // ---------- course structure ----------
  get('/api/admin/course', (req, res) => {
    const grades = GRADES.map((g) => ({
      grade: g,
      chapters: all('SELECT * FROM chapters WHERE grade = ? ORDER BY sort, id', g).map((c) => ({
        ...c, lessons: all('SELECT id, title, duration_seconds, thumbnail, video_provider, video_id, video_status, published, sort FROM lessons WHERE chapter_id = ? ORDER BY sort, id', c.id),
      })),
    }));
    sendJson(res, 200, { grades });
  });

  post('/api/admin/chapters', async (req, res) => {
    const b = await readJson(req);
    const g = grade(b.grade);
    const title = str(b.title, 200);
    if (!title) throw bad('title_required');
    const sort = (one('SELECT MAX(sort) m FROM chapters WHERE grade = ?', g).m ?? -1) + 1;
    const info = run('INSERT INTO chapters (grade, title, description, sort) VALUES (?, ?, ?, ?)', g, title, str(b.description, 2000), sort);
    sendJson(res, 201, { chapter: one('SELECT * FROM chapters WHERE id = ?', Number(info.lastInsertRowid)) });
  });

  put('/api/admin/chapters/:id', async (req, res, { id }) => {
    const c = chapterOr404(id);
    const b = await readJson(req);
    const title = 'title' in b ? str(b.title, 200) : c.title;
    if (!title) throw bad('title_required');
    run('UPDATE chapters SET title = ?, description = ?, published = ?, updated_at = ? WHERE id = ?',
      title, 'description' in b ? str(b.description, 2000) : c.description, 'published' in b ? (b.published ? 1 : 0) : c.published, nowIso(), c.id);
    sendJson(res, 200, { chapter: one('SELECT * FROM chapters WHERE id = ?', c.id) });
  });

  del('/api/admin/chapters/:id', (req, res, { id }) => {
    const c = chapterOr404(id);
    if (one('SELECT 1 FROM lessons WHERE chapter_id = ?', c.id)) throw new HttpError(409, 'chapter_not_empty', 'Move or delete the lessons in this chapter first.');
    run('DELETE FROM chapters WHERE id = ?', c.id);
    sendJson(res, 200, { ok: true });
  });

  post('/api/admin/chapters/reorder', async (req, res) => {
    const b = await readJson(req);
    const g = grade(b.grade);
    const ids = (b.ids || []).map(int);
    const existing = all('SELECT id FROM chapters WHERE grade = ?', g).map((x) => x.id);
    if (ids.length !== existing.length || !ids.every((i) => existing.includes(i))) throw bad('ids_mismatch');
    tx(() => ids.forEach((cid, i) => run('UPDATE chapters SET sort = ? WHERE id = ?', i, cid)));
    sendJson(res, 200, { ok: true });
  });

  post('/api/admin/lessons', async (req, res) => {
    const b = await readJson(req);
    const c = chapterOr404(b.chapter_id);
    const title = str(b.title, 200);
    if (!title) throw bad('title_required');
    const sort = (one('SELECT MAX(sort) m FROM lessons WHERE chapter_id = ?', c.id).m ?? -1) + 1;
    const info = run('INSERT INTO lessons (chapter_id, title, description, sort) VALUES (?, ?, ?, ?)', c.id, title, str(b.description, 5000), sort);
    sendJson(res, 201, { lesson: one('SELECT * FROM lessons WHERE id = ?', Number(info.lastInsertRowid)) });
  });

  get('/api/admin/lessons/:id', (req, res, { id }) => {
    const l = lessonOr404(id);
    const textbooks = all('SELECT * FROM textbooks WHERE grade = ? ORDER BY is_active DESC, id DESC', l.grade);
    const refs = all('SELECT * FROM lesson_refs WHERE lesson_id = ?', l.id);
    const chapters = all('SELECT id, grade, title FROM chapters ORDER BY grade, sort, id');
    sendJson(res, 200, { lesson: l, textbooks, refs, chapters });
  });

  put('/api/admin/lessons/:id', async (req, res, { id }) => {
    const l = lessonOr404(id);
    const b = await readJson(req);
    const title = 'title' in b ? str(b.title, 200) : l.title;
    if (!title) throw bad('title_required');
    let chapterId = l.chapter_id, sort = l.sort;
    if ('chapter_id' in b && int(b.chapter_id) !== l.chapter_id) {
      const c = chapterOr404(b.chapter_id);
      if (c.grade !== l.grade && one('SELECT 1 FROM lesson_refs WHERE lesson_id = ?', l.id)) {
        throw new HttpError(409, 'grade_change_with_refs', 'This lesson has textbook references for another grade. Clear them before moving it to a different grade.');
      }
      chapterId = c.id;
      sort = (one('SELECT MAX(sort) m FROM lessons WHERE chapter_id = ?', c.id).m ?? -1) + 1;
    }
    const published = 'published' in b ? (b.published ? 1 : 0) : l.published;
    if (published && !l.video_id) throw new HttpError(409, 'needs_video', 'Add a video before publishing this lesson.');
    const duration = 'duration_seconds' in b ? Math.max(0, Math.round(Number(b.duration_seconds) || 0)) : l.duration_seconds;
    run('UPDATE lessons SET chapter_id = ?, sort = ?, title = ?, description = ?, duration_seconds = ?, published = ?, updated_at = ? WHERE id = ?',
      chapterId, sort, title, 'description' in b ? str(b.description, 5000) : l.description, duration, published, nowIso(), l.id);
    sendJson(res, 200, { lesson: lessonWithGrade(l.id) });
  });

  del('/api/admin/lessons/:id', (req, res, { id }) => {
    const l = lessonOr404(id);
    if (l.published) throw new HttpError(409, 'unpublish_first', 'Unpublish the lesson before deleting it.');
    run('DELETE FROM lessons WHERE id = ?', l.id);
    if (l.video_provider === 'local') rmQuiet(privVideos(), l.video_id);
    sendJson(res, 200, { ok: true });
  });

  post('/api/admin/lessons/reorder', async (req, res) => {
    const b = await readJson(req);
    const c = chapterOr404(b.chapter_id);
    const ids = (b.ids || []).map(int);
    const existing = all('SELECT id FROM lessons WHERE chapter_id = ?', c.id).map((x) => x.id);
    if (ids.length !== existing.length || !ids.every((i) => existing.includes(i))) throw bad('ids_mismatch');
    tx(() => ids.forEach((lid, i) => run('UPDATE lessons SET sort = ? WHERE id = ?', i, lid)));
    sendJson(res, 200, { ok: true });
  });

  // Curriculum references for one lesson + textbook edition.
  put('/api/admin/lessons/:id/refs/:tid', async (req, res, { id, tid }) => {
    const l = lessonOr404(id);
    const t = textbookOr404(tid);
    if (t.grade !== l.grade) throw bad('grade_mismatch', 'The textbook is for a different grade.');
    const b = await readJson(req);
    const f = { chapter: str(b.chapter, 200), section: str(b.section, 200), pages: str(b.pages, 100), exercises: str(b.exercises, 200) };
    run(`INSERT INTO lesson_refs (lesson_id, textbook_id, chapter, section, pages, exercises, reviewed) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lesson_id, textbook_id) DO UPDATE SET chapter = excluded.chapter, section = excluded.section, pages = excluded.pages, exercises = excluded.exercises, reviewed = excluded.reviewed`,
      l.id, t.id, f.chapter, f.section, f.pages, f.exercises, b.reviewed ? 1 : 0);
    sendJson(res, 200, { ref: one('SELECT * FROM lesson_refs WHERE lesson_id = ? AND textbook_id = ?', l.id, t.id) });
  });

  // ---------- uploads (raw request bodies; progress shown by XHR) ----------
  const target = (q) => {
    const kind = q.get('target');
    if (kind === 'lesson') return { kind, lesson: lessonOr404(q.get('id')) };
    if (kind === 'demo' || kind === 'teacher') return { kind };
    throw bad('invalid_target');
  };

  function setVideo(t, provider, videoId, duration, status) {
    if (t.kind === 'lesson') {
      const old = t.lesson;
      run('UPDATE lessons SET video_provider = ?, video_id = ?, video_status = ?, duration_seconds = CASE WHEN ? > 0 THEN ? ELSE duration_seconds END, updated_at = ? WHERE id = ?',
        provider, videoId, status, duration, duration, nowIso(), old.id);
      if (old.video_provider === 'local' && old.video_id && old.video_id !== videoId) rmQuiet(privVideos(), old.video_id);
    } else {
      const s = getSettings();
      const old = s.demo || {};
      setSetting('demo', { ...old, provider, video_id: videoId, status, duration_seconds: duration > 0 ? duration : old.duration_seconds || 0 });
      if (old.provider === 'local' && old.video_id && old.video_id !== videoId) rmQuiet(privVideos(), old.video_id);
    }
  }

  put('/api/admin/upload/video', async (req, res) => {
    if (config.video.provider !== 'local') throw bad('use_cloudflare', 'Videos upload directly to Cloudflare Stream on this site.');
    const q = new URL(req.url, 'http://x').searchParams;
    const t = target(q);
    if (t.kind === 'teacher') throw bad('invalid_target');
    const ct = String(req.headers['content-type'] || '');
    const ext = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-m4v': '.mp4' }[ct.split(';')[0]];
    if (!ext) throw bad('unsupported_video', 'Upload an MP4 (H.264/AAC) video.');
    const name = crypto.randomBytes(16).toString('hex') + ext;
    await streamToFile(req, path.join(privVideos(), name), config.maxVideoBytes);
    const duration = Math.max(0, Math.round(Number(q.get('duration')) || 0));
    setVideo(t, 'local', name, duration, 'ready');
    sendJson(res, 200, { ok: true, video_id: name });
  });

  post('/api/admin/cloudflare/upload-url', async (req, res) => {
    if (!cloudflare.configured()) throw bad('cloudflare_not_configured');
    const b = await readJson(req);
    const t = target(new URLSearchParams({ target: b.target, id: b.id ?? '' }));
    // The lesson keeps its current video until the browser finishes uploading and calls /select.
    const up = await cloudflare.createDirectUpload(t.kind === 'lesson' ? `lesson-${t.lesson.id}` : 'demo');
    sendJson(res, 200, { upload_url: up.uploadURL, uid: up.uid });
  });

  // Pick an existing video from the connected private Cloudflare Stream library.
  post('/api/admin/cloudflare/select', async (req, res) => {
    if (!cloudflare.configured()) throw bad('cloudflare_not_configured');
    const b = await readJson(req);
    const t = target(new URLSearchParams({ target: b.target, id: b.id ?? '' }));
    const v = await cloudflare.get(str(b.uid, 64));
    setVideo(t, 'cloudflare', str(b.uid, 64), v.duration, v.ready ? 'ready' : 'processing');
    sendJson(res, 200, { ok: true, ready: v.ready, duration: v.duration });
  });

  post('/api/admin/cloudflare/refresh', async (req, res) => {
    const b = await readJson(req);
    const t = target(new URLSearchParams({ target: b.target, id: b.id ?? '' }));
    const uid = t.kind === 'lesson' ? t.lesson.video_id : getSettings().demo?.video_id;
    if (!uid) throw bad('no_video');
    const v = await cloudflare.get(uid);
    setVideo(t, 'cloudflare', uid, v.duration, v.ready ? 'ready' : 'processing');
    sendJson(res, 200, { ready: v.ready, duration: v.duration, status: v.status });
  });

  put('/api/admin/upload/image', async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const t = target(q);
    const buf = await readBody(req, 5 * 1024 * 1024);
    const ext = buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.subarray(0, 4).toString('hex') === '89504e47' ? 'png'
      : buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
    if (!ext) throw bad('unsupported_image', 'Use a JPG, PNG or WebP image.');
    const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(pubImg(), name), buf);
    const url = `/media/img/${name}`;
    const oldOf = (u) => (u || '').replace('/media/img/', '');
    if (t.kind === 'lesson') { rmQuiet(pubImg(), oldOf(t.lesson.thumbnail)); run('UPDATE lessons SET thumbnail = ?, updated_at = ? WHERE id = ?', url, nowIso(), t.lesson.id); }
    else if (t.kind === 'teacher') { rmQuiet(pubImg(), oldOf(getSettings().teacher_photo)); setSetting('teacher_photo', url); }
    else { const d = getSettings().demo || {}; rmQuiet(pubImg(), oldOf(d.thumbnail)); setSetting('demo', { ...d, thumbnail: url }); }
    sendJson(res, 200, { url });
  });

  // ---------- textbooks ----------
  get('/api/admin/textbooks', (req, res) => {
    const books = all(`SELECT t.*, (SELECT COUNT(*) FROM lesson_refs r WHERE r.textbook_id = t.id) AS ref_count FROM textbooks t ORDER BY grade, is_active DESC, id DESC`);
    sendJson(res, 200, { textbooks: books, candidates: all('SELECT * FROM candidate_links ORDER BY grade, id') });
  });

  const TB_FIELDS = { title: 300, track: 120, language: 120, edition: 120, publication_year: 20, academic_year: 20, source_url: 1000, pdf_permission_note: 1000, notes: 3000 };

  post('/api/admin/textbooks', async (req, res) => {
    const b = await readJson(req);
    const g = grade(b.grade);
    const info = run('INSERT INTO textbooks (grade) VALUES (?)', g);
    const id = Number(info.lastInsertRowid);
    for (const [k, max] of Object.entries(TB_FIELDS)) if (k in b) run(`UPDATE textbooks SET ${k} = ? WHERE id = ?`, str(b[k], max), id);
    sendJson(res, 201, { textbook: one('SELECT * FROM textbooks WHERE id = ?', id) });
  });

  put('/api/admin/textbooks/:id', async (req, res, { id }) => {
    const t = textbookOr404(id);
    const b = await readJson(req);
    const n = { ...t };
    for (const [k, max] of Object.entries(TB_FIELDS)) if (k in b) n[k] = str(b[k], max);
    if ('source_kind' in b) { if (!['', 'official', 'authorized'].includes(b.source_kind)) throw bad('invalid_source_kind'); n.source_kind = b.source_kind; }
    if ('review_status' in b) { if (!['unreviewed', 'in_review', 'verified'].includes(b.review_status)) throw bad('invalid_status'); n.review_status = b.review_status; }
    if ('published' in b) n.published = b.published ? 1 : 0;
    if (n.source_url && !/^https:\/\/[^\s]+$/.test(n.source_url)) throw bad('invalid_url', 'Source links must start with https://');
    if (n.source_url && !n.source_kind) n.source_kind = '';
    if (n.published) {
      if (!n.title || !n.edition) throw bad('title_edition_required', 'Enter the title as printed and the edition before publishing.');
      if (n.review_status !== 'verified') throw bad('not_verified', 'Mark the record as verified against the students’ book before publishing.');
    }
    if (!n.published && t.is_active) throw new HttpError(409, 'active_edition', 'This is the active edition. Activate another edition first, or keep it published.');
    run(`UPDATE textbooks SET title=?, track=?, language=?, edition=?, publication_year=?, academic_year=?, source_url=?, source_kind=?, pdf_permission_note=?, notes=?, review_status=?, published=?, updated_at=? WHERE id=?`,
      n.title, n.track, n.language, n.edition, n.publication_year, n.academic_year, n.source_url, n.source_kind, n.pdf_permission_note, n.notes, n.review_status, n.published, nowIso(), t.id);
    sendJson(res, 200, { textbook: one('SELECT * FROM textbooks WHERE id = ?', t.id) });
  });

  del('/api/admin/textbooks/:id', (req, res, { id }) => {
    const t = textbookOr404(id);
    if (t.is_active || t.published) throw new HttpError(409, 'in_use', 'Unpublish this record (and make another edition active) before deleting it.');
    run('DELETE FROM textbooks WHERE id = ?', t.id);
    rmQuiet(privPdfs(), t.pdf_file);
    sendJson(res, 200, { ok: true });
  });

  put('/api/admin/textbooks/:id/pdf', async (req, res, { id }) => {
    const t = textbookOr404(id);
    const q = new URL(req.url, 'http://x').searchParams;
    const permission = str(q.get('permission'), 1000);
    if (permission.length < 5) throw bad('permission_required', 'Describe your permission to distribute this PDF.');
    const name = crypto.randomBytes(16).toString('hex') + '.pdf';
    const dest = path.join(privPdfs(), name);
    await streamToFile(req, dest, 200 * 1024 * 1024);
    const fd = fs.openSync(dest, 'r'); const head = Buffer.alloc(5); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
    if (head.toString() !== '%PDF-') { fs.rmSync(dest, { force: true }); throw bad('not_pdf', 'That file is not a PDF.'); }
    rmQuiet(privPdfs(), t.pdf_file);
    run('UPDATE textbooks SET pdf_file = ?, pdf_permission_note = ?, updated_at = ? WHERE id = ?', name, permission, nowIso(), t.id);
    sendJson(res, 200, { textbook: one('SELECT * FROM textbooks WHERE id = ?', t.id) });
  });

  del('/api/admin/textbooks/:id/pdf', (req, res, { id }) => {
    const t = textbookOr404(id);
    rmQuiet(privPdfs(), t.pdf_file);
    run('UPDATE textbooks SET pdf_file = NULL, updated_at = ? WHERE id = ?', nowIso(), t.id);
    sendJson(res, 200, { ok: true });
  });

  // Review before switching the active edition: which lessons still lack references in the new edition.
  get('/api/admin/textbooks/:id/review', (req, res, { id }) => {
    const t = textbookOr404(id);
    const current = one('SELECT * FROM textbooks WHERE grade = ? AND is_active = 1', t.grade);
    const lessons = all(`SELECT l.id, l.title, l.published, c.title chapter_title FROM lessons l JOIN chapters c ON c.id = l.chapter_id WHERE c.grade = ? ORDER BY c.sort, c.id, l.sort, l.id`, t.grade)
      .map((l) => ({
        ...l,
        current_ref: current ? one('SELECT * FROM lesson_refs WHERE lesson_id = ? AND textbook_id = ?', l.id, current.id) || null : null,
        new_ref: one('SELECT * FROM lesson_refs WHERE lesson_id = ? AND textbook_id = ?', l.id, t.id) || null,
      }));
    sendJson(res, 200, { textbook: t, current, lessons, missing: lessons.filter((l) => l.published && !(l.new_ref && l.new_ref.reviewed)).length });
  });

  post('/api/admin/textbooks/:id/copy-refs', async (req, res, { id }) => {
    const t = textbookOr404(id);
    const b = await readJson(req);
    const from = textbookOr404(b.from_id);
    if (from.grade !== t.grade) throw bad('grade_mismatch');
    const info = run(`INSERT OR IGNORE INTO lesson_refs (lesson_id, textbook_id, chapter, section, pages, exercises, reviewed)
                      SELECT lesson_id, ?, chapter, section, pages, exercises, 0 FROM lesson_refs WHERE textbook_id = ?`, t.id, from.id);
    sendJson(res, 200, { copied: Number(info.changes) });
  });

  post('/api/admin/textbooks/:id/activate', async (req, res, { id }) => {
    const t = textbookOr404(id);
    const b = await readJson(req);
    if (!t.published || t.review_status !== 'verified') throw new HttpError(409, 'not_ready', 'Verify and publish this edition before making it active.');
    const missing = one(`SELECT COUNT(*) n FROM lessons l JOIN chapters c ON c.id = l.chapter_id
      WHERE c.grade = ? AND l.published = 1 AND NOT EXISTS (SELECT 1 FROM lesson_refs r WHERE r.lesson_id = l.id AND r.textbook_id = ? AND r.reviewed = 1)`, t.grade, t.id).n;
    if (missing && !b.confirm_missing) throw new HttpError(409, 'refs_unreviewed', `${missing} published lesson(s) have no reviewed reference for this edition.`, { missing });
    tx(() => {
      run('UPDATE textbooks SET is_active = 0 WHERE grade = ?', t.grade);
      run('UPDATE textbooks SET is_active = 1, updated_at = ? WHERE id = ?', nowIso(), t.id);
    });
    sendJson(res, 200, { ok: true });
  });

  put('/api/admin/candidates/:id', async (req, res, { id }) => {
    const c = one('SELECT * FROM candidate_links WHERE id = ?', int(id));
    if (!c) throw new HttpError(404, 'not_found');
    const b = await readJson(req);
    const status = 'status' in b ? b.status : c.status;
    if (!['to_review', 'matches', 'does_not_match'].includes(status)) throw bad('invalid_status');
    run('UPDATE candidate_links SET status = ?, notes = ?, reviewed_at = ? WHERE id = ?', status, 'notes' in b ? str(b.notes, 2000) : c.notes, status === 'to_review' ? null : nowIso(), c.id);
    sendJson(res, 200, { candidate: one('SELECT * FROM candidate_links WHERE id = ?', c.id) });
  });

  post('/api/admin/candidates', async (req, res) => {
    const b = await readJson(req);
    const url = str(b.url, 1000);
    if (!/^https:\/\/\S+$/.test(url)) throw bad('invalid_url');
    const g = Number(b.grade) === 0 ? 0 : grade(b.grade);
    const info = run('INSERT INTO candidate_links (grade, label, url, notes) VALUES (?, ?, ?, ?)', g, str(b.label, 300) || url, url, str(b.notes, 2000));
    sendJson(res, 201, { candidate: one('SELECT * FROM candidate_links WHERE id = ?', Number(info.lastInsertRowid)) });
  });

  // ---------- enrollments ----------
  const enrollmentRow = (e) => e && ({
    ...e, grades: parseGrades(e.grades),
    state: e.status === 'cancelled' ? 'cancelled' : enrollmentState(e),
    is_latest: one('SELECT MAX(id) m FROM enrollments WHERE user_id = ?', e.user_id).m === e.id,
  });

  get('/api/admin/enrollments', (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const term = str(q.get('q'), 200).toUpperCase();
    const status = q.get('status') || 'all';
    const where = []; const p = [];
    if (term) { where.push('(UPPER(e.reference) LIKE ? OR UPPER(u.email) LIKE ? OR UPPER(u.name) LIKE ?)'); const like = `%${term.replace(/[%_]/g, '')}%`; p.push(like, like, like); }
    const now = nowIso();
    if (status === 'pending') where.push(`e.status = 'pending'`);
    else if (status === 'active') { where.push(`e.status = 'active' AND (e.expires_at IS NULL OR e.expires_at > ?)`); p.push(now); }
    else if (status === 'expired') { where.push(`e.status = 'active' AND e.expires_at <= ?`); p.push(now); }
    else if (status === 'revoked') where.push(`e.status IN ('revoked','cancelled')`);
    const rows = all(`SELECT e.*, u.name student_name, u.email student_email, u.grade student_grade FROM enrollments e JOIN users u ON u.id = e.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE e.status WHEN 'pending' THEN 0 ELSE 1 END, e.requested_at DESC LIMIT 300`, ...p);
    sendJson(res, 200, { enrollments: rows.map(enrollmentRow) });
  });

  get('/api/admin/enrollments/:id', (req, res, { id }) => {
    const e = one(`SELECT e.*, u.name student_name, u.email student_email, u.grade student_grade FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.id = ?`, int(id));
    if (!e) throw new HttpError(404, 'not_found');
    const events = all(`SELECT ev.*, a.name actor_name, a.role actor_role FROM enrollment_events ev LEFT JOIN users a ON a.id = ev.actor_id WHERE ev.enrollment_id = ? ORDER BY ev.id DESC`, e.id);
    sendJson(res, 200, { enrollment: enrollmentRow(e), events });
  });

  const loadE = (id) => { const e = one('SELECT * FROM enrollments WHERE id = ?', int(id)); if (!e) throw new HttpError(404, 'not_found'); return e; };

  post('/api/admin/enrollments/:id/approve', async (req, res, { id }, admin) => {
    const b = await readJson(req);
    const e = loadE(id);
    if (e.status === 'cancelled') throw new HttpError(409, 'cancelled', 'This request was cancelled.');
    const latest = one('SELECT MAX(id) m FROM enrollments WHERE user_id = ?', e.user_id).m;
    if (e.status !== 'pending' && e.id !== latest) throw new HttpError(409, 'not_latest', 'The student has a newer request — approve that one instead.');
    let expires = null;
    const date = 'expires_date' in b ? str(b.expires_date, 10) : (e.access_mode === 'end_date' ? e.access_end_date : '');
    if (date) {
      expires = endOfDayIso(date);
      if (!expires) throw bad('invalid_date');
      if (Date.parse(expires) <= Date.now()) throw bad('end_date_past', 'Choose an end date in the future.');
    }
    const note = str(b.note, 2000);
    tx(() => {
      // A student keeps one current enrollment: close any other open request and any other unexpired access.
      for (const o of all(`SELECT id, status FROM enrollments WHERE user_id = ? AND id != ? AND (status = 'pending' OR (status = 'active' AND (expires_at IS NULL OR expires_at > ?)))`, e.user_id, e.id, nowIso())) {
        run(`UPDATE enrollments SET status = ?, revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ?`, o.status === 'pending' ? 'cancelled' : 'revoked', nowIso(), admin.id, nowIso(), o.id);
        logEvent(o.id, admin.id, 'superseded', `Replaced by ${e.reference}`);
      }
      run(`UPDATE enrollments SET status = 'active', approved_at = ?, approved_by = ?, expires_at = ?, revoked_at = NULL, revoked_by = NULL,
           payment_note = CASE WHEN ? != '' THEN ? ELSE payment_note END, updated_at = ? WHERE id = ?`, nowIso(), admin.id, expires, note, note, nowIso(), e.id);
      logEvent(e.id, admin.id, 'approved', expires ? `Access until ${date}` : 'Ongoing access');
    });
    const u = one('SELECT * FROM users WHERE id = ?', e.user_id);
    const fresh = loadE(e.id);
    emails.approved(u, fresh, getSettings().course_title, gradesText(parseGrades(fresh.grades)), expires ? `until ${date}` : 'ongoing').catch((err) => console.error(err));
    sendJson(res, 200, { enrollment: enrollmentRow(fresh) });
  });

  post('/api/admin/enrollments/:id/revoke', async (req, res, { id }, admin) => {
    const b = await readJson(req);
    const e = loadE(id);
    if (!['active', 'pending'].includes(e.status)) throw new HttpError(409, 'not_revocable');
    const newStatus = e.status === 'pending' ? 'cancelled' : 'revoked';
    tx(() => {
      run(`UPDATE enrollments SET status = ?, revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ?`, newStatus, nowIso(), admin.id, nowIso(), e.id);
      logEvent(e.id, admin.id, newStatus === 'cancelled' ? 'request_cancelled' : 'revoked', str(b.reason, 500));
    });
    sendJson(res, 200, { enrollment: enrollmentRow(loadE(e.id)) });
  });

  post('/api/admin/enrollments/:id/expiry', async (req, res, { id }, admin) => {
    const b = await readJson(req);
    const e = loadE(id);
    if (e.status !== 'active') throw new HttpError(409, 'not_active');
    const date = str(b.expires_date, 10);
    let expires = null;
    if (date) { expires = endOfDayIso(date); if (!expires) throw bad('invalid_date'); }
    run('UPDATE enrollments SET expires_at = ?, updated_at = ? WHERE id = ?', expires, nowIso(), e.id);
    logEvent(e.id, admin.id, 'expiry_changed', expires ? `Access until ${date}` : 'Ongoing access');
    sendJson(res, 200, { enrollment: enrollmentRow(loadE(e.id)) });
  });

  // Move a student to another grade (e.g. the next school year). Updates the account and this enrollment.
  post('/api/admin/enrollments/:id/grade', async (req, res, { id }, admin) => {
    const b = await readJson(req);
    const e = loadE(id);
    const g = grade(b.grade);
    if (one('SELECT MAX(id) m FROM enrollments WHERE user_id = ?', e.user_id).m !== e.id) throw new HttpError(409, 'not_latest', 'Change the grade on the student’s newest enrollment.');
    tx(() => {
      run('UPDATE users SET grade = ? WHERE id = ?', g, e.user_id);
      run('UPDATE enrollments SET grades = ?, updated_at = ? WHERE id = ?', JSON.stringify([g]), nowIso(), e.id);
      logEvent(e.id, admin.id, 'grade_changed', `Grade ${parseGrades(e.grades).join(', ')} → Grade ${g}`);
    });
    sendJson(res, 200, { enrollment: enrollmentRow(loadE(e.id)) });
  });

  post('/api/admin/enrollments/:id/note', async (req, res, { id }, admin) => {
    const b = await readJson(req);
    const e = loadE(id);
    const note = str(b.note, 2000);
    run('UPDATE enrollments SET payment_note = ?, updated_at = ? WHERE id = ?', note, nowIso(), e.id);
    logEvent(e.id, admin.id, 'note_updated');
    sendJson(res, 200, { enrollment: enrollmentRow(loadE(e.id)) });
  });

  // Dev helper: view console-mode emails (never exposed when a real provider is configured).
  get('/api/admin/outbox', (req, res) => {
    if (config.email.provider !== 'console') throw new HttpError(404, 'not_found');
    sendJson(res, 200, { emails: all('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 50') });
  });
}
