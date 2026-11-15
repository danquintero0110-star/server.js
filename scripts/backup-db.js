// Respaldo en caliente de la base de datos (seguro con el servicio corriendo).
// Uso: node scripts/backup-db.js <carpeta> [--keep 14]
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';

const dir = process.argv[2] || path.join(config.dataDir, 'backups');
const keep = Number(process.argv[process.argv.indexOf('--keep') + 1]) || 14;
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const file = path.join(dir, `selah-${stamp}.db`);
const db = new Database(path.join(config.dataDir, 'selah.db'), { readonly: true });
await db.backup(file);
db.close();
const old = fs.readdirSync(dir).filter((f) => /^selah-.*\.db$/.test(f)).sort().reverse().slice(keep);
old.forEach((f) => fs.rmSync(path.join(dir, f)));
console.log(file);
