// Teacher super-admin dashboard. Every action here is also checked server-side (role = admin).
import { h, append, clear, icon, toast, copyText, fmtIqd, fmtDuration, fmtDate, fmtPhone, ltr, sheet, confirmSheet, field, input, textarea, select, busy } from './ui.js';
import { api } from './api.js';
import { STRINGS } from './i18n.js';
import { createPlayer } from './player.js';
import { onLeave, navigate, refreshSite, state } from './app.js';

const GRADES = [10, 11, 12];
let overview = null;
const err = (e) => e?.message || 'Something went wrong.';
const statusBadge = (s) => h('span', { class: `badge ${{ pending: 'warn', active: 'ok', expired: 'bad', revoked: 'bad', cancelled: 'neutral', superseded: 'neutral' }[s] || 'neutral'}` },
  { pending: 'Awaiting confirmation', active: 'Access granted', expired: 'Expired', revoked: 'Revoked', cancelled: 'Cancelled', superseded: 'Replaced by newer request' }[s] || s);
const pubBadge = (p) => h('span', { class: `badge ${p ? 'ok' : 'neutral'}` }, p ? 'Published' : 'Draft');
const reviewBadge = (r) => h('span', { class: `badge ${{ verified: 'ok', in_review: 'warn', unreviewed: 'bad' }[r]}` }, { verified: 'Verified', in_review: 'In review', unreviewed: 'Not reviewed' }[r]);

async function save(btn, fn, okMsg = 'Saved') {
  busy(btn, true);
  try { const r = await fn(); if (okMsg) toast(okMsg + ' ✓'); return r; }
  catch (e) { toast(err(e), 'bad'); throw e; }
  finally { busy(btn, false); }
}
const swallow = (p) => p.catch(() => {});

function parseDuration(v) {
  const s = String(v || '').trim();
  if (!s) return 0;
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((a, n) => a * 60 + n, 0);
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true;
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); resolve(Math.round(d || 0)); };
    v.onloadedmetadata = () => done(isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 15000);
    v.src = url;
  });
}
// Grab a frame from a local video file to use as a thumbnail.
function captureFrame(file, at = 3) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const url = URL.createObjectURL(file);
    const fin = (b) => { URL.revokeObjectURL(url); resolve(b); };
    v.onloadeddata = () => { v.currentTime = Math.min(at, (v.duration || 6) / 3); };
    v.onseeked = () => {
      const c = document.createElement('canvas');
      const w = Math.min(960, v.videoWidth || 960); c.width = w; c.height = Math.round(w * (v.videoHeight || 540) / (v.videoWidth || 960));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((b) => fin(b), 'image/jpeg', 0.82);
    };
    v.onerror = () => fin(null);
    setTimeout(() => fin(null), 20000);
    v.src = url;
  });
}
const videoType = (f) => f.type || ({ mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[f.name.split('.').pop().toLowerCase()] || 'video/mp4');

// Video upload widget shared by lessons and the demo.
function videoUploader({ target, id, current, onDone }) {
  const cf = overview.video_provider === 'cloudflare';
  const box = h('div', { class: 'stack' });
  const bar = h('div', { class: 'progress', hidden: true, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Upload progress' }, h('span'));
  const status = h('div', { class: 'small muted', 'aria-live': 'polite' });
  const file = h('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.m4v,.webm', class: 'input' });
  const cancel = h('button', { class: 'btn danger sm', type: 'button', hidden: true }, 'Cancel upload');
  let job = null;
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    bar.hidden = false; cancel.hidden = false; file.disabled = true;
    const setP = (p) => { const pc = Math.round(p * 100); bar.firstChild.style.width = pc + '%'; bar.setAttribute('aria-valuenow', pc); status.textContent = `Uploading ${f.name} — ${pc}%`; };
    try {
      const duration = await probeDuration(f);
      if (cf) {
        const { upload_url, uid } = await api.post('/api/admin/cloudflare/upload-url', { target, id });
        const fd = new FormData(); fd.append('file', f);
        job = api.upload('POST', upload_url, fd, setP);
        await job.promise;
        // Only now switch the lesson to the new video (the old one keeps playing until this point).
        await api.post('/api/admin/cloudflare/select', { target, id, uid });
        status.textContent = 'Uploaded. Cloudflare is processing the video — refresh the status in a minute.';
      } else {
        job = api.upload('PUT', `/api/admin/upload/video?target=${target}&id=${id ?? ''}&duration=${duration}`, f, setP, videoType(f));
        await job.promise;
        status.textContent = 'Video uploaded ✓';
      }
      if (target === 'lesson' && !current?.thumbnail) {
        const blob = await captureFrame(f);
        if (blob) await swallow(api.upload('PUT', `/api/admin/upload/image?target=lesson&id=${id}`, blob, null, 'image/jpeg').promise);
      }
      toast('Video uploaded ✓');
      onDone && onDone();
    } catch (e) { status.textContent = err(e); toast(err(e), 'bad'); }
    finally { job = null; cancel.hidden = true; file.disabled = false; file.value = ''; }
  });
  cancel.addEventListener('click', () => job?.abort());
  append(box, [
    field(current?.video_id ? 'Replace video' : 'Upload video', file, cf ? 'Uploads go straight to your private Cloudflare Stream library.' : 'MP4 (H.264 + AAC) plays on every phone and computer. Large files are fine; keep this page open until it finishes.'),
    bar, status, cancel,
  ]);
  if (cf) {
    const uid = input({ placeholder: '32-character Stream video ID', autocapitalize: 'none', spellcheck: 'false', class: 'input mono' });
    const pick = h('button', { class: 'btn secondary', type: 'button' }, 'Use this video');
    pick.addEventListener('click', () => save(pick, () => api.post('/api/admin/cloudflare/select', { target, id, uid: uid.value.trim() }), 'Video linked').then(() => onDone && onDone()).catch(() => {}));
    const refresh = h('button', { class: 'btn ghost', type: 'button' }, icon('retry'), 'Refresh processing status');
    refresh.addEventListener('click', () => save(refresh, () => api.post('/api/admin/cloudflare/refresh', { target, id }), 'Status updated').then(() => onDone && onDone()).catch(() => {}));
    append(box, [h('details', null, h('summary', { style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'Choose a video already in Cloudflare Stream'), h('div', { class: 'row', style: 'margin-top:8px' }, uid, pick)), current?.video_id ? refresh : null]);
  }
  return box;
}

function imageUploader(label, url, target, id, onDone) {
  const f = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'input' });
  f.addEventListener('change', async () => {
    const file = f.files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Images must be under 5 MB.', 'bad'); return; }
    try { await api.upload('PUT', `/api/admin/upload/image?target=${target}&id=${id ?? ''}`, file, null, file.type).promise; toast('Image updated ✓'); onDone && onDone(); }
    catch (e) { toast(err(e), 'bad'); }
  });
  return h('div', { class: 'stack' }, url ? h('img', { src: url, alt: '', style: 'width:180px;border-radius:10px;border:1px solid var(--line)' }) : null, field(label, f));
}

