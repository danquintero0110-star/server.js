// "Selah habla": escuchar el estudio, conversar por voz, devocional guiado y memorizar el versículo.
import { api } from './api.js';
import { h, icon, toast, vibrate } from './ui.js';
import * as V from './voice.js';

const RATE_KEY = 'selah-voice-rate';
const rate = () => Number(localStorage.getItem(RATE_KEY)) || 1;

async function passageText(v) {
  if (!v?.code) return '';
  try {
    const p = await api.get(`/api/bible?code=${v.code}&chapter=${v.chapter}&from=${v.verse_start || 0}&to=${v.verse_end || 0}`);
    return p.verses.map((x) => x.text).join(' ');
  } catch {
    return '';
  }
}

const firstName = (me) => {
  const n = String(me?.username || '').split(/[\s._-]/)[0];
  return n ? n[0].toUpperCase() + n.slice(1) : '';
};

// ------------------------------------------------------------------ Escenario
/** Pantalla completa con el orbe que respira, escucha y habla. */
function stage({ eyebrow, onClose }) {
  const canvas = h('canvas');
  const core = h('div', { class: 'core' });
  const caption = h('p', { class: 'v-caption' });
  const sub = h('p', { class: 'v-sub' });
  const status = h('p', { class: 'v-status' });
  const controls = h('footer', { class: 'v-controls' });
  const extra = h('div', { class: 'v-extra' });
  const orb = h('button', { class: 'orb v-orb', 'aria-label': 'Selah' }, canvas, core);
  const el = h(
    'div',
    { class: 'vstage', role: 'dialog', 'aria-modal': 'true' },
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Cerrar', onclick: () => close() }, icon('x')),
      h('span', { class: 'eyebrow' }, eyebrow),
      h('span', { style: { width: '44px' } }),
    ),
    h('section', { class: 'v-center' }, orb, status, caption, sub, extra),
    controls,
  );
  let mode = 'idle'; // idle | speaking | listening | thinking
  let levelFn = null;
  let raf;
  let smooth = 0;
  const levels = new Array(64).fill(0);
  const ctx = canvas.getContext('2d');
  function draw() {
    const dpr = devicePixelRatio || 1;
    const w = (canvas.width = canvas.clientWidth * dpr);
    const hh = (canvas.height = canvas.clientHeight * dpr);
    const t = performance.now();
    let lv = 0;
    if (mode === 'listening' && levelFn) lv = levelFn();
    else if (mode === 'speaking') lv = 0.18 + 0.16 * Math.abs(Math.sin(t / 180)) * Math.abs(Math.sin(t / 470 + 1));
    else if (mode === 'thinking') lv = 0.06 + 0.05 * Math.sin(t / 260);
    else lv = 0.03 + 0.03 * Math.sin(t / 900);
    smooth += (lv - smooth) * 0.22;
    levels.push(smooth);
    levels.shift();
    core.style.transform = `scale(${1 + smooth * 0.22})`;
    ctx.clearRect(0, 0, w, hh);
    const cx = w / 2;
    const cy = hh / 2;
    const base = Math.min(w, hh) * 0.3;
    const css = getComputedStyle(document.documentElement);
    const color = mode === 'listening' ? css.getPropertyValue('--rose').trim() || '#e08a83' : css.getPropertyValue('--amber').trim() || '#f0a948';
    for (let ring = 0; ring < 3; ring++) {
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2 - Math.PI / 2;
        const v = levels[63 - Math.min(i, 64 - i) - ring * 4] || 0;
        const spin = mode === 'thinking' ? t / 400 : t / (700 + ring * 300);
        const r = base + ring * base * 0.22 + v * base * (0.55 - ring * 0.12) + Math.sin(a * 3 + spin) * 3 * dpr;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55 - ring * 0.15;
      ctx.lineWidth = (2 - ring * 0.4) * dpr;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(draw);
  }
  let closed = false;
  const onPop = () => close();
  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    V.stopSpeaking();
    api_finish?.();
    window.removeEventListener('popstate', onPop);
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
    onClose?.();
  }
  let api_finish = null;
  document.body.append(el);
  window.addEventListener('popstate', onPop);
  draw();
  return {
    el,
    orb,
    get closed() {
      return closed;
    },
    setMode(m, fn = null) {
      mode = m;
      levelFn = fn;
      el.dataset.mode = m;
    },
    caption(text, { big = true } = {}) {
      caption.classList.toggle('small', !big);
      caption.textContent = text || '';
      caption.classList.remove('in');
      void caption.offsetWidth;
      caption.classList.add('in');
    },
    sub: (t) => (sub.textContent = t || ''),
    status: (t) => (status.textContent = t || ''),
    controls: (...nodes) => controls.replaceChildren(...nodes.flat().filter(Boolean)),
    extra: (...nodes) => extra.replaceChildren(...nodes.flat().filter(Boolean)),
    close,
    /** Termina la escucha en curso (si la hay). Devuelve true si había una. */
    finishListening() {
      if (!api_finish) return false;
      api_finish();
      return true;
    },
    set finisher(fn) {
      api_finish = fn;
    },
  };
}

