// Fills a FRESH database with clearly-labelled demo content for testing (needs ffmpeg).
// Never run this on the live site. Usage: npm run seed-demo
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../lib/config.js';
import { one, run, setSetting, getSettings } from '../lib/db.js';

if (one('SELECT 1 FROM chapters LIMIT 1')) { console.error('Database already has chapters — demo seed skipped.'); process.exit(0); }
const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const vids = path.join(config.dataDir, 'private', 'videos');
const imgs = path.join(config.dataDir, 'public', 'img');

function makeVideo(label, eq, seconds) {
  const name = crypto.randomBytes(16).toString('hex') + '.mp4';
  const esc = (s) => s.replace(/:/g, '\\:').replace(/'/g, "\u2019");
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0xfbf8f1:s=1280x720:d=${seconds}:r=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-vf', [`drawtext=fontfile=${font}:text='${esc(label)}':fontsize=44:fontcolor=0x0f4c5c:x=60:y=60`,
      `drawtext=fontfile=${font}:text='${esc(eq)}':fontsize=96:fontcolor=0x1b2430:x=(w-tw)/2:y=(h-th)/2`,
      `drawtext=fontfile=${font}:text='%{pts\\:hms}':fontsize=40:fontcolor=0x9a5b00:x=w-tw-60:y=h-90`].join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart',
    path.join(vids, name)]);
  return name;
}
function makeThumb(eq, color) {
  const name = crypto.randomBytes(12).toString('hex') + '.jpg';
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=1`, '-frames:v', '1',
    '-vf', `drawtext=fontfile=${font}:text='${eq.replace(/:/g, '\\:')}':fontsize=54:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`, path.join(imgs, name)]);
  return `/media/img/${name}`;
}

const plan = {
  10: [['Sets and intervals', [['Set notation', 'A ∪ B = {1, 2, 3}'], ['Intervals on the number line', '[−2, 5)']]], ['Linear equations', [['Solving ax + b = c', '3x + 4 = 19']]]],
  11: [['Functions', [['Domain and range', 'f(x) = √(x − 1)'], ['Composite functions', '(f ∘ g)(x)']]]],
  12: [['Sequences', [['Arithmetic sequences', 'aₙ = a₁ + (n − 1)d']]], ['Probability', [['Basic probability', 'P(A) = n(A) / n(S)']]]],
};
const colors = { 10: '0x0f766e', 11: '0x4338ca', 12: '0x9d174d' };
for (const [g, chapters] of Object.entries(plan)) {
  // Demo textbook record (clearly marked as a placeholder, verified only for testing).
  const tb = one('SELECT id FROM textbooks WHERE grade = ?', Number(g));
  run(`UPDATE textbooks SET title = ?, language = 'Kurdish (Badini)', edition = 'DEMO edition', publication_year = '2025', academic_year = '2025–2026',
       review_status = 'verified', published = 1, is_active = 1 WHERE id = ?`, `[DEMO] Grade ${g} Literary Mathematics`, tb.id);
  chapters.forEach(([ct, lessons], ci) => {
    const ch = run('INSERT INTO chapters (grade, title, sort, published) VALUES (?, ?, ?, 1)', Number(g), ct, ci);
    lessons.forEach(([lt, eq], li) => {
      const secs = 40 + li * 10;
      const v = makeVideo(`Grade ${g} · ${lt}`, eq, secs);
      const l = run(`INSERT INTO lessons (chapter_id, title, description, duration_seconds, thumbnail, video_provider, video_id, video_status, published, sort)
        VALUES (?, ?, ?, ?, ?, 'local', ?, 'ready', 1, ?)`, Number(ch.lastInsertRowid), lt,
        `Worked example: $${eq}$\nPractise the exercises from the textbook, then rewatch the tricky step.\n$$${eq}$$`, secs, makeThumb(eq, colors[g]), v, li);
      run(`INSERT INTO lesson_refs (lesson_id, textbook_id, chapter, section, pages, exercises, reviewed) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        Number(l.lastInsertRowid), tb.id, `${ci + 1}`, `${ci + 1}.${li + 1}`, `${12 + li * 4}–${15 + li * 4}`, '1–6');
    });
  });
}
const demo = makeVideo('Free demo · 2 minutes', 'x² − 5x + 6 = 0', 20);
setSetting('demo', { provider: 'local', video_id: demo, title: 'Free demo: factorising a quadratic', duration_seconds: 20, published: true, thumbnail: makeThumb('x² − 5x + 6 = 0', '0x0f4c5c') });
const s = getSettings();
if (!s.price_iqd) setSetting('price_iqd', 75000);
if (!s.whatsapp_number) setSetting('whatsapp_number', '9647500000000');
setSetting('teacher_name', s.teacher_name === '[Teacher Name]' ? '[Teacher Name]' : s.teacher_name);
setSetting('teacher_intro', 'Demo introduction: I teach Literary-track mathematics in Duhok. Short, clear lessons that follow the KRG textbook page by page.');
console.log('Demo content created.');
