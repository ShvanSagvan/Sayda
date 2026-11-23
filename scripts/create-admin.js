// Create or promote the teacher's super-admin account.
// Usage: npm run create-admin -- teacher@example.com "Teacher Name"
// The password is read from the ADMIN_PASSWORD environment variable or prompted for.
import readline from 'node:readline';
import { one, run, nowIso } from '../lib/db.js';
import { hashPassword, normalizeEmail, validatePassword } from '../lib/auth.js';

const email = normalizeEmail(process.argv[2]);
const name = process.argv[3] || 'Teacher';
if (!email) { console.error('Usage: npm run create-admin -- <email> "<name>"'); process.exit(1); }

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}
const pw = process.env.ADMIN_PASSWORD || await ask('Password (min 8 characters): ');
const err = validatePassword(pw);
if (err) { console.error(err); process.exit(1); }
const hash = await hashPassword(pw);
const existing = one('SELECT * FROM users WHERE email = ?', email);
if (existing) {
  run(`UPDATE users SET role = 'admin', password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`, hash, nowIso(), existing.id);
  console.log(`Promoted ${email} to teacher super-admin.`);
} else {
  run(`INSERT INTO users (name, email, password_hash, role, email_verified_at) VALUES (?, ?, ?, 'admin', ?)`, name, email, hash, nowIso());
  console.log(`Created teacher super-admin ${email}.`);
}
