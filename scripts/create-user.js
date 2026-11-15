// Uso: node scripts/create-user.js <usuario> [contraseña]
// Si no se pasa contraseña, se genera una segura y se muestra una sola vez.
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/auth.js';

const [username, given] = process.argv.slice(2);
if (!username) {
  console.error('Uso: node scripts/create-user.js <usuario> [contraseña]');
  process.exit(1);
}
const password = given || crypto.randomBytes(12).toString('base64url');
const db = openDb(path.join(config.dataDir, 'selah.db'));
db.prepare(
  'INSERT INTO users (username, pass_hash) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET pass_hash = excluded.pass_hash',
).run(username, hashPassword(password));
db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(username);
console.log(`Usuario listo: ${username}`);
if (!given) console.log(`Contraseña: ${password}`);
