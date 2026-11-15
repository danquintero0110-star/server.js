// Grabadora del navegador.
// Interfaz común (Fase 2: un plugin nativo de Android implementará la misma forma
// para grabar con la pantalla apagada): start(), pause(), resume(), stop() → Blob,
// discard(), level() → 0..1, elapsed() → segundos, state.
//
// Los fragmentos se guardan en IndexedDB cada 5 s para no perder una prédica
// si el navegador se cierra o el teléfono se queda sin batería.

const DB = 'selah-rec';
const STORE = 'chunks';

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}
const clearChunks = () => tx('readwrite', (s) => s.clear()).catch(() => {});

/** ¿Quedó una grabación interrumpida? Devuelve { blob, seconds } o null. */
export async function pendingRecording() {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    if (!all?.length) return null;
    const meta = all.find((x) => x.meta)?.meta || {};
    const parts = all.filter((x) => x.blob).map((x) => x.blob);
    if (!parts.length) return null;
    return { blob: new Blob(parts, { type: meta.mime || parts[0].type }), seconds: meta.seconds || 0, mime: meta.mime };
  } catch {
    return null;
  }
}
export const discardPending = clearChunks;

function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'];
  return opts.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

export function isSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export class WebRecorder {
  state = 'idle';
  #rec;
  #stream;
  #chunks = [];
  #ctx;
  #analyser;
  #buf;
  #startedAt = 0;
  #accum = 0;
  #wake;
  #metaKey = null;

  async start() {
    await clearChunks();
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const mime = pickMime();
    this.mime = mime.split(';')[0] || 'audio/webm';
    this.#rec = new MediaRecorder(this.#stream, { ...(mime && { mimeType: mime }), audioBitsPerSecond: 64000 });
    this.#rec.ondataavailable = (e) => {
      if (!e.data?.size) return;
      this.#chunks.push(e.data);
      tx('readwrite', (s) => s.add({ blob: e.data })).catch(() => {});
      this.#saveMeta();
    };
    this.#rec.start(5000);
    this.#ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.#ctx.createMediaStreamSource(this.#stream);
    this.#analyser = this.#ctx.createAnalyser();
    this.#analyser.fftSize = 512;
    this.#buf = new Uint8Array(this.#analyser.fftSize);
    src.connect(this.#analyser);
    this.#startedAt = performance.now();
    this.state = 'recording';
    this.#lock();
    document.addEventListener('visibilitychange', this.#onVis);
  }

  #onVis = () => {
    if (document.visibilityState === 'visible' && this.state === 'recording') this.#lock();
  };

  async #lock() {
    try {
      this.#wake = await navigator.wakeLock?.request('screen');
    } catch {}
  }

  #saveMeta() {
    const meta = { mime: this.mime, seconds: Math.round(this.elapsed()) };
    tx('readwrite', (s) => {
      if (this.#metaKey != null) s.put({ meta }, this.#metaKey);
      else {
        const r = s.add({ meta });
        r.onsuccess = () => (this.#metaKey = r.result);
      }
    }).catch(() => {});
  }

  pause() {
    if (this.state !== 'recording') return;
    this.#rec.pause();
    this.#accum += performance.now() - this.#startedAt;
    this.state = 'paused';
  }
  resume() {
    if (this.state !== 'paused') return;
    this.#rec.resume();
    this.#startedAt = performance.now();
    this.state = 'recording';
  }
  elapsed() {
    return (this.#accum + (this.state === 'recording' ? performance.now() - this.#startedAt : 0)) / 1000;
  }
  level() {
    if (!this.#analyser || this.state !== 'recording') return 0;
    this.#analyser.getByteTimeDomainData(this.#buf);
    let sum = 0;
    for (const v of this.#buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.#buf.length) * 4);
  }
  stop() {
    return new Promise((resolve) => {
      if (!this.#rec) return resolve(null);
      this.#rec.onstop = () => {
        this.#cleanup();
        resolve(new Blob(this.#chunks, { type: this.mime }));
      };
      this.elapsedFinal = this.elapsed();
      this.#rec.stop();
    });
  }
  async discard() {
    if (this.#rec && this.#rec.state !== 'inactive') this.#rec.stop();
    this.#cleanup();
    await clearChunks();
  }
  /** Llamar cuando la subida terminó bien. */
  done() {
    return clearChunks();
  }
  #cleanup() {
    this.state = 'idle';
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#ctx?.close().catch(() => {});
    this.#wake?.release?.().catch(() => {});
    document.removeEventListener('visibilitychange', this.#onVis);
  }
}
