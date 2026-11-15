// Prueba de punta a punta contra un servidor real (proveedores reales, sin simulaciones).
// Uso:
//   SELAH_URL=https://selah.orbitix.app SELAH_USER=danny SELAH_PASS=... node scripts/e2e.js [--file audio.mp3 | --youtube URL]
// Sin --file ni --youtube, sintetiza una mini prédica en español con espeak-ng (o ffmpeg flite)
// que incluye anuncios y citas bíblicas, y verifica cada resultado.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.SELAH_URL || 'http://127.0.0.1:3070').replace(/\/$/, '');
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : '';
};

const SCRIPT = `Buenos días iglesia. Antes de comenzar, un anuncio importante: este sábado a las seis de la tarde tenemos el retiro de jóvenes en el salón principal. Inscríbanse con el hermano Carlos.
Ahora abramos la Biblia en el evangelio de Mateo, capítulo catorce, versículos veintinueve al treinta y uno.
Pedro bajó de la barca y caminó sobre las aguas para ir a Jesús. Pero cuando vio el viento fuerte, tuvo miedo y comenzó a hundirse.
Primer punto: la tormenta no significa que Dios se fue. Segundo punto: Jesús te llama a salir de la barca. Tercer punto: mantén tus ojos en Jesús.
Escuchen bien: el viento no decide tu destino, Jesús sí.
Como dice Juan capítulo tres, versículo dieciséis: porque de tal manera amó Dios al mundo que ha dado a su Hijo unigénito.
Y el Salmo veintitrés, versículo uno, nos recuerda: el Señor es mi pastor, nada me faltará.
Esta semana, cada mañana, antes de mirar el celular, ora cinco minutos y entrega tu tormenta a Dios. Amén.`;

function synth(dir) {
  const wav = path.join(dir, 'predica.wav');
  const out = path.join(dir, 'predica.mp3');
  try {
    execFileSync('espeak-ng', ['-v', 'es-419', '-s', '150', '-w', wav, SCRIPT]);
  } catch {
    execFileSync('espeak', ['-v', 'es', '-s', '150', '-w', wav, SCRIPT]);
  }
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', wav, '-ac', '1', '-b:a', '64k', out]);
  return out;
}

let cookie = '';
async function call(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, { method, body, headers: { ...headers, cookie } });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data.error || ''}`);
  return data;
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const t0 = Date.now();
await call('POST', '/api/login', JSON.stringify({ username: process.env.SELAH_USER, password: process.env.SELAH_PASS }), {
  'content-type': 'application/json',
});
check('login', true);

let note;
if (arg('--youtube')) {
  note = await call('POST', '/api/notes', JSON.stringify({ youtubeUrl: arg('--youtube') }), { 'content-type': 'application/json' });
} else {
  const file = arg('--file') || synth(fs.mkdtempSync(path.join(os.tmpdir(), 'selah-e2e-')));
  const fd = new FormData();
  fd.append('source', 'upload');
  fd.append('preachedAt', '2026-11-15');
  fd.append('title', '');
  fd.append('audio', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), path.basename(file));
  note = await call('POST', '/api/notes', fd);
}
check('nota creada', Boolean(note.id), note.id);

let last = '';
for (;;) {
  note = await call('GET', `/api/notes/${note.id}`);
  if (note.status !== last) console.log(`  … ${note.status} (${Math.round((Date.now() - t0) / 1000)} s)`);
  last = note.status;
  if (note.status === 'ready' || note.status === 'error') break;
  await new Promise((r) => setTimeout(r, 3000));
}
check('procesada', note.status === 'ready', note.error);
if (note.status !== 'ready') process.exit(1);

const a = note.analysis;
check('transcripción con marcas de tiempo', note.transcript.length > 0 && note.transcript.every((s) => typeof s.start === 'number'), `${note.transcript.length} fragmentos`);
check('título sugerido', Boolean(note.title), note.title);
check('resumen estructurado', a.central_idea && a.main_points.length >= 2 && a.practical_application.length >= 1, a.central_idea);
check('frases fuertes', a.strong_quotes.length >= 1);
const refs = a.verses.map((v) => v.reference);
check('versículos detectados', refs.length >= 1, refs.join(' · '));
if (!arg('--file') && !arg('--youtube')) {
  check('Mateo 14 detectado', refs.some((r) => r.startsWith('Mateo 14')));
  check('Juan 3:16 detectado', refs.includes('Juan 3:16'));
  check('anuncio del retiro con hora y lugar', a.announcements.some((x) => /retiro/i.test(x.title) && x.time === '18:00' && x.place), JSON.stringify(a.announcements[0] || {}));
}
const v0 = a.verses[0];
if (v0) {
  const p = await call('GET', `/api/bible?code=${v0.code}&chapter=${v0.chapter}&from=${v0.verse_start}&to=${v0.verse_end}`);
  check('texto bíblico al tocar la cita', p.verses.length > 0, `${p.reference} (${p.version})`);
}
check('preguntas de célula + tarea', a.cell_questions.length >= 3 && Boolean(a.weekly_task.title));
check('devocional de 5 días', a.devotional.length === 5);
check('frases para redes', a.social_quotes.length >= 3);
const w = await call('GET', `/api/notes/${note.id}/whatsapp`);
check('texto para WhatsApp', w.summary.includes(note.title));
const pdf = await fetch(`${BASE}/api/notes/${note.id}/export.pdf`, { headers: { cookie } });
check('PDF', pdf.ok && (await pdf.arrayBuffer()).byteLength > 1000);
const audio = await fetch(`${BASE}/api/notes/${note.id}/audio`, { headers: { cookie, range: 'bytes=0-99' } });
check('audio reproducible por rangos', audio.status === 206);
const search = await call('GET', `/api/notes?q=${encodeURIComponent(note.title.split(' ')[0])}`);
check('búsqueda', search.some((n) => n.id === note.id));
const chat = await fetch(`${BASE}/api/notes/${note.id}/chat`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ question: '¿Cuál es la idea central en una frase?' }),
});
const sse = await chat.text();
check('chat sobre la nota', /event: done/.test(sse), (/"text":"([^"]{0,90})/.exec(sse.split('event: done')[1] || '') || [])[1]);

const cost = await call('GET', `/api/notes/${note.id}`).then((n) => n.cost);
console.log(`\nCosto real de esta nota: ${JSON.stringify(cost)} · ${Math.round(note.durationSec)} s de audio · ${Math.round((Date.now() - t0) / 1000)} s en total`);
console.log(`Nota: ${BASE}/nota/${note.id}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} verificación(es) fallaron` : '\nTodo en verde');
process.exit(failed ? 1 : 0);
