# Real-device test checklist

The automated run (`npm run test:devices`) uses Chromium with phone/tablet emulation. It checks layout,
flows and access rules, but it is **not** Safari: iOS/iPadOS Safari, the WhatsApp app hand-off, native
fullscreen and real network drops must be checked by hand on the live (HTTPS) site before launch.

Use two accounts: the teacher account and a new student account. Use the live Cloudflare Stream setup.
Tick each box per device.

| # | Check | iPhone Safari | iPad Safari | Android Chrome | Win Chrome | Win Edge | Mac Safari | Mac Chrome |
|---|-------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 1 | Home page readable in portrait **and** landscape; no sideways scrolling | | | | | | | |
| 2 | Register → verification email arrives → link opens and verifies | | | | | | | |
| 3 | Sign in from a locked lesson returns to that lesson | | | | | | | |
| 4 | Forgot password → email → new password works; link can't be reused | | | | | | | |
| 5 | Enroll page shows price (IQD), grades included, access period, teacher's WhatsApp number | | | | | | | |
| 6 | **Pay via WhatsApp** opens the WhatsApp app (phones) / WhatsApp Web or desktop app (computers) with the message prefilled and editable | | | | | | | |
| 7 | Same test on a device **without WhatsApp**: wa.me page appears; back on the site the number + reference are visible and copyable; "Send to a parent" shares the details | | | | | | | |
| 8 | Tap Pay again → same reference (check in dashboard: one request, opened 2×) | | | | | | | |
| 9 | Paid lesson locked before approval | | | | | | | |
| 10 | Teacher approves (on desktop **and** on iPad) → student sees "Access granted", gets email | | | | | | | |
| 11 | Lesson plays; equations/handwriting legible on the smallest phone | | | | | | | |
| 12 | Fullscreen: rotate phone to landscape, video fills the screen; exit works | | | | | | | |
| 13 | Close the tab mid-lesson, reopen → "Resume from m:ss" continues at that point | | | | | | | |
| 14 | Airplane mode for 10 s while playing → "Connection lost" → turn it off → continues at the same second | | | | | | | |
| 15 | Textbooks page: correct title/edition/year; official link opens | | | | | | | |
| 16 | Kurdish (RTL) wording reads correctly; equations stay left-to-right | | | | | | | |
| 17 | Teacher uploads a video (desktop + iPad), sets thumbnail, maps textbook pages, publishes | | | | | | | |
| 18 | Teacher revokes → student's video stops playing on next load; student sees "Access revoked" | | | | | | | |
| 19 | Keyboard only (computers): Tab through menu, forms, dashboard; Space/←/→/F in the player | | | | | | | |

With the teacher, preview one real lesson and the textbook record for each grade and confirm grade,
Literary track, language/dialect, edition and source link before publishing (Grade 10 especially — it was
revised for 2025–2026). Then ask a few students to: find their grade, identify their textbook, open the
correct lesson, and resume after losing connection.
