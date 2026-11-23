# Wezhay / Adabi Mathematics — course website

Mobile-first site for a Duhok mathematics teacher: KRG Literary (Wezhay / Adabi) track, Grades 10, 11 and 12.
One student account type, one paid course split into three grade sections, manual FIB payment approval through WhatsApp.

- **Zero dependencies.** Node.js 22.5+ only (built-in SQLite). No `npm install` needed.
- **Responsive** for phones, tablets and computers, portrait and landscape; touch, mouse and keyboard; right-to-left Kurdish.
- **Private video**: Cloudflare Stream signed tokens (recommended) or private files on the server.

## Run it locally

```bash
cp .env.example .env            # for a quick local try, set EMAIL_PROVIDER=console and VIDEO_PROVIDER=local, BASE_URL=http://localhost:3000, NODE_ENV=development
npm run create-admin -- teacher@example.com "Teacher Name"
npm run seed-demo               # optional, test data only (needs ffmpeg) — never on the live site
npm start                       # http://localhost:3000
```

Sign in with the teacher account and go to **Teacher dashboard**. In test mode emails (verification, reset, approval) appear under **Test emails**.

## Go live checklist

1. Host on any Node 22 server with a persistent disk (Render, Railway, Fly.io, a VPS). Put it behind HTTPS (Cloudflare or the host's TLS) and set `BASE_URL`, `NODE_ENV=production` and `TRUST_PROXY` (`cloudflare` behind Cloudflare, `1` behind nginx/Render).
2. **Cloudflare Stream**: create an API token with *Stream: Edit*, create a signing key (`POST /accounts/{account_id}/stream/keys`), and fill the `CF_*` variables. Uploads from the dashboard go directly to Cloudflare with `requireSignedURLs` on; the server signs a fresh token (default 10 minutes) for every playback after checking the student's access. Note: a Cloudflare token is not tied to one student, so after a revoke an already-issued token can play until it expires; local-provider streams stop immediately.
3. **Email**: create a Resend account, verify your domain, set `RESEND_API_KEY` and `EMAIL_FROM`.
4. In the dashboard → **Settings**: teacher name, photo, introduction, price in IQD, grades included, access period, WhatsApp number, message wording, demo video.
5. **Textbooks**: review the private candidate links, check covers/editions against the books students use in Duhok (Grade 10 was revised for 2025–2026), fill in each record, mark it *Verified*, publish, then make it the active edition.
6. **Site wording**: confirm the Kurdish text with the teacher before switching the site language.
7. Back up `DATA_DIR` (database + images + PDFs, and videos if using the local provider).

## How the payment flow works

1. A verified student taps **Pay via WhatsApp**. The server creates (or reuses) one pending request with a reference like `MA-7KQM-4XPT`.
2. WhatsApp opens with an editable message containing the price and the reference. The teacher's number and the reference are always shown on screen, with Copy / Share buttons, so a student without WhatsApp — or a parent paying from another phone — can continue elsewhere.
3. The teacher sends FIB payment instructions, checks the money arrived in FIB, searches the reference in **Enrollments**, and approves. Opening WhatsApp never grants access.
4. The student gets an approval email with a link to the course. Revoking or expiry stops new playback tokens immediately (and, for local video, the open stream). A new request after approval closes any older open request so each student has one current enrollment.

The site never asks for, stores or transmits banking credentials, PINs or verification codes.

## Tests

```bash
npm run test:devices   # Playwright: 15 device profiles, full student/teacher flows, access control (needs ffmpeg + playwright)
```

Results and screenshots go to `tests/output/`. These use Chromium with device emulation; see **TESTING.md** for the hands-on pass on real iPhones, iPads and Android phones that emulation cannot replace.

## Project layout

```
server.js            HTTP server, security headers, CSRF origin check, static files
lib/                 config, database, auth, access rules, video providers, email
routes/public.js     catalog, lessons, playback, auth, student enrollment
routes/admin.js      teacher dashboard API (role checked on every route)
public/              single-page front end (no build step)
scripts/             create-admin, seed-demo
tests/devices.mjs    cross-device end-to-end test run
```
