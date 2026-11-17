import { api } from './api.js';
import { h, icon, LOGO, toast, sheet, copyText, shareText, waLink, mmss, dateParts, longDate, vibrate } from './ui.js';
import { WebRecorder, isSupported as canRecord, pendingRecording, discardPending } from './recorder.js';

const app = document.getElementById('app');
const state = { me: null, bible: null, folders: [], folder: '', q: '' };
let cleanup = null;

// ---------------------------------------------------------------- Router
const routes = [
  [/^\/entrar$/, loginView],
  [/^\/grabar$/, recordView],
  [/^\/nota\/([\w-]+)$/, noteView],
  [/^\/$/, homeView],
];

export function go(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  render();
}

async function render() {
  const path = location.pathname;
  if (!state.me && path !== '/entrar') {
    try {
      const me = await api.get('/api/me');
      state.me = me.user;
      state.bible = me.bible;
    } catch {
      return go('/entrar', { replace: true });
    }
  }
  const [re, view] = routes.find(([re]) => re.test(path)) || [null, homeView];
  const params = re ? path.match(re).slice(1) : [];
  const swap = async () => {
    document.querySelectorAll('.sheet, .scrim').forEach((el) => el.remove());
    cleanup?.();
    cleanup = null;
    const node = await view(...params);
    app.replaceChildren(node);
    window.scrollTo(0, 0);
  };
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const vt = document.startViewTransition(swap);
    vt.ready.catch(() => {});
    vt.finished.catch(() => {});
  } else swap();
}

window.addEventListener('popstate', () => render());
window.addEventListener('selah:logout', () => {
  state.me = null;
  if (location.pathname !== '/entrar') go('/entrar', { replace: true });
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    go(a.getAttribute('href'));
  }
});

// ---------------------------------------------------------------- Login
function loginView() {
  const err = h('p', { class: 'muted', style: { minHeight: '22px', margin: '0', color: 'var(--rose)' } });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Entrar');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.textContent = '';
        const fd = new FormData(form);
        try {
          const r = await api.post('/api/login', { username: fd.get('u'), password: fd.get('p') });
          state.me = r.user;
          vibrate(15);
          go('/', { replace: true });
        } catch (e2) {
          err.textContent = e2.message;
          form.animate([{ translate: '0' }, { translate: '-8px' }, { translate: '8px' }, { translate: '0' }], { duration: 300 });
        } finally {
          btn.disabled = false;
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Usuario'), h('input', { class: 'input', id: 'u', name: 'u', autocomplete: 'username', autocapitalize: 'none', required: true })),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Contraseña'), h('input', { class: 'input', id: 'p', name: 'p', type: 'password', autocomplete: 'current-password', required: true })),
    err,
    btn,
  );
  return h(
    'main',
    { class: 'login stagger' },
    h('div', { class: 'mark', html: LOGO }),
    h('span', { class: 'eyebrow' }, 'Notas de prédica'),
    h('h1', { class: 'display' }, 'Selah', h('em', {}, '.')),
    h('p', { class: 'tag' }, 'Haz una pausa. Escucha, guarda y medita lo que Dios habló.'),
    form,
  );
}

// ---------------------------------------------------------------- Inicio
function greeting() {
  const hr = new Date().getHours();
  return hr < 12 ? 'Buenos días' : hr < 19 ? 'Buenas tardes' : 'Buenas noches';
}

const STATUS = { queued: 'En cola', downloading: 'Descargando', transcribing: 'Transcribiendo', analyzing: 'Analizando', error: 'Error' };

function noteCard(n) {
  const d = dateParts(n.preachedAt) || {};
  const snippet = n.snippet
    ? h('p', { class: 'snip', html: escapeHtml(n.snippet).replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>') })
    : n.centralIdea
      ? h('p', {}, n.centralIdea)
      : null;
  const folder = state.folders.find((f) => f.id === n.folderId);
  return h(
    'a',
    { class: 'card note-card', href: `/nota/${n.id}`, 'data-link': true },
    h('div', { class: 'date-tile' }, h('b', {}, d.day ?? '·'), h('span', {}, d.month ?? '')),
    h(
      'div',
      { style: { minWidth: 0 } },
      h('h3', {}, n.title || (n.status === 'error' ? 'Nota sin procesar' : 'Procesando prédica…')),
      snippet,
      h(
        'div',
        { class: 'meta' },
        n.status !== 'ready' ? h('span', { class: `status${n.status === 'error' ? ' err' : ''}` }, STATUS[n.status] || n.status) : null,
        n.preacher ? h('span', {}, n.preacher) : null,
        n.durationSec ? h('span', { class: 'tnum' }, `${Math.round(n.durationSec / 60)} min`) : null,
        folder ? h('span', {}, `· ${folder.name}`) : null,
      ),
    ),
  );
}

async function homeView() {
  const list = h('div', { class: 'list' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  const chips = h('div', { class: 'chips' });
  const recover = h('div');
  let timer;
  let poll;

  async function loadNotes() {
    const qs = new URLSearchParams({ q: state.q, folder: state.folder });
    const notes = await api.get(`/api/notes?${qs}`);
    if (!notes.length) {
      list.replaceChildren(
        state.q
          ? h('div', { class: 'empty' }, h('h3', {}, 'Nada por aquí'), h('p', { class: 'muted' }, `No encontré “${state.q}” en tus notas.`))
          : emptyState(),
      );
    } else list.replaceChildren(h('div', { class: 'list stagger', style: { marginTop: 0 } }, notes.map(noteCard)));
    clearTimeout(poll);
    if (notes.some((n) => !['ready', 'error'].includes(n.status))) poll = setTimeout(loadNotes, 4000);
  }

  async function loadFolders() {
    state.folders = await api.get('/api/folders');
    const chip = (id, label, n) =>
      h(
        'button',
        {
          class: `chip${state.folder === id ? ' on' : ''}`,
          onclick: () => {
            state.folder = id;
            vibrate(6);
            loadFolders();
            loadNotes();
          },
        },
        id && id !== 'none' ? h('i', { class: 'dot' }) : null,
        label,
        n != null ? h('span', { class: 'n' }, n) : null,
      );
    chips.replaceChildren(
      chip('', 'Todas'),
      ...state.folders.map((f) => chip(String(f.id), f.name, f.count)),
      chip('none', 'Sin carpeta'),
      h('button', { class: 'chip add', onclick: () => folderSheet(() => (loadFolders(), loadNotes())) }, icon('plus'), 'Carpeta'),
    );
  }

  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Buscar en todas tus prédicas',
    value: state.q,
    enterkeyhint: 'search',
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.q = e.target.value.trim();
        loadNotes();
      }, 250);
    },
  });

  pendingRecording().then((p) => {
    if (!p || p.blob.size < 2000) return;
    recover.replaceChildren(
      h(
        'div',
        { class: 'banner' },
        icon('mic'),
        h('p', {}, h('b', {}, 'Grabación sin terminar'), h('br'), h('span', { class: 'muted' }, `${mmss(p.seconds)} guardados en este dispositivo`)),
        h('button', { class: 'btn small primary', onclick: () => uploadBlob(p.blob, 'record', () => discardPending()) }, 'Procesar'),
        h('button', { class: 'icon-btn', 'aria-label': 'Descartar', onclick: async () => (await discardPending(), recover.replaceChildren()) }, icon('x')),
      ),
    );
  });

  loadFolders().then(loadNotes).catch((e) => toast(e.message, { error: true }));
  cleanup = () => {
    clearTimeout(poll);
    clearTimeout(timer);
  };

  const name = state.me?.username ? state.me.username[0].toUpperCase() + state.me.username.slice(1) : '';
  return h(
    'main',
    { class: 'view' },
    h(
      'header',
      { class: 'topbar' },
      h('div', { style: { width: '40px', height: '40px' }, html: LOGO }),
      h('button', { class: 'icon-btn', 'aria-label': 'Más opciones', onclick: menuSheet }, icon('more')),
    ),
    h('div', { class: 'stagger', style: { marginTop: '26px' } }, h('span', { class: 'eyebrow' }, `${greeting()}${name ? `, ${name}` : ''}`), h('h1', { class: 'display' }, 'Lo que Dios ', h('em', {}, 'habló'))),
    recover,
    h('div', { class: 'search' }, icon('search'), search),
    chips,
    list,
    h('div', { class: 'fab-wrap' }, h('button', { class: 'fab', onclick: newNoteSheet }, icon('plus'), 'Nueva nota')),
  );
}

