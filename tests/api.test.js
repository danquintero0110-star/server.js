import { dataDir, fakeAnthropic, SAMPLE_SEGMENTS } from './helpers.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { createQueue, deps } from '../src/lib/pipeline.js';
import { hashPassword } from '../src/lib/auth.js';
import { setClient } from '../src/providers/ai.js';

const db = openDb(path.join(dataDir, 'selah.db'), { bibleFile: config.bibleFile });
const queue = createQueue(db, { log: { error() {}, warn() {} } });
const app = buildApp({ db, queue });
const anthropic = fakeAnthropic();
let cookie = '';

// Sustitutos de ffmpeg/yt-dlp y del proveedor de transcripción.
deps.media = {
  ...deps.media,
  ensurePlayable: async (input) => ({ file: path.basename(input), mime: 'audio/webm' }),
  probeDuration: async () => 240,
  toTranscriptionAudio: async (input, output) => fs.copyFileSync(input, output),
  downloadYoutube: async (vid, dir, id) => {
    const file = path.join(dir, `${id}.m4a`);
    fs.writeFileSync(file, 'audio');
    return { file, mime: 'audio/mp4', title: 'Culto dominical', duration: 240, uploader: 'Iglesia', date: '2026-11-08' };
  },
};
deps.stt = { transcribe: async () => ({ provider: 'deepgram', segments: SAMPLE_SEGMENTS, duration: 240, costUsd: 0.02 }) };