// ---------------- shell ----------------
export async function renderAdmin(root, path) {
  overview = await api.get('/api/admin/overview');
  const nav = [
    ['/admin', 'Overview'], ['/admin/enrollments', 'Enrollments', overview.pending], ['/admin/course', 'Lessons'],
    ['/admin/textbooks', 'Textbooks', overview.candidates_to_review + overview.textbooks_unverified || 0], ['/admin/settings', 'Settings'], ['/admin/wording', 'Site wording'],
    ...(overview.email_provider === 'console' ? [['/admin/outbox', 'Test emails']] : []),
  ];
  const curSection = path.startsWith('/admin/lessons') ? '/admin/course' : path.replace(/^(\/admin\/[a-z]+).*$/, '$1');
  const content = h('div', { class: 'admin-main' });
  const signOut = h('button', { class: 'btn ghost sm', type: 'button', style: 'margin-top:auto' }, 'Sign out');
  signOut.addEventListener('click', async () => { await api.post('/api/auth/logout'); state.catalog = null; await refreshSite(); navigate('/'); });
  append(root, h('div', { class: 'admin-shell' },
    h('nav', { class: 'admin-nav', 'aria-label': 'Dashboard' }, nav.map(([href, label, count]) => h('a', { href, 'aria-current': curSection === href ? 'page' : undefined }, label, count ? h('span', { class: 'count' }, count) : null)), signOut),
    content));
  let m;
  if (path === '/admin') return overviewPage(content);
  if (path === '/admin/enrollments') return enrollmentsPage(content);
  if (path === '/admin/course') return coursePage(content, 10);
  if ((m = path.match(/^\/admin\/course\/(10|11|12)$/))) return coursePage(content, Number(m[1]));
  if ((m = path.match(/^\/admin\/lessons\/(\d+)$/))) return lessonEditor(content, Number(m[1]));
  if (path === '/admin/textbooks') return textbooksAdmin(content);
  if (path === '/admin/settings') return settingsPage(content);
  if (path === '/admin/wording') return wordingPage(content);
  if (path === '/admin/outbox') return outboxPage(content);
  content.append(h('p', null, 'Not found.'));
}

function overviewPage(c) {
  const o = overview;
  const todo = [];
  if (o.settings_missing.includes('whatsapp_number')) todo.push(['Add your WhatsApp number so students can reach you.', '/admin/settings']);
  if (o.settings_missing.includes('price_iqd')) todo.push(['Set the course price in IQD.', '/admin/settings']);
  if (!o.chapters) todo.push(['Add your first chapter and lesson, then upload its video (Lessons → choose a grade → Add chapter → + Lesson → Upload video).', '/admin/course']);
  else if (!o.lessons_with_video) todo.push(['Upload a video: Lessons → open a lesson with “Edit” → Upload video.', '/admin/course']);
  if (o.candidates_to_review) todo.push([`Review ${o.candidates_to_review} candidate textbook link(s) — they stay private until you check them.`, '/admin/textbooks']);
  if (o.textbooks_unverified) todo.push([`${o.textbooks_unverified} textbook record(s) are not verified yet (pay special attention to Grade 10, revised for 2025–2026).`, '/admin/textbooks']);
  if (o.video_provider === 'cloudflare' && !o.cloudflare_configured) todo.push(['Cloudflare Stream is selected but not fully configured on the server.', null]);
  if (o.email_provider === 'console') todo.push(['Emails are in test mode (shown under “Test emails”). Configure an email provider before launch.', '/admin/outbox']);
  append(c, [
    h('h1', null, 'Teacher dashboard'),
    h('div', { class: 'stat-grid' },
      [['Awaiting confirmation', o.pending, '/admin/enrollments?status=pending'], ['Active students', o.active, '/admin/enrollments?status=active'], ['Published lessons', o.lessons, '/admin/course'], ['Draft lessons', o.drafts, '/admin/course']]
        .map(([l, n, href]) => h('a', { class: 'card stat', href }, h('div', { class: 'n' }, n), h('div', { class: 'muted small' }, l)))),
    h('h2', { style: 'margin-top:24px' }, 'Before you launch'),
    todo.length ? h('div', { class: 'list' }, todo.map(([txt, href]) => h('div', { class: 'card item' }, h('div', { class: 'row between' }, h('span', { class: 'grow' }, txt), href ? h('a', { class: 'btn secondary sm', href }, 'Open') : null))))
      : h('div', { class: 'notice ok' }, h('p', null, 'Everything essential is set up.')),
  ]);
}

// ---------------- enrollments ----------------
async function enrollmentsPage(c) {
  const params = new URLSearchParams(location.search);
  let q = params.get('q') || '', status = params.get('status') || 'all';
  const search = input({ type: 'search', placeholder: 'Search reference, email or name', value: q, 'aria-label': 'Search enrollments', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'search' });
  const chips = h('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Filter by status' });
  const list = h('div', { class: 'list', 'aria-live': 'polite' });
  const filters = [['all', 'All'], ['pending', 'Awaiting'], ['active', 'Active'], ['expired', 'Expired'], ['revoked', 'Revoked / cancelled']];
  const drawChips = () => { clear(chips).append(...filters.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(status === v), onclick: () => { status = v; drawChips(); load(); } }, l))); };
  let seq = 0, autoOpened = '';
  async function load() {
    const my = ++seq;
    history.replaceState(null, '', `/admin/enrollments?${new URLSearchParams({ ...(q ? { q } : {}), ...(status !== 'all' ? { status } : {}) })}`);
    const r = await api.get(`/api/admin/enrollments?q=${encodeURIComponent(q)}&status=${status}`);
    if (my !== seq) return;
    clear(list);
    if (!r.enrollments.length) { list.append(h('div', { class: 'card empty' }, q ? 'No enrollment matches that search.' : 'No enrollments yet.')); return; }
    for (const e of r.enrollments) {
      list.append(h('button', { class: 'card item', type: 'button', onclick: () => enrollmentSheet(e.id, load) },
        h('div', { class: 'item-head' }, h('span', { class: 'item-title' }, e.student_name), statusBadge(e.state)),
        h('div', { class: 'row small' }, h('span', { class: 'mono', dir: 'ltr' }, e.reference), h('span', { class: 'muted' }, ltr(e.student_email))),
        h('div', { class: 'row small muted' }, `Requested ${fmtDate(e.requested_at, true)}`, e.whatsapp_open_count ? ` · WhatsApp opened ${e.whatsapp_open_count}×` : ' · WhatsApp not opened yet',
          ` · ${fmtIqd(e.price_iqd)} IQD`), h('div', { class: 'row small' }, ...e.grades.map((g) => h('span', { class: `chip g${g}` }, `Grade ${g}`)))));
    }
    // Exact reference typed/pasted: open it once (not again after every refresh).
    if (r.enrollments.length === 1 && q && q !== autoOpened && r.enrollments[0].reference.toUpperCase() === q.toUpperCase()) { autoOpened = q; enrollmentSheet(r.enrollments[0].id, load); }
  }
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); load(); }, 250); });
  drawChips();
  append(c, [h('h1', null, 'Enrollments'),
    h('p', { class: 'muted' }, 'Match the reference in the WhatsApp message or FIB transfer note, check the payment arrived in FIB, then approve. A parent may pay from a different phone — the reference identifies the student.'),
    h('div', { class: 'toolbar' }, search), chips, h('div', { style: 'height:12px' }), list]);
  await load();
  if (!matchMedia('(pointer: coarse)').matches) search.focus({ preventScroll: true });
}