function speedButton() {
  const speeds = [0.9, 1, 1.15, 1.3];
  const b = h('button', { class: 'icon-btn v-speed', 'aria-label': 'Velocidad' }, `${rate()}×`);
  b.onclick = () => {
    const i = (speeds.indexOf(rate()) + 1) % speeds.length;
    localStorage.setItem(RATE_KEY, speeds[i]);
    b.textContent = `${speeds[i]}×`;
    vibrate(5);
  };
  return b;
}

/** Escucha hasta que la persona deja de hablar (o toca para terminar). Devuelve el texto. */
async function listenTurn(st, note, { prompt = 'Te escucho…', silenceMs = 1500, maxWaitMs = 9000 } = {}) {
  let clip;
  try {
    clip = await V.startClip({ maxMs: 90000 });
  } catch {
    toast('Permite el micrófono para platicar con Selah', { error: true, ms: 4500 });
    return null;
  }
  vibrate(12);
  st.setMode('listening', clip.level);
  st.status(prompt);
  let spoke = false;
  let quietSince = performance.now();
  const started = performance.now();
  await new Promise((resolve) => {
    const finish = () => {
      clearInterval(iv);
      st.finisher = null;
      resolve();
    };
    st.finisher = finish;
    const iv = setInterval(() => {
      if (st.closed) return finish();
      const lv = clip.level();
      const now = performance.now();
      if (lv > 0.09) {
        spoke = true;
        quietSince = now;
      }
      if (spoke && now - quietSince > silenceMs) finish();
      if (!spoke && now - started > maxWaitMs) finish();
    }, 100);
  });
  const blob = await clip.stop();
  if (st.closed) return null;
  if (!spoke) {
    st.setMode('idle');
    return '';
  }
  st.setMode('thinking');
  st.status('Escuchando lo que dijiste…');
  try {
    return await api.listen(note.id, blob);
  } catch (e) {
    toast(e.status ? e.message : 'Sin conexión', { error: true });
    st.setMode('idle');
    return null;
  }
}

/** Selah responde por voz mientras llega la respuesta. */
async function answerTurn(st, note, question, { mode = 'voz', day } = {}) {
  st.setMode('thinking');
  st.status('Selah está pensando…');
  const sp = V.streamSpeaker({ rate: rate(), onSentence: (t) => (st.setMode('speaking'), st.status(''), st.caption(t)) });
  let final = '';
  try {
    final = await api.chat(note.id, question, { mode, day, onDelta: (d) => sp.feed(d) });
  } catch (e) {
    sp.end();
    toast(e.status ? e.message : 'Sin conexión', { error: true });
    st.setMode('idle');
    return '';
  }
  await sp.end();
  if (!st.closed) st.setMode('idle');
  return final;
}

async function say(st, text, opts = {}) {
  st.setMode('speaking');
  await V.speak(text, { rate: rate(), onSentence: (_, s) => st.caption(s, opts) });
  if (!st.closed) st.setMode('idle');
}

