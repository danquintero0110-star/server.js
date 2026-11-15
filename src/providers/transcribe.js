import fs from 'node:fs';
import { config } from '../config.js';

// Precios de referencia (USD por minuto) para estimar el costo por nota.
const PRICE_PER_MIN = { deepgram: 0.0043, elevenlabs: 0.0067, openai: 0.006 };

export function availableProvider(env = process.env) {
  const order = ['deepgram', 'elevenlabs', 'openai'];
  const keys = { deepgram: 'DEEPGRAM_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', openai: 'OPENAI_API_KEY' };
  const forced = config.transcribe.provider;
  if (forced) return env[keys[forced]] ? forced : null;
  return order.find((p) => env[keys[p]]) || null;
}

/** Agrupa palabras con tiempo en frases legibles para la transcripción sincronizada. */
export function groupWords(words, { maxChars = 220, pause = 1.1 } = {}) {
  const segments = [];
  let cur = null;
  for (const w of words) {
    const text = String(w.text ?? w.word ?? '').trim();
    if (!text) continue;
    if (!cur) cur = { start: w.start, end: w.end, text: '' };
    else if (w.start - cur.end > pause || cur.text.length > maxChars) {
      segments.push(cur);
      cur = { start: w.start, end: w.end, text: '' };
    }
    cur.text += (cur.text && !/^[,.;:!?¡¿)]/.test(text) ? ' ' : '') + text;
    cur.end = w.end;
    if (/[.!?]$/.test(text) && cur.text.length > 60) {
      segments.push(cur);
      cur = null;
    }
  }
  if (cur) segments.push(cur);
  return segments.map((s) => ({ start: round(s.start), end: round(s.end), text: s.text.trim() }));
}

const round = (n) => Math.round(Number(n || 0) * 100) / 100;

async function check(res, name) {
  if (res.ok) return res.json();
  const body = await res.text().catch(() => '');
  throw new Error(`${name} respondió ${res.status}: ${body.slice(0, 400)}`);
}

async function deepgram(file, mime) {
  const params = new URLSearchParams({
    model: config.transcribe.deepgramModel,
    language: 'es',
    smart_format: 'true',
    punctuate: 'true',
    paragraphs: 'true',
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': mime },
    body: fs.createReadStream(file),
    duplex: 'half',
  });
  const data = await check(res, 'Deepgram');
  const alt = data.results?.channels?.[0]?.alternatives?.[0] || {};
  const paragraphs = alt.paragraphs?.paragraphs || [];
  let segments = paragraphs.flatMap((p) => p.sentences.map((s) => ({ start: round(s.start), end: round(s.end), text: s.text })));
  if (!segments.length && alt.words) segments = groupWords(alt.words.map((w) => ({ ...w, text: w.punctuated_word || w.word })));
  return { segments, duration: data.metadata?.duration || 0 };
}

async function elevenlabs(file, mime) {
  const form = new FormData();
  form.append('model_id', config.transcribe.elevenlabsModel);
  form.append('language_code', 'spa');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), 'audio');
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    body: form,
  });
  const data = await check(res, 'ElevenLabs');
  const words = (data.words || []).filter((w) => w.type === 'word');
  const segments = groupWords(words);
  return { segments, duration: words.length ? words[words.length - 1].end : 0 };
}

async function openai(file, mime) {
  const form = new FormData();
  form.append('model', config.transcribe.openaiModel);
  form.append('language', 'es');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), 'audio.ogg');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await check(res, 'OpenAI');
  const segments = (data.segments || []).map((s) => ({ start: round(s.start), end: round(s.end), text: s.text.trim() }));
  return { segments, duration: data.duration || 0 };
}

const PROVIDERS = { deepgram, elevenlabs, openai };

export async function transcribe(file, mime = 'audio/ogg') {
  const provider = availableProvider();
  if (!provider) throw new Error('No hay llave de transcripción configurada (DEEPGRAM_API_KEY, ELEVENLABS_API_KEY u OPENAI_API_KEY).');
  const { segments, duration } = await PROVIDERS[provider](file, mime);
  if (!segments.length) throw new Error('La transcripción llegó vacía. ¿El audio tiene voz?');
  const minutes = (duration || segments[segments.length - 1].end) / 60;
  return { provider, segments, duration, costUsd: round(minutes * PRICE_PER_MIN[provider]) };
}
