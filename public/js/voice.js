// Voz de Selah: hablar y escuchar.
// Hablar: voz humana del servidor (Deepgram Aura-2, p. ej. "Valerio"); si falla, la voz del teléfono.
// Escuchar: clips cortos que transcribe el servidor.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
const store = typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null, setItem() {} };

export const canSpeak = () => typeof Audio !== 'undefined' || Boolean(synth);
export const canListen = () => Boolean(typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');

// ---- Preferencia de voz ('device' = la del teléfono)
const VOICE_KEY = 'selah-voice-v2';
let serverDefault = '';
/** La voz predeterminada la decide el servidor (la de locutor si está configurada). */
export const setDefaultVoice = (id) => (serverDefault = id || '');
export const getVoiceId = () => store.getItem(VOICE_KEY) || serverDefault || '';
export const setVoiceId = (id) => store.setItem(VOICE_KEY, id);
let noteId = '';
/** Para registrar el costo de la voz en la nota que se está escuchando. */
export const setNoteContext = (id) => (noteId = id || '');
let cloudDownUntil = 0;
const useCloud = () => getVoiceId() !== 'device' && Date.now() > cloudDownUntil && typeof fetch !== 'undefined';

// ---- Voz del teléfono (respaldo)
let chosen = null;
function voices() {
  return new Promise((resolve) => {
    if (!synth) return resolve([]);
    const v = synth.getVoices();
    if (v.length) return resolve(v);
    const done = () => resolve(synth.getVoices());
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1200);
  });
}

/** La voz del teléfono en español más natural (prefiere Latinoamérica y voces "naturales"). */
export async function pickVoice() {
  if (chosen) return chosen;
  const list = (await voices()).filter((v) => /^es([-_]|$)/i.test(v.lang));
  const score = (v) =>
    (/natural|neural|online|premium|enhanced/i.test(v.name) ? 40 : 0) +
    (/google/i.test(v.name) ? 20 : 0) +
    (/es[-_](mx|us|419|co|ar|cl|pe)/i.test(v.lang) ? 15 : /es[-_]es/i.test(v.lang) ? 5 : 8) +
    (v.localService ? 2 : 0);
  chosen = list.sort((a, b) => score(b) - score(a))[0] || null;
  return chosen;
}

/** Convierte texto escrito en texto que suena bien al leerlo. */
export function forSpeech(text) {
  return String(text || '')
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '')
    .replace(/(\d)\s*:\s*(\d+)\s*[-–]\s*(\d+)/g, '$1, versículos $2 al $3')
    .replace(/(\d)\s*:\s*(\d+)/g, '$1, versículo $2')
    .replace(/[*_#>`~]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Corta en fragmentos de 2-3 frases (~300 caracteres): la voz fluye como una persona hablando
 * y hay menos uniones. El primero es más corto para que la voz empiece rápido.
 */
export function sentences(text, { target = 300, first = 160 } = {}) {
  const out = [];
  for (const s of forSpeech(text).match(/[^.!?¡¿;:]+[.!?;:]*|[¡¿][^.!?]+[.!?]*/g) || []) {
    const t = s.trim();
    if (!t) continue;
    const last = out[out.length - 1];
    const limit = out.length === 1 ? first : target;
    if (last && (last.length < 40 || t.length < 12 || last.length + t.length < limit) && last.length + t.length < 420) out[out.length - 1] += ` ${t}`;
    else if (t.length > 900) out.push(...(t.match(/.{1,700}(\s|$)/g) || [t]).map((x) => x.trim()));
    else out.push(t);
  }
  return out;
}

// ---- Voz humana del servidor
const cache = new Map(); // "voz|texto" → Promise<objectURL>
function cloudUrl(text, { prev = '', next = '' } = {}, voice = getVoiceId()) {
  const key = `${voice}|${text}`;
  if (cache.has(key)) return cache.get(key);
  const p = fetch('/api/tts', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, noteId, prev, next }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`tts ${r.status}`);
      return r.blob();
    })
    .then((b) => URL.createObjectURL(b));
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  if (cache.size > 80) {
    const [oldKey, oldP] = cache.entries().next().value;
    cache.delete(oldKey);
    oldP.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  }
  return p;
}
// Audios ya cargados y listos para sonar (sin hueco entre fragmentos).
const ready = new Map(); // objectURL → HTMLAudioElement
function preload(url) {
  if (ready.has(url) || typeof Audio === 'undefined') return;
  const a = new Audio();
  a.preload = 'auto';
  a.src = url;
  a.load();
  ready.set(url, a);
  if (ready.size > 6) ready.delete(ready.keys().next().value);
}
/** Pide y carga el audio por adelantado para que no haya pausas entre fragmentos. */
export function prefetch(text, ctx = {}) {
  if (text && useCloud()) cloudUrl(text, ctx).then(preload).catch(() => {});
}

