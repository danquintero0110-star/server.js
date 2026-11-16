import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline as pump } from 'node:stream/promises';
import { audioDir, config } from './config.js';
import { indexNote } from './db.js';
import * as auth from './lib/auth.js';
import { BIBLE_VERSION, getPassage, parseRef } from './lib/bible.js';
import * as exp from './lib/exporters.js';
import { youtubeId } from './lib/media.js';
import { chatAboutNote } from './providers/ai.js';
import { availableProvider } from './providers/transcribe.js';

const EXT = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/flac': 'flac' };

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

function serializeNote(n, { full = false } = {}) {
  const base = {
    id: n.id,
    title: n.title,
    preacher: n.preacher,
    preachedAt: n.preached_at,
    folderId: n.folder_id,
    sourceType: n.source_type,
    sourceUrl: n.source_url,
    durationSec: n.duration_sec,
    status: n.status,
    error: n.error,
    createdAt: n.created_at,
  };
  const a = n.analysis_json ? JSON.parse(n.analysis_json) : null;
  if (!full) return { ...base, centralIdea: a?.central_idea || '' };
  return {
    ...base,
    hasAudio: Boolean(n.audio_file),
    provider: n.provider,
    cost: JSON.parse(n.cost_json || '{}'),
    transcript: n.transcript_json ? JSON.parse(n.transcript_json).segments : [],
    analysis: a,
  };
}

