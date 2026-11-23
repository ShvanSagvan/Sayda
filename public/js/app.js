import { h, append, clear, icon, toast, copyText, fmtIqd, fmtDuration, fmtDate, fmtPhone, ltr, richText, field, input, busy } from './ui.js';
import { api } from './api.js';
import { t, setLanguage, currentLang } from './i18n.js';
import { createPlayer } from './player.js';

const mainEl = document.getElementById('main');
const topbar = document.getElementById('topbar');
const footer = document.getElementById('footer');
export const state = { site: null, catalog: null };
let leaveHooks = [];
export const onLeave = (fn) => leaveHooks.push(fn);

// ---------------- helpers ----------------
const user = () => state.site?.user || null;
const isAdmin = () => user()?.role === 'admin';
const enr = () => state.site?.enrollment || null;
const gradesLabel = (gs) => (gs || []).map((g) => t('grade', { g })).join(' · ');
const safeNext = (n) => (n && /^\/(?!\/)[\w\-/?=&.%]*$/.test(n) ? n : null);
const errText = (e) => (e?.code && t('err.' + e.code) !== 'err.' + e.code ? t('err.' + e.code) : e?.message || t('err.generic'));
export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export async function refreshSite() {
  state.site = await api.get('/api/site');
  // A visitor's own choice (language button) wins over the site's default language.
  let lang = state.site.language;
  try { lang = localStorage.getItem('lang') || lang; } catch { /* private mode */ }
  setLanguage(lang, state.site.wordings?.[lang] || state.site.wording);
  document.title = state.site.course_title || 'Mathematics';
  return state.site;
}
export async function loadCatalog(force) {
  if (!state.catalog || force) state.catalog = await api.get('/api/catalog');
  return state.catalog;
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  render();
}

function gradeChip(g) { return h('span', { class: `chip g${g}` }, t('grade', { g })); }
function termsText(terms) { return terms.access_mode === 'end_date' && terms.access_end_date ? t('terms.until', { date: fmtDate(terms.access_end_date) }) : t('terms.ongoing'); }

function copyBox(label, value, { cls = '', mono = false, display } = {}) {
  const btn = h('button', { class: 'btn secondary sm', type: 'button', 'aria-label': `${t('enroll.copy')}: ${label}` }, icon('copy'), t('enroll.copy'));
  btn.addEventListener('click', async () => {
    const ok = await copyText(value);
    toast(ok ? `${t('enroll.copied')} ✓` : value, ok ? '' : 'bad');
    if (ok) { btn.lastChild.textContent = t('enroll.copied'); setTimeout(() => { btn.lastChild.textContent = t('enroll.copy'); }, 2000); }
  });
  return h('div', { class: 'field' },
    h('span', { class: 'label' }, label),
    h('div', { class: 'copy-box' }, h('div', { class: `val ${cls} ${mono ? 'mono' : ''}`, dir: mono ? 'ltr' : 'auto' }, display || value), btn));
}

function statusInfo(e) {
  const s = e?.state || 'ready';
  const badge = { ready: 'neutral', pending: 'warn', active: 'ok', expired: 'bad', revoked: 'bad' }[s];
  let text = t(`status.${s}.text`, { grades: gradesLabel(e?.grades), date: fmtDate(e?.expires_at) });
  if (s === 'active' && e.expires_at) text += ' ' + t('status.active.until', { date: fmtDate(e.expires_at) });
  return { s, badge, text };
}

function statusCard(e) {
  const { s, badge, text } = statusInfo(e);
  return h('section', { class: `card status-card ${s}`, 'aria-live': 'polite' },
    h('h2', { style: 'margin:0' }, h('span', { class: `badge ${badge}`, style: 'font-size:1rem;padding:4px 12px' }, t('status.' + s))),
    h('p', { style: 'margin:.5em 0 0' }, text));
}

function emptyState(msg, action) { return h('div', { class: 'card empty' }, h('p', null, msg), action || null); }

// ---------------- header / footer ----------------
function renderChrome() {
  const s = state.site;
  const here = location.pathname;
  const cur = (p) => (here === p || (p !== '/' && here.startsWith(p)) ? 'page' : undefined);
  const links = [
    ['/', t('nav.home')], ['/course', t('nav.grades')], ['/textbooks', t('nav.textbooks')],
    ...(user() ? [isAdmin() ? ['/admin', t('nav.dashboard')] : ['/account', t('nav.account')]] : [['/login', t('nav.signin')]]),
  ];
  const langBtn = (cls) => h('button', { class: cls, type: 'button', lang: currentLang() === 'ku' ? 'en' : 'ku-Arab', onclick: () => {
    const next = currentLang() === 'ku' ? 'en' : 'ku';
    try { localStorage.setItem('lang', next); } catch { /* private mode */ }
    setLanguage(next, state.site.wordings?.[next] || {});
    render();
  } }, '🌐 ', t('nav.lang'));
  const drawer = h('nav', { class: 'drawer wrap', id: 'drawer', hidden: true, 'aria-label': t('nav.menu') },
    links.map(([href, label]) => h('a', { href, 'aria-current': cur(href) }, label)),
    !user() ? h('a', { href: '/register' }, t('nav.register')) : null);
  const menuBtn = h('button', { class: 'btn ghost icon-btn menu-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'drawer', 'aria-label': t('nav.menu') }, icon('menu'));
  menuBtn.addEventListener('click', () => {
    const open = drawer.hidden;
    drawer.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open));
    if (open) drawer.querySelector('a')?.focus();
  });
  const closeDrawer = (focusBtn) => { if (!drawer.hidden) { drawer.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); if (focusBtn) menuBtn.focus(); } };
  drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(true); });
  clear(topbar).append(
    h('div', { class: 'wrap' },
      h('a', { class: 'brand', href: '/' }, h('img', { class: 'brand-mark', src: '/favicon.svg', alt: '' }), h('span', { class: 'brand-text' }, s.course_title)),
      h('nav', { class: 'nav', 'aria-label': 'Main' },
        links.map(([href, label]) => h('a', { href, 'aria-current': cur(href) }, label)),
        !user() ? h('a', { href: '/register', class: 'btn sm', style: 'color:#fff;margin-inline-start:6px' }, t('nav.register')) : null,
        langBtn('btn ghost sm lang-btn')),
      langBtn('btn ghost sm lang-btn lang-mobile'), menuBtn),
    drawer);
  clear(footer).append(h('div', { class: 'wrap' },
    h('span', null, `${s.teacher_name} · ${t('footer.city', { city: s.city })}`),
    h('span', null, t('footer.track'))));
}