async function waitReady(id) {
  for (let i = 0; i < 100; i++) {
    const r = await app.inject({ url: `/api/notes/${id}`, headers: { cookie } });
    const n = r.json();
    if (n.status === 'ready' || n.status === 'error') return n;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

function multipart(fields, file) {
  const boundary = '----selah' + Date.now();
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`);
  const body = Buffer.concat([Buffer.from(chunks.join('')), file.data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

before(async () => {
  setClient(anthropic);
  db.prepare('INSERT INTO users (username, pass_hash) VALUES (?, ?)').run('danny', hashPassword('clave-de-prueba'));
  await app.ready();
});
after(() => app.close());

test('la API exige sesión', async () => {
  assert.equal((await app.inject({ url: '/api/notes' })).statusCode, 401);
  for (const url of ['/%61pi/notes', '/api/%6eotes', '/api/notes?x=/api/login', '/api/login/../notes', '/%61pi/folders']) {
    const r = await app.inject({ url });
    assert.ok(r.statusCode === 401 || r.statusCode === 404, `${url} → ${r.statusCode}`);
    assert.doesNotMatch(r.body, /"id"/);
  }
  assert.equal((await app.inject({ url: '/api/health' })).statusCode, 200);
});

test('el freno de login no se salta cambiando X-Forwarded-For', async () => {
  let last;
  for (let i = 0; i < 9; i++) {
    last = await app.inject({ method: 'POST', url: '/api/login', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': `6.6.6.${i}, 9.9.9.9` }, payload: { username: 'danny', password: 'x' } });
  }
  assert.equal(last.statusCode, 429);
});

test('login rechaza clave mala y acepta la buena', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'danny', password: 'x' } });
  assert.equal(bad.statusCode, 401);
  const ok = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'Danny', password: 'clave-de-prueba' } });
  assert.equal(ok.statusCode, 200);
  const c = ok.cookies.find((c) => c.name === 'selah_sid');
  assert.ok(c.httpOnly);
  cookie = `selah_sid=${c.value}`;
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).json().bible.id, 'RV1909');
});

let noteId;
test('subir audio procesa la nota de punta a punta', async () => {
  const folder = (await app.inject({ method: 'POST', url: '/api/folders', headers: { cookie }, payload: { name: 'Domingos' } })).json();
  const { body, headers } = multipart(
    { source: 'record', preachedAt: '2026-11-15', folderId: folder.id },
    { name: 'grabacion.webm', type: 'audio/webm', data: Buffer.from('fake-webm-audio') },
  );
  const r = await app.inject({ method: 'POST', url: '/api/notes', headers: { ...headers, cookie }, body });
  assert.equal(r.statusCode, 201, r.body);
  noteId = r.json().id;
  const n = await waitReady(noteId);
  assert.equal(n.status, 'ready', n.error);
  assert.equal(n.title, 'Fe que camina sobre el agua');
  assert.equal(n.folderId, folder.id);
  assert.equal(n.transcript.length, 4);
  assert.deepEqual(
    n.analysis.verses.map((v) => v.reference),
    ['Mateo 14:29-31', 'Juan 3:16'],
  );
  assert.equal(n.analysis.devotional[0].reference, 'Salmos 23:1');
  assert.ok(n.cost.transcription > 0 && n.cost.analysis > 0);
  // La IA recibió la transcripción con marcas de tiempo y la fecha del servicio.
  const prompt = anthropic.calls[0].messages[0].content;
  assert.match(prompt, /Fecha del servicio: 2026-11-15/);
  assert.match(prompt, /\[3:20\] Porque de tal manera/);
  assert.equal(anthropic.calls[0].output_config.format.type, 'json_schema');
});

test('subida por partes: reanuda, rechaza posiciones malas y crea la nota', async () => {
  const data = Buffer.alloc(20 * 1024 * 1024 + 123, 7);
  const start = await app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie }, payload: { size: data.length, mime: 'video/mp4', name: 'culto.mp4', source: 'upload', preachedAt: '2026-11-15' } });
  assert.equal(start.statusCode, 200, start.body);
  const { id, chunkSize } = start.json();
  const put = (offset, buf) =>
    app.inject({ method: 'PUT', url: `/api/uploads/${id}?offset=${offset}`, headers: { cookie, 'content-type': 'application/octet-stream' }, body: buf });
  // Terminar antes de tiempo no se permite.
  assert.equal((await app.inject({ method: 'POST', url: `/api/uploads/${id}/finish`, headers: { cookie } })).statusCode, 409);
  let r = await put(0, data.subarray(0, chunkSize));
  assert.equal(r.json().offset, chunkSize);
  // Reenviar la misma parte (p. ej. tras perder la respuesta) responde 409 con la posición real.
  r = await put(0, data.subarray(0, chunkSize));
  assert.equal(r.statusCode, 409);
  assert.equal((await app.inject({ url: `/api/uploads/${id}`, headers: { cookie } })).json().offset, chunkSize);
  // Una parte de más de 16 MB se rechaza.
  assert.equal((await put(chunkSize, Buffer.alloc(17 * 1024 * 1024))).statusCode, 413);
  for (let o = chunkSize; o < data.length; o += chunkSize) {
    r = await put(o, data.subarray(o, o + chunkSize));
    assert.equal(r.statusCode, 200, r.body);
  }
  const fin = await app.inject({ method: 'POST', url: `/api/uploads/${id}/finish`, headers: { cookie } });
  assert.equal(fin.statusCode, 201, fin.body);
  const n = await waitReady(fin.json().id);
  assert.equal(n.status, 'ready', n.error);
  assert.equal(n.sourceType, 'upload');
  assert.equal(n.preachedAt, '2026-11-15');
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 0);
  await app.inject({ method: 'DELETE', url: `/api/notes/${n.id}`, headers: { cookie } });
});

test('subida por partes: límites de tamaño, tipo y espacio en disco', async () => {
  const post = (payload) => app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie }, payload });
  assert.equal((await post({ size: 3 * 1024 ** 3, mime: 'audio/wav' })).statusCode, 413);
  assert.equal((await post({ size: 100, mime: 'image/png' })).statusCode, 400);
  assert.equal((await post({ size: 0, mime: 'audio/wav' })).statusCode, 400);
  const prev = config.minFreeMb;
  config.minFreeMb = 1e12;
  try {
    assert.equal((await post({ size: 100, mime: 'audio/wav' })).statusCode, 507);
  } finally {
    config.minFreeMb = prev;
  }
  assert.equal((await app.inject({ method: 'PUT', url: '/api/uploads/nope?offset=0', headers: { cookie, 'content-type': 'application/octet-stream' }, body: 'x' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/uploads', payload: { size: 1 } })).statusCode, 401);
});

test('el audio se sirve con soporte de rangos', async () => {
  const r = await app.inject({ url: `/api/notes/${noteId}/audio`, headers: { cookie, range: 'bytes=0-3' } });
  assert.equal(r.statusCode, 206);
  assert.equal(r.body, 'fake');
});

test('búsqueda entre notas sin importar acentos', async () => {
  const r = await app.inject({ url: '/api/notes?q=transcripcion%20tormenta', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  const r2 = (await app.inject({ url: '/api/notes?q=destino', headers: { cookie } })).json();
  assert.equal(r2.length, 1);
  assert.match(r2[0].snippet, /\[\[destino\]\]/);
  const r3 = (await app.inject({ url: '/api/notes?q=jovenes', headers: { cookie } })).json();
  assert.equal(r3.length, 1, 'quita diacríticos');
});

test('versículo al tocar la cita', async () => {
  const r = (await app.inject({ url: '/api/bible?ref=Mateo%2014:29-31', headers: { cookie } })).json();
  assert.equal(r.verses.length, 3);
  assert.equal(r.versionName, 'Reina-Valera 1909');
});

test('exportar WhatsApp y PDF', async () => {
  const w = (await app.inject({ url: `/api/notes/${noteId}/whatsapp`, headers: { cookie } })).json();
  assert.match(w.summary, /\*Fe que camina sobre el agua\*/);
  assert.match(w.announcements, /Retiro de jóvenes/);
  assert.match(w.announcements, /sábado 21 de noviembre · 6:00 p\. m\./);
  const pdf = await app.inject({ url: `/api/notes/${noteId}/export.pdf`, headers: { cookie } });
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.rawPayload.length > 5000);
});

test('estudio desarrollado: versículos resueltos, costo guardado y sin pagar dos veces', async () => {
  const n = (await app.inject({ url: `/api/notes/${noteId}`, headers: { cookie } })).json();
  const st = n.analysis.study;
  assert.ok(st, 'el estudio se genera tras el análisis');
  assert.deepEqual(
    st.points[0].verses.map((v) => [v.reference, v.role]),
    [['Mateo 14:29-31', 'citado'], ['Salmos 46:1', 'complementario']],
  );
  assert.equal(st.memory_verse.reference, 'Juan 3:16');
  assert.ok(n.cost.study > 0);
  const before = anthropic.calls.filter((c) => c.output_config?.format?.schema?.properties?.introduction).length;
  const pdf = await app.inject({ url: `/api/notes/${noteId}/export.pdf`, headers: { cookie } });
  assert.equal(pdf.statusCode, 200);
  const after = anthropic.calls.filter((c) => c.output_config?.format?.schema?.properties?.introduction).length;
  assert.equal(after, before);
  // Si el estudio falta (nota anterior a esta función), el PDF lo genera al pedirlo.
  const row = db.prepare('SELECT analysis_json FROM notes WHERE id = ?').get(noteId);
  const a = JSON.parse(row.analysis_json);
  delete a.study;
  db.prepare('UPDATE notes SET analysis_json = ? WHERE id = ?').run(JSON.stringify(a), noteId);
  const pdf2 = await app.inject({ url: `/api/notes/${noteId}/export.pdf`, headers: { cookie } });
  assert.equal(pdf2.statusCode, 200);
  assert.ok(JSON.parse(db.prepare('SELECT analysis_json FROM notes WHERE id = ?').get(noteId).analysis_json).study);
});

test('chat sobre la nota con streaming y memoria', async () => {
  const r = await app.inject({ method: 'POST', url: `/api/notes/${noteId}/chat`, headers: { cookie }, payload: { question: '¿Por qué se hundió Pedro?' } });
  assert.match(r.body, /event: delta/);
  assert.match(r.body, /event: done/);
  const call = anthropic.calls.at(-1);
  assert.equal(call.system[1].cache_control.type, 'ephemeral');
  assert.match(call.system[1].text, /Pedro|Mateo/);
  const hist = (await app.inject({ url: `/api/notes/${noteId}/chat`, headers: { cookie } })).json();
  assert.equal(hist.length, 2);
  assert.equal(hist[1].role, 'assistant');
});

test('voz: escuchar un clip y responder en modo voz y devocional', async () => {
  const r = await app.inject({
    method: 'POST',
    url: `/api/notes/${noteId}/listen`,
    headers: { cookie, 'content-type': 'application/octet-stream', 'x-audio-mime': 'audio/webm' },
    body: Buffer.alloc(4000, 1),
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.json().text, /retiro de jóvenes/);
  // Clip vacío o casi vacío: sin texto y sin pagar.
  const empty = await app.inject({ method: 'POST', url: `/api/notes/${noteId}/listen`, headers: { cookie, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(10) });
  assert.equal(empty.json().text, '');
  const bad = await app.inject({ method: 'POST', url: `/api/notes/${noteId}/listen`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-audio-mime': 'text/html' }, body: Buffer.alloc(4000) });
  assert.equal(bad.statusCode, 400);
  const big = await app.inject({ method: 'POST', url: `/api/notes/${noteId}/listen`, headers: { cookie, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(7 * 1024 * 1024) });
  assert.equal(big.statusCode, 413);

  await app.inject({ method: 'POST', url: `/api/notes/${noteId}/chat`, headers: { cookie }, payload: { question: 'Hola', mode: 'voz' } });
  let sys = anthropic.calls.at(-1).system.map((b) => b.text).join('\n');
  assert.match(sys, /MODO VOZ/);
  assert.doesNotMatch(sys, /DEVOCIONAL GUIADO/);
  await app.inject({ method: 'POST', url: `/api/notes/${noteId}/chat`, headers: { cookie }, payload: { question: 'Siento paz', mode: 'devocional', day: 2 } });
  sys = anthropic.calls.at(-1).system.map((b) => b.text).join('\n');
  assert.match(sys, /DEVOCIONAL GUIADO: estás acompañando a la persona en el día 2/);
  await app.inject({ method: 'POST', url: `/api/notes/${noteId}/chat`, headers: { cookie }, payload: { question: 'Texto normal' } });
  sys = anthropic.calls.at(-1).system.map((b) => b.text).join('\n');
  assert.doesNotMatch(sys, /MODO VOZ/);
});

test('nota desde YouTube', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/notes', headers: { cookie }, payload: { youtubeUrl: 'https://vimeo.com/1' } });
  assert.equal(bad.statusCode, 400);
  const r = await app.inject({ method: 'POST', url: '/api/notes', headers: { cookie }, payload: { youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' } });
  const n = await waitReady(r.json().id);
  assert.equal(n.status, 'ready', n.error);
  assert.equal(n.preachedAt, '2026-11-08');
  const analysisCall = anthropic.calls.findLast((c) => c.output_config?.format && !c.output_config.format.schema?.properties?.introduction);
  assert.match(analysisCall.messages[0].content, /YouTube "Culto dominical"/);
});

test('errores del proceso quedan visibles y se puede reintentar', async () => {
  const original = deps.stt.transcribe;
  deps.stt.transcribe = async () => {
    throw new Error('Deepgram respondió 401');
  };
  const { body, headers } = multipart({ source: 'upload' }, { name: 'a.mp3', type: 'audio/mpeg', data: Buffer.from('x') });
  const id = (await app.inject({ method: 'POST', url: '/api/notes', headers: { ...headers, cookie }, body })).json().id;
  const n = await waitReady(id);
  assert.equal(n.status, 'error');
  assert.match(n.error, /401/);
  deps.stt.transcribe = original;
  await app.inject({ method: 'POST', url: `/api/notes/${id}/reprocess`, headers: { cookie }, payload: {} });
  assert.equal((await waitReady(id)).status, 'ready');
});

test('borrar nota elimina audio y búsqueda', async () => {
  const n = (await app.inject({ url: `/api/notes/${noteId}`, headers: { cookie } })).json();
  assert.ok(n.hasAudio);
  await app.inject({ method: 'DELETE', url: `/api/notes/${noteId}`, headers: { cookie } });
  assert.equal((await app.inject({ url: `/api/notes/${noteId}`, headers: { cookie } })).statusCode, 404);
  const left = (await app.inject({ url: '/api/notes?q=destino', headers: { cookie } })).json();
  assert.ok(!left.some((x) => x.id === noteId));
  assert.ok(!fs.existsSync(path.join(dataDir, 'audio', `${noteId}.src.webm`)));
});

test('la SPA responde en rutas del cliente', async () => {
  const r = await app.inject({ url: '/nota/abc' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
});
