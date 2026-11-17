import crypto from 'node:crypto';

const SESSION_DAYS = 60;
export const COOKIE = 'selah_sid';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function sessionUser(db, token) {
  if (!token) return null;
  return (
    db
      .prepare('SELECT u.id, u.username, u.is_admin AS isAdmin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
      .get(sha(token), Date.now()) || null
  );
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

/** Freno simple contra fuerza bruta: 8 intentos fallidos por IP cada 15 min. */
const attempts = new Map();
export function loginAllowed(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > 15 * 60_000) return true;
  return a.count < 8;
}
export function loginFailed(ip) {
  if (attempts.size > 5000) for (const [k, v] of attempts) if (Date.now() - v.first > 15 * 60_000) attempts.delete(k);
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > 15 * 60_000) attempts.set(ip, { first: Date.now(), count: 1 });
  else a.count++;
}
export function loginSucceeded(ip) {
  attempts.delete(ip);
}

/** Contraseña aleatoria fácil de dictar (sin caracteres confusos). */
export function randomPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(12);
  return Array.from(b, (x) => abc[x % abc.length]).join('');
}