let audioEl = null;
let stopCurrent = null;
let playingCloud = false;
function cloudSay(t, rate, my, ctx = {}) {
  return cloudUrl(t, ctx).then(
    (url) =>
      new Promise((resolve, reject) => {
        if (my !== token) return resolve();
        let a = ready.get(url);
        ready.delete(url);
        if (!a) {
          audioEl ||= new Audio();
          a = audioEl;
          a.src = url;
        }
        const finish = (err) => {
          a.onended = a.onerror = null;
          playingCloud = false;
          stopCurrent = null;
          err ? reject(err) : resolve();
        };
        stopCurrent = () => {
          a.pause();
          finish();
        };
        a.onended = () => finish();
        a.onerror = () => finish(new Error('audio'));
        a.playbackRate = rate;
        a.preservesPitch = true;
        playingCloud = true;
        a.play().catch(finish);
      }),
  );
}

let token = 0;
let keepAlive = 0;

/** Habla un texto. Devuelve una promesa que se cumple al terminar (o al detenerse). */
export async function speak(text, { rate = 1, onSentence, prev = '', next = '' } = {}) {
  if (!canSpeak()) return;
  const my = ++token;
  const parts = sentences(text);
  const ctx = (i) => ({ prev: i > 0 ? parts[i - 1] : prev, next: i < parts.length - 1 ? parts[i + 1] : next });
  prefetch(parts[0], ctx(0));
  prefetch(parts[1], ctx(1));
  for (let i = 0; i < parts.length; i++) {
    if (my !== token) return;
    prefetch(parts[i + 1], ctx(i + 1));
    onSentence?.(i, parts[i]);
    await sayOne(parts[i], rate, my, ctx(i));
  }
}

async function sayOne(t, rate, my, ctx = {}) {
  if (useCloud()) {
    try {
      return await cloudSay(t, rate, my, ctx);
    } catch {
      if (my !== token) return;
      cloudDownUntil = Date.now() + 60000; // un minuto con la voz del teléfono y se reintenta
    }
  }
  return deviceSay(t, await pickVoice(), rate, my);
}