// ------------------------------------------------------------------ 1. Escuchar el estudio
async function buildScript(note) {
  const a = note.analysis;
  const s = a.study;
  const parts = [{ label: 'Inicio', text: `${note.title}. ${a.central_idea}` }];
  if (s?.introduction) parts.push({ label: 'Introducción', text: s.introduction });
  const points = s?.points?.length ? s.points : a.main_points.map((p) => ({ ...p, development: p.detail, verses: [] }));
  for (const [i, p] of points.entries()) {
    let text = `Punto ${i + 1}. ${p.title}. ${p.development}`;
    for (const v of p.verses || []) {
      const t = await passageText(v);
      if (t) text += ` ${v.reference}. ${t}`;
    }
    if (p.reflection_question) text += ` Para reflexionar: ${p.reflection_question}`;
    parts.push({ label: `Punto ${i + 1}`, text });
  }
  if (a.practical_application?.length) parts.push({ label: 'Aplicación', text: `Para aplicar esta semana. ${a.practical_application.join('. ')}.` });
  if (s?.conclusion) parts.push({ label: 'Conclusión', text: s.conclusion });
  if (s?.prayer) parts.push({ label: 'Oración', text: `Oremos. ${s.prayer}` });
  return parts.map((p) => ({ ...p, lines: V.sentences(p.text) }));
}

async function listenStudy(note) {
  const st = stage({ eyebrow: 'Escuchar el estudio' });
  st.setMode('thinking');
  st.status('Preparando la lectura…');
  const script = await buildScript(note);
  if (st.closed) return;
  const flat = script.flatMap((p, si) => p.lines.map((line) => ({ si, line })));
  let idx = 0;
  let playing = false;
  const chips = script.map((p, si) =>
    h('button', { class: 'chip', onclick: () => jump(flat.findIndex((x) => x.si === si)) }, p.label),
  );
  st.extra(h('div', { class: 'v-chips' }, chips));
  const playBtn = h('button', { class: 'stop-btn v-play', 'aria-label': 'Reproducir' }, icon('play'));
  const prev = h('button', {
    class: 'icon-btn',
    'aria-label': 'Anterior',
    onclick: () => {
      const si = flat[idx]?.si ?? 0;
      const s0 = startOf(si);
      jump(idx - s0 < 2 ? startOf(Math.max(0, si - 1)) : s0);
    },
  }, icon('rew'));
  const next = h('button', { class: 'icon-btn', 'aria-label': 'Siguiente', onclick: () => jump(startOf((flat[idx]?.si ?? 0) + 1)) }, icon('fwd'));
  st.controls(prev, playBtn, next, speedButton());
  function startOf(si) {
    const i = flat.findIndex((x) => x.si === si);
    return i < 0 ? flat.length : i;
  }
  function mark() {
    const si = flat[idx]?.si;
    chips.forEach((c, i) => c.classList.toggle('on', i === si));
    chips[si]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    st.sub(`${idx + 1} / ${flat.length}`);
  }
  async function loop() {
    playing = true;
    playBtn.replaceChildren(icon('pause'));
    while (playing && idx < flat.length && !st.closed) {
      mark();
      st.setMode('speaking');
      st.status(script[flat[idx].si].label);
      st.caption(flat[idx].line);
      const my = idx;
      const line = (k) => flat[k]?.line || '';
      V.prefetch(line(idx + 1), { prev: line(idx), next: line(idx + 2) });
      await V.speak(line(idx), { rate: rate(), prev: line(idx - 1), next: line(idx + 1) });
      if (!playing || my !== idx) return;
      idx++;
    }
    if (idx >= flat.length) {
      idx = 0;
      st.status('Fin del estudio');
      st.caption('Amén. Que esta palabra dé fruto en tu semana.');
    }
    pause();
  }
  function pause() {
    playing = false;
    V.stopSpeaking();
    playBtn.replaceChildren(icon('play'));
    if (!st.closed) st.setMode('idle');
  }
  function jump(i) {
    V.stopSpeaking();
    idx = Math.min(Math.max(0, i), flat.length - 1);
    playing = false;
    setTimeout(loop, 60);
  }
  playBtn.onclick = () => (playing ? pause() : loop());
  st.orb.onclick = playBtn.onclick;
  loop();
}