async function enrollmentSheet(id, onChange) {
  const { enrollment: e, events } = await api.get(`/api/admin/enrollments/${id}`);
  sheet(e.student_name, (body, close) => {
    const refresh = () => { close(); onChange && onChange(); };
    const copyRef = h('button', { class: 'btn secondary sm', type: 'button', onclick: async () => toast((await copyText(e.reference)) ? 'Copied ✓' : e.reference) }, icon('copy'), 'Copy');
    append(body, [
      h('div', { class: 'row between' }, statusBadge(e.state), h('span', { class: 'mono', dir: 'ltr', style: 'font-weight:800' }, e.reference), copyRef),
      h('dl', { class: 'kv', style: 'margin-top:14px' },
        h('dt', null, 'Name'), h('dd', null, e.student_name),
        h('dt', null, 'Email'), h('dd', null, ltr(e.student_email)),
        h('dt', null, 'Requested'), h('dd', null, fmtDate(e.requested_at, true)),
        h('dt', null, 'Price'), h('dd', null, `${fmtIqd(e.price_iqd)} IQD`),
        h('dt', null, 'Grade'), h('dd', null, e.grades.map((g) => `Grade ${g}`).join(', ')),
        h('dt', null, 'Terms shown'), h('dd', null, e.access_mode === 'end_date' ? `Until ${fmtDate(e.access_end_date)}` : 'Ongoing'),
        e.approved_at ? [h('dt', null, 'Approved'), h('dd', null, fmtDate(e.approved_at, true))] : null,
        e.state === 'active' || e.state === 'expired' ? [h('dt', null, 'Access ends'), h('dd', null, e.expires_at ? fmtDate(e.expires_at, true) : 'No end date')] : null,
        h('dt', null, 'WhatsApp'), h('dd', null, e.whatsapp_open_count ? `Opened ${e.whatsapp_open_count}× (last ${fmtDate(e.whatsapp_opened_at, true)})` : 'Not opened')),
    ]);
    if (e.is_latest) {
      const gsel = select([[10, 'Grade 10'], [11, 'Grade 11'], [12, 'Grade 12']], e.student_grade || e.grades[0] || 10, { 'aria-label': 'Grade' });
      const gbtn = h('button', { class: 'btn secondary sm', type: 'button' }, 'Change grade');
      gbtn.addEventListener('click', () => save(gbtn, () => api.post(`/api/admin/enrollments/${e.id}/grade`, { grade: Number(gsel.value) }), 'Grade changed').then(refresh).catch(() => {}));
      append(body, h('div', { class: 'row', style: 'margin-top:12px' }, h('div', { class: 'grow' }, gsel), gbtn));
    }
    if (['pending', 'revoked', 'expired'].includes(e.state) && e.is_latest) {
      const ongoing = h('input', { type: 'checkbox', checked: e.access_mode !== 'end_date' });
      const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10); // Duhok date
      const future = e.access_mode === 'end_date' && e.access_end_date && e.access_end_date >= today ? e.access_end_date : '';
      const date = input({ type: 'date', value: future, min: today, disabled: e.access_mode !== 'end_date' });
      ongoing.addEventListener('change', () => { date.disabled = ongoing.checked; if (!ongoing.checked) date.focus(); });
      const note = textarea({ rows: 2, placeholder: 'e.g. FIB transfer 25,000 IQD received 21 Nov from parent’s account', value: e.payment_note || '' });
      const idOk = h('input', { type: 'checkbox' });
      const approve = h('button', { class: 'btn block lg', type: 'button' }, icon('check'), e.state === 'pending' ? 'Payment verified — approve access' : 'Grant access again');
      approve.addEventListener('click', async () => {
        if (!idOk.checked) { toast('Confirm the student’s name or email matches the payment first.', 'bad'); idOk.focus(); return; }
        if (!ongoing.checked && !date.value) { toast('Choose an end date or tick “Ongoing access”.', 'bad'); date.focus(); return; }
        const ok = await confirmSheet('Approve access?', `${e.student_name} (${e.student_email}) will be able to watch ${e.grades.map((g) => 'Grade ' + g).join(', ')} videos immediately.`, 'Approve');
        if (!ok) return;
        await save(approve, () => api.post(`/api/admin/enrollments/${e.id}/approve`, { expires_date: ongoing.checked ? '' : date.value, note: note.value }), 'Access granted').then(refresh).catch(() => {});
      });
      append(body, h('section', { class: 'card flat stack', style: 'margin-top:16px' }, h('h3', null, 'Approve after checking FIB'),
        h('label', { class: 'check' }, idOk, h('span', null, 'I checked the payment in FIB and the student’s name or email (', h('b', null, e.student_name), ' · ', ltr(e.student_email), ') matches the WhatsApp message / reference')),
        h('label', { class: 'check' }, ongoing, h('span', null, 'Ongoing access (no end date)')), field('Access end date', date, 'Access stops at the end of this day (Duhok time).'),
        field('Private payment note', note, 'Only teachers can see this.'), approve));
    }
    if (e.state === 'active') {
      const date = input({ type: 'date', value: e.expires_at ? new Date(Date.parse(e.expires_at) + 3 * 3600_000).toISOString().slice(0, 10) : '' });
      const setExp = h('button', { class: 'btn secondary', type: 'button' }, 'Save end date');
      setExp.addEventListener('click', () => save(setExp, () => api.post(`/api/admin/enrollments/${e.id}/expiry`, { expires_date: date.value })).then(refresh).catch(() => {}));
      append(body, h('section', { class: 'card flat stack', style: 'margin-top:16px' }, h('h3', null, 'Access period'), field('End date (leave empty for ongoing)', date), setExp));
    }
    if (e.state === 'active' || e.state === 'pending') {
      const reason = input({ placeholder: 'Reason (private)' });
      const revoke = h('button', { class: 'btn danger', type: 'button' }, e.state === 'pending' ? 'Cancel this request' : 'Revoke access');
      revoke.addEventListener('click', async () => {
        if (!(await confirmSheet(e.state === 'pending' ? 'Cancel request?' : 'Revoke access?', e.state === 'pending' ? 'The student can create a new request later.' : 'The student will immediately stop receiving playback for paid lessons.', e.state === 'pending' ? 'Cancel request' : 'Revoke', { danger: true }))) return;
        await save(revoke, () => api.post(`/api/admin/enrollments/${e.id}/revoke`, { reason: reason.value }), 'Updated').then(refresh).catch(() => {});
      });
      append(body, h('section', { class: 'stack', style: 'margin-top:16px' }, reason, revoke));
    }
    if (e.state !== 'pending' || true) {
      const note2 = textarea({ rows: 2, value: e.payment_note || '' });
      const saveNote = h('button', { class: 'btn secondary sm', type: 'button' }, 'Save note');
      saveNote.addEventListener('click', () => save(saveNote, () => api.post(`/api/admin/enrollments/${e.id}/note`, { note: note2.value })).catch(() => {}));
      if (e.state !== 'pending' && e.state !== 'revoked' && e.state !== 'expired') append(body, h('section', { class: 'stack', style: 'margin-top:16px' }, field('Private payment note', note2), saveNote));
    }
    append(body, h('section', { style: 'margin-top:18px' }, h('h3', null, 'History'),
      h('ol', { class: 'timeline' }, events.map((ev) => h('li', null, h('b', null, ev.action.replace(/_/g, ' ')), ` — ${ev.actor_name || 'system'}${ev.actor_role === 'admin' ? ' (teacher)' : ev.actor_role === 'student' ? ' (student)' : ''} · ${fmtDate(ev.created_at, true)}`, ev.detail ? h('div', { class: 'muted' }, ev.detail) : null)))));
  });
}