// ---------------- pages ----------------
async function homePage(root) {
  const s = state.site;
  const cat = await loadCatalog();
  const e = enr();
  const st = e?.state || 'ready';
  const terms = s.terms;
  const initials = (s.teacher_name || '?').replace(/[[\]]/g, '').trim().slice(0, 1) || '∑';

  let cta;
  if (isAdmin()) cta = h('a', { class: 'btn block lg', href: '/admin' }, t('nav.dashboard'));
  else if (!user()) cta = h('a', { class: 'btn block lg', href: '/register?next=/enroll' }, t('home.enroll'));
  else if (st === 'active') cta = h('a', { class: 'btn block lg', href: '/course' }, t('home.continue'));
  else if (st === 'pending') cta = h('a', { class: 'btn accent block lg', href: '/enroll' }, t('status.pending'));
  else cta = h('a', { class: 'btn block lg', href: '/enroll' }, st === 'ready' ? t('home.enroll') : t('status.renew'));

  const priceReady = terms.open;
  append(root, [
    h('section', { class: 'hero' }, h('div', { class: 'wrap' },
      h('div', null,
        h('p', { class: 'eyebrow' }, s.course_subtitle),
        h('h1', null, s.course_title),
        h('div', { class: 'teacher', style: 'margin:18px 0' },
          s.teacher_photo ? h('img', { class: 'avatar', src: s.teacher_photo, alt: s.teacher_name, width: 72, height: 72 }) : h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials),
          h('div', null, h('div', { class: 'muted small' }, t('home.teacher')), h('div', { style: 'font-weight:800;font-size:1.15rem' }, s.teacher_name), h('div', { class: 'muted small' }, s.city))),
        s.teacher_intro ? h('p', { class: 'intro', dir: 'auto' }, s.teacher_intro) : null,
        h('div', { class: 'row' }, h('a', { class: 'btn secondary', href: '/course' }, t('home.browse')), s.demo ? h('a', { class: 'btn ghost', href: '#demo' }, icon('play'), t('home.demo')) : null)),
      h('aside', { class: 'card price-card', 'aria-labelledby': 'price-h' },
        h('h2', { id: 'price-h', class: 'muted small', style: 'font-weight:700;margin-bottom:4px' }, t('home.price')),
        priceReady ? h('div', { class: 'price' }, ltr(fmtIqd(terms.price_iqd)), ' ', h('small', null, t('iqd'))) : h('p', { class: 'muted' }, t('enroll.not_ready')),
        h('div', { class: 'label', style: 'margin-top:12px' }, t('grades.available')),
        h('div', { class: 'row', style: 'margin-top:6px' }, terms.grades.map(gradeChip)),
        h('ul', { class: 'terms-list' },
          h('li', null, icon('check'), h('span', null, t('terms.onegrade'))),
          h('li', null, icon('clock'), h('span', null, termsText(terms))),
          h('li', null, icon('check'), h('span', null, t('terms.manual')))),
        e && st !== 'ready' ? h('p', null, h('span', { class: `badge ${statusInfo(e).badge}` }, t('status.' + st))) : null,
        priceReady || isAdmin() ? cta : null))),
    s.demo ? demoSection(s.demo) : null,
    h('section', { class: 'section' }, h('div', { class: 'wrap' },
      h('h2', null, t('home.grades.title')),
      h('div', { class: 'grade-cards' }, cat.grades.map((g) => {
        const n = g.chapters.reduce((a, c) => a + c.lessons.length, 0);
        return h('a', { class: `card grade-card g${g.grade}`, href: `/grade/${g.grade}` },
          h('span', { class: 'num' }, t('grade', { g: g.grade })),
          h('span', { class: 'muted' }, n ? t('home.lessons.count', { n }) : t('home.lessons.soon')),
          g.textbook ? h('span', { class: 'small' }, icon('book'), ' ', g.textbook.title) : null,
          h('span', { class: 'row small', style: 'margin-top:auto' }, g.has_access ? h('span', { class: 'lock open' }, icon('unlock'), ' ', t('lesson.free')) : null));
      })))),
  ]);
}

function demoSection(d) {
  const wrapEl = h('div', { class: 'player-wrap' });
  const p = createPlayer({ title: d.title || t('home.demo'), poster: d.thumbnail, fetchPlayback: () => api.post('/api/demo/playback') });
  onLeave(() => p.destroy());
  wrapEl.append(p.el);
  return h('section', { class: 'section', id: 'demo' }, h('div', { class: 'wrap' },
    h('h2', null, d.title || t('home.demo')),
    h('p', { class: 'muted' }, t('home.demo.note'), d.duration_seconds ? ` · ${fmtDuration(d.duration_seconds)}` : ''),
    h('div', { style: 'max-width:860px' }, wrapEl)));
}

