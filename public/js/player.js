// Resumable private video player.
// - Gets a short-lived playback grant from the server before every (re)load, so revoked or expired
//   access stops working and direct links are checked the same way.
// - iOS needs play() inside the tap: the grant is fetched ahead of time and ONE <video> element is
//   reused for every retry, so a single tap starts playback.
// - Survives connection drops: remembers the position, waits for the network, gets a fresh grant
//   and continues from the same second.
import { h, icon, fmtDuration, clear } from './ui.js';
import { t } from './i18n.js';

let sdkPromise = null;
function loadStreamSdk() {
  if (window.Stream) return Promise.resolve(window.Stream);
  sdkPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://embed.cloudflarestream.com/embed/sdk.latest.js';
    s.onload = () => resolve(window.Stream); s.onerror = () => { sdkPromise = null; reject(new Error('sdk')); };
    document.head.append(s);
  });
  return sdkPromise;
}

const BACKOFF = [1500, 3000, 6000, 10000, 20000, 30000];
const isIphone = () => /iPhone|iPod/.test(navigator.userAgent);
const landscapePhone = () => matchMedia('(orientation: landscape) and (max-height: 520px)').matches;

export function createPlayer({ title, poster, fetchPlayback, onProgress, onDenied, startAt = 0 }) {
  const wrap = h('div', { class: 'player', tabindex: '0', role: 'region', 'aria-label': title || 'Video' });
  const stage = h('div', { class: 'stage' });
  const overlay = h('div', { class: 'overlay' });
  const live = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
  wrap.append(stage, overlay, live);

  let video = null;      // the single reusable <video> (local provider)
  let iframe = null;     // Cloudflare Stream iframe
  let media = null;      // adapter currently in use
  let grant = null;      // last unused playback grant {provider, src|iframe, exp}
  let provider = null;
  let pos = startAt || 0, duration = 0;
  let wantPlaying = false, loading = false, destroyed = false, errored = false;
  let attempt = 0, retryTimer = null, watchdog = null, loadTimer = null, loadSeq = 0, lastSaved = 0;
  let fsAfterLoad = false;

  const say = (msg) => { live.textContent = msg; };
  function showOverlay(children) { clear(overlay); overlay.hidden = false; overlay.append(...children); }
  const hideOverlay = () => { overlay.hidden = true; clear(overlay); };
  const fresh = (g) => g && g.exp * 1000 - Date.now() > 60_000;

  async function getGrant() { const g = await fetchPlayback(); provider = g.provider; return g; }
  // Prefetch so the first tap can start playback synchronously (iOS).
  getGrant().then((g) => { if (!media) grant = g; }).catch(() => {});

  function playButton(label, at) {
    return h('button', { class: 'btn accent lg', type: 'button', onclick: () => userStart(at ?? pos) }, icon('play'), label);
  }
  function showStart() {
    showOverlay([
      poster ? h('img', { class: 'poster', src: poster, alt: '' }) : null,
      h('div', { class: 'overlay-inner' }, playButton(pos > 5 ? t('player.resume', { t: fmtDuration(pos) }) : t('lesson.watch'), pos)),
    ].filter(Boolean));
  }

  function save(force = false, beacon = false) {
    if (!media && !force) return;
    const now = Date.now();
    if (!force && now - lastSaved < 15000) return;
    lastSaved = now;
    onProgress && onProgress(pos, duration, beacon);
  }
  function clearTimers() { clearTimeout(retryTimer); clearTimeout(watchdog); clearTimeout(loadTimer); retryTimer = watchdog = loadTimer = null; }

  function failed(kind) {
    if (destroyed) return;
    loading = false;
    clearTimers();
    errored = true;
    save(true);
    const offline = !navigator.onLine;
    const msg = kind === 'fatal' ? t('player.error') : offline ? t('player.offline', { t: fmtDuration(pos) }) : t('player.retrying');
    showOverlay([h('p', null, msg), h('button', { class: 'btn accent', type: 'button', onclick: () => { attempt = 0; userStart(pos); } }, icon('retry'), t('player.retry'))]);
    say(msg);
    if (kind === 'fatal' || offline) return;
    retryTimer = setTimeout(() => load(pos, wantPlaying), BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
  }
  const onOnline = () => { if (errored && !destroyed) { attempt = 0; load(pos, wantPlaying); } };
  const onOffline = () => { if (wantPlaying && !destroyed) failed('net'); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  function armWatchdog() {
    clearTimeout(watchdog);
    const mark = pos;
    watchdog = setTimeout(() => { if (wantPlaying && Math.abs(pos - mark) < 0.5) failed('stall'); }, 20000);
  }

  function bind(m) {
    const on = (e, f) => m.on(e, (...a) => { if (media === m && !destroyed) f(...a); });
    on('timeupdate', () => {
      const ct = m.time;
      if (ct > 0 && !loading) pos = ct;
      if (m.duration > 0) duration = m.duration;
      clearTimeout(watchdog);
      save();
    });
    on('playing', () => { wantPlaying = true; errored = false; loading = false; attempt = 0; clearTimers(); hideOverlay(); });
    on('play', () => { wantPlaying = true; });
    on('pause', () => { if (!loading && !errored) { wantPlaying = false; save(true); } });
    on('seeked', () => { if (!loading) { pos = m.time; save(true); } });
    on('ended', () => { wantPlaying = false; pos = duration || pos; save(true); });
    on('waiting', () => { if (wantPlaying) armWatchdog(); });
    on('error', () => { if (m.video && !m.video.getAttribute('src')) return; failed('net'); });
  }

  function ensureVideo() {
    if (video) return video;
    // No download button, no right-click "Save video as…", no picture-in-picture or casting; the file URL is
    // a short-lived signed link tied to the signed-in student and re-checked on every request.
    video = h('video', { controls: true, playsinline: true, 'webkit-playsinline': true, preload: 'metadata', controlslist: 'nodownload noremoteplayback', disablepictureinpicture: true, disableremoteplayback: true, draggable: 'false', poster: poster || undefined, 'x-webkit-airplay': 'deny' });
    video.disablePictureInPicture = true;
    video.addEventListener('contextmenu', (e) => e.preventDefault());
    video.addEventListener('dragstart', (e) => e.preventDefault());
    stage.append(video);
    const v = video;
    const m = {
      get time() { return v.currentTime; }, set time(x) { v.currentTime = x; },
      get duration() { return isFinite(v.duration) ? v.duration : 0; }, get paused() { return v.paused; },
      play: () => v.play(), pause: () => v.pause(), on: (e, f) => v.addEventListener(e, f), video: v,
    };
    media = m;
    bind(m);
    return v;
  }

  // Point the reusable <video> at a grant and continue at `at`.
  function attachLocal(g, at, autoplay, seq) {
    const v = ensureVideo();
    pos = at || 0;
    v.addEventListener('loadedmetadata', () => {
      if (seq !== loadSeq) return;
      if (pos > 0 && pos < v.duration - 1) { try { v.currentTime = pos; } catch { /* Safari before canplay */ } }
      loading = false; errored = false; clearTimeout(loadTimer);
      if (fsAfterLoad) { fsAfterLoad = false; fullscreen(); }
      if (!autoplay) hideOverlay();
    }, { once: true });
    // iOS can ignore an early seek; repeat once playback can start.
    v.addEventListener('canplay', () => { if (seq === loadSeq && pos > 1 && Math.abs(v.currentTime - pos) > 2) { try { v.currentTime = pos; } catch { /* ignore */ } } }, { once: true });
    v.src = g.src;
    if (autoplay) {
      // Reached synchronously from the tap when a fresh grant was prefetched, so iOS allows sound.
      v.play().then(() => { if (seq === loadSeq) hideOverlay(); }).catch(() => {
        if (seq === loadSeq && !destroyed && !errored) { loading = false; showOverlay([playButton(t('player.tap', { t: fmtDuration(pos) }), pos)]); }
      });
    } else v.load();
    loadTimer = setTimeout(() => { if (seq === loadSeq && loading) failed('net'); }, 25000);
  }

  async function attachCloudflare(g, at, autoplay, seq) {
    const Stream = await loadStreamSdk();
    if (destroyed || seq !== loadSeq) return;
    if (iframe) iframe.remove();
    pos = at || 0;
    const q = new URLSearchParams({ preload: 'auto', autoplay: autoplay ? 'true' : 'false', startTime: String(Math.floor(pos)), letterboxColor: 'black' });
    if (poster) q.set('poster', new URL(poster, location.href).href);
    iframe = h('iframe', { src: `${g.iframe}?${q}`, title: title || 'Video', allow: 'accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true });
    stage.append(iframe);
    const p = Stream(iframe);
    const m = {
      get time() { return p.currentTime || 0; }, set time(x) { p.currentTime = x; },
      get duration() { return p.duration || 0; }, get paused() { return p.paused; },
      play: () => Promise.resolve(p.play()), pause: () => p.pause(), on: (e, f) => p.addEventListener(e, f),
    };
    media = m;
    bind(m);
    // The iframe has its own play button; never leave our spinner covering it (iOS blocks autoplay).
    m.on('loadeddata', () => { if (media === m) { loading = false; hideOverlay(); } });
    loadTimer = setTimeout(() => { if (seq === loadSeq && loading) { loading = false; hideOverlay(); } }, 4000);
  }

  async function load(at, autoplay, preGrant) {
    if (destroyed) return;
    const seq = ++loadSeq;
    loading = true; clearTimers();
    if (!preGrant) showOverlay([h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, t('common.loading'))]);
    let g = preGrant;
    if (!g) {
      try { g = await getGrant(); }
      catch (e) {
        if (destroyed || seq !== loadSeq) return;
        loading = false;
        if (e.status === 0) return failed('net');
        if (e.status === 401 || e.status === 403 || e.status === 404) { hideOverlay(); onDenied && onDenied(e); return; }
        if (e.status === 409) return failed('fatal');
        return failed('net');
      }
    }
    if (destroyed || seq !== loadSeq) return;
    try {
      if (g.provider === 'cloudflare') await attachCloudflare(g, at, autoplay, seq);
      else attachLocal(g, at, autoplay, seq);
    } catch { if (seq === loadSeq) failed('net'); }
  }

  // A user tap: start synchronously when we already hold a fresh grant (keeps iOS's gesture).
  function userStart(at) {
    wantPlaying = true; attempt = 0; errored = false;
    if (landscapePhone()) wrap.scrollIntoView({ block: 'start' });
    const g = grant; grant = null; // each grant is used once
    if (g && fresh(g) && g.provider !== 'cloudflare') { hideOverlay(); load(at, true, g); return; }
    // No fresh grant yet: bless the element inside the gesture so the later play() is allowed on iOS.
    if (provider !== 'cloudflare') { const v = ensureVideo(); if (!v.getAttribute('src')) v.play().catch(() => {}); }
    load(at, true);
  }

  function fullscreen() {
    if (!media) { fsAfterLoad = true; userStart(pos); return; }
    const v = media.video;
    const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (req) {
      Promise.resolve(req.call(wrap)).then(() => {
        try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch { /* not supported */ }
      }).catch(() => v?.webkitEnterFullscreen?.());
    } else if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iPhone Safari
  }
  const onFsChange = () => { if (!(document.fullscreenElement || document.webkitFullscreenElement)) { try { screen.orientation?.unlock?.(); } catch { /* ignore */ } } };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // Keyboard controls when the player region itself has focus (native controls keep their own keys).
  wrap.addEventListener('keydown', (e) => {
    if (e.target !== wrap) return;
    const k = e.key;
    if ((!media || !media.time) && !wantPlaying && (k === ' ' || k === 'Enter' || k === 'k')) { e.preventDefault(); userStart(pos); return; }
    if (!media) return;
    if (k === ' ' || k === 'k') { e.preventDefault(); media.paused ? media.play().catch(() => {}) : media.pause(); }
    else if (k === 'ArrowRight') { e.preventDefault(); media.time = Math.min((media.time || 0) + 10, media.duration || 1e9); }
    else if (k === 'ArrowLeft') { e.preventDefault(); media.time = Math.max((media.time || 0) - 10, 0); }
    else if (k === 'f' || k === 'F') { e.preventDefault(); fullscreen(); }
  });

  const onHide = () => { if (document.visibilityState === 'hidden') save(true, true); };
  const onPageHide = () => save(true, true);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  showStart();

  return {
    el: wrap,
    fullscreen,
    // iPhone has no element fullscreen; with Cloudflare the iframe's own button handles it.
    get canFullscreen() { return !(isIphone() && provider === 'cloudflare'); },
    start: (at) => userStart(at ?? pos),
    get position() { return pos; },
    destroy() {
      if (destroyed) return;
      if (media && media.time > 0) save(true, true);
      destroyed = true; loadSeq++; clearTimers();
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('fullscreenchange', onFsChange); document.removeEventListener('webkitfullscreenchange', onFsChange);
    },
  };
}