// ---------------- course structure ----------------
async function coursePage(c, grade) {
  const data = await api.get('/api/admin/course');
  const g = data.grades.find((x) => x.grade === grade);
  const reload = () => { clear(c); coursePage(c, grade); };
  const reorder = async (url, body) => { try { await api.post(url, body); reload(); } catch (e) { toast(err(e), 'bad'); } };
  const move = (arr, i, d) => { const a = arr.map((x) => x.id); [a[i], a[i + d]] = [a[i + d], a[i]]; return a; };

  const addTitle = input({ placeholder: 'New chapter title', maxlength: 200 });
  const addBtn = h('button', { class: 'btn', type: 'submit' }, 'Add chapter');
  const addForm = h('form', { class: 'row', onsubmit: async (ev) => { ev.preventDefault(); if (!addTitle.value.trim()) return addTitle.focus(); await save(addBtn, () => api.post('/api/admin/chapters', { grade, title: addTitle.value })).then(reload).catch(() => {}); } }, h('div', { class: 'grow' }, addTitle), addBtn);

  append(c, [
    h('h1', null, 'Lessons'),
    h('nav', { class: 'seg', 'aria-label': 'Grade' }, GRADES.map((x) => h('a', { href: `/admin/course/${x}`, 'aria-current': x === grade ? 'page' : undefined }, `Grade ${x}`))),
    h('div', { style: 'height:14px' }),
    addForm,
    h('div', { style: 'height:14px' }),
    g.chapters.length ? null : h('div', { class: 'card stack' }, h('h2', null, `How to add Grade ${grade} videos`),
      h('ol', { style: 'margin:0;padding-inline-start:20px;display:grid;gap:6px' },
        h('li', null, 'Type a chapter name above (e.g. “Chapter 1 — Sets”) and press ', h('b', null, 'Add chapter'), '.'),
        h('li', null, 'Press ', h('b', null, '+ Lesson'), ' on the chapter and give the lesson a title.'),
        h('li', null, 'On the lesson page, press ', h('b', null, 'Upload video'), ' and pick the MP4 from your computer or iPad. Keep the page open until it says “Video uploaded”.'),
        h('li', null, 'Press ', h('b', null, 'Publish lesson'), ', and ', h('b', null, 'Publish'), ' the chapter. Students of this grade can then watch it after you approve their payment.'))),
    h('div', { class: 'list' }, g.chapters.map((ch, ci) => {
      const pubBtn = h('button', { class: 'btn secondary sm', type: 'button' }, ch.published ? 'Unpublish' : 'Publish');
      pubBtn.addEventListener('click', () => save(pubBtn, () => api.put(`/api/admin/chapters/${ch.id}`, { published: !ch.published })).then(reload).catch(() => {}));
      const edit = h('button', { class: 'btn ghost sm', type: 'button' }, 'Rename');
      edit.addEventListener('click', () => sheet('Edit chapter', (body, close) => {
        const ti = input({ value: ch.title, maxlength: 200 }); const de = textarea({ value: ch.description, rows: 3 });
        const sb = h('button', { class: 'btn', type: 'button' }, 'Save');
        sb.addEventListener('click', () => save(sb, () => api.put(`/api/admin/chapters/${ch.id}`, { title: ti.value, description: de.value })).then(() => { close(); reload(); }).catch(() => {}));
        const del = h('button', { class: 'btn danger', type: 'button' }, 'Delete chapter');
        del.addEventListener('click', async () => { if (await confirmSheet('Delete chapter?', 'Only empty chapters can be deleted.', 'Delete', { danger: true })) save(del, () => api.del(`/api/admin/chapters/${ch.id}`), 'Deleted').then(() => { close(); reload(); }).catch(() => {}); });
        append(body, h('div', { class: 'form' }, field('Title', ti), field('Description (optional)', de), h('div', { class: 'form-actions' }, sb, ch.lessons.length ? null : del)));
      }));
      const addLesson = h('button', { class: 'btn sm', type: 'button' }, '+ Lesson');
      addLesson.addEventListener('click', () => sheet('New lesson', (body, close) => {
        const ti = input({ maxlength: 200, placeholder: 'Lesson title' });
        const sb = h('button', { class: 'btn', type: 'submit' }, 'Create and add video');
        const f = h('form', { class: 'form', onsubmit: async (ev) => { ev.preventDefault(); if (!ti.value.trim()) return ti.focus(); const r = await save(sb, () => api.post('/api/admin/lessons', { chapter_id: ch.id, title: ti.value }), 'Lesson created').catch(() => null); if (r) { close(); navigate(`/admin/lessons/${r.lesson.id}`); } } }, field('Title', ti), sb);
        body.append(f); setTimeout(() => ti.focus(), 50);
      }));
      return h('section', { class: 'card', style: 'padding:0;overflow:hidden' },
        h('div', { class: 'item', style: 'padding:14px' },
          h('div', { class: 'item-head' }, h('span', { class: 'item-title' }, `${ci + 1}. ${ch.title}`), pubBadge(ch.published)),
          h('div', { class: 'row' },
            h('span', { class: 'reorder' },
              h('button', { class: 'btn ghost sm', type: 'button', disabled: ci === 0, 'aria-label': `Move ${ch.title} up`, onclick: () => reorder('/api/admin/chapters/reorder', { grade, ids: move(g.chapters, ci, -1) }) }, icon('up')),
              h('button', { class: 'btn ghost sm', type: 'button', disabled: ci === g.chapters.length - 1, 'aria-label': `Move ${ch.title} down`, onclick: () => reorder('/api/admin/chapters/reorder', { grade, ids: move(g.chapters, ci, 1) }) }, icon('down'))),
            edit, pubBtn, addLesson)),
        ch.lessons.length ? ch.lessons.map((l, li) => h('div', { class: 'admin-lesson' },
          h('span', { class: 'thumb' }, l.thumbnail ? h('img', { src: l.thumbnail, alt: '' }) : icon('play')),
          h('div', { style: 'min-width:0' }, h('div', { class: 'lesson-title' }, l.title),
            h('div', { class: 'row small', style: 'gap:6px;margin-top:4px' }, pubBadge(l.published),
              l.video_id ? h('span', { class: `badge ${l.video_status === 'ready' ? 'info' : 'warn'}` }, l.video_status === 'ready' ? 'Video ready' : 'Processing') : h('span', { class: 'badge bad' }, 'No video'),
              l.duration_seconds ? h('span', { class: 'muted' }, ltr(fmtDuration(l.duration_seconds))) : null)),
          h('div', { class: 'actions' },
            h('span', { class: 'reorder' },
              h('button', { class: 'btn ghost sm', type: 'button', disabled: li === 0, 'aria-label': `Move ${l.title} up`, onclick: () => reorder('/api/admin/lessons/reorder', { chapter_id: ch.id, ids: move(ch.lessons, li, -1) }) }, icon('up')),
              h('button', { class: 'btn ghost sm', type: 'button', disabled: li === ch.lessons.length - 1, 'aria-label': `Move ${l.title} down`, onclick: () => reorder('/api/admin/lessons/reorder', { chapter_id: ch.id, ids: move(ch.lessons, li, 1) }) }, icon('down'))),
            h('a', { class: 'btn ghost sm', href: `/lesson/${l.id}` }, icon('eye'), 'Preview'),
            h('a', { class: 'btn secondary sm', href: `/admin/lessons/${l.id}` }, 'Edit'))))
          : h('p', { class: 'muted small', style: 'padding:0 14px 14px;margin:0' }, 'No lessons yet.'));
    })),
  ]);
}