function refLine(ref) {
  if (!ref) return null;
  const parts = [['ref.chapter', ref.chapter], ['ref.section', ref.section], ['ref.pages', ref.pages], ['ref.exercises', ref.exercises]].filter(([, v]) => v);
  if (!parts.length) return null;
  return h('div', { class: 'ref' }, icon('book'), parts.map(([k, v]) => h('span', null, `${t(k)}: `, h('b', null, h('bdi', null, v)))));
}

function lockedBanner(gradeNum) {
  const e = enr();
  const st = e?.state || 'ready';
  if (!user()) return h('div', { class: 'notice info' }, icon('lock'), h('div', null, h('p', null, t('lesson.locked.signin')), h('div', { class: 'row' }, h('a', { class: 'btn sm', href: `/register?next=${encodeURIComponent(location.pathname)}` }, t('nav.register')), h('a', { class: 'btn secondary sm', href: `/login?next=${encodeURIComponent(location.pathname)}` }, t('nav.signin')))));
  if (isAdmin()) return null;
  const mine = user().grade;
  if (mine && gradeNum && mine !== gradeNum) {
    return h('div', { class: 'notice info' }, icon('lock'), h('div', null, h('p', null, t('lesson.locked.othergrade', { g: gradeNum, mine })),
      h('a', { class: 'btn sm secondary', href: `/grade/${mine}` }, t('grade', { g: mine }))));
  }
  const msg = st === 'pending' ? t('lesson.locked.pending') : st === 'expired' ? t('lesson.locked.expired') : st === 'revoked' ? t('lesson.locked.revoked')
    : st === 'active' ? t('lesson.locked.grade') : t('lesson.locked.enroll', { grades: gradesLabel(mine ? [mine] : state.site.terms.grades) });
  return h('div', { class: `notice ${st === 'pending' ? 'warn' : 'info'}` }, icon('lock'), h('div', null, h('p', null, msg),
    st !== 'active' ? h('a', { class: `btn sm ${st === 'pending' ? 'accent' : ''}`, href: '/enroll' }, st === 'pending' ? t('status.pending') : st === 'ready' ? t('home.enroll') : t('status.renew')) : null));
}

async function gradePage(root, g) {
  const cat = await loadCatalog(true);
  const grade = cat.grades.find((x) => x.grade === g);
  if (!grade) return notFound(root);
  let n = 0;
  append(root, h('div', { class: 'wrap section stack' },
    h('nav', { class: 'seg', 'aria-label': t('nav.grades') }, [10, 11, 12].map((x) => h('a', { href: `/grade/${x}`, 'aria-current': x === g ? 'page' : undefined }, t('grade', { g: x })))),
    h('div', { class: 'row between' }, h('h1', { style: 'margin:0' }, t('grade', { g })), grade.has_access ? h('span', { class: 'badge ok' }, icon('unlock'), t('status.active')) : null),
    grade.textbook
      ? h('a', { class: 'card flat row tb-link', href: `/textbooks#grade-${g}`, style: 'text-decoration:none;color:inherit;padding:12px 14px' }, icon('book'),
        h('span', { class: 'grow' }, h('b', null, grade.textbook.title), h('span', { class: 'muted small' }, ` · ${t('tb.edition')}: `, h('bdi', null, grade.textbook.edition))), icon('arrow', 'flip-rtl'))
      : null,
    !grade.has_access ? lockedBanner(g) : null,
    grade.chapters.length ? grade.chapters.map((c, ci) => h('details', { class: 'card chapter', open: ci === 0 || grade.chapters.length <= 2 },
      h('summary', null, h('span', { class: 'chapter-num' }, ci + 1), h('span', { class: 'grow' }, h('b', null, c.title), h('div', { class: 'muted small' }, t('home.lessons.count', { n: c.lessons.length }))), icon('chev', 'chev')),
      c.description ? h('p', { class: 'muted small', style: 'padding:0 16px' }, c.description) : null,
      h('ol', { class: 'lesson-list' }, c.lessons.map((l) => { n++; return lessonRow(l); }))))
      : emptyState(t('home.lessons.soon'))));
}

function lessonRow(l) {
  const pct = l.progress?.completed ? 100 : l.progress?.duration_seconds ? Math.min(100, Math.round((l.progress.position_seconds / l.progress.duration_seconds) * 100)) : 0;
  return h('li', { class: 'lesson-item' }, h('a', { href: `/lesson/${l.id}` },
    h('span', { class: 'thumb' }, l.thumbnail ? h('img', { src: l.thumbnail, alt: '', loading: 'lazy', width: 96, height: 54 }) : icon('play')),
    h('span', { style: 'min-width:0' },
      h('span', { class: 'lesson-title' }, l.title),
      h('span', { class: 'lesson-meta' }, l.duration_seconds ? h('span', null, icon('clock'), ' ', ltr(fmtDuration(l.duration_seconds))) : null, l.progress?.completed ? h('span', { class: 'badge ok' }, '✓') : null),
      refLine(l.ref),
      pct > 0 && pct < 100 ? h('span', { class: 'pbar', 'aria-hidden': 'true' }, h('span', { style: `width:${pct}%` })) : null),
    l.locked ? h('span', { class: 'lock', title: t('lesson.locked') }, icon('lock'), h('span', { class: 'visually-hidden' }, t('lesson.locked'))) : h('span', { class: 'lock open' }, icon('play'))));
}

const localKey = (lid) => `p:${user()?.id}:${lid}`;
function readLocalProgress(lid) { try { return JSON.parse(localStorage.getItem(localKey(lid)) || 'null'); } catch { return null; } }
function writeLocalProgress(lid, pos) { try { localStorage.setItem(localKey(lid), JSON.stringify({ pos, at: Date.now() })); } catch { /* private mode */ } }

