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
import { createPush, devotionalDay, localNow } from '../src/lib/push.js';

const db = openDb(path.join(dataDir, 'selah.db'), { bibleFile: config.bibleFile });
const queue = createQueue(db, { log: { error() {}, warn() {} } });
const pushSent = [];
const push = createPush(db, { log: { warn() {}, error() {} }, send: async (sub, payload) => pushSent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }) });
const app = buildApp({ db, queue, push });
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
  db.prepare('INSERT INTO users (username, pass_hash, is_admin) VALUES (?, ?, 1)').run('danny', hashPassword('clave-de-prueba'));
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

test('enfoques: la prédica aplicada a un área, guardada y sin pagar dos veces', async () => {
  const bad = await app.inject({ method: 'POST', url: `/api/notes/${noteId}/focus`, headers: { cookie }, payload: { area: '  ' } });
  assert.equal(bad.statusCode, 400);
  const r = await app.inject({ method: 'POST', url: `/api/notes/${noteId}/focus`, headers: { cookie }, payload: { area: 'Mi Trabajo' } });
  assert.equal(r.statusCode, 200, r.body);
  const { key, focus } = r.json();
  assert.equal(key, 'mi trabajo');
  assert.equal(focus.title, 'La fe en mi trabajo');
  assert.deepEqual(focus.verses.map((v) => v.reference), ['Colosenses 3:23']);
  const calls = anthropic.calls.length;
  const again = await app.inject({ method: 'POST', url: `/api/notes/${noteId}/focus`, headers: { cookie }, payload: { area: 'mi trabajo' } });
  assert.equal(again.json().focus.title, 'La fe en mi trabajo');
  assert.equal(anthropic.calls.length, calls, 'segunda vez sale de lo guardado');
  const n = (await app.inject({ url: `/api/notes/${noteId}`, headers: { cookie } })).json();
  assert.ok(n.analysis.focus['mi trabajo']);
  assert.ok(n.cost.focus > 0);
  await app.inject({ method: 'DELETE', url: `/api/notes/${noteId}/focus/mi%20trabajo`, headers: { cookie } });
  assert.equal((await app.inject({ url: `/api/notes/${noteId}`, headers: { cookie } })).json().analysis.focus['mi trabajo'], undefined);
});

test('mi marca: nombre, redes y logo', async () => {
  const b = (await app.inject({ method: 'PUT', url: '/api/me/brand', headers: { cookie }, payload: { name: 'Taller Quintero', handle: '@taller' } })).json();
  assert.equal(b.name, 'Taller Quintero');
  assert.equal((await app.inject({ url: '/api/me/logo', headers: { cookie } })).statusCode, 404);
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const up = await app.inject({ method: 'POST', url: '/api/me/logo', headers: { cookie, 'content-type': 'application/octet-stream', 'x-image-mime': 'image/png' }, body: png });
  assert.equal(up.statusCode, 200, up.body);
  assert.match(up.json().logo, /^png:/);
  const got = await app.inject({ url: '/api/me/logo', headers: { cookie } });
  assert.equal(got.statusCode, 200);
  assert.equal(got.rawPayload.length, png.length);
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).json().brand.name, 'Taller Quintero');
  assert.equal((await app.inject({ method: 'POST', url: '/api/me/logo', headers: { cookie, 'content-type': 'application/octet-stream', 'x-image-mime': 'image/gif' }, body: png })).statusCode, 400);
  await app.inject({ method: 'DELETE', url: '/api/me/logo', headers: { cookie } });
  assert.equal((await app.inject({ url: '/api/me/logo', headers: { cookie } })).statusCode, 404);
});