function emptyState() {
  return h(
    'div',
    { class: 'empty stagger' },
    h('div', {
      html: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="60" cy="60" r="44" opacity=".25"/><circle cx="60" cy="60" r="30" opacity=".45"/><path d="M46 52c6-10 22-10 26 0 3 8-10 10-14 16-3 5 2 10 10 8"/><circle cx="60" cy="88" r="2.5" fill="currentColor"/></svg>`,
    }),
    h('h3', {}, 'Tu primera prédica'),
    h('p', { class: 'muted' }, 'Graba el servicio, sube un audio o pega un enlace de YouTube. Selah se encarga del resto.'),
  );
}

function menuSheet() {
  sheet((close) => [
    h('h3', {}, state.me?.username || 'Cuenta'),
    h('p', { class: 'muted', style: { margin: 0 } }, `Biblia: ${state.bible?.name || 'Reina-Valera 1909'} (${state.bible?.license || 'dominio público'})`),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          class: 'action danger',
          onclick: async () => {
            await api.post('/api/logout');
            close();
            state.me = null;
            go('/entrar', { replace: true });
          },
        },
        h('span', { class: 'ic' }, icon('logout')),
        h('span', {}, h('b', {}, 'Cerrar sesión')),
        h('span'),
      ),
    ),
  ]);
}

function folderSheet(onDone, existing) {
  sheet((close) => {
    const input = h('input', { class: 'input', placeholder: 'Ej. Serie: Fe en acción', value: existing?.name || '', maxlength: 60 });
    setTimeout(() => input.focus(), 350);
    return [
      h('h3', {}, existing ? 'Renombrar carpeta' : 'Nueva carpeta'),
      h(
        'form',
        {
          style: { display: 'grid', gap: '14px', marginTop: '16px' },
          onsubmit: async (e) => {
            e.preventDefault();
            if (!input.value.trim()) return;
            if (existing) await api.patch(`/api/folders/${existing.id}`, { name: input.value });
            else await api.post('/api/folders', { name: input.value });
            close();
            onDone?.();
          },
        },
        input,
        h('button', { class: 'btn primary block' }, 'Guardar'),
      ),
    ];
  });
}

// ---------------------------------------------------------------- Nueva nota
function newNoteSheet() {
  vibrate(8);
  sheet((close) => {
    const fileInput = h('input', {
      type: 'file',
      accept: 'audio/*,video/mp4,.m4a,.mp3,.wav,.ogg,.opus,.aac,.flac,.webm',
      hidden: true,
      onchange: () => {
        const f = fileInput.files[0];
        if (f) {
          close();
          uploadBlob(f, 'upload');
        }
      },
    });
    const action = (ic, title, sub, onclick) =>
      h('button', { class: 'action', onclick }, h('span', { class: 'ic' }, icon(ic)), h('span', {}, h('b', {}, title), h('small', {}, sub)), icon('chev'));
    return [
      h('h3', {}, 'Nueva nota'),
      h('p', { class: 'muted', style: { margin: 0 } }, '¿De dónde viene la prédica?'),
      h(
        'div',
        { class: 'actions' },
        canRecord()
          ? action('mic', 'Grabar ahora', 'Con el micrófono del teléfono', () => {
              close();
              setTimeout(() => go('/grabar'), 200);
            })
          : null,
        action('upload', 'Subir audio', 'MP3, M4A, WAV, notas de voz…', () => fileInput.click()),
        action('yt', 'Enlace de YouTube', 'Transmisión o video del culto', () => {
          close();
          setTimeout(youtubeSheet, 220);
        }),
      ),
      fileInput,
    ];
  });
}

function youtubeSheet() {
  sheet((close) => {
    const input = h('input', { class: 'input', type: 'url', inputmode: 'url', placeholder: 'https://youtu.be/…', required: true });
    const btn = h('button', { class: 'btn primary block' }, 'Crear nota');
    setTimeout(() => input.focus(), 400);
    const paste = navigator.clipboard?.readText
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn small',
            onclick: async () => {
              try {
                input.value = (await navigator.clipboard.readText()).trim();
              } catch {}
            },
          },
          'Pegar',
        )
      : null;
    return [
      h('h3', {}, 'Desde YouTube'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Pega el enlace del culto. Funciona con videos y transmisiones ya terminadas.'),
      h(
        'form',
        {
          style: { display: 'grid', gap: '12px', marginTop: '18px' },
          onsubmit: async (e) => {
            e.preventDefault();
            btn.disabled = true;
            try {
              const n = await api.post('/api/notes', { youtubeUrl: input.value, folderId: folderForNew() });
              close();
              toast('Listo, la estoy procesando');
              go(`/nota/${n.id}`);
            } catch (err) {
              toast(err.message, { error: true });
              btn.disabled = false;
            }
          },
        },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, input, paste),
        btn,
      ),
    ];
  });
}

const folderForNew = () => (state.folder && state.folder !== 'none' ? state.folder : '');

function uploadBlob(blob, source, onDone) {
  const bar = h('i');
  const label = h('p', { class: 'muted tnum', style: { margin: '10px 0 0' } }, 'Preparando…');
  const s = sheet(() => [h('h3', {}, 'Subiendo audio'), label, h('div', { class: 'progress' }, bar)]);
  const today = new Date();
  const fields = {
    source,
    folderId: folderForNew(),
    preachedAt: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
  };
  const ext = (blob.type.includes('mp4') ? 'm4a' : blob.type.split('/')[1]?.split(';')[0]) || 'webm';
  if (!blob.name) blob = new File([blob], `grabacion.${ext}`, { type: blob.type });
  const total = blob.size / 1048576;
  const fmt = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`);
  return api
    .uploadChunked(blob, fields, (p) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      label.textContent = `${Math.round(p * 100)}% · ${fmt(total * p)} de ${fmt(total)}`;
    })
    .then(async (n) => {
      await onDone?.();
      s.close();
      vibrate(20);
      toast('Audio recibido');
      go(`/nota/${n.id}`);
      return true;
    })
    .catch((e) => {
      s.close();
      toast(`${e.message}. La grabación sigue guardada en el teléfono.`, { error: true, ms: 5000 });
      return false;
    });
}

// ---------------------------------------------------------------- Grabar
function recordView() {
  const rec = new WebRecorder();
  const canvas = h('canvas');
  const core = h('div', { class: 'core' });
  const timer = h('div', { class: 'timer' }, '0:00');
  const hint = h('p', { class: 'rec-hint' }, h('i', { class: 'live' }), 'Preparando micrófono…');
  const pauseBtn = h('button', { class: 'icon-btn', 'aria-label': 'Pausar', onclick: togglePause }, icon('pause'));
  const root = h(
    'main',
    { class: 'rec' },
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Descartar', onclick: discard }, icon('x')),
      h('span', { class: 'eyebrow' }, 'Grabando prédica'),
      h('span', { style: { width: '44px' } }),
    ),
    h('section', { class: 'rec-stage' }, h('div', { class: 'orb' }, canvas, core), timer, hint),
    h('footer', { class: 'rec-controls' }, pauseBtn, h('button', { class: 'stop-btn', 'aria-label': 'Terminar y procesar', onclick: finish }, h('i')), h('span', { style: { width: '62px' } })),
  );

  let raf;
  const ctx = canvas.getContext('2d');
  const levels = new Array(64).fill(0);
  let smooth = 0;
  function draw() {
    const dpr = devicePixelRatio || 1;
    const w = (canvas.width = canvas.clientWidth * dpr);
    const hgt = (canvas.height = canvas.clientHeight * dpr);
    const lv = rec.level();
    smooth += (lv - smooth) * 0.25;
    levels.push(smooth);
    levels.shift();
    core.style.transform = `scale(${1 + smooth * 0.18})`;
    ctx.clearRect(0, 0, w, hgt);
    const cx = w / 2;
    const cy = hgt / 2;
    const base = Math.min(w, hgt) * 0.3;
    const amber = getComputedStyle(document.documentElement).getPropertyValue('--amber').trim() || '#f0a948';
    for (let ring = 0; ring < 3; ring++) {
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2 - Math.PI / 2;
        // Espejo del historial: el anillo queda continuo y la voz más reciente arriba.
        const v = levels[63 - Math.min(i, 64 - i) - ring * 4];
        const r = base + ring * base * 0.22 + v * base * (0.5 - ring * 0.12) + Math.sin(a * 3 + performance.now() / (700 + ring * 300)) * 3 * dpr;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = amber;
      ctx.globalAlpha = 0.5 - ring * 0.14;
      ctx.lineWidth = (2 - ring * 0.4) * dpr;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    timer.textContent = mmss(rec.elapsed());
    raf = requestAnimationFrame(draw);
  }

  function togglePause() {
    vibrate(10);
    if (rec.state === 'recording') {
      rec.pause();
      root.classList.add('paused');
      pauseBtn.replaceChildren(icon('mic'));
      hint.lastChild.textContent = 'En pausa';
    } else {
      rec.resume();
      root.classList.remove('paused');
      pauseBtn.replaceChildren(icon('pause'));
      hint.lastChild.textContent = 'Grabando · deja la pantalla encendida';
    }
  }

  async function finish() {
    if (rec.state === 'idle') return;
    if (rec.elapsed() < 3) return toast('Graba al menos unos segundos', { error: true });
    vibrate([15, 40, 15]);
    cancelAnimationFrame(raf);
    const blob = await rec.stop();
    const ok = await uploadBlob(blob, 'record', () => rec.done());
    if (!ok) go('/', { replace: true }); // el inicio ofrece recuperar la grabación
  }

  async function discard() {
    if (rec.state !== 'idle' && rec.elapsed() > 10 && !confirm('¿Descartar esta grabación?')) return;
    await rec.discard();
    go('/', { replace: true });
  }

  rec
    .start()
    .then(() => {
      hint.lastChild.textContent = 'Grabando · deja la pantalla encendida';
      draw();
    })
    .catch((e) => {
      hint.lastChild.textContent = e.name === 'NotAllowedError' ? 'Permite el micrófono para grabar.' : `No pude abrir el micrófono: ${e.message}`;
    });

  const beforeUnload = (e) => {
    if (rec.state !== 'idle') e.preventDefault();
  };
  window.addEventListener('beforeunload', beforeUnload);
  cleanup = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('beforeunload', beforeUnload);
    if (rec.state !== 'idle') rec.stop(); // los fragmentos quedan en IndexedDB para recuperar
  };
  return root;
}