function deviceSay(t, voice, rate, my) {
  return new Promise((resolve) => {
    if (!synth || my !== token) return resolve();
    const u = new SpeechSynthesisUtterance(t);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'es-MX';
    u.rate = rate;
    u.pitch = 1;
    let doneCalled = false;
    const done = () => {
      if (doneCalled) return;
      doneCalled = true;
      clearInterval(keepAlive);
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    // Algunos navegadores se "duermen" a los ~15 s: se les da un empujón.
    clearInterval(keepAlive);
    keepAlive = setInterval(() => {
      if (my !== token) return done();
      if (!synth.speaking) return done();
      synth.pause();
      synth.resume();
    }, 10000);
    synth.speak(u);
  });
}

export function stopSpeaking() {
  token++;
  clearInterval(keepAlive);
  stopCurrent?.();
  try {
    synth?.cancel();
  } catch {}
}

export const isSpeaking = () => playingCloud || Boolean(synth?.speaking);

/** Escucha una muestra de una voz. */
export async function previewVoice(id) {
  const prev = getVoiceId();
  setVoiceId(id);
  try {
    await speak('Hola, soy Selah. Qué gusto acompañarte. Vamos juntos a la palabra de Dios.');
  } finally {
    setVoiceId(prev);
  }
}

/**
 * Habla mientras llega el texto (streaming del chat): dice cada frase en cuanto se completa.
 * feed(delta) → agrega texto; end() → dice lo que falte y resuelve al terminar.
 */
export function streamSpeaker({ rate = 1, onSentence } = {}) {
  const my = ++token;
  let buf = '';
  const queue = [];
  let playing = null;
  let ended = false;
  let resolveAll;
  const all = new Promise((r) => (resolveAll = r));

  let lastSaid = '';
  async function pump() {
    if (playing) return;
    while (queue.length && my === token) {
      const t = queue.shift();
      if (queue[0]) prefetch(queue[0], { prev: t });
      onSentence?.(t);
      playing = sayOne(t, rate, my, { prev: lastSaid, next: queue[0] || '' });
      lastSaid = t;
      await playing;
      playing = null;
    }
    if (ended && !queue.length) resolveAll();
    if (my !== token) resolveAll();
  }
  let count = 0;
  function enqueue(t) {
    queue.push(t);
    prefetch(t, { prev: queue[queue.length - 2] || lastSaid });
    count++;
  }
  function flush(force) {
    // La primera frase sale en cuanto está lista; las demás se juntan (~2 frases) para que fluya.
    let m;
    while ((m = (count === 0 ? /^([\s\S]*?[.!?;:])(\s|$)/ : /^([\s\S]{140,}?[.!?;:])(\s|$)/).exec(buf)) && (m[1].length >= 30 || force)) {
      const t = forSpeech(m[1]);
      buf = buf.slice(m[0].length);
      if (t) enqueue(t);
    }
    if (force && forSpeech(buf)) {
      enqueue(forSpeech(buf));
      buf = '';
    }
    pump();
  }
  return {
    feed(delta) {
      buf += delta;
      flush(false);
    },
    end() {
      ended = true;
      flush(true);
      if (!queue.length && !playing) resolveAll();
      return all;
    },
  };
}

/** Graba un clip corto desde el micrófono. stop() → Blob. level() → 0..1 para animar. */
export async function startClip({ maxMs = 90000 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  const rec = new MediaRecorder(stream, { ...(mime && { mimeType: mime }), audioBitsPerSecond: 32000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  rec.start(250);
  const started = performance.now();
  let stopped = null;
  const stop = () => {
    if (stopped) return stopped;
    stopped = new Promise((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        resolve(new Blob(chunks, { type: (mime || 'audio/webm').split(';')[0] }));
      };
      rec.state !== 'inactive' ? rec.stop() : rec.onstop();
    });
    return stopped;
  };
  const timer = setTimeout(stop, maxMs);
  return {
    stop: () => (clearTimeout(timer), stop()),
    cancel: () => (clearTimeout(timer), stop().then(() => null)),
    level() {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    },
    elapsed: () => (performance.now() - started) / 1000,
  };
}

/** Compara lo recitado con el versículo: devuelve { score 0..100, missing: [palabras] }. */
export function compareRecital(target, said) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9ñ\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const a = norm(target);
  const b = norm(said);
  if (!a.length) return { score: 0, missing: [] };
  // Subsecuencia común más larga palabra por palabra.
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hit = new Set();
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      hit.add(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const missing = [];
  let k = 0;
  for (const w of String(target).split(/\s+/)) {
    const n = norm(w).length;
    if (!n) continue;
    let ok = true;
    for (let t = 0; t < n; t++) if (!hit.has(k + t)) ok = false;
    if (!ok) missing.push(w);
    k += n;
  }
  return { score: Math.round((hit.size / a.length) * 100), missing };
}