// ------------------------------------------------------------------ 2. Conversar
async function converse(note, me, { greeting } = {}) {
  const st = stage({ eyebrow: 'Conversar con Selah' });
  let running = true;
  const mic = h('button', { class: 'stop-btn v-mic', 'aria-label': 'Hablar' }, icon('mic'));
  const end = h('button', { class: 'btn small', onclick: () => st.close() }, 'Terminar');
  st.controls(h('span', { style: { width: '62px' } }), mic, speedButton());
  st.extra(end);
  const name = firstName(me);
  async function cycle() {
    while (running && !st.closed) {
      const text = await listenTurn(st, note);
      if (st.closed) return;
      if (text === null) break;
      if (!text) {
        st.status('Toca el círculo para hablar');
        break;
      }
      st.caption(`“${text}”`, { big: false });
      await answerTurn(st, note, text);
    }
    st.setMode('idle');
    if (!st.closed) st.status('Toca el círculo para hablar');
  }
  let busy = false;
  const startTalking = async () => {
    if (st.finishListening()) return; // tocar mientras escucha = "ya terminé"
    V.stopSpeaking(); // tocar mientras habla = interrumpir y hablar
    if (busy) return;
    busy = true;
    await cycle();
    busy = false;
  };
  mic.onclick = startTalking;
  st.orb.onclick = startTalking;
  const hello =
    greeting ||
    `Hola${name ? ` ${name}` : ''}. Platiquemos de "${note.title}". ¿Qué fue lo que más te habló de esta prédica? Puedes preguntarme lo que quieras.`;
  await say(st, hello);
  if (!st.closed && !busy) startTalking();
  return st;
}

// ------------------------------------------------------------------ 3. Devocional guiado
function dayForToday(note) {
  const days = note.analysis.devotional || [];
  if (!days.length) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(note.preachedAt || '');
  let n = 1;
  if (m) n = Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
  return Math.min(days.length, Math.max(1, n));
}

async function guidedDevotional(note, me, dayNum) {
  const days = note.analysis.devotional || [];
  const d = days.find((x) => x.day === dayNum) || days[0];
  if (!d) return toast('Esta nota no tiene devocional', { error: true });
  const st = stage({ eyebrow: `Devocional · Día ${d.day}` });
  const doneBtn = h('button', { class: 'stop-btn v-mic', 'aria-label': 'Ya terminé de hablar', onclick: () => st.finishListening() }, icon('mic'));
  st.controls(h('span', { style: { width: '62px' } }), doneBtn, speedButton());
  st.orb.onclick = () => st.finishListening();
  const name = firstName(me);
  const verse = await passageText(d);
  st.status(d.title);
  await say(st, `${name ? `${name}, ` : ''}bienvenido al día ${d.day}. ${d.title}. Respira hondo. Leamos ${d.reference || 'la palabra de hoy'}.`);
  if (st.closed) return;
  if (verse) await say(st, verse);
  if (st.closed) return;
  await say(st, d.reflection);
  if (st.closed) return;
  await say(st, `Ahora cuéntame, con tus palabras: ¿qué te está diciendo Dios hoy con esto? Habla cuando quieras.`);
  if (st.closed) return;
  const answer = await listenTurn(st, note, { prompt: 'Te escucho. Comparte lo que sientes…', silenceMs: 2200, maxWaitMs: 20000 });
  if (st.closed) return;
  if (answer) {
    st.caption(`“${answer}”`, { big: false });
    await answerTurn(st, note, answer, { mode: 'devocional', day: d.day });
  }
  if (st.closed) return;
  if (d.action) await say(st, `Tu paso para hoy: ${d.action}`);
  if (st.closed) return;
  if (d.prayer) await say(st, `Oremos juntos. ${d.prayer}`);
  if (st.closed) return;
  st.status('Devocional terminado');
  st.caption('Que Dios te acompañe hoy.');
  st.controls(
    h('button', { class: 'btn', onclick: () => (st.close(), setTimeout(() => converse(note, me, { greeting: 'Sigamos platicando. ¿Qué más hay en tu corazón?' }), 300)) }, icon('talk'), 'Seguir platicando'),
    h('button', { class: 'btn primary', onclick: () => st.close() }, 'Amén'),
  );
  localStorage.setItem(`selah-dev-${note.id}-${d.day}`, '1');
}

// ------------------------------------------------------------------ 4. Memorizar
const LEVELS = [
  { hide: 0, label: 'Escúchalo y léelo conmigo' },
  { hide: 0.3, label: 'Faltan algunas palabras' },
  { hide: 0.6, label: 'Faltan más palabras' },
  { hide: 1, initials: true, label: 'Solo las iniciales' },
  { hide: 1, none: true, label: 'De memoria' },
];

function maskWords(text, level, seed) {
  const words = text.split(/\s+/);
  const L = LEVELS[level];
  if (L.none) return [h('span', { class: 'mv-hidden-all' }, '· · ·')];
  let x = seed;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  return words.flatMap((w, i) => {
    const hide = L.initials || (L.hide && rnd() < L.hide && w.replace(/\W/g, '').length > 2);
    const node = hide ? h('span', { class: 'mv-blank' }, L.initials ? `${w[0]}${'_'.repeat(Math.max(1, w.length - 2))}` : '_'.repeat(Math.max(3, w.length))) : h('span', {}, w);
    return i ? [' ', node] : [node];
  });
}