async function lessonPage(root, id) {
  let data;
  try { data = await api.get(`/api/lessons/${id}`); }
  catch (e) { if (e.status === 404) return notFound(root, t('lesson.notfound')); throw e; }
  const { lesson: l, ref, siblings, access, progress, textbook } = data;
  const idx = siblings.findIndex((x) => x.id === l.id);
  const prev = siblings[idx - 1], next = siblings[idx + 1];

  const playerWrap = h('div', { class: 'player-wrap' });
  const tools = h('div', { class: 'player-tools' });
  if (access === 'ok' && l.has_video) {
    let start = progress && !progress.completed ? progress.position_seconds : 0;
    const local = readLocalProgress(l.id);
    const dur = l.duration_seconds || 0;
    if (!progress?.completed && local && local.pos > start && (!dur || local.pos < dur - 15) && Date.now() - local.at < 14 * 86400_000) start = local.pos;
    const p = createPlayer({
      title: l.title, poster: l.thumbnail, startAt: start,
      fetchPlayback: () => api.post(`/api/lessons/${l.id}/playback`),
      onProgress: (pos, dur, beacon) => {
        writeLocalProgress(l.id, dur && pos >= dur - 15 ? 0 : pos); // finished lessons start from the beginning next time
        if (beacon) api.beacon(`/api/lessons/${l.id}/progress`, { position: pos, duration: dur });
        else api.post(`/api/lessons/${l.id}/progress`, { position: pos, duration: dur }).catch(() => {});
      },
      onDenied: async () => { await refreshSite(); render(); },
    });
    onLeave(() => p.destroy());
    playerWrap.append(p.el);
    append(tools, [
      h('button', { class: 'btn secondary sm', type: 'button', onclick: () => (p.canFullscreen ? p.fullscreen() : toast(t('player.fs.inside'))) }, icon('full'), t('player.fullscreen')),
      start > 5 ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { writeLocalProgress(l.id, 0); p.start(0); } }, icon('retry'), t('player.restart')) : null,
      matchMedia('(hover: hover) and (pointer: fine)').matches ? h('span', { class: 'muted small' }, t('player.keys')) : null,
    ]);
  } else if (access === 'ok') {
    playerWrap.append(h('div', { class: 'player' }, h('div', { class: 'overlay' }, h('p', null, t('lesson.novideo')))));
  } else {
    const banner = lockedBanner(l.grade);
    playerWrap.append(h('div', { class: 'player' },
      l.thumbnail ? h('img', { class: 'poster', src: l.thumbnail, alt: '' }) : null,
      h('div', { class: 'overlay' }, icon('lock'), h('p', null, h('b', null, t('lesson.locked.title'))))));
    tools.append(banner || '');
  }

  append(root, h('div', { class: 'wrap' }, h('div', { class: 'lesson-layout' },
    h('div', { style: 'min-width:0' },
      !l.published ? h('div', { class: 'notice warn', style: 'margin-bottom:10px' }, t('lesson.draft')) : null,
      playerWrap, tools,
      h('div', { class: 'row', style: 'margin-top:14px' }, h('a', { class: `chip g${l.grade}`, href: `/grade/${l.grade}`, style: 'text-decoration:none' }, t('grade', { g: l.grade })), h('span', { class: 'chip' }, l.chapter_title), l.duration_seconds ? h('span', { class: 'chip' }, icon('clock'), ltr(fmtDuration(l.duration_seconds))) : null),
      h('h1', { style: 'margin-top:10px' }, l.title),
      ref ? h('div', { class: 'card flat', style: 'padding:12px 14px;margin-bottom:14px' },
        h('div', { class: 'label', style: 'margin-bottom:4px' }, t('lesson.ref'), textbook ? h('span', { class: 'muted small' }, ` — ${textbook.title} (`, h('bdi', null, textbook.edition), ')') : null), refLine(ref)) : null,
      l.description ? h('div', { class: 'lesson-body', dir: 'auto' }, richText(l.description)) : null,
      h('div', { class: 'row between', style: 'margin-top:20px' },
        prev ? h('a', { class: 'btn secondary', href: `/lesson/${prev.id}` }, icon('back', 'flip-rtl'), t('lesson.prev')) : h('span'),
        next ? h('a', { class: 'btn', href: `/lesson/${next.id}` }, t('lesson.next'), icon('arrow', 'flip-rtl')) : null)),
    h('aside', { class: 'card', style: 'padding:10px' },
      h('h2', { class: 'small', style: 'padding:6px 12px;margin:0' }, t('lesson.chapterlist')),
      h('ol', { class: 'side-list' }, siblings.map((s, i) => h('li', null, h('a', { href: `/lesson/${s.id}`, 'aria-current': s.id === l.id ? 'page' : undefined },
        h('span', { class: 'chapter-num', style: 'width:28px;height:28px;font-size:.85rem' }, i + 1), h('span', { class: 'grow' }, s.title), s.duration_seconds ? h('span', { class: 'muted small' }, ltr(fmtDuration(s.duration_seconds))) : null))))))));
}