async function lessonEditor(c, id) {
  const { lesson: l, textbooks, refs, chapters } = await api.get(`/api/admin/lessons/${id}`);
  const reload = () => navigate(location.pathname, { replace: true }); // re-render (destroys the preview player)
  const title = input({ value: l.title, maxlength: 200 });
  const chapter = h('select', { class: 'input' }, GRADES.map((g) => h('optgroup', { label: `Grade ${g}` }, chapters.filter((x) => x.grade === g).map((x) => h('option', { value: x.id, selected: x.id === l.chapter_id }, x.title)))));
  const desc = textarea({ value: l.description, rows: 6 });
  const dur = input({ value: l.duration_seconds ? fmtDuration(l.duration_seconds) : '', inputmode: 'numeric', placeholder: 'mm:ss', class: 'input ltr' });
  const saveBtn = h('button', { class: 'btn', type: 'submit' }, 'Save details');
  const form = h('form', { class: 'form', onsubmit: (ev) => { ev.preventDefault(); save(saveBtn, () => api.put(`/api/admin/lessons/${l.id}`, { title: title.value, chapter_id: Number(chapter.value), description: desc.value, duration_seconds: parseDuration(dur.value) })).then(reload).catch(() => {}); } },
    field('Title', title), field('Chapter', chapter, 'Move the lesson by choosing another chapter.'),
    field('Description', desc, 'Write equations between $ signs, e.g. $x^2 + 3x = 10$ — they stay left-to-right on Kurdish pages. Use $$…$$ for a centred line.'),
    field('Duration', dur, 'Filled automatically from the uploaded video.'), saveBtn);

  const pub = h('button', { class: `btn ${l.published ? 'secondary' : ''}`, type: 'button' }, l.published ? 'Unpublish' : 'Publish lesson');
  pub.addEventListener('click', () => save(pub, () => api.put(`/api/admin/lessons/${l.id}`, { published: !l.published }), l.published ? 'Unpublished' : 'Published').then(reload).catch(() => {}));
  const del = h('button', { class: 'btn danger', type: 'button', disabled: !!l.published, title: l.published ? 'Unpublish first' : '' }, 'Delete lesson');
  del.addEventListener('click', async () => { if (await confirmSheet('Delete lesson?', 'This deletes the lesson, its textbook references and student progress.', 'Delete', { danger: true })) save(del, () => api.del(`/api/admin/lessons/${l.id}`), 'Deleted').then(() => navigate(`/admin/course/${l.grade}`)).catch(() => {}); });

  const previewWrap = h('div');
  if (l.video_id) {
    const p = createPlayer({ title: l.title, poster: l.thumbnail, fetchPlayback: () => api.post(`/api/lessons/${l.id}/playback`) });
    onLeave(() => p.destroy());
    previewWrap.append(p.el);
  }

  const refsSection = h('section', { class: 'card stack' }, h('h2', null, 'Textbook references'),
    h('p', { class: 'muted small' }, 'Map this video to the chapter, section, pages and exercises of each textbook edition. Leave anything you haven’t checked blank. References show next to the lesson for the active, published edition.'),
    textbooks.length ? textbooks.map((tb) => {
      const r = refs.find((x) => x.textbook_id === tb.id) || {};
      const f = { chapter: input({ value: r.chapter || '' }), section: input({ value: r.section || '' }), pages: input({ value: r.pages || '', placeholder: 'e.g. 42–45' }), exercises: input({ value: r.exercises || '', placeholder: 'e.g. 1–6, 9' }) };
      const reviewed = h('input', { type: 'checkbox', checked: !!r.reviewed });
      const sb = h('button', { class: 'btn secondary sm', type: 'button' }, 'Save reference');
      sb.addEventListener('click', () => save(sb, () => api.put(`/api/admin/lessons/${l.id}/refs/${tb.id}`, { chapter: f.chapter.value, section: f.section.value, pages: f.pages.value, exercises: f.exercises.value, reviewed: reviewed.checked })).catch(() => {}));
      return h('fieldset', { class: 'stack' }, h('legend', null, tb.title || `Grade ${tb.grade} textbook (untitled)`, ' · ', h('bdi', null, tb.edition || 'edition not set')),
        h('div', { class: 'row small' }, tb.is_active ? h('span', { class: 'badge ok' }, 'Active edition') : h('span', { class: 'badge neutral' }, 'Not active'), pubBadge(tb.published), reviewBadge(tb.review_status)),
        h('div', { class: 'grid two' }, field('Chapter', f.chapter), field('Section', f.section), field('Pages', f.pages), field('Exercises', f.exercises)),
        h('label', { class: 'check' }, reviewed, h('span', null, 'I checked these references against this edition')), sb);
    }) : h('p', { class: 'muted' }, 'No textbook records for this grade yet.'));

  append(c, [
    h('a', { href: `/admin/course/${l.grade}`, class: 'btn ghost sm' }, icon('back', 'flip-rtl'), `Grade ${l.grade} lessons`),
    h('div', { class: 'row between', style: 'margin-top:8px' }, h('h1', { style: 'margin:0' }, l.title), h('div', { class: 'row' }, pubBadge(l.published && l.chapter_published), h('a', { class: 'btn ghost sm', href: `/lesson/${l.id}` }, icon('eye'), 'Student view'))),
    !l.chapter_published ? h('div', { class: 'notice warn', style: 'margin-top:10px' }, h('p', null, 'This chapter is still a draft, so students can’t see this lesson yet.')) : null,
    h('div', { class: 'grid two', style: 'margin-top:16px;align-items:start' },
      h('section', { class: 'card' }, form),
      h('div', { class: 'stack' },
        h('section', { class: 'card stack' }, h('h2', null, 'Video'),
          l.video_id ? h('p', { class: 'small' }, h('span', { class: `badge ${l.video_status === 'ready' ? 'ok' : 'warn'}` }, l.video_status === 'ready' ? 'Ready' : 'Processing'), ' ', h('span', { class: 'muted' }, 'Private — only students with active access get a playback token.')) : h('div', { class: 'notice warn' }, h('p', null, 'No video yet.')),
          previewWrap, videoUploader({ target: 'lesson', id: l.id, current: l, onDone: reload })),
        h('section', { class: 'card' }, h('h2', null, 'Thumbnail'), imageUploader('Upload thumbnail (16:9)', l.thumbnail, 'lesson', l.id, reload)),
        h('section', { class: 'card row' }, pub, del))),
    h('div', { style: 'height:16px' }), refsSection,
  ]);
}

