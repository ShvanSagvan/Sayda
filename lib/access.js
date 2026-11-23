import crypto from 'node:crypto';
import { config } from './config.js';
import { one, run, getSettings } from './db.js';

// Enrollment reference shown to students/parents. No look-alike characters (0/O, 1/I/L).
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newReference() {
  for (;;) {
    const b = crypto.randomBytes(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += ALPHA[b[i] % ALPHA.length];
    const ref = `MA-${s.slice(0, 4)}-${s.slice(4)}`;
    if (!one('SELECT 1 FROM enrollments WHERE reference = ?', ref)) return ref;
  }
}

// End of the given calendar day in the site's timezone (Asia/Baghdad).
export function endOfDayIso(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  const d = new Date(`${date}T23:59:59${config.timezoneOffset}`);
  return isNaN(d) ? null : d.toISOString();
}

export function parseGrades(g) {
  try { const a = JSON.parse(g); return Array.isArray(a) ? a.map(Number) : []; } catch { return []; }
}

// Derived status of an enrollment row for display and access decisions.
export function enrollmentState(e, now = Date.now()) {
  if (!e) return 'ready';
  if (e.status === 'pending') return 'pending';
  if (e.status === 'revoked') return 'revoked';
  if (e.status === 'active') return e.expires_at && Date.parse(e.expires_at) <= now ? 'expired' : 'active';
  return 'ready';
}

// The enrollment that matters for a student: an open pending request, else the latest one.
export function currentEnrollment(userId) {
  return one(`SELECT * FROM enrollments WHERE user_id = ? AND status = 'pending'`, userId)
    || one(`SELECT * FROM enrollments WHERE user_id = ? AND status = 'active' ORDER BY approved_at DESC LIMIT 1`, userId)
    || one(`SELECT * FROM enrollments WHERE user_id = ? ORDER BY id DESC LIMIT 1`, userId);
}

// Active, unexpired access covering a given grade?
// Grades a student can watch: their active enrollment's grades, limited to the grade on their account
// (accounts made before grades existed have no grade and keep what they paid for).
export function activeGrades(userId) {
  const e = one(`SELECT * FROM enrollments WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) ORDER BY approved_at DESC LIMIT 1`, userId, new Date().toISOString());
  if (!e) return [];
  const mine = one('SELECT grade FROM users WHERE id = ?', userId)?.grade;
  return parseGrades(e.grades).filter((g) => !mine || g === mine);
}
export const hasGradeAccess = (userId, grade) => activeGrades(userId).includes(Number(grade));

// Lesson with its grade, or null.
export function lessonWithGrade(id) {
  return one(`SELECT l.*, c.grade, c.published AS chapter_published, c.title AS chapter_title FROM lessons l JOIN chapters c ON c.id = l.chapter_id WHERE l.id = ?`, Number(id)) || null;
}
export const isLessonPublic = (l) => !!(l && l.published && l.chapter_published);

// Central gate used by playback tokens AND every local media range request.
export function canWatch(user, lesson) {
  if (!user || !lesson) return { ok: false, code: 'not_found' };
  if (user.role === 'admin') return { ok: true }; // teacher preview, drafts included
  if (!isLessonPublic(lesson)) return { ok: false, code: 'not_found' };
  if (!hasGradeAccess(user.id, lesson.grade)) {
    const e = currentEnrollment(user.id);
    return { ok: false, code: 'no_access', state: enrollmentState(e) };
  }
  return { ok: true };
}

export function logEvent(enrollmentId, actorId, action, detail = '') {
  run('INSERT INTO enrollment_events (enrollment_id, actor_id, action, detail) VALUES (?, ?, ?, ?)', enrollmentId, actorId, action, detail);
}

export function courseTerms() {
  const s = getSettings();
  const grades = (s.grades_included || []).map(Number).filter((g) => [10, 11, 12].includes(g)).sort();
  const access_mode = s.access_mode === 'end_date' && s.access_end_date ? 'end_date' : 'ongoing';
  const access_end_date = access_mode === 'end_date' ? s.access_end_date : null;
  const price_iqd = Number(s.price_iqd) || 0;
  const ended = access_end_date ? Date.parse(endOfDayIso(access_end_date)) <= Date.now() : false;
  return { price_iqd, grades, access_mode, access_end_date, open: price_iqd > 0 && grades.length > 0 && !ended };
}

export function whatsappMessage(template, price, reference, student = {}) {
  let m = String(template)
    .replaceAll('[Price]', Number(price).toLocaleString('en-US'))
    .replaceAll('[Reference]', reference)
    .replaceAll('[Grade]', student.grade ? `Grade ${student.grade}` : '')
    .replaceAll('[Name]', student.name || '')
    .replaceAll('[Email]', student.email || '');
  // Older saved templates without the student details: add them so the teacher can confirm who paid.
  if (student.name && !String(template).includes('[Name]')) m += `\nStudent: ${student.name} (${student.email})${student.grade ? ` — Grade ${student.grade}` : ''}`;
  return m;
}
export function waDigits(n) {
  const d = String(n || '').replace(/\D/g, '').replace(/^00/, '');
  return /^07\d{9}$/.test(d) ? '964' + d.slice(1) : d; // local Iraqi format 07xx xxx xxxx
}