test('voz humana: lista de voces, audio con caché y límites', async () => {
  const voices = (await app.inject({ url: '/api/tts/voices', headers: { cookie } })).json();
  assert.equal(voices.default, 'valerio');
  assert.ok(voices.voices.some((v) => v.id === 'valerio' && v.gender === 'm'));
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.deepgram.com/v1/speak')) {
      seen.push({ url: String(url), body: JSON.parse(opts.body) });
      return new Response(Buffer.from('ID3fake-mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    return realFetch(url, opts);
  };
  try {
    const r = await app.inject({ method: 'POST', url: '/api/tts', headers: { cookie }, payload: { text: 'Hola, soy Selah.', voice: 'valerio', noteId } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['content-type'], 'audio/mpeg');
    assert.equal(r.body, 'ID3fake-mp3');
    assert.match(seen[0].url, /model=aura-2-valerio-es/);
    const again = await app.inject({ method: 'POST', url: '/api/tts', headers: { cookie }, payload: { text: 'Hola,   soy Selah.', voice: 'valerio' } });
    assert.equal(again.body, 'ID3fake-mp3');
    assert.equal(seen.length, 1, 'la segunda vez sale de la caché');
    await app.inject({ method: 'POST', url: '/api/tts', headers: { cookie }, payload: { text: 'Hola, soy Selah.', voice: 'no-existe' } });
    assert.equal(seen.length, 1, 'voz desconocida usa la predeterminada (ya en caché)');
    assert.equal((await app.inject({ method: 'POST', url: '/api/tts', headers: { cookie }, payload: { text: 'x'.repeat(1801) } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/tts', payload: { text: 'hola' } })).statusCode, 401);
    const n = (await app.inject({ url: `/api/notes/${noteId}`, headers: { cookie } })).json();
    assert.ok(n.cost.tts > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('voz de locutor (ElevenLabs) con respaldo de Deepgram si falla', async () => {
  const realFetch = globalThis.fetch;
  process.env.ELEVENLABS_API_KEY = 'test-eleven';
  let elevenOk = true;
  let lastBody = null;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.elevenlabs.io/')) {
      seen.push('eleven');
      lastBody = JSON.parse(opts.body);
      return elevenOk ? new Response(Buffer.from('ELEVEN-mp3'), { status: 200 }) : new Response('{"detail":"quota_exceeded"}', { status: 401 });
    }
    if (u.startsWith('https://api.deepgram.com/v1/speak')) {
      seen.push('deepgram');
      return new Response(Buffer.from('DG-mp3'), { status: 200 });
    }
    return realFetch(url, opts);
  };
  try {
    const voices = (await app.inject({ url: '/api/tts/voices', headers: { cookie } })).json();
    assert.equal(voices.default, 'selah');
    assert.ok(voices.voices.find((v) => v.id === 'selah').premium);
    assert.ok(!voices.voices.some((v) => v.id === 'faraon'), 'voces de biblioteca ocultas sin plan de pago');
    const r = await app.inject({ method: 'POST', url: '/api/tts', headers: { cookie }, payload: { text: 'La paz de Dios sea contigo.', prev: 'Hola, soy Selah.', next: 'Vamos a orar.' } });
    assert.equal(r.body, 'ELEVEN-mp3');
    assert.equal(lastBody.previous_text, 'Hola, soy Selah.');
    assert.equal(lastBody.next_text, 'Vamos a orar.');
    assert.equal(lastBody.model_id, 'eleven_v4');
    elevenOk = false;
    const fb = await app.inject({ method: 'POST', url: '/api/tts', headers: { cookie }, payload: { text: 'Otra frase distinta.', voice: 'selah' } });
    assert.equal(fb.statusCode, 200);
    assert.equal(fb.body, 'DG-mp3', 'sin créditos: suena Deepgram');
    elevenOk = true;
    const again = await app.inject({ method: 'POST', url: '/api/tts', headers: { cookie }, payload: { text: 'Otra frase distinta.', voice: 'selah' } });
    assert.equal(again.body, 'ELEVEN-mp3', 'el respaldo no se guardó en caché');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ELEVENLABS_API_KEY;
  }
  const v2 = (await app.inject({ url: '/api/tts/voices', headers: { cookie } })).json();
  assert.equal(v2.default, 'valerio');
  assert.ok(!v2.voices.some((v) => v.id === 'selah'), 'sin llave no se ofrecen voces de ElevenLabs');
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

test('cuentas separadas: nadie ve ni toca notas, carpetas ni subidas de otro', async () => {
  db.prepare('INSERT INTO users (username, pass_hash) VALUES (?, ?)').run('zabdi', hashPassword('otra-clave'));
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'zabdi', password: 'otra-clave' } });
  const other = login.headers['set-cookie'].split(';')[0];
  const mine = (await app.inject({ url: '/api/notes', headers: { cookie } })).json();
  assert.ok(mine.length > 0);
  assert.deepEqual((await app.inject({ url: '/api/notes', headers: { cookie: other } })).json(), []);
  assert.deepEqual((await app.inject({ url: '/api/notes?q=tormenta', headers: { cookie: other } })).json(), []);
  assert.deepEqual((await app.inject({ url: '/api/folders', headers: { cookie: other } })).json(), []);
  const id = mine[0].id;
  for (const [method, url] of [['GET', `/api/notes/${id}`], ['GET', `/api/notes/${id}/audio`], ['GET', `/api/notes/${id}/export.pdf`], ['GET', `/api/notes/${id}/whatsapp`], ['GET', `/api/notes/${id}/chat`], ['PATCH', `/api/notes/${id}`], ['POST', `/api/notes/${id}/reprocess`]]) {
    const r = await app.inject({ method, url, headers: { cookie: other }, payload: method === 'GET' ? undefined : {} });
    assert.equal(r.statusCode, 404, `${method} ${url} → ${r.statusCode}`);
  }
  assert.equal((await app.inject({ method: 'POST', url: `/api/notes/${id}/focus`, headers: { cookie: other }, payload: { area: 'trabajo' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/notes/${id}/listen`, headers: { cookie: other, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(2000) })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: other } })).json().brand.name, undefined, 'la marca es de cada quien');
  await app.inject({ method: 'DELETE', url: `/api/notes/${id}`, headers: { cookie: other } });
  assert.equal((await app.inject({ url: `/api/notes/${id}`, headers: { cookie } })).statusCode, 200, 'la nota sigue existiendo');
  // Carpeta ajena no se puede asignar.
  const f = (await app.inject({ method: 'POST', url: '/api/folders', headers: { cookie }, payload: { name: 'Mía' } })).json();
  const st = (await app.inject({ method: 'POST', url: '/api/uploads', headers: { cookie: other }, payload: { size: 10, mime: 'audio/webm', folderId: f.id } })).json();
  assert.equal((await app.inject({ url: `/api/uploads/${st.id}`, headers: { cookie } })).statusCode, 404, 'subida ajena invisible');
  await app.inject({ method: 'DELETE', url: `/api/uploads/${st.id}`, headers: { cookie: other } });
});

test('cuenta: cambiar contraseña y administración de cuentas', async () => {
  const me = (await app.inject({ url: '/api/me', headers: { cookie } })).json();
  assert.equal(me.user.isAdmin, 1, 'la primera cuenta es administradora');
  const bad = await app.inject({ method: 'POST', url: '/api/me/password', headers: { cookie }, payload: { current: 'mala', next: 'nueva-clave-123' } });
  assert.equal(bad.statusCode, 400);
  const short = await app.inject({ method: 'POST', url: '/api/me/password', headers: { cookie }, payload: { current: 'clave-de-prueba', next: 'corta' } });
  assert.equal(short.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/api/me/password', headers: { cookie }, payload: { current: 'clave-de-prueba', next: 'nueva-clave-123' } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode, 200, 'esta sesión sigue abierta');
  const relog = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'danny', password: 'nueva-clave-123' } });
  assert.equal(relog.statusCode, 200);
  // Admin crea y restablece cuentas.
  const created = (await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie }, payload: { username: 'Mama' } })).json();
  assert.equal(created.username, 'mama');
  assert.ok(created.password.length >= 10);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie }, payload: { username: 'mama' } })).statusCode, 409);
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'mama', password: created.password } });
  assert.equal(login.statusCode, 200);
  const mamaCookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ url: '/api/admin/users', headers: { cookie: mamaCookie } })).statusCode, 403, 'no-admin no administra');
  const reset = (await app.inject({ method: 'POST', url: `/api/admin/users/${created.id}/reset`, headers: { cookie } })).json();
  assert.notEqual(reset.password, created.password);
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: mamaCookie } })).statusCode, 401, 'el restablecimiento cierra sus sesiones');
  const list = (await app.inject({ url: '/api/admin/users', headers: { cookie } })).json();
  assert.ok(list.some((u) => u.username === 'mama'));
});

test('grupos: familia e iglesia, compartir prédicas, plática por persona y avisos', async () => {
  const loginAs = async (u, p) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: p } })).headers['set-cookie'].split(';')[0];
  const pw = (await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie }, payload: { username: 'papa' } })).json().password;
  const papa = await loginAs('papa', pw);
  const pw2 = (await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie }, payload: { username: 'eli' } })).json().password;
  const eli = await loginAs('eli', pw2);
  // Papá activa notificaciones.
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/papa1', keys: { p256dh: 'k', auth: 'a' } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie: papa }, payload: { subscription: sub, hour: 7, tz: 'America/Mexico_City' } })).statusCode, 200);
  // Familia
  const fam = (await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie }, payload: { name: 'Familia Quintero', kind: 'familia' } })).json();
  assert.equal(fam.role, 'admin');
  assert.match(fam.code, /^[A-Z0-9]{6}$/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/groups/join', headers: { cookie: papa }, payload: { code: 'nope00' } })).statusCode, 404);
  const joined = (await app.inject({ method: 'POST', url: '/api/groups/join', headers: { cookie: papa }, payload: { code: fam.code.toLowerCase() } })).json();
  assert.equal(joined.role, 'miembro');
  const notes = (await app.inject({ url: '/api/notes', headers: { cookie } })).json().filter((n) => n.isMine);
  const id = notes[0].id;
  assert.equal((await app.inject({ url: `/api/notes/${id}`, headers: { cookie: papa } })).statusCode, 404, 'antes de compartir no la ve');
  pushSent.length = 0;
  const sh = (await app.inject({ method: 'POST', url: `/api/notes/${id}/share`, headers: { cookie }, payload: { groupId: fam.id } })).json();
  assert.deepEqual(sh.shares.map((g) => g.name), ['Familia Quintero']);
  assert.equal(pushSent.length, 1, 'papá recibe aviso de la prédica nueva');
  assert.match(pushSent[0].body, /compartió/);
  const seen = (await app.inject({ url: `/api/notes/${id}`, headers: { cookie: papa } })).json();
  assert.equal(seen.isMine, false);
  assert.equal(seen.ownerName, 'danny');
  assert.ok((await app.inject({ url: '/api/notes', headers: { cookie: papa } })).json().some((n) => n.id === id && !n.isMine));
  assert.ok((await app.inject({ url: '/api/notes?folder=shared', headers: { cookie: papa } })).json().some((n) => n.id === id));
  assert.equal((await app.inject({ url: `/api/notes/${id}/export.pdf`, headers: { cookie: papa } })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/notes/${id}`, headers: { cookie: eli } })).statusCode, 404, 'quien no está en el grupo no la ve');
  // Papá no puede editar, borrar ni re-compartir.
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/notes/${id}`, headers: { cookie: papa }, payload: { title: 'x' } })).statusCode, 404);
  await app.inject({ method: 'DELETE', url: `/api/notes/${id}`, headers: { cookie: papa } });
  assert.equal((await app.inject({ url: `/api/notes/${id}`, headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/notes/${id}/share`, headers: { cookie: papa }, payload: { groupId: fam.id } })).statusCode, 404);
  // Cada quien su propia plática.
  await app.inject({ method: 'POST', url: `/api/notes/${id}/chat`, headers: { cookie: papa }, payload: { question: 'Pregunta de papá' } });
  const papaChat = (await app.inject({ url: `/api/notes/${id}/chat`, headers: { cookie: papa } })).json();
  assert.ok(papaChat.some((m) => m.content === 'Pregunta de papá'));
  const myChat = (await app.inject({ url: `/api/notes/${id}/chat`, headers: { cookie } })).json();
  assert.ok(!myChat.some((m) => m.content === 'Pregunta de papá'));
  // Iglesia: solo administradores comparten.
  const igl = (await app.inject({ method: 'POST', url: '/api/groups', headers: { cookie: papa }, payload: { name: 'Casa de Fe', kind: 'iglesia' } })).json();
  await app.inject({ method: 'POST', url: '/api/groups/join', headers: { cookie }, payload: { code: igl.code } });
  assert.equal((await app.inject({ method: 'POST', url: `/api/notes/${id}/share`, headers: { cookie }, payload: { groupId: igl.id } })).statusCode, 403);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.equal((await app.inject({ method: 'POST', url: `/api/groups/${igl.id}/logo`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-image-mime': 'image/png' }, body: png })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/groups/${igl.id}/logo`, headers: { cookie: papa, 'content-type': 'application/octet-stream', 'x-image-mime': 'image/png' }, body: png })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/groups/${igl.id}/logo`, headers: { cookie } })).statusCode, 200, 'los miembros ven el logo de la iglesia');
  assert.equal((await app.inject({ url: `/api/groups/${igl.id}/logo`, headers: { cookie: eli } })).statusCode, 404);
  // Salir del grupo: deja de verla. El último admin que sale deja a otro como admin.
  await app.inject({ method: 'DELETE', url: `/api/groups/${igl.id}/members/${(await app.inject({ url: '/api/me', headers: { cookie: papa } })).json().user.id}`, headers: { cookie: papa } });
  const igl2 = (await app.inject({ url: `/api/groups/${igl.id}`, headers: { cookie } })).json();
  assert.equal(igl2.role, 'admin');
  await app.inject({ method: 'DELETE', url: `/api/notes/${id}/share/${fam.id}`, headers: { cookie } });
  assert.equal((await app.inject({ url: `/api/notes/${id}`, headers: { cookie: papa } })).statusCode, 404, 'al dejar de compartir ya no la ve');
});

test('recordatorio diario del devocional', async () => {
  assert.equal(devotionalDay('2026-11-15', '2026-11-16'), 1);
  assert.equal(devotionalDay('2026-11-15', '2026-11-20'), 5);
  assert.equal(devotionalDay('2026-11-15', '2026-11-21'), null);
  assert.equal(devotionalDay('2026-11-15', '2026-11-15'), null);
  assert.deepEqual(localNow('America/Mexico_City', new Date('2026-11-17T13:30:00Z')), { date: '2026-11-17', hour: 7 });
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/danny1', keys: { p256dh: 'k', auth: 'a' } };
  await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie }, payload: { subscription: sub, hour: 7, tz: 'America/Mexico_City' } });
  const st = (await app.inject({ url: '/api/push', headers: { cookie } })).json();
  assert.ok(st.available && st.publicKey.length > 40);
  assert.ok(st.subscriptions.some((x) => x.endpoint === sub.endpoint));
  // Nota predicada hace 2 días → día 2.
  const n = (await app.inject({ url: '/api/notes', headers: { cookie } })).json().find((x) => x.isMine && x.status === 'ready');
  db.prepare("UPDATE notes SET preached_at = '2026-11-15' WHERE id = ?").run(n.id);
  pushSent.length = 0;
  await push.tick(new Date('2026-11-17T12:00:00Z')); // 6:00 en CDMX: aún no
  assert.equal(pushSent.filter((m) => m.endpoint === sub.endpoint).length, 0);
  await push.tick(new Date('2026-11-17T13:10:00Z')); // 7:10
  const mine = pushSent.filter((m) => m.endpoint === sub.endpoint);
  assert.equal(mine.length, 1);
  assert.match(mine[0].title, /Día 2/);
  assert.match(mine[0].url, /\?t=voz&dia=2$/);
  await push.tick(new Date('2026-11-17T13:20:00Z'));
  assert.equal(pushSent.filter((m) => m.endpoint === sub.endpoint).length, 1, 'una vez al día');
  // Suscripción vencida (410) se borra.
  const gone = createPush(db, { log: { warn() {} }, send: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); } });
  await gone.notifyUsers([(await app.inject({ url: '/api/me', headers: { cookie } })).json().user.id], { title: 't', body: 'b' });
  assert.ok(!(await app.inject({ url: '/api/push', headers: { cookie } })).json().subscriptions.some((x) => x.endpoint === sub.endpoint));
});

test('la SPA responde en rutas del cliente', async () => {
  const r = await app.inject({ url: '/nota/abc' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
});
