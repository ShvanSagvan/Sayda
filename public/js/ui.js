// Small DOM toolkit. Everything is built with createElement/textContent (no innerHTML from data).
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM is allowed by our strict CSP; style attributes are not
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden' || k === 'open' || k === 'multiple' || k === 'required' || k === 'readOnly') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}
export function append(el, ...children) {
  for (const c of [children].flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

const ICONS = {
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  unlock: 'M7 11V8a5 5 0 0 1 9.9-1M5 11h14v10H5z',
  play: 'M8 5v14l11-7z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  share: 'M12 3v12M7 8l5-5 5 5M5 14v6h14v-6',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7',
  chev: 'M6 9l6 6 6-6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  wa: 'M4 20l1.3-4A8 8 0 1 1 8 19zM9 9c0 3 3 6 6 6l1.2-1.3-2-1-1 .8c-1-.5-2.2-1.7-2.7-2.7l.8-1-1-2z',
  up: 'M12 19V5M6 11l6-6 6 6', down: 'M12 5v14M6 13l6 6 6-6',
  retry: 'M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  phone: 'M7 3h10v18H7zM11 18h2',
};
export function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', `icon ${cls}`); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', name === 'play' ? 'currentColor' : 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', ICONS[name] || ''); s.append(p);
  return s;
}

export function toast(msg, kind = '') {
  const region = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : undefined }, msg);
  region.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3200);
}

// Clipboard with fallbacks (insecure contexts, older Safari). Returns true on success.
export async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  const ta = h('textarea', { readonly: 'true', style: 'position:fixed;top:0;left:0;opacity:0;font-size:16px' });
  ta.value = text; document.body.append(ta);
  ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export const fmtIqd = (n) => new Intl.NumberFormat('en-US').format(Number(n) || 0);
export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h_ = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h_ ? `${h_}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtDate(iso, withTime = false) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00+03:00' : iso);
  const opts = { timeZone: 'Asia/Baghdad', year: 'numeric', month: 'short', day: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) };
  try { return new Intl.DateTimeFormat('en-GB', opts).format(d); } catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
}
// 9647501234567 -> +964 750 123 4567 (Iraq); generic grouping otherwise.
export function fmtPhone(d) {
  d = String(d || '');
  if (!d) return '';
  if (d.startsWith('964') && d.length === 13) return `+964 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}`;
  return '+' + d.replace(/(\d{3})(?=\d)/g, '$1 ');
}
export const ltr = (text, cls = '') => h('bdi', { dir: 'ltr', class: cls }, text);

// Lesson text: plain text with $inline$ and $$block$$ math kept left-to-right inside RTL pages.
export function richText(text) {
  const frag = document.createDocumentFragment();
  const re = /\$\$([^$]+)\$\$|\$([^$\n]+)\$/g;
  let last = 0, m;
  const s = String(text || '');
  while ((m = re.exec(s))) {
    if (m.index > last) frag.append(document.createTextNode(s.slice(last, m.index)));
    frag.append(h('span', { class: m[1] ? 'math math-block' : 'math', dir: 'ltr' }, (m[1] || m[2]).trim()));
    last = re.lastIndex;
  }
  if (last < s.length) frag.append(document.createTextNode(s.slice(last)));
  return frag;
}

// Accessible modal sheet built on <dialog>. Returns {dialog, body, close}.
export function sheet(title, build, { onClose } = {}) {
  const body = h('div', { class: 'sheet-body' });
  const closeBtn = h('button', { class: 'btn ghost icon-btn', type: 'button', 'aria-label': 'Close' }, icon('close'));
  const titleId = 'sh-' + Math.random().toString(36).slice(2);
  const native = typeof HTMLDialogElement === 'function' && typeof HTMLDialogElement.prototype.showModal === 'function';
  const d = h('dialog', { class: `sheet ${native ? '' : 'fallback'}`, 'aria-labelledby': titleId, role: native ? undefined : 'dialog', 'aria-modal': native ? undefined : 'true' },
    h('div', { class: 'sheet-head' }, h('h2', { id: titleId }, title), closeBtn), body);
  const opener = document.activeElement;
  let backdrop = null, closed = false;
  const finish = () => {
    if (closed) return; closed = true;
    d.remove(); backdrop?.remove();
    if (!document.querySelector('dialog.sheet')) document.documentElement.classList.remove('sheet-open');
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    onClose && onClose();
  };
  const close = () => { if (native) { if (d.open) d.close(); } else finish(); };
  closeBtn.addEventListener('click', close);
  d.addEventListener('click', (e) => { if (e.target === d) close(); }); // tap on backdrop
  d.addEventListener('close', finish);
  document.documentElement.classList.add('sheet-open');
  document.body.append(d);
  build(body, close);
  if (native) d.showModal();
  else {
    // iOS < 15.4 has no <dialog>: fixed sheet + backdrop + simple focus trap.
    backdrop = h('div', { class: 'sheet-backdrop', onclick: close });
    document.body.insertBefore(backdrop, d);
    d.setAttribute('open', '');
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key !== 'Tab') return;
      const f = [...d.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    closeBtn.focus();
  }
  return { dialog: d, body, close };
}

export function confirmSheet(title, message, okLabel, { danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    sheet(title, (body, close) => {
      append(body, [
        h('p', null, message),
        h('div', { class: 'form-actions' },
          h('button', { class: `btn ${danger ? 'danger' : ''}`, type: 'button', onclick: () => { answered = true; resolve(true); close(); } }, okLabel),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => close() }, 'Cancel')),
      ]);
    }, { onClose: () => { if (!answered) resolve(false); } });
  });
}

export function field(label, input, hint, id) {
  const fid = id || input.id || 'f-' + Math.random().toString(36).slice(2);
  input.id = fid;
  const hintEl = hint ? h('div', { class: 'hint', id: fid + '-hint' }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', fid + '-hint');
  return h('div', { class: 'field' }, h('label', { for: fid }, label), input, hintEl);
}
export const input = (attrs = {}) => h('input', { class: 'input', ...attrs });
export const textarea = (attrs = {}) => h('textarea', { class: 'input', ...attrs });
export function select(options, value, attrs = {}) {
  return h('select', { class: 'input', ...attrs }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
}

export function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}