// ---------------- textbooks ----------------
async function textbooksAdmin(c) {
  const { textbooks, candidates } = await api.get('/api/admin/textbooks');
  const reload = () => { clear(c); textbooksAdmin(c); };
  const candidateCard = (cd) => {
    const st = select([['to_review', 'To review'], ['matches', 'Matches students’ book'], ['does_not_match', 'Does not match']], cd.status);
    const notes = textarea({ rows: 2, value: cd.notes, placeholder: 'What you checked: cover, edition, year…' });
    const sb = h('button', { class: 'btn secondary sm', type: 'button' }, 'Save');
    sb.addEventListener('click', () => save(sb, () => api.put(`/api/admin/candidates/${cd.id}`, { status: st.value, notes: notes.value })).catch(() => {}));
    return h('div', { class: 'card flat item' },
      h('div', { class: 'item-head' }, h('span', { class: 'item-title' }, cd.grade ? `Grade ${cd.grade}` : 'All grades', ' — ', cd.label), h('span', { class: `badge ${{ to_review: 'warn', matches: 'ok', does_not_match: 'bad' }[cd.status]}` }, { to_review: 'To review', matches: 'Matches', does_not_match: 'Does not match' }[cd.status])),
      h('a', { href: cd.url, target: '_blank', rel: 'noopener noreferrer', class: 'small ltr', dir: 'ltr', style: 'overflow-wrap:anywhere' }, cd.url),
      h('div', { class: 'grid two' }, field('Status', st), field('Notes', notes)), sb);
  };
  const newCand = { url: input({ type: 'url', placeholder: 'https://…', class: 'input ltr' }), label: input({ placeholder: 'Description' }), grade: select([[0, 'All'], [10, 'Grade 10'], [11, 'Grade 11'], [12, 'Grade 12']], 10) };
  const addCand = h('button', { class: 'btn secondary', type: 'button' }, 'Add candidate link');
  addCand.addEventListener('click', () => save(addCand, () => api.post('/api/admin/candidates', { url: newCand.url.value, label: newCand.label.value, grade: Number(newCand.grade.value) })).then(reload).catch(() => {}));

  append(c, [
    h('h1', null, 'Textbooks & curriculum'),
    h('details', { class: 'card', open: candidates.some((x) => x.status === 'to_review') },
      h('summary', { style: 'cursor:pointer;font-weight:700;min-height:44px;display:flex;align-items:center;gap:8px' }, icon('lock'), 'Candidate links (private — never shown to students)'),
      h('div', { class: 'stack', style: 'margin-top:12px' },
        h('div', { class: 'notice warn' }, h('p', null, 'Check each cover and edition against the book your students use in Duhok before you publish any link. Grade 10 Literary Mathematics was revised for 2025–2026. Only add an official or otherwise authorized link to a textbook record.')),
        candidates.map(candidateCard),
        h('div', { class: 'grid two' }, field('URL', newCand.url), field('Label', newCand.label), field('Grade', newCand.grade)), addCand)),
    GRADES.map((g) => {
      const books = textbooks.filter((tb) => tb.grade === g);
      const add = h('button', { class: 'btn secondary sm', type: 'button' }, '+ New edition');
      add.addEventListener('click', () => save(add, () => api.post('/api/admin/textbooks', { grade: g }), 'Edition added').then(reload).catch(() => {}));
      return h('section', { class: 'stack', style: 'margin-top:22px' },
        h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, `Grade ${g} — Literary Mathematics`), add),
        books.map((tb) => editionCard(tb, books, reload)));
    }),
  ]);
}

function editionCard(tb, siblings, reload) {
  const f = {
    title: input({ value: tb.title, placeholder: 'Exactly as printed on the cover' }), track: input({ value: tb.track }), language: input({ value: tb.language, placeholder: 'e.g. Kurdish (Badini)' }),
    edition: input({ value: tb.edition, placeholder: 'e.g. Revised 2025' }), publication_year: input({ value: tb.publication_year, inputmode: 'numeric' }), academic_year: input({ value: tb.academic_year, placeholder: '2025–2026' }),
    source_url: input({ type: 'url', value: tb.source_url, placeholder: 'https://…', class: 'input ltr' }), notes: textarea({ value: tb.notes, rows: 2 }),
  };
  const kind = select([['', 'No public link'], ['official', 'Official (KRG / e-Parwarda)'], ['authorized', 'Otherwise authorized']], tb.source_kind);
  const review = select([['unreviewed', 'Not reviewed'], ['in_review', 'In review'], ['verified', 'Verified against students’ book']], tb.review_status);
  const published = h('input', { type: 'checkbox', checked: !!tb.published });
  const sb = h('button', { class: 'btn', type: 'button' }, 'Save record');
  sb.addEventListener('click', () => save(sb, () => api.put(`/api/admin/textbooks/${tb.id}`, { ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value])), source_kind: kind.value, review_status: review.value, published: published.checked })).then(reload).catch(() => {}));

  const pdfFile = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'input' });
  const perm = textarea({ rows: 2, value: tb.pdf_permission_note, placeholder: 'Who allowed you to distribute this PDF, and how' });
  const permOk = h('input', { type: 'checkbox' });
  const pdfBar = h('div', { class: 'progress', hidden: true }, h('span'));
  const upPdf = h('button', { class: 'btn secondary sm', type: 'button' }, icon('upload'), 'Upload PDF');
  upPdf.addEventListener('click', async () => {
    const file = pdfFile.files[0];
    if (!file) return pdfFile.focus();
    if (!permOk.checked || perm.value.trim().length < 5) { toast('Confirm and describe your permission to distribute this file.', 'bad'); return; }
    pdfBar.hidden = false; busy(upPdf, true);
    try { await api.upload('PUT', `/api/admin/textbooks/${tb.id}/pdf?permission=${encodeURIComponent(perm.value.trim())}`, file, (p) => { pdfBar.firstChild.style.width = Math.round(p * 100) + '%'; }, 'application/pdf').promise; toast('PDF uploaded ✓'); reload(); }
    catch (e) { toast(err(e), 'bad'); } finally { busy(upPdf, false); }
  });
  const rmPdf = h('button', { class: 'btn danger sm', type: 'button' }, 'Remove PDF');
  rmPdf.addEventListener('click', async () => { if (await confirmSheet('Remove PDF?', 'Students will no longer be able to download it.', 'Remove', { danger: true })) save(rmPdf, () => api.del(`/api/admin/textbooks/${tb.id}/pdf`), 'Removed').then(reload).catch(() => {}); });

  const activate = h('button', { class: 'btn accent sm', type: 'button' }, 'Make active edition…');
  activate.addEventListener('click', () => activationSheet(tb, siblings, reload));
  const del = h('button', { class: 'btn danger sm', type: 'button' }, 'Delete');
  del.addEventListener('click', async () => { if (await confirmSheet('Delete this record?', 'Its lesson references are deleted too.', 'Delete', { danger: true })) save(del, () => api.del(`/api/admin/textbooks/${tb.id}`), 'Deleted').then(reload).catch(() => {}); });

  return h('article', { class: `card edition ${tb.is_active ? 'active' : ''} stack` },
    h('div', { class: 'item-head' }, h('span', { class: 'item-title' }, tb.title || 'Untitled record', tb.edition ? ` · ${tb.edition}` : ''),
      h('span', { class: 'row', style: 'gap:6px' }, tb.is_active ? h('span', { class: 'badge ok' }, 'Active') : null, pubBadge(tb.published), reviewBadge(tb.review_status))),
    tb.notes && tb.review_status !== 'verified' ? h('div', { class: 'notice warn' }, h('p', null, tb.notes)) : null,
    h('div', { class: 'grid two' }, field('Title as printed', f.title), field('Track', f.track), field('Language / dialect', f.language), field('Edition', f.edition),
      field('Publication year', f.publication_year), field('Academic year used', f.academic_year), field('Source link', f.source_url, 'Shown to students only when the link type is official or authorized.'), field('Link type', kind),
      field('Teacher review status', review), field('Private notes', f.notes)),
    h('label', { class: 'check' }, published, h('span', null, 'Publish this record on the Textbooks page (requires title, edition and “Verified”)')),
    h('div', { class: 'row' }, sb, !tb.is_active ? activate : null, !tb.is_active && !tb.published ? del : null, h('span', { class: 'muted small' }, `${tb.ref_count} lesson reference(s)`)),
    h('details', null, h('summary', { style: 'cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600' }, tb.pdf_file ? 'PDF on this site ✓' : 'Host a PDF on this site (only with permission)'),
      h('div', { class: 'stack', style: 'margin-top:8px' },
        tb.pdf_file ? h('div', { class: 'row' }, h('a', { class: 'btn ghost sm', href: `/media/pdf/${tb.id}`, target: '_blank', rel: 'noopener' }, 'Open PDF'), rmPdf) : null,
        field('PDF file', pdfFile), field('Permission to distribute', perm),
        h('label', { class: 'check' }, permOk, h('span', null, 'I have permission to distribute this file to my students')), pdfBar, upPdf)));
}