async function memorize(note) {
  const a = note.analysis;
  const mv = a.study?.memory_verse || (a.verses || []).find((v) => v.found !== false);
  if (!mv) return toast('No encontré un versículo para memorizar', { error: true });
  const text = (await passageText(mv)).replace(/\s+/g, ' ').trim();
  if (!text) return toast('No encontré el texto del versículo', { error: true });
  const key = `selah-mem-${note.id}`;
  let level = Math.min(LEVELS.length - 1, Number(localStorage.getItem(key)) || 0);
  const st = stage({ eyebrow: 'Memoriza el versículo' });
  st.el.classList.add('mem');
  const verseBox = h('p', { class: 'mv-text' });
  const ref = h('p', { class: 'mv-ref' }, mv.reference);
  const dots = h('div', { class: 'mv-dots' });
  const score = h('div', { class: 'mv-score' });
  st.extra(dots, verseBox, ref, score);
  const mic = h('button', { class: 'stop-btn v-mic', 'aria-label': 'Recitar' }, icon('mic'));
  const hear = h('button', { class: 'icon-btn', 'aria-label': 'Escuchar el versículo' }, icon('headphones'));
  st.controls(hear, mic, speedButton());
  function render() {
    dots.replaceChildren(...LEVELS.map((_, i) => h('i', { class: i < level ? 'done' : i === level ? 'on' : '' })));
    verseBox.replaceChildren(...maskWords(text, level, 7 + level * 13));
    st.status(`Nivel ${level + 1} de ${LEVELS.length} · ${LEVELS[level].label}`);
    st.caption('');
  }
  async function readIt() {
    await say(st, `${mv.reference}. ${text}`, { big: false });
    st.caption('');
  }
  hear.onclick = () => (V.stopSpeaking(), readIt());
  let trying = false;
  async function attempt() {
    if (st.finishListening()) return;
    V.stopSpeaking();
    if (trying) return;
    trying = true;
    try {
      await attemptInner();
    } finally {
      trying = false;
    }
  }
  async function attemptInner() {
    score.replaceChildren();
    const said = await listenTurn(st, note, { prompt: 'Recítalo ahora…', silenceMs: 1800, maxWaitMs: 12000 });
    if (st.closed || said === null) return;
    if (!said) {
      st.status('No te escuché. Toca el micrófono e inténtalo.');
      return;
    }
    const r = V.compareRecital(text, said);
    score.replaceChildren(
      h('b', {}, `${r.score}%`),
      h('span', {}, r.score >= 85 ? '¡Excelente!' : r.score >= 60 ? 'Vas muy bien' : 'Sigue practicando'),
      r.missing.length && r.score < 100 ? h('small', {}, `Te faltó: ${r.missing.slice(0, 8).join(' ')}${r.missing.length > 8 ? '…' : ''}`) : null,
    );
    vibrate(r.score >= 85 ? [20, 60, 20] : 15);
    if (r.score >= 85) {
      if (level < LEVELS.length - 1) {
        level++;
        localStorage.setItem(key, level);
        await say(st, `¡Excelente! ${r.score} por ciento. Subamos de nivel.`, { big: false });
        render();
      } else {
        localStorage.setItem(key, level);
        await say(st, `¡Lo lograste! Ya tienes ${mv.reference} en tu corazón. Como dice el Salmo: en mi corazón he guardado tus dichos.`, { big: false });
        st.status('Versículo memorizado');
      }
    } else {
      const tip = r.missing.length ? `Te faltaron unas palabras. Escúchalo otra vez.` : 'Casi. Inténtalo de nuevo.';
      await say(st, `${r.score} por ciento. ${tip}`, { big: false });
      if (r.missing.length) await readIt();
    }
  }
  mic.onclick = attempt;
  st.orb.onclick = attempt;
  render();
  if (level === 0) await readIt();
}

