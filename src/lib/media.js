import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

function run(bin, args, { timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', (e) => {
      clearTimeout(t);
      reject(new Error(`${path.basename(bin)} no disponible: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(bin)} falló (${code}): ${err.slice(-600)}`));
    });
  });
}

export async function probeDuration(file) {
  try {
    const out = await run(config.bin.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      timeoutMs: 60_000,
    });
    const d = parseFloat(out.trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

/** Audio compacto para transcripción: Opus mono 16 kHz, ~24 kbps (45 min ≈ 8 MB). */
export async function toTranscriptionAudio(input, output) {
  await run(config.bin.ffmpeg, ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', output]);
  return output;
}

const PLAYABLE = new Set(['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/webm']);
// Por encima de esto se comprime aunque sea reproducible (p. ej. MP3 de alta calidad de 3 horas).
const MAX_KEEP_BYTES = 120 * 1048576;

/**
 * Garantiza un archivo reproducible en cualquier navegador (Safari incluido) y liviano:
 * video, WAV, FLAC o archivos muy pesados se convierten a AAC mono 64 kbps (45 min ≈ 22 MB)
 * y se borra el original para no llenar el disco.
 */
export async function ensurePlayable(input, mime, outDir, id) {
  const base = (mime || '').split(';')[0];
  let size = 0;
  try {
    size = fs.statSync(input).size;
  } catch {}
  if (PLAYABLE.has(base) && size <= MAX_KEEP_BYTES) return { file: path.basename(input), mime: base };
  const out = path.join(outDir, `${id}-play.m4a`);
  await run(config.bin.ffmpeg, ['-y', '-i', input, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out]);
  fs.rmSync(input, { force: true });
  return { file: path.basename(out), mime: 'audio/mp4' };
}

const YT_RE = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i;

export function youtubeId(url) {
  const m = YT_RE.exec(String(url || '').trim());
  return m ? m[1] : null;
}

export async function downloadYoutube(videoId, outDir, id) {
  const tpl = path.join(outDir, `${id}.%(ext)s`);
  const cleanup = () => fs.readdirSync(outDir).filter((f) => f.startsWith(`${id}.`)).forEach((f) => fs.rmSync(path.join(outDir, f), { force: true }));
  const out = await run(
    config.bin.ytdlp,
    [
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '--no-playlist', '--no-progress', '--match-filters', '!is_live',
      '--print', 'after_move:%(filepath)s\t%(title)s\t%(duration)s\t%(uploader)s\t%(upload_date)s',
      '-o', tpl,
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    { timeoutMs: 60 * 60_000 },
  ).catch((e) => {
    cleanup();
    throw e;
  });
  const line = out.trim().split('\n').pop() || '';
  const [filepath, title, duration, uploader, uploadDate] = line.split('\t');
  if (!filepath || !fs.existsSync(filepath)) {
    cleanup();
    throw new Error('yt-dlp no produjo audio. Si es una transmisión en vivo, espera a que termine.');
  }
  const ext = path.extname(filepath).slice(1);
  return {
    file: filepath,
    mime: ext === 'm4a' ? 'audio/mp4' : ext === 'webm' ? 'audio/webm' : `audio/${ext}`,
    title: title || '',
    duration: Number(duration) || 0,
    uploader: uploader || '',
    date: /^\d{8}$/.test(uploadDate || '') ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6)}` : '',
  };
}