async function activationSheet(tb, siblings, reload) {
  const r = await api.get(`/api/admin/textbooks/${tb.id}/review`);
  sheet(`Switch Grade ${tb.grade} to ${tb.edition || 'this edition'}`, (body, close) => {
    const refTxt = (x) => (x ? [x.chapter, x.section, x.pages && `p. ${x.pages}`, x.exercises && `ex. ${x.exercises}`].filter(Boolean).join(' · ') || '—' : '—');
    const copy = r.current && r.current.id !== tb.id ? h('button', { class: 'btn secondary sm', type: 'button' }, 'Copy references from current edition (as unreviewed)') : null;
    copy?.addEventListener('click', () => save(copy, () => api.post(`/api/admin/textbooks/${tb.id}/copy-refs`, { from_id: r.current.id }), 'Copied').then(() => { close(); activationSheet(tb, siblings, reload); }).catch(() => {}));
    const go = h('button', { class: 'btn', type: 'button' }, 'Make this the active edition');
    go.addEventListener('click', async () => {
      try { await api.post(`/api/admin/textbooks/${tb.id}/activate`, {}); }
      catch (e) {
        if (e.code === 'refs_unreviewed') {
          if (!(await confirmSheet('Some lessons are not reviewed', `${e.body.missing} published lesson(s) have no reviewed reference for this edition. Their references will be hidden until you add them. Switch anyway?`, 'Switch anyway'))) return;
          try { await api.post(`/api/admin/textbooks/${tb.id}/activate`, { confirm_missing: true }); } catch (e2) { return toast(err(e2), 'bad'); }
        } else return toast(err(e), 'bad');
      }
      toast('Active edition switched ✓'); close(); reload();
    });
    append(body, [
      !tb.published || tb.review_status !== 'verified' ? h('div', { class: 'notice warn' }, h('p', null, 'Verify and publish this record before making it active.')) : null,
      h('p', null, r.missing ? `${r.missing} published lesson(s) still need a reviewed reference for this edition.` : 'Every published lesson has a reviewed reference for this edition.'),
      copy,
      h('div', { class: 'table-wrap', style: 'margin-block:12px' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, h('th', null, 'Lesson'), h('th', null, `Current (${r.current?.edition || 'none'})`), h('th', null, `New (${tb.edition || '—'})`), h('th', null, 'Reviewed'))),
        h('tbody', null, r.lessons.map((l) => h('tr', null, h('td', null, h('a', { href: `/admin/lessons/${l.id}` }, l.title), l.published ? '' : ' (draft)'), h('td', null, refTxt(l.current_ref)), h('td', null, refTxt(l.new_ref)), h('td', null, l.new_ref?.reviewed ? '✓' : '—')))))),
      h('div', { class: 'form-actions' }, go),
    ]);
  });
}