export function buildApp({ db, queue, logger = false }) {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024, trustProxy: '127.0.0.1' });
  app.register(fastifyCookie);
  app.register(fastifyMultipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });
  app.register(fastifyStatic, {
    root: config.publicDir,
    wildcard: false,
    setHeaders(res, file) {
      if (/sw\.js$|\.webmanifest$|index\.html$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  });

  const getNote = (id) => db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  function createNote(req, n) {
    db.prepare(
      `INSERT INTO notes (id, title, preacher, preached_at, folder_id, source_type, source_url, audio_file, audio_mime, status)
       VALUES (@id, @title, @preacher, @preached_at, @folder_id, @sourceType, @sourceUrl, @audioFile, @audioMime, 'queued')`,
    ).run(n);
    indexNote(db, n.id);
    Promise.resolve(queue.enqueue(n.id)).catch((e) => req.log.error(e));
    return serializeNote(getNote(n.id), { full: true });
  }

  // --- Autenticación -------------------------------------------------------
  // Se decide con la ruta ya resuelta por el router (no con la URL cruda, que puede venir codificada).
  const PUBLIC = new Set(['/api/health', '/api/login']);
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions?.url;
    if (!route || !route.startsWith('/api/') || PUBLIC.has(route)) return;
    const user = auth.sessionUser(db, req.cookies[auth.COOKIE]);
    if (!user) return reply.code(401).send({ error: 'Inicia sesión' });
    req.user = user;
  });

  app.get('/api/health', async () => ({ ok: true, transcription: availableProvider() || 'sin-llave', ai: Boolean(process.env.ANTHROPIC_API_KEY) }));

  app.post('/api/login', async (req, reply) => {
    const ip = req.ip;
    if (!auth.loginAllowed(ip)) return reply.code(429).send({ error: 'Demasiados intentos. Espera unos minutos.' });
    const { username = '', password = '' } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
    if (!user || !auth.verifyPassword(String(password), user.pass_hash)) {
      auth.loginFailed(ip);
      return reply.code(401).send({ error: 'Usuario o contraseña incorrectos' });
    }
    auth.loginSucceeded(ip);
    const { token, maxAge } = auth.createSession(db, user.id);
    reply.setCookie(auth.COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge });
    return { user: { id: user.id, username: user.username } };
  });

  app.post('/api/logout', async (req, reply) => {
    auth.destroySession(db, req.cookies[auth.COOKIE]);
    reply.clearCookie(auth.COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ user: req.user, bible: BIBLE_VERSION }));

  // --- Carpetas ------------------------------------------------------------
  app.get('/api/folders', async () =>
    db.prepare('SELECT f.*, (SELECT count(*) FROM notes n WHERE n.folder_id = f.id) AS count FROM folders f ORDER BY name').all(),
  );
  app.post('/api/folders', async (req, reply) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: 'Escribe un nombre' });
    const color = String(req.body?.color || 'amber').slice(0, 20);
    const { lastInsertRowid } = db.prepare('INSERT INTO folders (name, color) VALUES (?, ?)').run(name, color);
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(lastInsertRowid);
  });
  app.patch('/api/folders/:id', async (req, reply) => {
    const f = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!f) return reply.code(404).send({ error: 'No existe' });
    db.prepare('UPDATE folders SET name = ?, color = ? WHERE id = ?').run(
      String(req.body?.name ?? f.name).trim().slice(0, 60) || f.name,
      String(req.body?.color ?? f.color).slice(0, 20),
      f.id,
    );
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(f.id);
  });
  app.delete('/api/folders/:id', async (req) => {
    db.prepare('DELETE FROM folders WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  // --- Notas ---------------------------------------------------------------
  app.get('/api/notes', async (req) => {
    const { q = '', folder = '' } = req.query;
    const where = [];
    const params = {};
    let sql = 'SELECT n.* FROM notes n';
    if (q.trim()) {
      const terms = q
        .replace(/["*^():]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t}"*`)
        .join(' ');
      if (terms) {
        sql = `SELECT n.*, snippet(notes_fts, 2, '[[', ']]', '…', 14) AS snip FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id`;
        where.push('notes_fts MATCH @terms');
        params.terms = terms;
      }
    }
    if (folder === 'none') where.push('n.folder_id IS NULL');
    else if (folder) {
      where.push('n.folder_id = @folder');
      params.folder = Number(folder);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += params.terms ? ' ORDER BY rank LIMIT 100' : ' ORDER BY n.preached_at DESC, n.created_at DESC LIMIT 300';
    return db
      .prepare(sql)
      .all(params)
      .map((n) => ({ ...serializeNote(n), snippet: n.snip || '' }));
  });

  app.post('/api/notes', async (req, reply) => {
    const id = crypto.randomUUID();
    fs.mkdirSync(audioDir(), { recursive: true });
    const fields = { title: '', preacher: '', preached_at: new Date().toISOString().slice(0, 10), folder_id: null };
    let sourceType;
    let sourceUrl = '';
    let audioFile = '';
    let audioMime = '';

    if (req.isMultipart()) {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          audioMime = (part.mimetype || '').split(';')[0];
          if (!audioMime.startsWith('audio/') && !audioMime.startsWith('video/') && audioMime !== 'application/octet-stream') {
            return reply.code(400).send({ error: 'El archivo debe ser de audio' });
          }
          const ext = EXT[audioMime] || path.extname(part.filename || '').slice(1).replace(/[^a-z0-9]/gi, '') || 'bin';
          audioFile = `${id}.src.${ext}`;
          try {
            await pump(part.file, fs.createWriteStream(path.join(audioDir(), audioFile)));
          } catch (e) {
            fs.rmSync(path.join(audioDir(), audioFile), { force: true });
            throw e;
          }
          if (part.file.truncated) {
            fs.rmSync(path.join(audioDir(), audioFile), { force: true });
            return reply.code(413).send({ error: `El archivo supera ${config.maxUploadMb} MB` });
          }
        } else if (part.fieldname === 'source') sourceType = part.value === 'record' ? 'record' : 'upload';
        else if (['title', 'preacher'].includes(part.fieldname)) fields[part.fieldname] = String(part.value).slice(0, 200);
        else if (part.fieldname === 'preachedAt' && /^\d{4}-\d{2}-\d{2}$/.test(part.value)) fields.preached_at = part.value;
        else if (part.fieldname === 'folderId' && part.value) fields.folder_id = Number(part.value) || null;
      }
      if (!audioFile) return reply.code(400).send({ error: 'Falta el audio' });
      sourceType ||= 'upload';
    } else {
      const b = req.body || {};
      if (!youtubeId(b.youtubeUrl)) return reply.code(400).send({ error: 'Ese enlace no parece de YouTube' });
      sourceType = 'youtube';
      sourceUrl = String(b.youtubeUrl).trim();
      fields.title = String(b.title || '').slice(0, 200);
      fields.preacher = String(b.preacher || '').slice(0, 200);
      if (/^\d{4}-\d{2}-\d{2}$/.test(b.preachedAt || '')) fields.preached_at = b.preachedAt;
      fields.folder_id = Number(b.folderId) || null;
    }

    return reply.code(201).send(createNote(req, { id, ...fields, sourceType, sourceUrl, audioFile, audioMime }));
  });

  // --- Subida por partes (archivos grandes, reanudable) ----------------------
  // 1) POST /api/uploads {size, mime, name, ...} → {id, offset}
  // 2) PUT  /api/uploads/:id?offset=N  (cuerpo binario, ≤ 16 MB por parte)
  // 3) GET  /api/uploads/:id → {offset}  (para reanudar tras un corte)
  // 4) POST /api/uploads/:id/finish → crea la nota
  const upDir = () => path.join(config.dataDir, 'uploads');
  const upMeta = (uid) => path.join(upDir(), `${uid}.json`);
  const upPart = (uid) => path.join(upDir(), `${uid}.part`);
  const readUp = (uid) => {
    if (!/^[0-9a-f-]{36}$/.test(uid)) return null;
    try {
      return JSON.parse(fs.readFileSync(upMeta(uid), 'utf8'));
    } catch {
      return null;
    }
  };
  const upOffset = (uid) => {
    try {
      return fs.statSync(upPart(uid)).size;
    } catch {
      return 0;
    }
  };
  const cleanUploads = () => {
    try {
      for (const f of fs.readdirSync(upDir())) {
        const full = path.join(upDir(), f);
        if (Date.now() - fs.statSync(full).mtimeMs > 24 * 3600 * 1000) fs.rmSync(full, { force: true });
      }
    } catch {}
  };
  cleanUploads();
  const cleanTimer = setInterval(cleanUploads, 3600 * 1000);
  cleanTimer.unref();
  app.addHook('onClose', async () => clearInterval(cleanTimer));

  app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));

  app.post('/api/uploads', async (req, reply) => {
    const b = req.body || {};
    const size = Number(b.size);
    const mime = String(b.mime || '').split(';')[0];
    if (!Number.isInteger(size) || size <= 0) return reply.code(400).send({ error: 'Archivo vacío' });
    if (mime && !mime.startsWith('audio/') && !mime.startsWith('video/') && mime !== 'application/octet-stream') {
      return reply.code(400).send({ error: 'El archivo debe ser de audio o video' });
    }
    if (size > config.maxUploadMb * 1048576) return reply.code(413).send({ error: `El archivo supera ${config.maxUploadMb} MB` });
    fs.mkdirSync(upDir(), { recursive: true });
    if (freeBytes(upDir()) - size < config.minFreeMb * 1048576) {
      return reply.code(507).send({ error: 'No hay espacio suficiente en el servidor para este archivo' });
    }
    const uid = crypto.randomUUID();
    const ext = EXT[mime] || path.extname(String(b.name || '')).slice(1).replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const meta = {
      size,
      mime: mime || 'application/octet-stream',
      ext,
      sourceType: b.source === 'record' ? 'record' : 'upload',
      title: String(b.title || '').slice(0, 200),
      preacher: String(b.preacher || '').slice(0, 200),
      preached_at: /^\d{4}-\d{2}-\d{2}$/.test(b.preachedAt || '') ? b.preachedAt : new Date().toISOString().slice(0, 10),
      folder_id: Number(b.folderId) || null,
    };
    fs.writeFileSync(upMeta(uid), JSON.stringify(meta));
    fs.writeFileSync(upPart(uid), '');
    return { id: uid, offset: 0, chunkSize: 8 * 1048576 };
  });

  app.get('/api/uploads/:id', async (req, reply) => {
    const meta = readUp(req.params.id);
    if (!meta) return reply.code(404).send({ error: 'La subida ya no existe' });
    return { id: req.params.id, offset: upOffset(req.params.id), size: meta.size };
  });

  const MAX_CHUNK = 16 * 1048576;
  const busy = new Set();
  app.put('/api/uploads/:id', async (req, reply) => {
    const uid = req.params.id;
    const meta = readUp(uid);
    if (!meta) return reply.code(404).send({ error: 'La subida ya no existe' });
    if (busy.has(uid)) return reply.code(409).send({ error: 'Parte en curso', offset: upOffset(uid) });
    const offset = Number(req.query.offset);
    const have = upOffset(uid);
    if (offset !== have) return reply.code(409).send({ error: 'Posición distinta', offset: have });
    const stream = req.body;
    if (!stream || typeof stream.pipe !== 'function') return reply.code(400).send({ error: 'Falta el contenido' });
    busy.add(uid);
    const tmp = `${upPart(uid)}.chunk`;
    try {
      let n = 0;
      const out = fs.createWriteStream(tmp);
      await pump(
        stream,
        async function* (src) {
          for await (const c of src) {
            n += c.length;
            if (n > MAX_CHUNK || have + n > meta.size) throw Object.assign(new Error('Parte demasiado grande'), { statusCode: 413 });
            yield c;
          }
        },
        out,
      );
      // Solo se agrega una parte completa: si la conexión se cortó a medias, se descarta.
      fs.appendFileSync(upPart(uid), fs.readFileSync(tmp));
    } catch (e) {
      if (e.statusCode === 413) return reply.code(413).send({ error: e.message });
      throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
      busy.delete(uid);
    }
    return { offset: upOffset(uid), size: meta.size };
  });

  app.post('/api/uploads/:id/finish', async (req, reply) => {
    const uid = req.params.id;
    const meta = readUp(uid);
    if (!meta) return reply.code(404).send({ error: 'La subida ya no existe' });
    if (busy.has(uid)) return reply.code(409).send({ error: 'Parte en curso' });
    const have = upOffset(uid);
    if (have !== meta.size) return reply.code(409).send({ error: 'La subida no está completa', offset: have });
    const id = crypto.randomUUID();
    const audioFile = `${id}.src.${meta.ext}`;
    fs.mkdirSync(audioDir(), { recursive: true });
    fs.renameSync(upPart(uid), path.join(audioDir(), audioFile));
    fs.rmSync(upMeta(uid), { force: true });
    const { size, mime, ext, sourceType, ...fields } = meta;
    return reply.code(201).send(createNote(req, { id, ...fields, sourceType, sourceUrl: '', audioFile, audioMime: mime }));
  });

  app.delete('/api/uploads/:id', async (req) => {
    if (readUp(req.params.id)) {
      fs.rmSync(upPart(req.params.id), { force: true });
      fs.rmSync(upMeta(req.params.id), { force: true });
    }
    return { ok: true };
  });

  app.get('/api/notes/:id', async (req, reply) => {
    const n = getNote(req.params.id);
    if (!n) return reply.code(404).send({ error: 'Nota no encontrada' });
    return serializeNote(n, { full: true });
  });

  app.patch('/api/notes/:id', async (req, reply) => {
    const n = getNote(req.params.id);
    if (!n) return reply.code(404).send({ error: 'Nota no encontrada' });
    const b = req.body || {};
    const upd = {
      title: b.title !== undefined ? String(b.title).slice(0, 200) : n.title,
      preacher: b.preacher !== undefined ? String(b.preacher).slice(0, 200) : n.preacher,
      preached_at: /^\d{4}-\d{2}-\d{2}$/.test(b.preachedAt || '') ? b.preachedAt : n.preached_at,
      folder_id: b.folderId !== undefined ? Number(b.folderId) || null : n.folder_id,
    };
    db.prepare(
      "UPDATE notes SET title = @title, preacher = @preacher, preached_at = @preached_at, folder_id = @folder_id, updated_at = datetime('now') WHERE id = @id",
    ).run({ ...upd, id: n.id });
    indexNote(db, n.id);
    return serializeNote(getNote(n.id), { full: true });
  });

  app.delete('/api/notes/:id', async (req) => {
    const n = getNote(req.params.id);
    if (n) {
      for (const f of fs.existsSync(audioDir()) ? fs.readdirSync(audioDir()) : []) {
        if (f.startsWith(`${n.id}.`) || f.startsWith(`${n.id}-`)) fs.rmSync(path.join(audioDir(), f), { force: true });
      }
    }
    db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(req.params.id);
    return { ok: true };
  });

  app.post('/api/notes/:id/reprocess', async (req, reply) => {
    const n = getNote(req.params.id);
    if (!n) return reply.code(404).send({ error: 'Nota no encontrada' });
    const fromScratch = req.body?.transcribe === true;
    db.prepare(
      `UPDATE notes SET status = 'queued', error = '', analysis_json = ''${fromScratch ? ", transcript_json = ''" : ''} WHERE id = ?`,
    ).run(n.id);
    Promise.resolve(queue.enqueue(n.id)).catch((e) => req.log.error(e));
    return serializeNote(getNote(n.id), { full: true });
  });

  app.get('/api/notes/:id/audio', async (req, reply) => {
    const n = getNote(req.params.id);
    if (!n?.audio_file) return reply.code(404).send({ error: 'Sin audio' });
    reply.header('Content-Type', n.audio_mime || 'audio/mp4');
    return reply.sendFile(n.audio_file, audioDir(), { cacheControl: false, contentType: false });
  });

  // --- Exportar ------------------------------------------------------------
  const passagesFor = (a) => {
    const map = new Map();
    for (const v of a.verses || []) {
      const p = getPassage(db, { code: v.code, chapter: v.chapter, verseStart: v.verse_start, verseEnd: v.verse_end });
      if (p) map.set(v.reference, p.verses.map((x) => (p.verses.length > 1 ? `${x.verse} ${x.text}` : x.text)).join(' '));
    }
    return map;
  };

  app.get('/api/notes/:id/export.pdf', async (req, reply) => {
    const n = getNote(req.params.id);
    if (!n?.analysis_json) return reply.code(404).send({ error: 'La nota aún no está lista' });
    const a = JSON.parse(n.analysis_json);
    const safe = (n.title || 'nota').normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'nota';
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${safe}.pdf"`);
    return reply.send(exp.summaryPdf(n, a, passagesFor(a)));
  });

  app.get('/api/notes/:id/whatsapp', async (req, reply) => {
    const n = getNote(req.params.id);
    if (!n?.analysis_json) return reply.code(404).send({ error: 'La nota aún no está lista' });
    const a = JSON.parse(n.analysis_json);
    return { summary: exp.summaryWhatsapp(n, a), announcements: exp.announcementsWhatsapp(n, a.announcements) };
  });

  // --- Biblia --------------------------------------------------------------
  app.get('/api/bible', async (req, reply) => {
    const ref = req.query.code
      ? { code: req.query.code, chapter: +req.query.chapter, verseStart: +req.query.from || 0, verseEnd: +req.query.to || 0 }
      : parseRef(req.query.ref);
    const p = ref && getPassage(db, ref);
    if (!p) return reply.code(404).send({ error: 'Pasaje no encontrado' });
    return { ...p, versionName: BIBLE_VERSION.name };
  });

  // --- Chat sobre una nota -------------------------------------------------
  app.get('/api/notes/:id/chat', async (req) =>
    db.prepare('SELECT id, role, content, created_at FROM chat_messages WHERE note_id = ? ORDER BY id').all(req.params.id),
  );
  app.delete('/api/notes/:id/chat', async (req) => {
    db.prepare('DELETE FROM chat_messages WHERE note_id = ?').run(req.params.id);
    return { ok: true };
  });

  app.post('/api/notes/:id/chat', async (req, reply) => {
    const n = getNote(req.params.id);
    if (!n?.transcript_json) return reply.code(404).send({ error: 'La nota aún no tiene transcripción' });
    const question = String(req.body?.question || '').trim().slice(0, 2000);
    if (!question) return reply.code(400).send({ error: 'Escribe una pregunta' });
    const history = db.prepare('SELECT role, content FROM chat_messages WHERE note_id = ? ORDER BY id DESC LIMIT 20').all(n.id).reverse();

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const out = await chatAboutNote({
        note: n,
        segments: JSON.parse(n.transcript_json).segments,
        analysis: n.analysis_json ? JSON.parse(n.analysis_json) : null,
        history,
        question,
        onText: (t) => send('delta', { text: t }),
      });
      const ins = db.prepare('INSERT INTO chat_messages (note_id, role, content) VALUES (?, ?, ?)');
      db.transaction(() => {
        ins.run(n.id, 'user', question);
        ins.run(n.id, 'assistant', out.text);
      })();
      db.prepare("UPDATE notes SET cost_json = json_set(cost_json, '$.chat', round(coalesce(json_extract(cost_json, '$.chat'), 0) + ?, 4)) WHERE id = ?").run(out.costUsd, n.id);
      send('done', { text: out.text });
    } catch (e) {
      req.log.error(e);
      send('error', { error: e.message || 'Error del asistente' });
    }
    res.end();
  });

  // --- SPA -----------------------------------------------------------------
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'No encontrado' });
    return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html');
  });

  return app;
}