async function textbooksPage(root) {
  const data = await api.get('/api/textbooks');
  append(root, h('div', { class: 'wrap section stack' },
    h('h1', null, t('tb.title')),
    h('p', { class: 'muted' }, t('tb.intro')),
    data.grades.map((g) => h('section', { id: `grade-${g.grade}`, class: 'stack', style: 'scroll-margin-top:80px' },
      h('h2', null, t('grade', { g: g.grade })),
      g.textbooks.length ? g.textbooks.map((tb) => h('article', { class: `card edition ${tb.is_active ? 'active' : ''}` },
        h('div', { class: 'item-head' }, h('h3', { style: 'margin:0' }, tb.title), h('span', { class: `badge ${tb.is_active ? 'ok' : 'neutral'}` }, tb.is_active ? t('tb.active') : t('tb.older'))),
        h('dl', { class: 'kv', style: 'margin-top:10px' },
          [['tb.track', tb.track], ['tb.language', tb.language], ['tb.edition', tb.edition], ['tb.year', tb.publication_year], ['tb.academic', tb.academic_year]]
            .filter(([, v]) => v).map(([k, v]) => [h('dt', null, t(k)), h('dd', null, h('bdi', null, v))])),
        h('div', { class: 'row', style: 'margin-top:14px' },
          tb.source_url ? h('a', { class: 'btn secondary', href: tb.source_url, target: '_blank', rel: 'noopener noreferrer' }, icon('ext', 'flip-rtl'), tb.source_kind === 'official' ? t('tb.open') : t('tb.open.auth')) : null,
          tb.pdf_url ? h('a', { class: 'btn', href: tb.pdf_url, download: '' }, icon('book'), t('tb.download')) : null,
          !tb.source_url && !tb.pdf_url ? h('span', { class: 'muted small' }, t('tb.nolink')) : null)))
        : emptyState(t('tb.none')))),
    h('p', null, h('a', { href: 'https://parwarda.edu.krd/', target: '_blank', rel: 'noopener noreferrer' }, t('tb.portal'), ' ', icon('ext', 'flip-rtl')))));
}

// ---------------- auth ----------------
function passwordInput(attrs) {
  const inp = input({ type: 'password', minlength: 8, maxlength: 200, required: true, ...attrs });
  const btn = h('button', { class: 'btn ghost sm', type: 'button', 'aria-pressed': 'false' }, t('auth.show'));
  btn.addEventListener('click', () => {
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password'; btn.textContent = show ? t('auth.hide') : t('auth.show'); btn.setAttribute('aria-pressed', String(show));
  });
  return { inp, el: h('div', { class: 'pw-wrap' }, inp, btn) };
}

function authForm(root, title, fields, submitLabel, onSubmit, after) {
  const err = h('div', { class: 'err', role: 'alert' });
  const submit = h('button', { class: 'btn block lg', type: 'submit' }, submitLabel);
  const form = h('form', { class: 'form', novalidate: true }, fields, err, submit);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const bad = [...form.querySelectorAll('input:not([type=radio])')].find((i) => !i.checkValidity());
    if (bad) { bad.setAttribute('aria-invalid', 'true'); bad.focus(); err.textContent = bad.type === 'email' ? t('err.email_invalid') : bad.type === 'password' || bad.name === 'password' ? t('err.password_too_short') : t('err.name_required'); return; }
    busy(submit, true);
    try { await onSubmit(); } catch (e) { err.textContent = errText(e); } finally { busy(submit, false); }
  });
  form.addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));
  append(root, h('div', { class: 'wrap' }, h('div', { class: 'card auth-card' }, h('h1', null, title), form, after || null)));
  if (!isTouchDevice()) form.querySelector('input')?.setAttribute('data-autofocus', '');
}

function afterSignIn(next) {
  const dest = safeNext(next) || (isAdmin() ? '/admin' : enr()?.state === 'active' ? '/course' : '/enroll');
  navigate(dest, { replace: true });
}