// ---------------- settings ----------------
async function settingsPage(c) {
  const { settings: s } = await api.get('/api/admin/settings');
  const reload = async () => { await refreshSite(); navigate(location.pathname, { replace: true }); };
  const section = (title, fields, payload, note) => {
    const b = h('button', { class: 'btn', type: 'button' }, 'Save');
    b.addEventListener('click', () => save(b, () => api.put('/api/admin/settings', payload())).then(reload).catch(() => {}));
    return h('section', { class: 'card stack' }, h('h2', null, title), note || null, fields, b);
  };
  // Teacher
  const tName = input({ value: s.teacher_name }), city = input({ value: s.city }), intro = textarea({ value: s.teacher_intro, rows: 5 });
  // Course
  const cTitle = input({ value: s.course_title }), cSub = input({ value: s.course_subtitle });
  const price = input({ value: s.price_iqd || '', inputmode: 'numeric', class: 'input ltr', placeholder: 'e.g. 75000' });
  const gradeBoxes = GRADES.map((g) => h('input', { type: 'checkbox', value: g, checked: s.grades_included.includes(g) }));
  const mOn = h('input', { type: 'radio', name: 'am', value: 'ongoing', checked: s.access_mode !== 'end_date' });
  const mEnd = h('input', { type: 'radio', name: 'am', value: 'end_date', checked: s.access_mode === 'end_date' });
  const endDate = input({ type: 'date', value: s.access_end_date || '' });
  // WhatsApp
  const wa = input({ type: 'tel', value: s.whatsapp_number ? '+' + s.whatsapp_number : '', inputmode: 'tel', autocomplete: 'off', class: 'input ltr', placeholder: '+964 750 123 4567' });
  const msg = textarea({ value: s.whatsapp_message, rows: 4 });
  const preview = h('div', { class: 'preview-msg' });
  const testLink = h('a', { class: 'btn ghost sm', target: '_blank', rel: 'noopener noreferrer' }, icon('ext', 'flip-rtl'), 'Test the chat link');
  const updPreview = () => {
    const text = msg.value.replaceAll('[Price]', fmtIqd(String(price.value).replace(/\D/g, ''))).replaceAll('[Reference]', 'MA-ABCD-2345').replaceAll('[Grade]', 'Grade 11').replaceAll('[Name]', 'Student Name').replaceAll('[Email]', 'student@gmail.com');
    preview.textContent = text;
    let n = wa.value.replace(/\D/g, '').replace(/^00/, '');
    if (/^07\d{9}$/.test(n)) n = '964' + n.slice(1); // local Iraqi format 07xx…
    testLink.href = `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
    testLink.hidden = n.length < 10;
  };
  [msg, price, wa].forEach((x) => x.addEventListener('input', updPreview)); updPreview();
  // Demo
  const d = s.demo || {};
  const dTitle = input({ value: d.title || '', placeholder: 'e.g. Solving quadratic equations — 2-minute demo' });
  const dPub = h('input', { type: 'checkbox', checked: !!d.published });
  const demoPrev = h('div');
  if (d.video_id) { const p = createPlayer({ title: 'Demo', poster: d.thumbnail, fetchPlayback: () => api.post('/api/demo/playback') }); onLeave(() => p.destroy()); demoPrev.append(p.el); }
  // Language
  const lang = select([['en', 'English'], ['ku', 'Kurdish (right-to-left)']], s.site_language);

  append(c, [
    h('h1', null, 'Settings'),
    h('div', { class: 'stack' },
      section('Teacher profile', [field('Name shown on the site', tName), field('City', city), field('Introduction', intro), imageUploader('Photo', s.teacher_photo, 'teacher', '', reload)],
        () => ({ teacher_name: tName.value, city: city.value, teacher_intro: intro.value })),
      section('Course & price', [field('Course title', cTitle), field('Subtitle', cSub), field('Price (IQD)', price, 'Shown to students before they pay.'),
        h('fieldset', null, h('legend', null, 'Grades open for enrollment (each student pays for and unlocks only their own grade)'), gradeBoxes.map((b) => h('label', { class: 'check' }, b, h('span', null, `Grade ${b.value}`)))),
        h('fieldset', null, h('legend', null, 'Access period'), h('label', { class: 'check' }, mOn, h('span', null, 'Ongoing access')), h('label', { class: 'check' }, mEnd, h('span', null, 'Ends on a date')), field('End date', endDate, 'Access stops at the end of this day (Duhok time). Changing this affects new approvals; you can adjust each student’s end date in Enrollments.'))],
        () => ({ course_title: cTitle.value, course_subtitle: cSub.value, price_iqd: price.value, grades_included: gradeBoxes.filter((b) => b.checked).map((b) => Number(b.value)), access_mode: mEnd.checked ? 'end_date' : 'ongoing', access_end_date: endDate.value })),
      section('WhatsApp & FIB payment', [field('Your WhatsApp number', wa, 'International format. Students see this number on every enrollment screen.'),
        field('Prefilled message', msg, 'Use [Price], [Reference], [Grade], [Name] and [Email]. Students can edit the message before sending.'), h('div', { class: 'label' }, 'Preview'), preview, testLink],
        () => ({ whatsapp_number: wa.value, whatsapp_message: msg.value }),
        h('div', { class: 'notice info' }, h('p', null, 'You send FIB payment instructions in WhatsApp, check the payment arrived in FIB, then approve the student in Enrollments. This site never handles banking details, PINs or codes.'))),
      section('Free teaching demo', [field('Demo title', dTitle), demoPrev, videoUploader({ target: 'demo', current: d, onDone: reload }), imageUploader('Demo thumbnail', d.thumbnail, 'demo', '', reload),
        h('label', { class: 'check' }, dPub, h('span', null, 'Show the demo on the home page (anyone can play it)'))],
        () => ({ demo: { title: dTitle.value, published: dPub.checked } })),
      section('Site language', [field('Default language', lang, 'The language new visitors see first. Everyone can switch between English and Kurdish with the 🌐 button at the top. Check the Kurdish wording in “Site wording”.')], () => ({ site_language: lang.value })),
    ),
  ]);
}

function wordingPage(c) {
  const s = state.site;
  return api.get('/api/admin/settings').then(({ settings }) => {
    const w = settings.wording || { en: {}, ku: {} };
    const rows = [];
    const filter = input({ type: 'search', placeholder: 'Filter wording…', 'aria-label': 'Filter wording' });
    const list = h('div');
    for (const key of Object.keys(STRINGS.en)) {
      const en = input({ value: w.en?.[key] || '', placeholder: STRINGS.en[key], 'aria-label': `English: ${key}` });
      const ku = input({ value: w.ku?.[key] || '', placeholder: STRINGS.ku[key] || '(not translated — English will show)', dir: 'rtl', lang: 'ku-Arab', 'aria-label': `Kurdish: ${key}` });
      const row = h('div', { class: 'wording-row', dataset: { key: key + ' ' + STRINGS.en[key].toLowerCase() } }, h('div', null, h('code', { class: 'small' }, key), h('div', { class: 'muted small' }, STRINGS.en[key])), en, ku);
      rows.push({ key, en, ku, row }); list.append(row);
    }
    filter.addEventListener('input', () => { const q = filter.value.toLowerCase(); rows.forEach((r) => { r.row.hidden = q && !r.row.dataset.key.toLowerCase().includes(q); }); });
    const confirmKu = h('input', { type: 'checkbox', checked: !!settings.wording_confirmed?.ku });
    const sb = h('button', { class: 'btn', type: 'button' }, 'Save wording');
    sb.addEventListener('click', () => {
      const out = { en: {}, ku: {} };
      for (const r of rows) {
        if (r.en.value.trim()) out.en[r.key] = r.en.value.trim();
        // Keep the draft Kurdish as the confirmed value when the teacher leaves it unchanged.
        const kv = r.ku.value.trim();
        if (kv) out.ku[r.key] = kv;
        else if (confirmKu.checked && STRINGS.ku[r.key]) out.ku[r.key] = STRINGS.ku[r.key];
      }
      save(sb, () => api.put('/api/admin/settings', { wording: out, wording_confirmed: { en: true, ku: confirmKu.checked } })).then(() => refreshSite()).catch(() => {});
    });
    append(c, [
      h('h1', null, 'Site wording'),
      h('div', { class: 'notice info' }, h('p', null, `Change any text students see. Leave a box empty to use the default (shown in grey). The Kurdish (Badini) defaults are a draft — please check them and correct any line. Default language: ${s.language === 'ku' ? 'Kurdish' : 'English'}.`)),
      h('div', { class: 'toolbar', style: 'margin-top:12px' }, filter),
      h('div', { class: 'card' }, h('div', { class: 'wording-row', style: 'font-weight:700' }, h('span', null, 'Text'), h('span', null, 'English'), h('span', null, 'Kurdish')), list),
      h('div', { class: 'card stack', style: 'margin-top:14px;position:sticky;bottom:8px' }, h('label', { class: 'check' }, confirmKu, h('span', null, 'I have checked the Kurdish wording and it matches what my students use')), sb),
    ]);
  });
}

async function outboxPage(c) {
  const { emails } = await api.get('/api/admin/outbox');
  append(c, [h('h1', null, 'Test emails'), h('p', { class: 'muted' }, 'Email is in test mode: messages are saved here instead of being sent. Configure EMAIL_PROVIDER before launch.'),
    h('div', { class: 'list' }, emails.length ? emails.map((m) => h('article', { class: 'card item' }, h('div', { class: 'item-head' }, h('b', null, m.subject), h('span', { class: 'muted small' }, fmtDate(m.created_at, true))), h('div', { class: 'small' }, 'To: ', ltr(m.to_email)),
      h('pre', { style: 'white-space:pre-wrap;font-family:inherit;margin:0;overflow-wrap:anywhere' }, ...m.body.split(/(https?:\/\/\S+)/).map((part) => (/^https?:\/\//.test(part) ? h('a', { href: part }, part) : part)))))
      : h('div', { class: 'card empty' }, 'No emails yet.'))]);
}
void fmtPhone; void ltr;