// ------------------------------------------------------------------ Panel de la pestaña
function voicePicker() {
  const box = h('div', { class: 'v-voices' });
  const render = (list) => {
    const cur = V.getVoiceId();
    const opt = (id, label, desc) =>
      h(
        'div',
        { class: `v-voice${cur === id ? ' on' : ''}` },
        h(
          'button',
          {
            class: 'v-voice-pick',
            onclick: () => {
              V.setVoiceId(id);
              vibrate(8);
              render(list);
              V.stopSpeaking();
              V.previewVoice(id);
            },
          },
          h('b', {}, label),
          h('small', {}, desc),
        ),
        h(
          'button',
          {
            class: 'icon-btn small',
            'aria-label': `Escuchar a ${label}`,
            onclick: () => {
              V.stopSpeaking();
              V.previewVoice(id);
            },
          },
          icon('play'),
        ),
      );
    const curLabel = cur === 'device' ? 'Teléfono' : list.find((v) => v.id === cur)?.label || '';
    const tag = box.parentElement?.querySelector('.v-voice-cur');
    if (tag) tag.textContent = curLabel;
    box.replaceChildren(
      ...list.map((v) => opt(v.id, v.label, v.desc)),
      opt('device', 'Voz del teléfono', 'Gratis, más robótica · funciona sin internet'),
    );
  };
  api
    .get('/api/tts/voices')
    .then((r) => {
      V.setDefaultVoice(r.default);
      render(r.available ? r.voices : []);
    })
    .catch(() => render([]));
  return h('details', { class: 'card v-voice-box' }, h('summary', {}, icon('headphones'), 'Voz de Selah', h('span', { class: 'v-voice-cur' }, '')), box);
}

export function voicePanel(note, { me, pauseAudio }) {
  if (!V.canSpeak()) return h('p', { class: 'muted' }, 'Tu navegador no permite que Selah hable. Actualiza tu navegador (Safari, Chrome, Samsung Internet o Edge) e intenta de nuevo.');
  V.setNoteContext(note.id);
  const a = note.analysis;
  const linkDay = Number(new URLSearchParams(location.search).get('dia')) || 0;
  const day = (note.analysis.devotional || []).some((d) => d.day === linkDay) ? linkDay : dayForToday(note);
  const memKey = Number(localStorage.getItem(`selah-mem-${note.id}`)) || 0;
  const open = (fn) => () => {
    pauseAudio?.();
    vibrate(10);
    fn();
  };
  const card = (ic, t, d, fn, cls = '') =>
    h('button', { class: `action v-card ${cls}`, onclick: open(fn) }, h('span', { class: 'ic' }, icon(ic)), h('span', {}, h('b', {}, t), h('small', {}, d)), icon('chev'));
  const listenOk = V.canListen();
  return [
    h(
      'div',
      { class: 'v-hero card' },
      h('div', { class: 'v-hero-orb' }, h('i'), h('i'), h('i')),
      h('div', {}, h('h3', {}, 'Selah habla contigo'), h('p', { class: 'muted' }, 'Escucha el estudio, platica de la prédica con tu voz, vive el devocional y guarda el versículo en tu corazón.')),
    ),
    h(
      'div',
      { class: 'actions stagger' },
      card('headphones', 'Escuchar el estudio', a.study ? 'Selah te lee el mensaje completo, con sus versículos' : 'Selah te lee los puntos principales', () => listenStudy(note), 'primary'),
      listenOk ? card('talk', 'Conversar', 'Pregunta con tu voz y Selah te responde hablando', () => converse(note, me)) : null,
      listenOk && day ? card('sun', `Devocional guiado · Día ${day}`, 'Te lee, te pregunta, te escucha y ora contigo', () => guidedDevotional(note, me, day)) : null,
      listenOk ? card('spark', 'Memoriza el versículo', `${a.study?.memory_verse?.reference || 'Versículo de la semana'} · nivel ${memKey + 1} de ${LEVELS.length}`, () => memorize(note)) : null,
    ),
    day && listenOk
      ? h(
          'div',
          { class: 'v-days' },
          (a.devotional || []).map((d) =>
            h(
              'button',
              { class: `chip${localStorage.getItem(`selah-dev-${note.id}-${d.day}`) ? ' on' : ''}`, onclick: open(() => guidedDevotional(note, me, d.day)) },
              `Día ${d.day}`,
            ),
          ),
        )
      : null,
    voicePicker(),
    h('p', { class: 'faint', style: { fontSize: '12.5px', marginTop: '14px' } }, 'Tus palabras solo se usan para responderte y quedan guardadas en "Preguntar".'),
  ];
}
