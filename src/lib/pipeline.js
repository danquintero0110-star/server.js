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
    const cost = JSON.parse(note.cost_json || '{}');
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
        cost.transcription = t.costUsd;
        set(id, {
          transcript_json: JSON.stringify({ segments: t.segments }),
          provider: t.provider,
          duration_sec: duration || t.duration,
          cost_json: JSON.stringify(cost),
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
    cost.analysis = costUsd;
    set(id, {
      analysis_json: JSON.stringify(analysis),
      title: fresh.title || analysis.title || 'Prédica sin título',
      preacher: fresh.preacher || analysis.preacher || '',
      status: 'ready',
      cost_json: JSON.stringify(cost),
    });
    indexNote(db, id);
  }

  async function drain() {
    if (running) return;
    running = true;
    while (pending.length) {
      const id = pending.shift();
      try {
        await processNote(id);
      } catch (e) {
        log.error?.(`Nota ${id}: ${e.stack || e.message}`);
        set(id, { status: 'error', error: e.message.slice(0, 500) });
      }
    }
    running = false;
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