// ---------------------------------------------------------------- Nota
const TABS = [
  ['resumen', 'Resumen'],
  ['versiculos', 'Versículos'],
  ['anuncios', 'Anuncios'],
  ['celula', 'Célula'],
  ['devocional', 'Devocional'],
  ['redes', 'Redes'],
  ['transcripcion', 'Transcripción'],
  ['chat', 'Preguntar'],
];

async function noteView(id) {
  let note;
  try {
    note = await api.get(`/api/notes/${id}`);
  } catch (e) {
    toast(e.message, { error: true });
    go('/', { replace: true });
    return h('div');
  }
  const root = h('main', { class: 'view' });
  const top = h('header', { class: 'note-top' });
  const audio = new Audio();
  audio.preload = 'metadata';
  let poll;
  let player = null;
  let tab = new URLSearchParams(location.search).get('t') || 'resumen';
  const timeListeners = new Set();
  audio.addEventListener('timeupdate', () => timeListeners.forEach((f) => f(audio.currentTime)));

  const seek = (sec, play = true) => {
    audio.currentTime = sec;
    if (play) audio.play().catch(() => {});
    vibrate(6);
  };

  const onScroll = () => top.classList.toggle('solid', scrollY > 60);
  window.addEventListener('scroll', onScroll, { passive: true });
  cleanup = () => {
    clearTimeout(poll);
    audio.pause();
    audio.src = '';
    window.removeEventListener('scroll', onScroll);
    player?.remove();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  };

  function header() {
    top.replaceChildren(
      h('button', { class: 'icon-btn', 'aria-label': 'Volver', onclick: () => (history.length > 1 ? history.back() : go('/')) }, icon('back')),
      h('div', { class: 't' }, note.title),
      h('button', { class: 'icon-btn', 'aria-label': 'Opciones', onclick: optionsSheet }, icon('more')),
    );
  }

  function hero() {
    const folder = state.folders.find((f) => f.id === note.folderId);
    return h(
      'section',
      { class: 'hero stagger' },
      h('span', { class: 'eyebrow' }, [longDate(note.preachedAt), note.preacher].filter(Boolean).join(' · ') || 'Prédica'),
      h('h1', {}, note.title || (note.status === 'error' ? 'Nota sin procesar' : 'Procesando prédica…')),
      note.analysis?.central_idea ? h('p', { class: 'idea' }, note.analysis.central_idea) : null,
      h(
        'div',
        { class: 'meta' },
        note.durationSec ? h('span', {}, `${Math.round(note.durationSec / 60)} min`) : null,
        folder ? h('span', {}, folder.name) : null,
        note.sourceType === 'youtube' ? h('a', { href: note.sourceUrl, target: '_blank', rel: 'noopener' }, 'Ver en YouTube') : null,
      ),
    );
  }

  function processing() {
    const order = ['queued', 'downloading', 'transcribing', 'analyzing', 'ready'];
    const steps = [
      ...(note.sourceType === 'youtube' ? [['downloading', 'Descargando de YouTube', 'Obteniendo solo el audio']] : [['queued', 'Audio recibido', 'Guardado de forma segura']]),
      ['transcribing', 'Transcribiendo', 'Palabra por palabra, con tiempos'],
      ['analyzing', 'Meditando el mensaje', 'Resumen, versículos, anuncios y más'],
      ['ready', 'Listo', ''],
    ];
    const cur = order.indexOf(note.status);
    if (note.status === 'error') {
      return h(
        'div',
        { class: 'card steps' },
        h('h3', { class: 'h2' }, 'Algo salió mal'),
        h('p', { class: 'muted' }, note.error),
        h(
          'div',
          { style: { display: 'flex', gap: '10px', marginTop: '10px', flexWrap: 'wrap' } },
          h('button', { class: 'btn primary', onclick: () => reprocess(false) }, icon('refresh'), 'Reintentar'),
          h('button', { class: 'btn', onclick: () => reprocess(true) }, 'Transcribir de nuevo'),
        ),
      );
    }
    return h(
      'div',
      { class: 'card steps stagger' },
      steps.map(([key, title, sub]) => {
        const i = order.indexOf(key);
        const cls = i < cur || (key === 'queued' && cur > 0) ? 'done' : i === cur || (key === 'queued' && cur === 0) ? 'active' : '';
        return h('div', { class: `step ${cls}` }, h('i'), h('div', {}, h('b', {}, title), sub ? h('small', {}, sub) : null));
      }),
      h('p', { class: 'faint', style: { fontSize: '13px', margin: '18px 0 0' } }, 'Una prédica de 45 minutos tarda unos 2 a 4 minutos. Puedes salir; te espera aquí.'),
    );
  }

  async function reprocess(transcribe) {
    note = await api.post(`/api/notes/${note.id}/reprocess`, { transcribe });
    draw();
  }

  function draw() {
    header();
    const nodes = [top, hero()];
    if (note.status !== 'ready') {
      nodes.push(processing());
      clearTimeout(poll);
      if (note.status !== 'error')
        poll = setTimeout(async () => {
          note = await api.get(`/api/notes/${note.id}`);
          if (note.status === 'ready') vibrate([20, 60, 20]);
          draw();
        }, 3000);
    } else {
      nodes.push(tabsBar(), panelFor(tab));
      mountPlayer();
    }
    root.replaceChildren(...nodes);
    requestAnimationFrame(moveIndicator);
  }

  // ---- pestañas
  let tabsEl;
  let indicator;
  function tabsBar() {
    indicator = h('span', { class: 'tab-ind' });
    tabsEl = h(
      'nav',
      { class: 'tabs', role: 'tablist' },
      indicator,
      TABS.map(([key, label]) =>
        h(
          'button',
          {
            class: `tab${key === tab ? ' on' : ''}`,
            role: 'tab',
            'aria-selected': key === tab,
            'data-k': key,
            onclick: () => switchTab(key),
          },
          label,
          key === 'anuncios' && note.analysis.announcements?.length ? h('span', { class: 'badge' }, note.analysis.announcements.length) : null,
        ),
      ),
    );
    return tabsEl;
  }
  function moveIndicator() {
    const on = tabsEl?.querySelector('.tab.on');
    if (!on || !indicator) return;
    indicator.style.left = `${on.offsetLeft}px`;
    indicator.style.width = `${on.offsetWidth}px`;
    on.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
  function switchTab(key) {
    if (key === tab) return;
    tab = key;
    vibrate(5);
    history.replaceState({}, '', `/nota/${note.id}?t=${key}`);
    tabsEl.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('on', b.dataset.k === key);
      b.setAttribute('aria-selected', b.dataset.k === key);
    });
    moveIndicator();
    const old = root.querySelector('.panel');
    old.replaceWith(panelFor(key));
    const y = tabsEl.offsetTop - (parseFloat(getComputedStyle(tabsEl).top) || 0);
    if (scrollY > y) window.scrollTo({ top: y, behavior: 'smooth' });
  }

  function panelFor(key) {
    timeListeners.clear();
    const panel = h('section', { class: 'panel', role: 'tabpanel' });
    const builders = { resumen, versiculos, anuncios, celula, devocional, redes, transcripcion, chat };
    panel.append(...[builders[key]?.()].flat().filter(Boolean));
    return panel;
  }

  const tsChip = (sec) => (sec || sec === 0 ? h('button', { class: 'ts', onclick: () => seek(sec) }, icon('play'), mmss(sec)) : null);
  const title = (text, extra) => h('div', { class: 'section-title' }, h('span', { class: 'eyebrow' }, text), extra || null);
  const a = () => note.analysis;

  function resumen() {
    const key = `selah-checks-${note.id}`;
    let checks = {};
    try {
      checks = JSON.parse(localStorage.getItem(key) || '{}');
    } catch {}
    return [
      title('Puntos principales'),
      h(
        'div',
        { class: 'points stagger' },
        a().main_points.map((p) => h('article', { class: 'card point' }, h('h4', {}, p.title), h('p', {}, p.detail), tsChip(p.timestamp_sec))),
      ),
      a().strong_quotes?.length ? title('Frases fuertes') : null,
      h(
        'div',
        { class: 'socials stagger' },
        (a().strong_quotes || []).map((q) => h('blockquote', { class: 'card quote', style: { margin: 0 } }, h('p', {}, q.text), tsChip(q.timestamp_sec))),
      ),
      a().practical_application?.length ? title('Aplicación práctica') : null,
      h(
        'div',
        { class: 'checks stagger' },
        (a().practical_application || []).map((t, i) =>
          h(
            'label',
            { class: 'card check' },
            h('input', {
              type: 'checkbox',
              checked: checks[i],
              onchange: (e) => {
                checks[i] = e.target.checked;
                vibrate(8);
                try {
                  localStorage.setItem(key, JSON.stringify(checks));
                } catch {}
              },
            }),
            h('span', {}, t),
          ),
        ),
      ),
      h(
        'div',
        { class: 'export-row' },
        h('button', { class: 'btn', onclick: pdfSheet }, icon('pdf'), 'PDF'),
        h('button', { class: 'btn primary', onclick: whatsappSheet }, icon('wa'), 'WhatsApp'),
      ),
    ];
  }

  async function pdfSheet() {
    const label = h('p', { class: 'muted', style: { margin: '6px 0 0' } }, note.analysis?.study ? 'Preparando el PDF…' : 'Preparando tu estudio completo con versículos. La primera vez tarda hasta 1 minuto…');
    const bar = h('i', { style: { width: '8%' } });
    const body = h('div', {}, label, h('div', { class: 'progress', style: { marginTop: '14px' } }, bar));
    const s = sheet(() => [h('h3', {}, 'Estudio en PDF'), body]);
    let pct = 8;
    const tick = setInterval(() => {
      pct = Math.min(92, pct + (92 - pct) * 0.06);
      bar.style.width = `${pct}%`;
    }, 700);
    let blob;
    try {
      const res = await fetch(`/api/notes/${note.id}/export.pdf`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
      blob = await res.blob();
    } catch (e) {
      clearInterval(tick);
      s.close();
      toast(e instanceof TypeError ? 'Sin conexión. Revisa tu internet e intenta de nuevo.' : e.message, { error: true, ms: 5000 });
      return;
    }
    clearInterval(tick);
    if (!note.analysis.study) note = await api.get(`/api/notes/${note.id}`).catch(() => note);
    const name = `${(note.title || 'estudio').normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'estudio'}.pdf`;
    const file = new File([blob], name, { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const canShare = navigator.canShare?.({ files: [file] });
    vibrate(15);
    body.replaceChildren(
      h('p', { class: 'muted', style: { margin: '6px 0 0' } }, `Listo · ${Math.max(1, Math.round(blob.size / 1024))} KB`),
      h(
        'div',
        { class: 'export-row', style: { marginTop: '16px' } },
        h('a', { class: 'btn', href: url, download: name }, icon('pdf'), 'Guardar'),
        canShare
          ? h(
              'button',
              {
                class: 'btn primary',
                onclick: async () => {
                  try {
                    await navigator.share({ files: [file], title: note.title });
                  } catch (e) {
                    if (e.name !== 'AbortError') toast('No se pudo compartir; usa Guardar', { error: true });
                  }
                },
              },
              icon('wa'),
              'Compartir',
            )
          : h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, icon('pdf'), 'Abrir'),
      ),
    );
  }

  async function whatsappSheet() {
    let w;
    try {
      w = await api.get(`/api/notes/${note.id}/whatsapp`);
    } catch (e) {
      toast(e.status ? e.message : 'Sin conexión. Revisa tu internet e intenta de nuevo.', { error: true, ms: 5000 });
      return;
    }
    sheet(() => [
      h('h3', {}, 'Compartir resumen'),
      h('pre', { class: 'card', style: { whiteSpace: 'pre-wrap', padding: '16px', font: '500 14px/1.5 var(--sans)', maxHeight: '42vh', overflow: 'auto', marginTop: '14px' } }, w.summary),
      h(
        'div',
        { class: 'export-row', style: { marginTop: '14px' } },
        h('button', { class: 'btn', onclick: () => copyText(w.summary, 'Resumen copiado') }, icon('copy'), 'Copiar'),
        h('a', { class: 'btn primary', href: waLink(w.summary), target: '_blank', rel: 'noopener' }, icon('wa'), 'Abrir WhatsApp'),
      ),
    ]);
  }

  function versiculos() {
    const list = a().verses || [];
    if (!list.length) return h('p', { class: 'muted' }, 'No se detectaron citas bíblicas en esta prédica.');
    return [
      title(`${list.length} ${list.length === 1 ? 'pasaje' : 'pasajes'}`, h('span', { class: 'faint', style: { fontSize: '12px' } }, state.bible?.id || 'RV1909')),
      h(
        'div',
        { class: 'verses stagger' },
        list.map((v) =>
          h(
            'button',
            { class: `card verse${v.found ? '' : ' missing'}`, onclick: () => verseSheet(v) },
            h('b', {}, v.reference),
            h('small', {}, v.context || v.how_cited || ''),
            icon('book'),
          ),
        ),
      ),
    ];
  }

  async function verseSheet(v) {
    const body = h('div', {}, h('div', { class: 'skeleton', style: { height: '120px', marginTop: '14px' } }));
    sheet(() => [
      h('span', { class: 'eyebrow' }, state.bible?.name || 'Reina-Valera 1909'),
      h('h3', {}, v.reference),
      body,
      v.timestamp_sec != null
        ? h('button', { class: 'btn block', style: { marginTop: '18px' }, onclick: () => seek(v.timestamp_sec) }, icon('play'), `Escuchar en ${mmss(v.timestamp_sec)}`)
        : null,
    ]);
    try {
      const p = await api.get(`/api/bible?code=${v.code}&chapter=${v.chapter}&from=${v.verse_start}&to=${v.verse_end}`);
      body.replaceChildren(
        h('p', { class: 'passage' }, p.verses.map((x) => [h('sup', {}, x.verse), `${x.text} `])),
        h('button', { class: 'btn small', style: { marginTop: '12px' }, onclick: () => copyText(`${p.reference} (${p.version})\n${p.verses.map((x) => x.text).join(' ')}`) }, icon('copy'), 'Copiar'),
        h('p', { class: 'version' }, `${p.versionName} · Dominio público`),
      );
    } catch {
      body.replaceChildren(h('p', { class: 'muted' }, 'No encontré ese pasaje en la RV1909. Puede ser una cita aproximada.'));
    }
  }

  function anuncios() {
    const list = a().announcements || [];
    if (!list.length) return h('p', { class: 'muted' }, 'No hubo anuncios en este audio.');
    return [
      title('Agenda', h('button', { class: 'btn small primary', onclick: copyAllAnnouncements }, icon('wa'), 'Copiar todo')),
      h(
        'div',
        { class: 'agenda stagger' },
        list.map((ev) => {
          const d = dateParts(ev.date);
          return h(
            'article',
            { class: 'card event' },
            h('div', { class: 'cal' }, d ? [h('span', {}, d.dow), h('b', {}, d.day), h('small', {}, d.month)] : [h('span', {}, 'Pronto'), h('b', {}, '·')]),
            h(
              'div',
              {},
              h('h4', {}, ev.title),
              ev.description ? h('p', {}, ev.description) : null,
              h(
                'div',
                { class: 'meta' },
                !d && ev.when_text ? h('span', {}, icon('cal'), ev.when_text) : null,
                ev.time ? h('span', {}, icon('clock'), fmtTime(ev.time)) : null,
                ev.place ? h('span', {}, icon('pin'), ev.place) : null,
              ),
              h(
                'div',
                { class: 'row' },
                h('button', { class: 'btn small', onclick: () => copyText(announcementText(ev), 'Anuncio copiado') }, icon('copy'), 'WhatsApp'),
                ev.date ? h('button', { class: 'btn small ghost', onclick: () => downloadIcs(ev) }, icon('cal'), 'Calendario') : null,
                tsChip(ev.timestamp_sec),
              ),
            ),
          );
        }),
      ),
    ];
  }

  async function copyAllAnnouncements() {
    const w = await api.get(`/api/notes/${note.id}/whatsapp`);
    copyText(w.announcements, 'Anuncios copiados para WhatsApp');
  }

  function celula() {
    const qs = a().cell_questions || [];
    const text = `*Preguntas para célula — ${note.title}*\n\n${qs.map((q, i) => `${i + 1}. ${q}`).join('\n')}${
      a().weekly_task?.title ? `\n\n🎯 *Tarea de la semana:* ${a().weekly_task.title}. ${a().weekly_task.description}` : ''
    }`;
    return [
      a().weekly_task?.title
        ? h('article', { class: 'card task' }, h('span', { class: 'eyebrow' }, 'Tarea de la semana'), h('h4', {}, a().weekly_task.title), h('p', { class: 'muted', style: { margin: 0 } }, a().weekly_task.description))
        : null,
      title('Preguntas para célula', h('button', { class: 'btn small', onclick: () => copyText(text, 'Preguntas copiadas') }, icon('copy'), 'Copiar')),
      h('div', { class: 'questions stagger' }, qs.map((q) => h('div', { class: 'card question' }, q))),
    ];
  }

  function devocional() {
    const days = a().devotional || [];
    const dots = h('div', { class: 'dots' }, days.map((_, i) => h('i', { class: i ? '' : 'on' })));
    const track = h(
      'div',
      {
        class: 'days',
        onscroll: (e) => {
          const el = e.currentTarget;
          const i = Math.round(el.scrollLeft / (el.firstChild?.offsetWidth + 12 || 1));
          dots.querySelectorAll('i').forEach((d, j) => d.classList.toggle('on', j === i));
        },
      },
      days.map((d) =>
        h(
          'article',
          { class: 'card day' },
          h('div', { class: 'num' }, `0${d.day}`.slice(-2)),
          h('h4', {}, d.title),
          d.reference ? h('button', { class: 'ts', style: { marginTop: 0, width: 'fit-content' }, onclick: () => verseSheet({ ...d, timestamp_sec: null }) }, icon('book'), d.reference) : null,
          h('p', {}, d.reflection),
          h('span', { class: 'lbl' }, 'Hoy'),
          h('p', {}, d.action),
          h('span', { class: 'lbl' }, 'Oración'),
          h('p', { class: 'pray' }, d.prayer),
        ),
      ),
    );
    return [title('Devocional de 5 días'), track, dots];
  }

  function redes() {
    return [
      title('Para compartir'),
      h(
        'div',
        { class: 'socials stagger' },
        (a().social_quotes || []).map((q) =>
          h(
            'article',
            { class: 'card social' },
            h('p', {}, q),
            h(
              'div',
              { class: 'row' },
              h('span', {}, `${q.length} caracteres`),
              h('span', { style: { display: 'flex', gap: '6px' } }, h('button', { class: 'btn small', onclick: () => copyText(q) }, icon('copy'), 'Copiar'), h('button', { class: 'icon-btn', 'aria-label': 'Compartir', onclick: () => shareText(q) }, icon('share'))),
            ),
          ),
        ),
      ),
    ];
  }

  function transcripcion() {
    const sections = a().sections || [];
    const LABEL = { predica: 'Prédica', anuncios: 'Anuncios', alabanza: 'Alabanza', oracion: 'Oración', otro: 'Otro' };
    const segEls = [];
    const wrap = h('div', { class: 'transcript' });
    let lastKind = null;
    note.transcript.forEach((s) => {
      const sec = sections.find((x) => s.start >= x.start_sec && s.start < x.end_sec);
      if (sec && sec.kind !== lastKind) {
        wrap.append(h('div', { class: 'divider' }, LABEL[sec.kind] || sec.kind));
        lastKind = sec.kind;
      }
      const el = h('button', { class: 'seg', onclick: () => seek(s.start) }, h('time', {}, mmss(s.start)), h('span', {}, s.text));
      segEls.push([s, el]);
      wrap.append(el);
    });
    let follow = true;
    let lastIdx = -1;
    const followBtn = h('div', { class: 'follow', hidden: true }, h('button', { class: 'btn small primary', onclick: () => ((follow = true), (followBtn.hidden = true), lastIdx = -1, tick(audio.currentTime)) }, 'Seguir el audio'));
    let userScroll = 0;
    const markUser = () => (userScroll = Date.now());
    window.addEventListener('touchmove', markUser, { passive: true });
    window.addEventListener('wheel', markUser, { passive: true });
    const tick = (t) => {
      let idx = -1;
      for (let i = 0; i < segEls.length; i++) if (segEls[i][0].start <= t + 0.2) idx = i;
      if (idx === lastIdx) return;
      segEls[lastIdx]?.[1].classList.remove('now');
      lastIdx = idx;
      const el = segEls[idx]?.[1];
      if (!el) return;
      el.classList.add('now');
      if (Date.now() - userScroll < 3000 && !audio.paused) {
        follow = false;
        followBtn.hidden = false;
      }
      if (follow && !audio.paused) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    timeListeners.add(tick);
    requestAnimationFrame(() => tick(audio.currentTime));
    return [title(`${note.transcript.length} fragmentos`, h('span', { class: 'faint', style: { fontSize: '12px' } }, 'Toca una frase para escucharla')), wrap, followBtn];
  }

  function chat() {
    const box = h('div', { class: 'chat' });
    const ta = h('textarea', { rows: 1, placeholder: 'Pregunta sobre esta prédica…', enterkeyhint: 'send' });
    const sendBtn = h('button', { class: 'icon-btn', 'aria-label': 'Enviar' }, icon('send'));
    const suggest = h(
      'div',
      { class: 'suggest' },
      ['¿Cuál fue la idea más importante?', 'Dame un versículo para memorizar', '¿Cómo aplico esto en mi trabajo?', 'Resúmelo para un niño'].map((s) =>
        h('button', { class: 'chip', onclick: () => ask(s) }, s),
      ),
    );
    const bubble = (role, text) => {
      const el = h('div', { class: `msg ${role}` });
      setMsg(el, text);
      return el;
    };
    function setMsg(el, text) {
      el.replaceChildren(
        ...text.split(/(\[\d{1,2}:\d{2}(?::\d{2})?\])/).map((part) => {
          const m = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]$/.exec(part);
          if (!m) return part;
          const sec = m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
          return tsChip(sec);
        }),
      );
    }
    api.get(`/api/notes/${note.id}/chat`).then((msgs) => {
      if (msgs.length) suggest.remove();
      box.append(...msgs.map((m) => bubble(m.role, m.content)));
    });
    let busy = false;
    async function ask(q) {
      q = (q || ta.value).trim();
      if (!q || busy) return;
      busy = true;
      ta.value = '';
      suggest.remove();
      box.append(bubble('user', q));
      const reply = h('div', { class: 'msg assistant' }, h('span', { class: 'typing' }, h('i'), h('i'), h('i')));
      box.append(reply);
      reply.scrollIntoView({ block: 'end', behavior: 'smooth' });
      let acc = '';
      try {
        const final = await api.chat(note.id, q, {
          onDelta: (t) => {
            acc += t;
            reply.textContent = acc;
          },
        });
        setMsg(reply, final || acc);
      } catch (e) {
        reply.textContent = e.message;
        reply.style.color = 'var(--rose)';
      }
      busy = false;
      reply.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        ask();
      }
    });
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    });
    sendBtn.addEventListener('click', () => ask());
    return [
      title('Conversa con la prédica', h('button', { class: 'btn small ghost', onclick: async () => (await api.del(`/api/notes/${note.id}/chat`), box.replaceChildren(), toast('Conversación borrada')) }, 'Borrar')),
      box,
      suggest,
      h('div', { class: 'composer' }, ta, sendBtn),
    ];
  }

  // ---- reproductor
  function mountPlayer() {
    if (player || !note.hasAudio) return;
    audio.src = `/api/notes/${note.id}/audio`;
    const playBtn = h('button', { class: 'play', 'aria-label': 'Reproducir' }, icon('play'));
    const range = h('input', { class: 'range', type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Posición' });
    const cur = h('span', {}, '0:00');
    const dur = h('span', {}, mmss(note.durationSec));
    // Las grabaciones del navegador (webm) pueden reportar duración "Infinity": se usa la guardada.
    const D = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : note.durationSec || 0);
    const speeds = [1, 1.25, 1.5, 2, 0.8];
    let si = 0;
    const speed = h('button', { 'aria-label': 'Velocidad' }, '1×');
    speed.onclick = () => {
      si = (si + 1) % speeds.length;
      audio.playbackRate = speeds[si];
      speed.textContent = `${speeds[si]}×`;
    };
    playBtn.onclick = () => (audio.paused ? audio.play() : audio.pause());
    audio.addEventListener('play', () => playBtn.replaceChildren(icon('pause')));
    audio.addEventListener('pause', () => playBtn.replaceChildren(icon('play')));
    let dragging = false;
    range.addEventListener('input', () => {
      dragging = true;
      cur.textContent = mmss((range.value / 1000) * D());
      range.style.setProperty('--p', `${range.value / 10}%`);
    });
    range.addEventListener('change', () => {
      dragging = false;
      audio.currentTime = (range.value / 1000) * D();
    });
    audio.addEventListener('timeupdate', () => {
      if (dragging) return;
      const d = D() || 1;
      range.value = (audio.currentTime / d) * 1000;
      range.style.setProperty('--p', `${(audio.currentTime / d) * 100}%`);
      cur.textContent = mmss(audio.currentTime);
    });
    audio.addEventListener('loadedmetadata', () => (dur.textContent = mmss(D())));
    player = h(
      'div',
      { class: 'player' },
      playBtn,
      h('div', { class: 'scrub' }, range, h('div', { class: 'times' }, cur, dur)),
      h(
        'div',
        { class: 'p-side' },
        h('button', { 'aria-label': 'Atrás 15 segundos', onclick: () => (audio.currentTime = Math.max(0, audio.currentTime - 15)) }, icon('rew')),
        h('button', { 'aria-label': 'Adelante 15 segundos', onclick: () => (audio.currentTime += 15) }, icon('fwd')),
        speed,
      ),
    );
    document.body.append(player);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: note.title, artist: note.preacher || 'Selah', artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
      navigator.mediaSession.setActionHandler('seekbackward', () => (audio.currentTime -= 15));
      navigator.mediaSession.setActionHandler('seekforward', () => (audio.currentTime += 15));
    }
  }

  function optionsSheet() {
    sheet((close) => {
      const act = (ic, t, fn, cls = '') => h('button', { class: `action ${cls}`, onclick: () => (close(), fn()) }, h('span', { class: 'ic' }, icon(ic)), h('span', {}, h('b', {}, t)), h('span'));
      return [
        h('h3', {}, 'Opciones'),
        h(
          'div',
          { class: 'actions' },
          act('edit', 'Editar datos', editSheet),
          act('folder', 'Mover a carpeta', moveSheet),
          note.status === 'ready' ? act('refresh', 'Volver a analizar', () => reprocess(false)) : null,
          act(
            'trash',
            'Eliminar nota',
            async () => {
              if (!confirm('¿Eliminar esta nota y su audio? No se puede deshacer.')) return;
              await api.del(`/api/notes/${note.id}`);
              toast('Nota eliminada');
              go('/', { replace: true });
            },
            'danger',
          ),
        ),
      ];
    });
  }

  function editSheet() {
    sheet((close) => {
      const t = h('input', { class: 'input', value: note.title });
      const p = h('input', { class: 'input', value: note.preacher, placeholder: 'Nombre del predicador' });
      const d = h('input', { class: 'input', type: 'date', value: note.preachedAt });
      return [
        h('h3', {}, 'Editar nota'),
        h(
          'form',
          {
            style: { display: 'grid', gap: '14px', marginTop: '16px' },
            onsubmit: async (e) => {
              e.preventDefault();
              note = await api.patch(`/api/notes/${note.id}`, { title: t.value, preacher: p.value, preachedAt: d.value });
              close();
              draw();
              toast('Guardado');
            },
          },
          h('div', { class: 'field' }, h('label', {}, 'Título'), t),
          h('div', { class: 'field' }, h('label', {}, 'Predicador'), p),
          h('div', { class: 'field' }, h('label', {}, 'Fecha'), d),
          h('button', { class: 'btn primary block' }, 'Guardar'),
        ),
      ];
    });
  }

  async function moveSheet() {
    state.folders = await api.get('/api/folders');
    sheet((close) => [
      h('h3', {}, 'Mover a carpeta'),
      h(
        'div',
        { class: 'actions' },
        [{ id: null, name: 'Sin carpeta' }, ...state.folders].map((f) =>
          h(
            'button',
            {
              class: 'action',
              onclick: async () => {
                note = await api.patch(`/api/notes/${note.id}`, { folderId: f.id || '' });
                close();
                draw();
                toast(`Movida a ${f.name}`);
              },
            },
            h('span', { class: 'ic' }, icon(note.folderId === f.id ? 'check' : 'folder')),
            h('span', {}, h('b', {}, f.name)),
            h('span'),
          ),
        ),
        h('button', { class: 'action', onclick: () => (close(), folderSheet(moveSheet)) }, h('span', { class: 'ic' }, icon('plus')), h('span', {}, h('b', {}, 'Nueva carpeta')), h('span')),
      ),
    ]);
  }

  if (!state.folders.length) api.get('/api/folders').then((f) => (state.folders = f)).catch(() => {});
  draw();
  return root;
}

