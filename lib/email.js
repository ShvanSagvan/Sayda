import { config } from './config.js';
import { run } from './db.js';

// Sends transactional email. "console" mode stores messages in email_outbox and
// prints them (for local testing). "resend" uses the Resend HTTP API.
export async function sendEmail(to, subject, text) {
  if (config.email.provider === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.email.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.email.from, to: [to], subject, text }),
    });
    if (!r.ok) console.error('[email] send failed', r.status, await r.text().catch(() => ''));
    return r.ok;
  }
  run('INSERT INTO email_outbox (to_email, subject, body) VALUES (?, ?, ?)', to, subject, text);
  if (!process.env.QUIET) console.log(`[email:console] to=${to} subject="${subject}"\n${text}\n`);
  return true;
}

const link = (p) => `${config.baseUrl}${p}`;

export const emails = {
  reset: (u, token, course) => sendEmail(u.email, `Reset your password — ${course}`,
    `Hello ${u.name},\n\nUse this link to choose a new password:\n${link('/reset?token=' + token)}\n\nThe link expires in 1 hour and can be used once. If you did not ask for this, you can ignore this email.`),
  approved: (u, enr, course, gradesText, expiresText) => sendEmail(u.email, `Access granted — ${course}`,
    `Hello ${u.name},\n\nYour payment was confirmed and your access to ${course} is now active.\n\nIncluded: ${gradesText}\nAccess: ${expiresText}\nEnrollment reference: ${enr.reference}\n\nStart learning:\n${link('/course')}\n`),
};
