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
import { deps as pipelineDeps, ensureFocus, ensureStudy, focusKey } from './lib/pipeline.js';
import { availableProvider } from './providers/transcribe.js';
import * as tts from './providers/tts.js';

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

export function buildApp({ db, queue, logger = false, push = null }) {
  const notifyUsers = push ? (ids, msg) => push.notifyUsers(ids, msg).catch(() => {}) : null;
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

  // Siempre con el dueño: una persona nunca ve ni toca notas de otra.
  const getNote = (id, uid) => db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(id, uid);
  // Ver (no editar): dueño o miembro de un grupo con el que se compartió la nota.
  const viewNote = (id, uid) =>
    db
      .prepare(
        `SELECT n.*, CASE WHEN n.user_id = @uid THEN 1 ELSE 0 END AS is_mine, ou.username AS owner_name FROM notes n
         LEFT JOIN users ou ON ou.id = n.user_id
         WHERE n.id = @id AND (n.user_id = @uid OR EXISTS (
           SELECT 1 FROM note_shares s JOIN group_members m ON m.group_id = s.group_id WHERE s.note_id = n.id AND m.user_id = @uid))`,
      )
      .get({ id, uid });
  const sharesOf = (noteId) =>
    db.prepare('SELECT g.id, g.name, g.kind FROM note_shares s JOIN groups g ON g.id = s.group_id WHERE s.note_id = ? ORDER BY g.name').all(noteId);
  const full = (n, uid) => ({
    ...serializeNote(n, { full: true }),
    isMine: n.user_id === uid,
    ownerName: n.user_id === uid ? '' : n.owner_name || db.prepare('SELECT username FROM users WHERE id = ?').get(n.user_id)?.username || '',
    shares: n.user_id === uid ? sharesOf(n.id) : [],
  });
  const ownFolder = (fid, uid) => (fid ? db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(fid, uid)?.id || null : null);
  function createNote(req, n) {
    db.prepare(
      `INSERT INTO notes (id, user_id, title, preacher, preached_at, folder_id, source_type, source_url, audio_file, audio_mime, status)
       VALUES (@id, @user_id, @title, @preacher, @preached_at, @folder_id, @sourceType, @sourceUrl, @audioFile, @audioMime, 'queued')`,
    ).run({ ...n, user_id: req.user.id, folder_id: ownFolder(n.folder_id, req.user.id) });
    indexNote(db, n.id);
    Promise.resolve(queue.enqueue(n.id)).catch((e) => req.log.error(e));
    return full(getNote(n.id, req.user.id), req.user.id);
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
    return { user: { id: user.id, username: user.username, isAdmin: user.is_admin } };
  });

  app.post('/api/logout', async (req, reply) => {
    auth.destroySession(db, req.cookies[auth.COOKIE]);
    reply.clearCookie(auth.COOKIE, { path: '/' });
    return { ok: true };
  });

  const brandOf = (uid) => {
    try {
      return JSON.parse(db.prepare('SELECT brand_json FROM users WHERE id = ?').get(uid)?.brand_json || '{}');
    } catch {
      return {};
    }
  };
  const saveBrand = (uid, b) => db.prepare('UPDATE users SET brand_json = ? WHERE id = ?').run(JSON.stringify(b), uid);
  const brandDir = () => path.join(config.dataDir, 'brand');
  const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

  app.get('/api/me', async (req) => ({ user: req.user, bible: BIBLE_VERSION, brand: brandOf(req.user.id) }));

  // --- Mi marca: nombre, usuario de redes y logo para las imágenes -------------
  app.put('/api/me/brand', async (req) => {
    const b = brandOf(req.user.id);
    const body = req.body || {};
    if (body.name !== undefined) b.name = String(body.name).trim().slice(0, 60);
    if (body.handle !== undefined) b.handle = String(body.handle).trim().slice(0, 40);
    if (body.showLogo !== undefined) b.showLogo = Boolean(body.showLogo);
    saveBrand(req.user.id, b);
    return b;
  });
  app.post('/api/me/logo', async (req, reply) => {
    const mime = String(req.headers['x-image-mime'] || '').split(';')[0];
    const ext = LOGO_TYPES[mime];
    if (!ext) return reply.code(400).send({ error: 'El logo debe ser PNG, JPG o WEBP' });
    const stream = req.body;
    if (!stream || typeof stream.pipe !== 'function') return reply.code(400).send({ error: 'Falta la imagen' });
    fs.mkdirSync(brandDir(), { recursive: true });
    const file = path.join(brandDir(), `${req.user.id}.${ext}`);
    const tmp = `${file}.tmp`;
    try {
      let size = 0;
      await pump(
        stream,
        async function* (src) {
          for await (const c of src) {
            size += c.length;
            if (size > 2 * 1048576) throw Object.assign(new Error('El logo debe pesar menos de 2 MB'), { statusCode: 413 });
            yield c;
          }
        },
        fs.createWriteStream(tmp),
      );
      for (const e of Object.values(LOGO_TYPES)) fs.rmSync(path.join(brandDir(), `${req.user.id}.${e}`), { force: true });
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (e.statusCode === 413) return reply.code(413).send({ error: e.message });
      throw e;
    }
    const b = brandOf(req.user.id);
    b.logo = `${ext}:${Date.now()}`;
    if (b.showLogo === undefined) b.showLogo = true;
    saveBrand(req.user.id, b);
    return b;
  });
  app.get('/api/me/logo', async (req, reply) => {
    const b = brandOf(req.user.id);
    const ext = String(b.logo || '').split(':')[0];
    if (!Object.values(LOGO_TYPES).includes(ext) || !fs.existsSync(path.join(brandDir(), `${req.user.id}.${ext}`))) return reply.code(404).send({ error: 'Sin logo' });
    reply.header('Cache-Control', 'private, max-age=600');
    return reply.sendFile(`${req.user.id}.${ext}`, brandDir(), { cacheControl: false });
  });
  app.delete('/api/me/logo', async (req) => {
    for (const e of Object.values(LOGO_TYPES)) fs.rmSync(path.join(brandDir(), `${req.user.id}.${e}`), { force: true });
    const b = brandOf(req.user.id);
    delete b.logo;
    saveBrand(req.user.id, b);
    return b;
  });

  // --- Carpetas ------------------------------------------------------------
  app.get('/api/folders', async (req) =>
    db.prepare('SELECT f.*, (SELECT count(*) FROM notes n WHERE n.folder_id = f.id) AS count FROM folders f WHERE f.user_id = ? ORDER BY name').all(req.user.id),
  );
  app.post('/api/folders', async (req, reply) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: 'Escribe un nombre' });
    const color = String(req.body?.color || 'amber').slice(0, 20);
    const { lastInsertRowid } = db.prepare('INSERT INTO folders (name, color, user_id) VALUES (?, ?, ?)').run(name, color, req.user.id);
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(lastInsertRowid);
  });
  app.patch('/api/folders/:id', async (req, reply) => {
    const f = db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!f) return reply.code(404).send({ error: 'No existe' });
    db.prepare('UPDATE folders SET name = ?, color = ? WHERE id = ?').run(
      String(req.body?.name ?? f.name).trim().slice(0, 60) || f.name,
      String(req.body?.color ?? f.color).slice(0, 20),
      f.id,
    );
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(f.id);
  });
  app.delete('/api/folders/:id', async (req) => {
    db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    return { ok: true };
  });

  // --- Notas ---------------------------------------------------------------
  app.get('/api/notes', async (req) => {
    const { q = '', folder = '' } = req.query;
    const visible = `(n.user_id = @uid OR n.id IN (SELECT s.note_id FROM note_shares s JOIN group_members m ON m.group_id = s.group_id WHERE m.user_id = @uid))`;
    const where = [visible];
    const params = { uid: req.user.id };
    let sql = 'SELECT n.*, ou.username AS owner_name FROM notes n LEFT JOIN users ou ON ou.id = n.user_id';
    if (q.trim()) {
      const terms = q
        .replace(/["*^():]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t}"*`)
        .join(' ');
      if (terms) {
        sql = `SELECT n.*, ou.username AS owner_name, snippet(notes_fts, 2, '[[', ']]', '…', 14) AS snip FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id LEFT JOIN users ou ON ou.id = n.user_id`;
        where.push('notes_fts MATCH @terms');
        params.terms = terms;
      }
    }
    if (folder === 'shared') where.push('n.user_id != @uid');
    else if (folder === 'none') where.push('n.folder_id IS NULL AND n.user_id = @uid');
    else if (folder) {
      where.push('n.folder_id = @folder AND n.user_id = @uid');
      params.folder = Number(folder);
    }
    sql += ` WHERE ${where.join(' AND ')}`;
    sql += params.terms ? ' ORDER BY rank LIMIT 100' : ' ORDER BY n.preached_at DESC, n.created_at DESC LIMIT 300';
    return db
      .prepare(sql)
      .all(params)
      .map((n) => ({ ...serializeNote(n), snippet: n.snip || '', isMine: n.user_id === req.user.id, ownerName: n.user_id === req.user.id ? '' : n.owner_name || '' }));
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
  const readUp = (uid, userId) => {
    if (!/^[0-9a-f-]{36}$/.test(uid)) return null;
    try {
      const m = JSON.parse(fs.readFileSync(upMeta(uid), 'utf8'));
      return m.userId === userId ? m : null;
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
      userId: req.user.id,
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
    const meta = readUp(req.params.id, req.user.id);
    if (!meta) return reply.code(404).send({ error: 'La subida ya no existe' });
    return { id: req.params.id, offset: upOffset(req.params.id), size: meta.size };
  });

  const MAX_CHUNK = 16 * 1048576;
  const busy = new Set();
  app.put('/api/uploads/:id', async (req, reply) => {
    const uid = req.params.id;
    const meta = readUp(uid, req.user.id);
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
    const meta = readUp(uid, req.user.id);
    if (!meta) return reply.code(404).send({ error: 'La subida ya no existe' });
    if (busy.has(uid)) return reply.code(409).send({ error: 'Parte en curso' });
    const have = upOffset(uid);
    if (have !== meta.size) return reply.code(409).send({ error: 'La subida no está completa', offset: have });
    const id = crypto.randomUUID();
    const audioFile = `${id}.src.${meta.ext}`;
    fs.mkdirSync(audioDir(), { recursive: true });
    fs.renameSync(upPart(uid), path.join(audioDir(), audioFile));
    fs.rmSync(upMeta(uid), { force: true });
    const { size, mime, ext, sourceType, userId, ...fields } = meta;
    return reply.code(201).send(createNote(req, { id, ...fields, sourceType, sourceUrl: '', audioFile, audioMime: mime }));
  });

  app.delete('/api/uploads/:id', async (req) => {
    if (readUp(req.params.id, req.user.id)) {
      fs.rmSync(upPart(req.params.id), { force: true });
      fs.rmSync(upMeta(req.params.id), { force: true });
    }
    return { ok: true };
  });

  app.get('/api/notes/:id', async (req, reply) => {
    const n = viewNote(req.params.id, req.user.id);
    if (!n) return reply.code(404).send({ error: 'Nota no encontrada' });
    return full(n, req.user.id);
  });

  app.patch('/api/notes/:id', async (req, reply) => {
    const n = getNote(req.params.id, req.user.id);
    if (!n) return reply.code(404).send({ error: 'Nota no encontrada' });
    const b = req.body || {};
    const upd = {
      title: b.title !== undefined ? String(b.title).slice(0, 200) : n.title,
      preacher: b.preacher !== undefined ? String(b.preacher).slice(0, 200) : n.preacher,
      preached_at: /^\d{4}-\d{2}-\d{2}$/.test(b.preachedAt || '') ? b.preachedAt : n.preached_at,
      folder_id: b.folderId !== undefined ? ownFolder(Number(b.folderId) || null, req.user.id) : n.folder_id,
    };
    db.prepare(
      "UPDATE notes SET title = @title, preacher = @preacher, preached_at = @preached_at, folder_id = @folder_id, updated_at = datetime('now') WHERE id = @id",
    ).run({ ...upd, id: n.id });
    indexNote(db, n.id);
    return full(getNote(n.id, req.user.id), req.user.id);
  });

  app.delete('/api/notes/:id', async (req) => {
    const n = getNote(req.params.id, req.user.id);
    if (n) {
      for (const f of fs.existsSync(audioDir()) ? fs.readdirSync(audioDir()) : []) {
        if (f.startsWith(`${n.id}.`) || f.startsWith(`${n.id}-`)) fs.rmSync(path.join(audioDir(), f), { force: true });
      }
    }
    if (n) {
      db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
      db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(n.id);
    }
    return { ok: true };
  });

  app.post('/api/notes/:id/reprocess', async (req, reply) => {
    const n = getNote(req.params.id, req.user.id);
    if (!n) return reply.code(404).send({ error: 'Nota no encontrada' });
    const fromScratch = req.body?.transcribe === true;
    db.prepare(
      `UPDATE notes SET status = 'queued', error = '', analysis_json = ''${fromScratch ? ", transcript_json = ''" : ''} WHERE id = ?`,
    ).run(n.id);
    Promise.resolve(queue.enqueue(n.id)).catch((e) => req.log.error(e));
    return full(getNote(n.id, req.user.id), req.user.id);
  });

  app.get('/api/notes/:id/audio', async (req, reply) => {
    const n = viewNote(req.params.id, req.user.id);
    if (!n?.audio_file) return reply.code(404).send({ error: 'Sin audio' });
    reply.header('Content-Type', n.audio_mime || 'audio/mp4');
    return reply.sendFile(n.audio_file, audioDir(), { cacheControl: false, contentType: false });
  });

  // --- Exportar ------------------------------------------------------------
  const textFor = (v) => {
    if (!v?.code) return '';
    const p = getPassage(db, { code: v.code, chapter: v.chapter, verseStart: v.verse_start, verseEnd: v.verse_end });
    if (!p) return '';
    return p.verses.map((x) => (p.verses.length > 1 ? `${x.verse} ${x.text}` : x.text)).join(' ');
  };

  app.get('/api/notes/:id/export.pdf', async (req, reply) => {
    const n = viewNote(req.params.id, req.user.id);
    if (!n?.analysis_json) return reply.code(404).send({ error: 'La nota aún no está lista' });
    let a = JSON.parse(n.analysis_json);
    if (!a.study) {
      try {
        a = await ensureStudy(db, n.id);
      } catch (e) {
        req.log.warn(`PDF sin estudio desarrollado para ${n.id}: ${e.message}`);
      }
    }
    const safe = (n.title || 'nota').normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'nota';
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${safe}.pdf"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(exp.summaryPdf(n, a, textFor));
  });

  app.get('/api/notes/:id/whatsapp', async (req, reply) => {
    const n = viewNote(req.params.id, req.user.id);
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
  app.get('/api/notes/:id/chat', async (req, reply) => {
    if (!viewNote(req.params.id, req.user.id)) return reply.code(404).send({ error: 'Nota no encontrada' });
    return db.prepare('SELECT id, role, content, created_at FROM chat_messages WHERE note_id = ? AND user_id = ? ORDER BY id').all(req.params.id, req.user.id);
  });
  app.delete('/api/notes/:id/chat', async (req) => {
    if (viewNote(req.params.id, req.user.id)) db.prepare('DELETE FROM chat_messages WHERE note_id = ? AND user_id = ?').run(req.params.id, req.user.id);
    return { ok: true };
  });

  app.post('/api/notes/:id/chat', async (req, reply) => {
    const n = viewNote(req.params.id, req.user.id);
    if (!n?.transcript_json) return reply.code(404).send({ error: 'La nota aún no tiene transcripción' });
    const question = String(req.body?.question || '').trim().slice(0, 2000);
    if (!question) return reply.code(400).send({ error: 'Escribe una pregunta' });
    const mode = ['voz', 'devocional'].includes(req.body?.mode) ? req.body.mode : 'texto';
    const analysisObj = n.analysis_json ? JSON.parse(n.analysis_json) : null;
    const devotionalDay = mode === 'devocional' ? (analysisObj?.devotional || []).find((d) => d.day === Number(req.body?.day)) || null : null;
    const history = db.prepare('SELECT role, content FROM chat_messages WHERE note_id = ? AND user_id = ? ORDER BY id DESC LIMIT 20').all(n.id, req.user.id).reverse();

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const out = await chatAboutNote({
        note: n,
        segments: JSON.parse(n.transcript_json).segments,
        analysis: analysisObj,
        history,
        question,
        mode,
        devotionalDay,
        onText: (t) => send('delta', { text: t }),
      });
      const ins = db.prepare('INSERT INTO chat_messages (note_id, role, content, user_id) VALUES (?, ?, ?, ?)');
      db.transaction(() => {
        ins.run(n.id, 'user', question, req.user.id);
        ins.run(n.id, 'assistant', out.text, req.user.id);
      })();
      db.prepare("UPDATE notes SET cost_json = json_set(cost_json, '$.chat', round(coalesce(json_extract(cost_json, '$.chat'), 0) + ?, 4)) WHERE id = ?").run(out.costUsd, n.id);
      send('done', { text: out.text });
    } catch (e) {
      req.log.error(e);
      send('error', { error: e.message || 'Error del asistente' });
    }
    res.end();
  });

  // --- Enfoques: la prédica aplicada a un área ---------------------------------
  app.post('/api/notes/:id/focus', async (req, reply) => {
    const n = viewNote(req.params.id, req.user.id);
    if (!n?.analysis_json) return reply.code(404).send({ error: 'La nota aún no está lista' });
    const area = String(req.body?.area || '').trim();
    if (!focusKey(area)) return reply.code(400).send({ error: 'Escribe un área, por ejemplo "mi trabajo"' });
    if (area.length > 80) return reply.code(400).send({ error: 'Escribe un área más corta' });
    try {
      return { key: focusKey(area), focus: await ensureFocus(db, n.id, area) };
    } catch (e) {
      req.log.error(e);
      return reply.code(502).send({ error: 'No pude preparar ese enfoque. Intenta de nuevo.' });
    }
  });
  app.delete('/api/notes/:id/focus/:key', async (req, reply) => {
    const n = getNote(req.params.id, req.user.id);
    if (!n?.analysis_json) return reply.code(404).send({ error: 'Nota no encontrada' });
    const a = JSON.parse(n.analysis_json);
    if (a.focus) delete a.focus[req.params.key];
    db.prepare('UPDATE notes SET analysis_json = ? WHERE id = ?').run(JSON.stringify(a), n.id);
    return { ok: true };
  });

  // --- Voz humana de Selah (texto → audio), con caché en disco -----------------
  const ttsDir = () => path.join(config.dataDir, 'tts');
  const TTS_CACHE_MAX = 250 * 1048576;
  let ttsBytesSinceClean = Infinity;
  const cleanTts = () => {
    try {
      const files = fs.readdirSync(ttsDir()).map((f) => {
        const st = fs.statSync(path.join(ttsDir(), f));
        return { f, size: st.size, t: st.atimeMs || st.mtimeMs };
      });
      let total = files.reduce((n, x) => n + x.size, 0);
      for (const x of files.sort((a, b) => a.t - b.t)) {
        if (total <= TTS_CACHE_MAX * 0.8) break;
        fs.rmSync(path.join(ttsDir(), x.f), { force: true });
        total -= x.size;
      }
    } catch {}
    ttsBytesSinceClean = 0;
  };
  app.get('/api/tts/voices', async () => ({
    available: tts.ttsAvailable(),
    default: tts.defaultVoice(),
    voices: tts.availableVoices().map(([id, v]) => ({ id, label: v.label, desc: v.desc, gender: v.gender, premium: v.provider === 'eleven' })),
  }));
  app.post('/api/tts', async (req, reply) => {
    if (!tts.ttsAvailable()) return reply.code(503).send({ error: 'Voz no disponible' });
    const text = String(req.body?.text || '').replace(/\s+/g, ' ').trim();
    const voice = tts.resolveVoice(req.body?.voice);
    if (!text) return reply.code(400).send({ error: 'Falta el texto' });
    if (text.length > 1800) return reply.code(400).send({ error: 'Texto demasiado largo' });
    const hash = crypto.createHash('sha256').update(`${voice}\n${text}`).digest('hex').slice(0, 40);
    const file = path.join(ttsDir(), `${hash}.mp3`);
    reply.header('Content-Type', 'audio/mpeg').header('Cache-Control', 'private, max-age=86400');
    if (fs.existsSync(file)) {
      const now = new Date();
      fs.utimesSync(file, now, now);
      return reply.send(fs.createReadStream(file));
    }
    if (freeBytes(config.dataDir) < config.minFreeMb * 1048576) {
      // Sin espacio para caché: se genera igual pero no se guarda.
      const { audio } = await tts.synthesize(text, voice);
      return reply.send(audio);
    }
    const ctxText = (x) => String(x || '').replace(/\s+/g, ' ').trim().slice(-300);
    let out;
    try {
      out = await tts.synthesize(text, voice, { prev: ctxText(req.body?.prev), next: ctxText(req.body?.next).slice(0, 300) });
    } catch (e) {
      req.log.warn(e.message);
      return reply.code(502).send({ error: 'La voz no respondió' });
    }
    if (out.fallback) {
      // No se guarda en caché: cuando vuelva ElevenLabs debe sonar la voz elegida.
      req.log.warn(`ElevenLabs falló, se usó Deepgram: ${tts.lastElevenError}`);
      return reply.send(out.audio);
    }
    fs.mkdirSync(ttsDir(), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, out.audio);
    fs.renameSync(`${file}.tmp`, file);
    ttsBytesSinceClean += out.audio.length;
    if (ttsBytesSinceClean > 20 * 1048576) cleanTts();
    const noteId = String(req.body?.noteId || '');
    if (noteId && viewNote(noteId, req.user.id)) {
      db.prepare("UPDATE notes SET cost_json = json_set(cost_json, '$.tts', round(coalesce(json_extract(cost_json, '$.tts'), 0) + ?, 4)) WHERE id = ?").run(out.costUsd, noteId);
    }
    return reply.send(out.audio);
  });

  // --- Voz: escuchar lo que dice la persona (clips cortos) ---------------------
  const MAX_CLIP = 6 * 1048576;
  app.post('/api/notes/:id/listen', async (req, reply) => {
    const n = viewNote(req.params.id, req.user.id);
    if (!n) return reply.code(404).send({ error: 'Nota no encontrada' });
    const stream = req.body;
    if (!stream || typeof stream.pipe !== 'function') return reply.code(400).send({ error: 'Envía el audio como application/octet-stream' });
    const mime = String(req.headers['x-audio-mime'] || 'audio/webm').split(';')[0];
    if (!/^audio\/[\w.+-]+$/.test(mime)) return reply.code(400).send({ error: 'Tipo de audio no válido' });
    const tmpDir = path.join(config.dataDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `${crypto.randomUUID()}.clip`);
    try {
      let size = 0;
      await pump(
        stream,
        async function* (src) {
          for await (const c of src) {
            size += c.length;
            if (size > MAX_CLIP) throw Object.assign(new Error('El audio es demasiado largo'), { statusCode: 413 });
            yield c;
          }
        },
        fs.createWriteStream(file),
      );
      if (size < 1000) return { text: '' };
      let t;
      try {
        t = await pipelineDeps.stt.transcribe(file, mime);
      } catch (e) {
        if (/vac[ií]a/i.test(e.message)) return { text: '' };
        throw e;
      }
      db.prepare("UPDATE notes SET cost_json = json_set(cost_json, '$.voice', round(coalesce(json_extract(cost_json, '$.voice'), 0) + ?, 4)) WHERE id = ?").run(t.costUsd || 0, n.id);
      return { text: t.segments.map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim() };
    } catch (e) {
      if (e.statusCode === 413) return reply.code(413).send({ error: e.message });
      throw e;
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  // --- Notificaciones (recordatorio diario y avisos) ---------------------------------
  app.get('/api/push', async (req) => {
    const rows = db.prepare('SELECT endpoint, hour, tz, daily FROM push_subscriptions WHERE user_id = ?').all(req.user.id);
    return { available: Boolean(push), publicKey: push?.publicKey || '', subscriptions: rows.map((r) => ({ endpoint: r.endpoint, hour: r.hour, tz: r.tz, daily: Boolean(r.daily) })) };
  });
  app.post('/api/push/subscribe', async (req, reply) => {
    if (!push) return reply.code(503).send({ error: 'Notificaciones no disponibles' });
    const sub = req.body?.subscription || {};
    const endpoint = String(sub.endpoint || '');
    if (!/^https:\/\/[\w.-]+\//.test(endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return reply.code(400).send({ error: 'Suscripción no válida' });
    const hour = Math.min(23, Math.max(0, Number.parseInt(req.body?.hour ?? 7, 10) || 0));
    const tz = String(req.body?.tz || 'America/Mexico_City').slice(0, 60);
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_json, hour, tz, daily) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json, hour = excluded.hour, tz = excluded.tz, daily = excluded.daily`,
    ).run(req.user.id, endpoint, JSON.stringify({ p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }), hour, tz, req.body?.daily === false ? 0 : 1);
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req) => {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user.id, String(req.body?.endpoint || ''));
    return { ok: true };
  });
  app.post('/api/push/test', async (req, reply) => {
    if (!push) return reply.code(503).send({ error: 'Notificaciones no disponibles' });
    await push.notifyUsers([req.user.id], { title: 'Selah', body: '¡Listo! Así te llegarán tus recordatorios. 🙏', url: '/' });
    return { ok: true };
  });

  // --- Mi cuenta y administración ------------------------------------------------
  app.post('/api/me/password', async (req, reply) => {
    const { current = '', next = '' } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!auth.verifyPassword(String(current), u.pass_hash)) return reply.code(400).send({ error: 'La contraseña actual no es correcta' });
    if (String(next).length < 8) return reply.code(400).send({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(String(next)), u.id);
    // Cierra las demás sesiones (otros teléfonos), conserva esta.
    const keep = crypto.createHash('sha256').update(req.cookies[auth.COOKIE] || '').digest('hex');
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, keep);
    return { ok: true };
  });

  const adminOnly = (req, reply) => {
    if (!req.user.isAdmin) {
      reply.code(403).send({ error: 'Solo el administrador puede hacer esto' });
      return false;
    }
    return true;
  };
  app.get('/api/admin/users', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    return db
      .prepare(
        `SELECT u.id, u.username, u.is_admin AS isAdmin, u.created_at AS createdAt,
          (SELECT count(*) FROM notes n WHERE n.user_id = u.id) AS notes,
          (SELECT max(s.expires_at) FROM sessions s WHERE s.user_id = u.id) AS lastSession
         FROM users u ORDER BY u.id`,
      )
      .all();
  });
  app.post('/api/admin/users', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const username = String(req.body?.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,30}$/.test(username)) return reply.code(400).send({ error: 'Usuario de 2 a 30 letras o números, sin espacios' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return reply.code(409).send({ error: 'Ese usuario ya existe' });
    const password = auth.randomPassword();
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username, pass_hash) VALUES (?, ?)').run(username, auth.hashPassword(password));
    return { id: Number(lastInsertRowid), username, password };
  });
  app.post('/api/admin/users/:id/reset', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
    if (!u) return reply.code(404).send({ error: 'No existe' });
    const password = auth.randomPassword();
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    return { username: u.username, password };
  });

  // --- Grupos: familia o iglesia ---------------------------------------------------
  const memberOf = (gid, uid) => db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(gid, uid);
  const newCode = () => {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (;;) {
      const c = Array.from(crypto.randomBytes(6), (b) => abc[b % abc.length]).join('');
      if (!db.prepare('SELECT 1 FROM groups WHERE code = ?').get(c)) return c;
    }
  };
  const groupOut = (g, uid) => {
    const role = memberOf(g.id, uid)?.role;
    return {
      id: g.id,
      name: g.name,
      kind: g.kind,
      role,
      code: g.code,
      brand: JSON.parse(g.brand_json || '{}'),
      members: db.prepare('SELECT count(*) AS n FROM group_members WHERE group_id = ?').get(g.id).n,
      notes: db.prepare('SELECT count(*) AS n FROM note_shares WHERE group_id = ?').get(g.id).n,
    };
  };
  app.get('/api/groups', async (req) =>
    db
      .prepare('SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name')
      .all(req.user.id)
      .map((g) => groupOut(g, req.user.id)),
  );
  app.post('/api/groups', async (req, reply) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const kind = req.body?.kind === 'iglesia' ? 'iglesia' : 'familia';
    if (!name) return reply.code(400).send({ error: 'Escribe un nombre para el grupo' });
    const { lastInsertRowid } = db.prepare('INSERT INTO groups (name, kind, code, created_by) VALUES (?, ?, ?, ?)').run(name, kind, newCode(), req.user.id);
    db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(lastInsertRowid, req.user.id);
    return groupOut(db.prepare('SELECT * FROM groups WHERE id = ?').get(lastInsertRowid), req.user.id);
  });
  app.post('/api/groups/join', async (req, reply) => {
    const code = String(req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const g = db.prepare('SELECT * FROM groups WHERE code = ?').get(code);
    if (!g) return reply.code(404).send({ error: 'No encontré un grupo con ese código' });
    db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, 'miembro')").run(g.id, req.user.id);
    notifyUsers?.(adminsOf(g.id, req.user.id), { title: g.name, body: `${req.user.username} se unió al grupo`, url: '/grupos' });
    return groupOut(g, req.user.id);
  });
  app.get('/api/groups/:id', async (req, reply) => {
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!g || !memberOf(g.id, req.user.id)) return reply.code(404).send({ error: 'Grupo no encontrado' });
    return {
      ...groupOut(g, req.user.id),
      memberList: db
        .prepare('SELECT u.id, u.username, m.role FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.role, u.username')
        .all(g.id),
    };
  });
  app.patch('/api/groups/:id', async (req, reply) => {
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!g || memberOf(g.id, req.user.id)?.role !== 'admin') return reply.code(403).send({ error: 'Solo quien administra el grupo puede cambiarlo' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 60) || g.name : g.name;
    const brand = JSON.parse(g.brand_json || '{}');
    if (req.body?.handle !== undefined) brand.handle = String(req.body.handle).trim().slice(0, 40);
    db.prepare('UPDATE groups SET name = ?, brand_json = ? WHERE id = ?').run(name, JSON.stringify(brand), g.id);
    if (req.body?.newCode) db.prepare('UPDATE groups SET code = ? WHERE id = ?').run(newCode(), g.id);
    return groupOut(db.prepare('SELECT * FROM groups WHERE id = ?').get(g.id), req.user.id);
  });
  app.delete('/api/groups/:id/members/:uid', async (req, reply) => {
    const gid = Number(req.params.id);
    const target = Number(req.params.uid);
    const me = memberOf(gid, req.user.id);
    if (!me) return reply.code(404).send({ error: 'Grupo no encontrado' });
    if (target !== req.user.id && me.role !== 'admin') return reply.code(403).send({ error: 'Solo quien administra puede quitar personas' });
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, target);
    const left = db.prepare('SELECT count(*) AS n FROM group_members WHERE group_id = ?').get(gid).n;
    if (!left) db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
    else if (!db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND role = 'admin'").get(gid)) {
      // Nunca queda un grupo sin administrador.
      db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = (SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at LIMIT 1)").run(gid, gid);
    }
    return { ok: true };
  });
  app.post('/api/groups/:id/members/:uid/role', async (req, reply) => {
    const gid = Number(req.params.id);
    if (memberOf(gid, req.user.id)?.role !== 'admin') return reply.code(403).send({ error: 'Solo quien administra puede cambiar roles' });
    const role = req.body?.role === 'admin' ? 'admin' : 'miembro';
    db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(role, gid, Number(req.params.uid));
    return { ok: true };
  });
  // Logo del grupo (para las imágenes de la iglesia).
  const groupLogoName = (gid, ext) => `g${gid}.${ext}`;
  app.post('/api/groups/:id/logo', async (req, reply) => {
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!g || memberOf(g.id, req.user.id)?.role !== 'admin') return reply.code(403).send({ error: 'Solo quien administra el grupo puede cambiar el logo' });
    const ext = LOGO_TYPES[String(req.headers['x-image-mime'] || '').split(';')[0]];
    if (!ext) return reply.code(400).send({ error: 'El logo debe ser PNG, JPG o WEBP' });
    fs.mkdirSync(brandDir(), { recursive: true });
    const file = path.join(brandDir(), groupLogoName(g.id, ext));
    const tmp = `${file}.tmp`;
    try {
      let size = 0;
      await pump(
        req.body,
        async function* (src) {
          for await (const c of src) {
            size += c.length;
            if (size > 2 * 1048576) throw Object.assign(new Error('El logo debe pesar menos de 2 MB'), { statusCode: 413 });
            yield c;
          }
        },
        fs.createWriteStream(tmp),
      );
      for (const e of Object.values(LOGO_TYPES)) fs.rmSync(path.join(brandDir(), groupLogoName(g.id, e)), { force: true });
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (e.statusCode === 413) return reply.code(413).send({ error: e.message });
      throw e;
    }
    const brand = JSON.parse(g.brand_json || '{}');
    brand.logo = `${ext}:${Date.now()}`;
    db.prepare('UPDATE groups SET brand_json = ? WHERE id = ?').run(JSON.stringify(brand), g.id);
    return groupOut(db.prepare('SELECT * FROM groups WHERE id = ?').get(g.id), req.user.id);
  });
  app.get('/api/groups/:id/logo', async (req, reply) => {
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!g || !memberOf(g.id, req.user.id)) return reply.code(404).send({ error: 'Sin logo' });
    const ext = String(JSON.parse(g.brand_json || '{}').logo || '').split(':')[0];
    if (!Object.values(LOGO_TYPES).includes(ext) || !fs.existsSync(path.join(brandDir(), groupLogoName(g.id, ext)))) return reply.code(404).send({ error: 'Sin logo' });
    reply.header('Cache-Control', 'private, max-age=600');
    return reply.sendFile(groupLogoName(g.id, ext), brandDir(), { cacheControl: false });
  });

  // --- Compartir una prédica con un grupo -------------------------------------------
  const adminsOf = (gid, exceptUid) =>
    db.prepare("SELECT user_id FROM group_members WHERE group_id = ? AND role = 'admin' AND user_id != ?").all(gid, exceptUid).map((r) => r.user_id);
  app.post('/api/notes/:id/share', async (req, reply) => {
    const n = getNote(req.params.id, req.user.id);
    if (!n) return reply.code(404).send({ error: 'Solo puedes compartir tus propias notas' });
    const gid = Number(req.body?.groupId);
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
    const role = g && memberOf(g.id, req.user.id)?.role;
    if (!role) return reply.code(404).send({ error: 'Grupo no encontrado' });
    if (g.kind === 'iglesia' && role !== 'admin') return reply.code(403).send({ error: 'En un grupo de iglesia solo quien administra puede compartir prédicas' });
    const r = db.prepare('INSERT OR IGNORE INTO note_shares (note_id, group_id, shared_by) VALUES (?, ?, ?)').run(n.id, g.id, req.user.id);
    if (r.changes) {
      const to = db.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?').all(g.id, req.user.id).map((x) => x.user_id);
      notifyUsers?.(to, { title: `${g.name}: nueva prédica`, body: `${req.user.username} compartió «${n.title || 'una prédica'}»`, url: `/nota/${n.id}` });
    }
    return { shares: sharesOf(n.id) };
  });
  app.delete('/api/notes/:id/share/:gid', async (req, reply) => {
    const n = getNote(req.params.id, req.user.id);
    if (!n) return reply.code(404).send({ error: 'Nota no encontrada' });
    db.prepare('DELETE FROM note_shares WHERE note_id = ? AND group_id = ?').run(n.id, Number(req.params.gid));
    return { shares: sharesOf(n.id) };
  });

  // --- SPA -----------------------------------------------------------------
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'No encontrado' });
    return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html');
  });

  return app;
}
