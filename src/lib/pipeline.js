import fs from 'node:fs';
import path from 'node:path';
import { audioDir } from '../config.js';
import { indexNote } from '../db.js';
import * as media from './media.js';
import { bookCode, formatRef, getPassage } from './bible.js';
import * as stt from '../providers/transcribe.js';
import * as ai from '../providers/ai.js';

/** Dependencias inyectables para pruebas. */
export const deps = { media, stt, ai };

/** Resuelve las referencias que entrega la IA contra la RV1909 local. */
export function resolveVerses(db, list = []) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const code = bookCode(v.book);
    if (!code) continue;
    const vs = v.verse_start || 0;
    const ve = v.verse_end && v.verse_end >= vs ? v.verse_end : vs;
    const reference = formatRef(code, v.chapter, vs, ve);
    if (seen.has(reference)) continue;
    seen.add(reference);
    const passage = getPassage(db, { code, chapter: v.chapter, verseStart: vs, verseEnd: ve });
    out.push({ ...v, code, reference, found: Boolean(passage), verse_start: vs, verse_end: ve });
  }
  return out;
}

const studyInFlight = new Map();

/**
 * Estudio desarrollado (puntos con sustento bíblico) para el PDF. Se guarda dentro de
 * analysis_json.study; si ya existe no se vuelve a pagar. Llamadas simultáneas comparten resultado.
 */
export function ensureStudy(db, id) {
  if (studyInFlight.has(id)) return studyInFlight.get(id);
  const run = (async () => {
    const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!n?.analysis_json) throw new Error('La nota aún no está lista');
    const analysis = JSON.parse(n.analysis_json);
    if (analysis.study) return analysis;
    const { segments } = JSON.parse(n.transcript_json || '{"segments":[]}');
    const { study, costUsd } = await deps.ai.developStudy({ segments, analysis, serviceDate: n.preached_at });
    study.points = (study.points || []).map((p) => ({ ...p, verses: resolveVerses(db, p.verses || []).filter((v) => v.found) }));
    const [mv] = study.memory_verse ? resolveVerses(db, [study.memory_verse]) : [];
    study.memory_verse = mv?.found ? mv : null;
    // Releer por si la nota cambió mientras se generaba (p. ej. reprocesar).
    const cur = db.prepare('SELECT analysis_json FROM notes WHERE id = ?').get(id);
    if (!cur?.analysis_json) throw new Error('La nota cambió mientras se preparaba el estudio');
    const updated = { ...JSON.parse(cur.analysis_json), study };
    db.prepare("UPDATE notes SET analysis_json = ?, cost_json = json_set(cost_json, '$.study', ?) WHERE id = ?").run(JSON.stringify(updated), costUsd, id);
    return updated;
  })().finally(() => studyInFlight.delete(id));
  studyInFlight.set(id, run);
  return run;
}

const focusInFlight = new Map();
export const focusKey = (area) =>
  String(area || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

/** Aplica la prédica a un área (trabajo, intercesión…). Se guarda en analysis_json.focus[clave]. */
export function ensureFocus(db, id, area) {
  const key = focusKey(area);
  const k = `${id}:${key}`;
  if (focusInFlight.has(k)) return focusInFlight.get(k);
  const run = (async () => {
    const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!n?.analysis_json) throw new Error('La nota aún no está lista');
    const analysis = JSON.parse(n.analysis_json);
    if (analysis.focus?.[key]) return analysis.focus[key];
    const { segments } = JSON.parse(n.transcript_json || '{"segments":[]}');
    const { focus, costUsd } = await deps.ai.focusApplication({ segments, analysis, area: String(area).slice(0, 80), serviceDate: n.preached_at });
    focus.area = String(area).trim().slice(0, 80);
    focus.verses = resolveVerses(db, focus.verses || []).filter((v) => v.found);
    focus.created_at = new Date().toISOString();
    const cur = db.prepare('SELECT analysis_json FROM notes WHERE id = ?').get(id);
    if (!cur?.analysis_json) throw new Error('La nota cambió mientras se preparaba el enfoque');
    const updated = JSON.parse(cur.analysis_json);
    updated.focus = { ...(updated.focus || {}), [key]: focus };
    db.prepare(
      "UPDATE notes SET analysis_json = ?, cost_json = json_set(cost_json, '$.focus', round(coalesce(json_extract(cost_json, '$.focus'), 0) + ?, 4)) WHERE id = ?",
    ).run(JSON.stringify(updated), costUsd, id);
    return focus;
  })().finally(() => focusInFlight.delete(k));
  focusInFlight.set(k, run);
  return run;
}

