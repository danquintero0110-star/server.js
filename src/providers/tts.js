// Voz humana de Selah.
// - ElevenLabs (voces de locutor, requiere ELEVENLABS_API_KEY).
// - Deepgram Aura-2 (misma llave que la transcripción) como respaldo.
import { config } from '../config.js';

export const VOICES = {
  // ElevenLabs: voz diseñada en la cuenta del dueño (funciona en el plan gratis).
  selah: { provider: 'eleven', id: process.env.ELEVENLABS_VOICE_ID || 'BDadAH8WNdVe8MyC96Bg', label: 'Selah', desc: 'Locutor grave, cálido y sereno', gender: 'm' },
  // Voces de la biblioteca de ElevenLabs: requieren plan de pago (ELEVENLABS_LIBRARY=1 para ofrecerlas).
  faraon: { provider: 'eleven', library: true, id: 'W1hAcdh0RNsPYUA7fkJh', label: 'El Faraón', desc: 'Grave, cálida y cercana · Colombia', gender: 'm' },
  zabra: { provider: 'eleven', library: true, id: 'G6LT3kjUUW86fQaWfBaj', label: 'Zabra', desc: 'Locutor grave y sereno · México', gender: 'm' },
  // Deepgram Aura-2.
  valerio: { provider: 'deepgram', id: 'aura-2-valerio-es', label: 'Valerio', desc: 'Grave y natural · México', gender: 'm' },
  javier: { provider: 'deepgram', id: 'aura-2-javier-es', label: 'Javier', desc: 'Tranquila y amigable · Latinoamérica', gender: 'm' },
  estrella: { provider: 'deepgram', id: 'aura-2-estrella-es', label: 'Estrella', desc: 'Serena y cálida · México', gender: 'f' },
  olivia: { provider: 'deepgram', id: 'aura-2-olivia-es', label: 'Olivia', desc: 'Suave y cercana · México', gender: 'f' },
};

const hasEleven = () => Boolean(process.env.ELEVENLABS_API_KEY);
const hasDeepgram = () => Boolean(process.env.DEEPGRAM_API_KEY);
const usable = (v) => (v.provider === 'eleven' ? hasEleven() && (!v.library || process.env.ELEVENLABS_LIBRARY === '1') : hasDeepgram());

export const ttsAvailable = () => hasEleven() || hasDeepgram();
export const availableVoices = () => Object.entries(VOICES).filter(([, v]) => usable(v));
export function defaultVoice() {
  const pref = process.env.SELAH_VOICE;
  if (pref && VOICES[pref] && usable(VOICES[pref])) return pref;
  return hasEleven() ? 'selah' : 'valerio';
}
export const resolveVoice = (id) => (VOICES[id] && usable(VOICES[id]) ? id : defaultVoice());

// Costo aproximado en USD por 1000 caracteres.
// ElevenLabs Turbo usa medio crédito por carácter (plan gratis: 10 000 créditos al mes).
const PRICE = { eleven: 0.05, deepgram: 0.03 };

async function eleven(text, v) {
  const model = process.env.ELEVENLABS_TTS_MODEL || 'eleven_turbo_v2_5';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.id}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.6, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true, speed: 0.94 },
    }),
    signal: AbortSignal.timeout(config.ttsTimeoutMs || 30000),
  });
  if (!res.ok) throw new Error(`ElevenLabs respondió ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function deepgram(text, v) {
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${v.id}&encoding=mp3`, {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(config.ttsTimeoutMs || 30000),
  });
  if (!res.ok) throw new Error(`Deepgram TTS respondió ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Devuelve { audio: Buffer (mp3), costUsd, voice } — si ElevenLabs falla (p. ej. sin créditos), usa Deepgram. */
export async function synthesize(text, voiceId) {
  const id = resolveVoice(voiceId);
  const v = VOICES[id];
  const cost = (p) => Math.round((text.length / 1000) * PRICE[p] * 10000) / 10000;
  if (v.provider === 'eleven') {
    try {
      return { audio: await eleven(text, v), costUsd: cost('eleven'), voice: id };
    } catch (e) {
      if (!hasDeepgram()) throw e;
      lastElevenError = e.message;
      return { audio: await deepgram(text, VOICES.valerio), costUsd: cost('deepgram'), voice: 'valerio', fallback: true };
    }
  }
  return { audio: await deepgram(text, v), costUsd: cost('deepgram'), voice: id };
}
export let lastElevenError = '';