// ---------------------------------------------------------------- Utilidades
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function fmtTime(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'a. m.' : 'p. m.'}`;
}
function announcementText(ev) {
  const when = [ev.date ? longDate(ev.date) : ev.when_text, ev.time ? fmtTime(ev.time) : ''].filter(Boolean).join(' · ');
  return [`📌 *${ev.title}*`, when && `🗓️ ${when}`, ev.place && `📍 ${ev.place}`, ev.description].filter(Boolean).join('\n');
}
function downloadIcs(ev) {
  const d = ev.date.replace(/-/g, '');
  const [hh, mm] = (ev.time || '').split(':');
  const start = ev.time ? `${d}T${hh.padStart(2, '0')}${mm}00` : d;
  const endH = ev.time ? `${d}T${String(Math.min(23, +hh + 2)).padStart(2, '0')}${mm}00` : d;
  const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Selah//ES', 'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@selah`,
    ev.time ? `DTSTART:${start}` : `DTSTART;VALUE=DATE:${start}`,
    ev.time ? `DTEND:${endH}` : `DTEND;VALUE=DATE:${endH}`,
    `SUMMARY:${esc(ev.title)}`, `LOCATION:${esc(ev.place)}`, `DESCRIPTION:${esc(ev.description)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  h('a', { href: url, download: `${ev.title.slice(0, 40)}.ics` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- Arranque
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();
