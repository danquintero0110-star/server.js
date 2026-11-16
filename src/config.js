import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carga .env local si existe (en producción systemd usa EnvironmentFile).
const envFile = process.env.SELAH_ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const env = process.env;

export const config = {
  port: Number(env.PORT || 3070),
  host: env.HOST || '127.0.0.1',
  dataDir: path.resolve(env.SELAH_DATA_DIR || path.join(ROOT, 'data', 'runtime')),
  publicDir: path.join(ROOT, 'public'),
  bibleFile: path.join(ROOT, 'data', 'bible', 'spaRV1909_vpl.txt.gz'),
  cookieSecure: env.COOKIE_SECURE !== 'false',
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 2048),
  // Espacio que siempre debe quedar libre en el disco (servidor compartido).
  minFreeMb: Number(env.MIN_FREE_MB || 1536),
  ai: {
    model: env.AI_MODEL || 'claude-opus-5-5',
    effort: env.AI_EFFORT || 'medium',
    chatEffort: env.AI_CHAT_EFFORT || 'low',
  },
  transcribe: {
    provider: env.TRANSCRIBE_PROVIDER || '', // deepgram | elevenlabs | openai ('' = automático)
    elevenlabsModel: env.ELEVENLABS_STT_MODEL || 'scribe_v1',
    deepgramModel: env.DEEPGRAM_MODEL || 'nova-3',
    openaiModel: env.OPENAI_STT_MODEL || 'whisper-1',
  },
  bin: {
    ffmpeg: env.FFMPEG_BIN || 'ffmpeg',
    ffprobe: env.FFPROBE_BIN || 'ffprobe',
    ytdlp: env.YTDLP_BIN || 'yt-dlp',
  },
};

export function audioDir() {
  return path.join(config.dataDir, 'audio');
}
