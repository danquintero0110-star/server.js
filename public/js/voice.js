// Voz de Selah: hablar (síntesis del teléfono) y escuchar (clips que transcribe el servidor).
// Sin llaves extra: la voz usa las voces en español del propio teléfono.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

export const canSpeak = () => Boolean(synth && typeof SpeechSynthesisUtterance !== 'undefined');
export const canListen = () => Boolean(typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');

let chosen = null;
function voices() {
  return new Promise((resolve) => {
    const v = synth.getVoices();
    if (v.length) return resolve(v);
    const done = () => resolve(synth.getVoices());
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1200);
  });
}

/** La voz en español más natural disponible (prefiere Latinoamérica y voces "naturales"). */
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

/** Corta en frases (las voces de Android se cortan con textos largos). */
export function sentences(text) {
  const out = [];
  for (const s of forSpeech(text).match(/[^.!?¡¿;:]+[.!?;:]*|[¡¿][^.!?]+[.!?]*/g) || []) {
    const t = s.trim();
    if (!t) continue;
    const last = out[out.length - 1];
    if (last && (last.length < 40 || t.length < 12) && last.length + t.length < 220) out[out.length - 1] += ` ${t}`;
    else out.push(t);
  }
  return out;
}

let token = 0;
let keepAlive = 0;

/** Habla un texto. Devuelve una promesa que se cumple al terminar (o al detenerse). */
export async function speak(text, { rate = 1, onSentence } = {}) {
  if (!canSpeak()) return;
  const my = ++token;
  const voice = await pickVoice();
  const parts = sentences(text);
  for (let i = 0; i < parts.length; i++) {
    if (my !== token) return;
    onSentence?.(i, parts[i]);
    await sayOne(parts[i], voice, rate, my);
  }
}

function sayOne(t, voice, rate, my) {
  return new Promise((resolve) => {
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
  try {
    synth?.cancel();
  } catch {}
}

export const isSpeaking = () => Boolean(synth?.speaking);

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
  let voice = null;
  const ready = pickVoice().then((v) => (voice = v));

  async function pump() {
    if (playing) return;
    await ready;
    while (queue.length && my === token) {
      const t = queue.shift();
      onSentence?.(t);
      playing = sayOne(t, voice, rate, my);
      await playing;
      playing = null;
    }
    if (ended && !queue.length) resolveAll();
    if (my !== token) resolveAll();
  }
  function flush(force) {
    const re = /^([\s\S]*?[.!?;:])(\s|$)/;
    let m;
    while ((m = re.exec(buf)) && (m[1].length >= 30 || force)) {
      const t = forSpeech(m[1]);
      buf = buf.slice(m[0].length);
      if (t) queue.push(t);
    }
    if (force && forSpeech(buf)) {
      queue.push(forSpeech(buf));
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