function registerPage(root) {
  if (user()) return navigate('/enroll', { replace: true });
  const next = new URLSearchParams(location.search).get('next');
  if (safeNext(next)) { try { sessionStorage.setItem('returnTo', next); } catch { /* private mode */ } }
  const name = input({ name: 'name', autocomplete: 'name', required: true, minlength: 2, maxlength: 100 });
  const email = input({ name: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pw = passwordInput({ name: 'password', autocomplete: 'new-password' });
  const grades = gradePicker('reg-grade');
  authForm(root, t('auth.register'), [field(t('auth.name'), name, t('auth.name.hint')), field(t('auth.email'), email), grades.el, replacePw(field(t('auth.password'), pw.inp, t('auth.password.hint')), pw.el)], t('auth.register'), async () => {
    const grade = grades.value();
    if (!grade) { const e = new Error(t('err.grade_required')); e.code = 'grade_required'; grades.el.querySelector('input').focus(); throw e; }
    await api.post('/api/auth/register', { name: name.value, email: email.value, password: pw.inp.value, grade });
    await refreshSite();
    navigate('/enroll' + (safeNext(next) && next !== '/enroll' ? `?next=${encodeURIComponent(next)}` : ''), { replace: true });
  }, h('p', { class: 'muted', style: 'margin-top:16px' }, t('auth.have'), ' ', h('a', { href: '/login' + location.search }, t('auth.signin'))));
}
// Big, tappable grade choice (radio buttons) used at sign-up and on the enroll page.
function gradePicker(name, current) {
  const offered = state.site.terms.grades.length ? state.site.terms.grades : [10, 11, 12];
  const el = h('fieldset', { class: 'grade-pick' }, h('legend', null, t('auth.grade')),
    h('div', { class: 'grade-options' }, [10, 11, 12].filter((g) => offered.includes(g) || g === current).map((g) => h('label', { class: `grade-opt g${g}` },
      h('input', { type: 'radio', name, value: g, checked: g === current, required: true }), h('span', null, t('grade', { g }))))),
    h('div', { class: 'hint' }, t('auth.grade.hint')));
  return { el, value: () => Number(el.querySelector('input:checked')?.value || 0) };
}
// field() puts the raw input in place; swap it for the wrapper with the show/hide button.
function replacePw(fieldEl, wrapper) { const inp = fieldEl.querySelector('input'); inp.replaceWith(wrapper); wrapper.prepend(inp); return fieldEl; }

function loginPage(root) {
  const next = new URLSearchParams(location.search).get('next');
  if (user()) return afterSignIn(next);
  const email = input({ name: 'email', type: 'email', autocomplete: 'username', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pw = passwordInput({ name: 'password', autocomplete: 'current-password', minlength: 1 });
  authForm(root, t('auth.signin'), [field(t('auth.email'), email), replacePw(field(t('auth.password'), pw.inp), pw.el),
    h('a', { href: '/forgot', class: 'small' }, t('auth.forgot'))], t('auth.signin'), async () => {
    await api.post('/api/auth/login', { email: email.value, password: pw.inp.value });
    await refreshSite();
    afterSignIn(next);
  }, h('p', { class: 'muted', style: 'margin-top:16px' }, t('auth.new'), ' ', h('a', { href: '/register' + location.search }, t('auth.register'))));
}

function forgotPage(root) {
  const email = input({ name: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', required: true });
  authForm(root, t('auth.forgot.title'), [field(t('auth.email'), email)], t('auth.forgot.send'), async () => {
    await api.post('/api/auth/forgot', { email: email.value });
    const card = root.querySelector('.auth-card');
    clear(card).append(h('h1', null, t('auth.forgot.title')), h('div', { class: 'notice ok' }, h('p', null, t('auth.forgot.sent'))), h('p', { style: 'margin-top:16px' }, h('a', { href: '/login' }, t('auth.signin'))));
  });
}

function resetPage(root) {
  const token = new URLSearchParams(location.search).get('token') || '';
  history.replaceState(null, '', '/reset'); // keep the token out of history/screenshots
  const pw = passwordInput({ name: 'password', autocomplete: 'new-password' });
  authForm(root, t('auth.reset.title'), [replacePw(field(t('auth.password'), pw.inp, t('auth.password.hint')), pw.el)], t('auth.reset.save'), async () => {
    await api.post('/api/auth/reset', { token, password: pw.inp.value });
    await refreshSite();
    toast(t('auth.reset.done'));
    afterSignIn(null);
  });
}

// ---------------- enrollment ----------------
async function enrollPage(root) {
  if (!user()) return navigate('/register?next=/enroll', { replace: true });
  if (isAdmin()) return navigate('/admin', { replace: true });
  const s = state.site;
  const u = user();
  const e = enr();
  const st = e?.state || 'ready';
  const terms = s.terms;
  const step = st === 'active' ? 4 : st === 'pending' ? 3 : 2;
  const steps = h('ol', { class: 'steps', 'aria-label': t('enroll.title') }, ['enroll.step1', 'enroll.step3', 'enroll.step.confirm', 'enroll.step4'].map((k, i) =>
    h('li', { class: i + 1 < step || (i === 3 && st === 'active') ? 'done' : i + 1 === step ? 'now' : '', 'aria-current': i + 1 === step ? 'step' : undefined }, t(k))));

  // Grade can be changed by the student only while nothing is pending or active.
  const canChangeGrade = st !== 'active' && st !== 'pending';
  const gradeChanger = h('button', { class: 'btn ghost sm', type: 'button' }, t('enroll.changegrade'));
  gradeChanger.addEventListener('click', () => {
    const pick = gradePicker('chg-grade', u.grade);
    const save = h('button', { class: 'btn', type: 'button' }, t('common.save'));
    save.addEventListener('click', async () => { busy(save, true); try { await api.post('/api/me/grade', { grade: pick.value() }); await refreshSite(); render(); } catch (err) { toast(errText(err), 'bad'); busy(save, false); } });
    gradeChanger.replaceWith(h('div', { class: 'stack', style: 'width:100%' }, pick.el, save));
  });
  if (!u.grade && canChangeGrade) setTimeout(() => gradeChanger.click()); // older accounts: ask for the grade first
  const summary = h('section', { class: 'card' },
    h('div', { class: 'row between' }, h('div', null, h('div', { class: 'muted small' }, t('home.price')), h('div', { class: 'price' }, ltr(fmtIqd(st === 'active' ? e.price_iqd : terms.price_iqd)), ' ', h('small', null, t('iqd'))))),
    h('div', { class: 'label', style: 'margin-top:10px' }, t('enroll.yourgrade')),
    h('div', { class: 'row', style: 'margin-top:6px' }, (st === 'active' || st === 'pending' ? e.grades : [u.grade]).filter(Boolean).map(gradeChip), canChangeGrade ? gradeChanger : null),
    h('p', { class: 'small muted', style: 'margin:8px 0 0' }, t('enroll.gradeonly')),
    h('p', { class: 'small', style: 'margin:12px 0 0' }, icon('clock'), ' ', termsText(terms)));

  const body = h('div', { class: 'stack' });
  if (st === 'active') {
    append(body, statusCard(e), h('a', { class: 'btn block lg', href: '/course' }, t('home.continue')));
  } else {
    append(body, statusCard(e), paymentPanel(e));
    if (st === 'pending') {
      const poll = setInterval(async () => {
        if (document.visibilityState !== 'visible') return;
        try { const me = await api.get('/api/me'); if (me.enrollment?.state !== 'pending') { await refreshSite(); render(); } } catch { /* offline: keep trying */ }
      }, 30000);
      onLeave(() => clearInterval(poll));
    }
  }
  const back = safeNext(sessionStorage.getItem('returnTo') || '');
  const backLink = back && back !== '/enroll' ? h('a', { class: 'btn secondary block', href: back, onclick: () => sessionStorage.removeItem('returnTo') }, icon('back', 'flip-rtl'), t('enroll.back')) : null;
  // Before payment, price + grade come first (short), then the action; pending puts the action on top.
  const order = st === 'pending' ? [body, summary, backLink] : [summary, body, backLink];
  append(root, h('div', { class: 'wrap section', style: 'max-width:760px' }, h('h1', null, t('enroll.title')), steps, h('div', { class: 'stack' }, ...order)));
}

function paymentPanel(e) {
  const s = state.site;
  const number = s.whatsapp_number;
  const st = e?.state || 'ready';
  const terms = s.terms;
  const panel = h('section', { class: 'card stack', 'aria-labelledby': 'pay-h' });
  if (!terms.open) { panel.append(h('p', null, t('enroll.not_ready'))); return panel; }
  const hasRef = st === 'pending' && e.reference;

  const create = async (open) => {
    const r = await api.post('/api/me/enrollment', { open_whatsapp: open });
    state.site.enrollment = r.enrollment;
    return r.enrollment;
  };
  let primary;
  if (!number) {
    primary = h('div', { class: 'notice warn' }, h('p', null, t('enroll.nowa.number')));
  } else if (hasRef && e.wa_url) {
    // Real link: a genuine tap opens the WhatsApp app (universal link) or wa.me in a new tab.
    primary = h('a', { class: 'btn wa block lg', href: e.wa_url, target: '_blank', rel: 'noopener noreferrer' }, icon('wa'), t('enroll.reopen'));
    primary.addEventListener('click', () => { api.post('/api/me/enrollment', { open_whatsapp: true }).catch(() => {}); });
  } else {
    primary = h('button', { class: 'btn wa block lg', type: 'button' }, icon('wa'), t('enroll.pay'));
    primary.addEventListener('click', async () => {
      // Desktop: open the tab now (inside the click) so pop-up blockers allow it; fill in the URL once the reference exists.
      // Open the tab now, inside the tap/click, so pop-up blockers (and iOS) allow it; the site stays
      // open in this tab with the reference visible. Falls back to this tab if pop-ups are blocked.
      let win = null;
      try { win = window.open('', '_blank'); } catch { win = null; }
      busy(primary, true);
      try {
        const en = await create(true);
        if (en.wa_url) {
          if (win && !win.closed) { try { win.opener = null; } catch { /* ignore */ } win.location.href = en.wa_url; }
          else { render(); location.href = en.wa_url; return; }
        } else if (win) win.close();
        render();
      } catch (err) { if (win) win.close(); toast(errText(err), 'bad'); busy(primary, false); }
    });
  }
  append(panel, [h('h2', { id: 'pay-h' }, t('enroll.pay')), primary]);
  if (!hasRef && number) {
    const refOnly = h('button', { class: 'btn ghost block', type: 'button' }, t('enroll.refonly'));
    refOnly.addEventListener('click', async () => { busy(refOnly, true); try { await create(false); render(); } catch (err) { toast(errText(err), 'bad'); busy(refOnly, false); } });
    panel.append(refOnly);
  }
  if (number) panel.append(copyBox(t('enroll.number'), '+' + number, { mono: true, display: fmtPhone(number) }));
  if (hasRef) {
    panel.append(copyBox(t('enroll.reference'), e.reference, { mono: true }));
    panel.append(copyBox(t('enroll.message'), e.message, { cls: 'msg' }));
    const iso = (x) => `\u2066${x}\u2069`; // keep numbers/references left-to-right inside Kurdish text
    const all = `${t('enroll.number')}: ${iso(fmtPhone(number))}\n${t('enroll.reference')}: ${iso(e.reference)}\n${t('home.price')}: ${iso(fmtIqd(terms.price_iqd))} ${t('iqd')}\n\n${e.message}`;
    const share = h('button', { class: 'btn secondary', type: 'button' }, icon('share'), navigator.share ? t('enroll.share') : t('enroll.copyall'));
    share.addEventListener('click', async () => {
      if (navigator.share) { try { await navigator.share({ title: s.course_title, text: all }); return; } catch (err) { if (err?.name === 'AbortError') return; } }
      toast((await copyText(all)) ? t('enroll.copied') + ' ✓' : all);
    });
    const web = h('a', { class: 'btn ghost', href: `https://web.whatsapp.com/send?phone=${number}&text=${encodeURIComponent(e.message)}`, target: '_blank', rel: 'noopener noreferrer' }, icon('ext', 'flip-rtl'), t('enroll.web'));
    panel.append(h('div', { class: 'row' }, share, !isTouchDevice() ? web : null));
  }
  if (number) panel.append(h('div', { class: 'notice info' }, icon('phone'), h('div', null, h('p', null, h('b', null, t('enroll.nowa'))), h('p', null, t('enroll.nowa.text')))));
  panel.append(
    h('h3', null, t('enroll.how')),
    h('ol', { style: 'padding-inline-start:20px;margin:0;display:grid;gap:6px' }, ['enroll.how1', 'enroll.how2', 'enroll.how3'].map((k) => h('li', null, t(k)))),
    h('div', { class: 'notice warn' }, h('p', null, t('enroll.never'))));
  return panel;
}

async function accountPage(root) {
  if (!user()) return navigate('/login?next=/account', { replace: true });
  if (isAdmin()) return navigate('/admin', { replace: true });
  await refreshSite();
  const e = enr();
  const cat = await loadCatalog(true);
  const started = cat.grades.flatMap((g) => g.chapters.flatMap((c) => c.lessons.filter((l) => l.progress && !l.locked).map((l) => ({ ...l, grade: g.grade }))))
    .sort((a, b) => (b.progress.completed ? -1 : 0) - (a.progress.completed ? -1 : 0)).slice(0, 6);
  const signout = h('button', { class: 'btn secondary', type: 'button' }, t('nav.signout'));
  signout.addEventListener('click', async () => { await api.post('/api/auth/logout'); state.catalog = null; await refreshSite(); navigate('/'); });
  append(root, h('div', { class: 'wrap section stack', style: 'max-width:820px' },
    h('h1', null, t('acct.title')),
    h('p', { class: 'muted' }, user().name, ' · ', ltr(user().email)),
    user().grade ? h('p', null, h('span', { class: 'label' }, t('enroll.yourgrade'), ': '), gradeChip(user().grade)) : null,
    statusCard(e),
    e?.reference ? copyBox(t('enroll.reference'), e.reference, { mono: true }) : null,
    e?.reference && state.site.whatsapp_number ? copyBox(t('enroll.number'), '+' + state.site.whatsapp_number, { mono: true, display: fmtPhone(state.site.whatsapp_number) }) : null,
    e && e.state !== 'active' ? h('a', { class: 'btn', href: '/enroll' }, e.state === 'pending' ? t('enroll.reopen') : e.state === 'ready' ? t('home.enroll') : t('status.renew')) : null,
    e?.requested_at ? h('dl', { class: 'kv' }, h('dt', null, t('acct.requested')), h('dd', null, fmtDate(e.requested_at, true)), e.price_iqd ? [h('dt', null, t('acct.price')), h('dd', null, ltr(fmtIqd(e.price_iqd)), ' ', t('iqd'))] : null) : null,
    h('h2', null, t('acct.continue')),
    started.length ? h('ol', { class: 'card lesson-list', style: 'padding:0' }, started.map(lessonRow)) : emptyState(t('acct.none'), h('a', { class: 'btn secondary', href: '/course' }, t('home.browse'))),
    signout));
}

function notFound(root, msg) {
  append(root, h('div', { class: 'wrap section' }, emptyState(msg || t('notfound'), h('a', { class: 'btn', href: '/' }, t('common.home')))));
}

// ---------------- router ----------------
let renderSeq = 0;
let lastRendered = '';
export async function render() {
  const seq = ++renderSeq;
  leaveHooks.forEach((f) => { try { f(); } catch { /* ignore */ } });
  leaveHooks = [];
  const path = location.pathname.replace(/\/+$/, '') || '/';
  renderChrome();
  clear(mainEl).append(h('div', { class: 'boot' }, h('span', { class: 'spinner', role: 'img', 'aria-label': t('common.loading') })));
  // Each page renders into its own detached container; only the latest navigation is swapped in.
  const root = h('div', { class: 'view' });
  try {
    let m;
    if (path === '/') await homePage(root);
    else if (path === '/course') { const g = user()?.grade || (state.site.enrollment?.state === 'active' && state.site.enrollment.grades?.[0]) || state.site.terms.grades?.[0] || 10; history.replaceState(null, '', `/grade/${g}`); await gradePage(root, g); }
    else if ((m = path.match(/^\/grade\/(10|11|12)$/))) await gradePage(root, Number(m[1]));
    else if ((m = path.match(/^\/lesson\/(\d+)$/))) await lessonPage(root, Number(m[1]));
    else if (path === '/textbooks') await textbooksPage(root);
    else if (path === '/register') await registerPage(root);
    else if (path === '/login') await loginPage(root);
    else if (path === '/forgot') await forgotPage(root);
    else if (path === '/reset') await resetPage(root);
    else if (path === '/enroll') await enrollPage(root);
    else if (path === '/account') await accountPage(root);
    else if (path === '/admin' || path.startsWith('/admin/')) {
      if (!user()) return navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
      if (!isAdmin()) notFound(root);
      else { const mod = await import('./admin.js'); await mod.renderAdmin(root, path); }
    } else notFound(root);
    if (seq !== renderSeq) return;
    clear(mainEl).append(root);
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    else window.scrollTo(0, 0);
    // Move focus to the new page heading for screen-reader and keyboard users.
    const af = root.querySelector('[data-autofocus]');
    const h1 = root.querySelector('h1');
    if (af) af.focus({ preventScroll: true });
    else if (h1 && !root.contains(document.activeElement)) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
    lastRendered = location.pathname + location.search;
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.status === 401) { await refreshSite().catch(() => {}); return navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true }); }
    clear(mainEl).append(h('div', { class: 'wrap section' }, h('div', { class: 'notice bad' }, h('div', null, h('p', null, errText(e)), h('button', { class: 'btn sm', type: 'button', onclick: () => render() }, icon('retry'), t('player.retry'))))));
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target === '_blank' || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/media/') || url.pathname.startsWith('/api/')) return;
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return; // in-page anchor
  e.preventDefault();
  document.getElementById('drawer')?.setAttribute('hidden', '');
  navigate(url.pathname + url.search + url.hash);
});
// Tap outside the open mobile menu closes it.
document.addEventListener('pointerdown', (e) => {
  const d = document.getElementById('drawer');
  if (d && !d.hidden && !topbar.contains(e.target)) { d.hidden = true; topbar.querySelector('.menu-btn')?.setAttribute('aria-expanded', 'false'); }
}, true);
window.addEventListener('popstate', () => { if (location.pathname + location.search !== lastRendered) render(); });

(async function boot() {
  try { await refreshSite(); }
  catch (e) {
    clear(mainEl).append(h('div', { class: 'wrap section' }, h('div', { class: 'notice bad' }, h('div', null, h('p', null, errText(e)), h('button', { class: 'btn sm', type: 'button', onclick: () => location.reload() }, t('player.retry'))))));
    return;
  }
  render();
})();
