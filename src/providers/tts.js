// Voz humana de Selah con Deepgram Aura-2 (misma llave que la transcripción).
import { config } from '../config.js';

export const VOICES = {
  valerio: { model: 'aura-2-valerio-es', label: 'Valerio', desc: 'Grave, cálida y natural · México', gender: 'm' },
  javier: { model: 'aura-2-javier-es', label: 'Javier', desc: 'Tranquila y amigable · Latinoamérica', gender: 'm' },
  luciano: { model: 'aura-2-luciano-es', label: 'Luciano', desc: 'Carismática y alegre · México', gender: 'm' },
  aquila: { model: 'aura-2-aquila-es', label: 'Áquila', desc: 'Cercana y expresiva · Latinoamérica', gender: 'm' },
  estrella: { model: 'aura-2-estrella-es', label: 'Estrella', desc: 'Serena y cálida · México', gender: 'f' },
  olivia: { model: 'aura-2-olivia-es', label: 'Olivia', desc: 'Suave y cercana · México', gender: 'f' },
};
export const DEFAULT_VOICE = 'valerio';
// USD por cada 1000 caracteres (Aura-2).
const PRICE_PER_KCHAR = 0.03;

export const ttsAvailable = () => Boolean(process.env.DEEPGRAM_API_KEY);

/** Devuelve { audio: Buffer (mp3), costUsd }. */
export async function synthesize(text, voice = DEFAULT_VOICE) {
  const v = VOICES[voice] || VOICES[DEFAULT_VOICE];
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${v.model}&encoding=mp3`, {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(config.ttsTimeoutMs || 30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Deepgram TTS respondió ${res.status}: ${body.slice(0, 300)}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  return { audio, costUsd: Math.round((text.length / 1000) * PRICE_PER_KCHAR * 10000) / 10000 };
}