export function createQueue(db, { log = console } = {}) {
  const pending = [];
  let running = false;

  const set = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE notes SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({
      ...fields,
      id,
    });
  };

  async function processNote(id) {
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!note) return;
    const dir = audioDir();
    fs.mkdirSync(dir, { recursive: true });
    const addCost = (key, usd) =>
      db.prepare("UPDATE notes SET cost_json = json_set(cost_json, '$.' || ?, ?) WHERE id = ?").run(key, usd, id);
    let { audio_file: audioFile, audio_mime: audioMime } = note;
    let hint = '';

    if (note.source_type === 'youtube' && !audioFile) {
      set(id, { status: 'downloading', error: '' });
      const vid = deps.media.youtubeId(note.source_url);
      const yt = await deps.media.downloadYoutube(vid, dir, id);
      audioFile = path.basename(yt.file);
      audioMime = yt.mime;
      hint = `Video de YouTube "${yt.title}" publicado por ${yt.uploader}`;
      set(id, {
        audio_file: audioFile,
        audio_mime: audioMime,
        duration_sec: yt.duration,
        title: note.title || yt.title,
        preached_at: yt.date || note.preached_at,
      });
    }

    const src = path.join(dir, audioFile);
    if (!audioFile || !fs.existsSync(src)) throw new Error('No se encontró el audio de la nota.');

    if (!note.transcript_json) {
      set(id, { status: 'transcribing', error: '' });
      const playable = await deps.media.ensurePlayable(src, audioMime, dir, id);
      audioFile = playable.file;
      const playPath = path.join(dir, audioFile);
      const duration = (await deps.media.probeDuration(playPath)) || note.duration_sec;
      set(id, { audio_file: audioFile, audio_mime: playable.mime, duration_sec: duration });

      const tmp = path.join(dir, `${id}.stt.ogg`);
      let sttFile = playPath;
      let sttMime = playable.mime;
      try {
        await deps.media.toTranscriptionAudio(playPath, tmp);
        sttFile = tmp;
        sttMime = 'audio/ogg';
      } catch (e) {
        log.warn?.(`ffmpeg no pudo comprimir ${id}, se envía el original: ${e.message}`);
      }
      try {
        const t = await deps.stt.transcribe(sttFile, sttMime);
        addCost('transcription', t.costUsd);
        set(id, {
          transcript_json: JSON.stringify({ segments: t.segments }),
          provider: t.provider,
          duration_sec: duration || t.duration,
        });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }

    const fresh = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
    set(id, { status: 'analyzing' });
    const { segments } = JSON.parse(fresh.transcript_json);
    const { analysis, costUsd } = await deps.ai.analyzeTranscript({ segments, serviceDate: fresh.preached_at, hint });
    analysis.verses = resolveVerses(db, analysis.verses);
    analysis.devotional = (analysis.devotional || []).map((d) => {
      const [r] = resolveVerses(db, [d]);
      return { ...d, reference: r?.reference || '', code: r?.code || '' };
    });
    addCost('analysis', costUsd);
    set(id, {
      analysis_json: JSON.stringify(analysis),
      title: fresh.title || analysis.title || 'Prédica sin título',
      preacher: fresh.preacher || analysis.preacher || '',
      status: 'ready',
    });
    indexNote(db, id);
    // El estudio para el PDF se prepara después: la nota ya se puede usar mientras tanto.
    try {
      await ensureStudy(db, id);
    } catch (e) {
      log.warn?.(`Estudio de ${id} no generado (se reintentará al pedir el PDF): ${e?.message ?? e}`);
    }
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const id = pending.shift();
        try {
          await processNote(id);
        } catch (e) {
          const msg = String(e?.message ?? e);
          log.error?.(`Nota ${id}: ${e?.stack || msg}`);
          try {
            set(id, { status: 'error', error: msg.slice(0, 500) });
          } catch {}
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(id) {
      if (!pending.includes(id)) pending.push(id);
      return drain();
    },
    resume() {
      const rows = db.prepare("SELECT id FROM notes WHERE status NOT IN ('ready', 'error') ORDER BY created_at").all();
      rows.forEach((r) => pending.push(r.id));
      return drain();
    },
    idle: () => !running && pending.length === 0,
  };
}
