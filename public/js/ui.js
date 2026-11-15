// Utilidades de interfaz: creación de nodos, iconos, avisos, hojas inferiores.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  upload: '<path d="M12 15V4m0 0-4 4m4-4 4 4"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  yt: '<rect x="3" y="5.5" width="18" height="13" rx="4"/><path d="m10.5 9.5 4 2.5-4 2.5z" fill="currentColor"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  rew: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/><text x="12" y="15.5" font-size="7.5" font-weight="800" text-anchor="middle" fill="currentColor" stroke="none">15</text>',
  fwd: '<path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4h-4"/><text x="12" y="15.5" font-size="7.5" font-weight="800" text-anchor="middle" fill="currentColor" stroke="none">15</text>',
  chev: '<path d="m9 5 7 7-7 7"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  share: '<path d="M12 3v12M12 3 8 7m4-4 4 4"/><path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  wa: '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.7z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 0 1-2-2l.8-1-1-2z" fill="currentColor" stroke="none"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 2h13v-4"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  send: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.8-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.8 3.5L20 15M20 20v-5h-5"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  return span.firstChild;
}

export const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd596"/><stop offset="1" stop-color="#e2743a"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#lg)"/><path d="M22 41c3 4 18 5 20-3 2-9-18-7-17-16 1-7 14-7 18-2" fill="none" stroke="#241405" stroke-width="4.2" stroke-linecap="round"/><path d="M18 50h28" stroke="#241405" stroke-width="3" stroke-linecap="round" opacity=".45"/></svg>`;

export function toast(msg, { error = false, ms = 2600 } = {}) {
  const el = h('div', { class: `toast${error ? ' err' : ''}` }, error ? null : icon('check'), msg);
  el.querySelector?.('svg')?.setAttribute('width', '16');
  document.getElementById('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

export function vibrate(ms = 10) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}

/** Hoja inferior con animación de resorte. Devuelve { el, close }. */
export function sheet(build) {
  const scrim = h('div', { class: 'scrim' });
  const el = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grab' }));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.classList.add('out');
    el.classList.add('out');
    setTimeout(() => {
      scrim.remove();
      el.remove();
    }, 280);
    window.removeEventListener('popstate', onPop);
  };
  const onPop = () => close();
  scrim.addEventListener('click', close);
  // Deslizar hacia abajo para cerrar.
  let y0 = null;
  el.addEventListener('touchstart', (e) => (y0 = el.scrollTop <= 0 ? e.touches[0].clientY : null), { passive: true });
  el.addEventListener(
    'touchmove',
    (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy > 0) el.style.transform = `translateY(${dy}px)`;
    },
    { passive: true },
  );
  el.addEventListener('touchend', (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    el.style.transform = '';
    if (dy > 90) close();
    y0 = null;
  });
  el.append(...[build(close)].flat());
  document.body.append(scrim, el);
  window.addEventListener('popstate', onPop);
  return { el, close };
}

export async function copyText(text, label = 'Copiado') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  vibrate(12);
  toast(label);
}

export async function shareText(text, title = 'Selah') {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  copyText(text);
}

export function waLink(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function mmss(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export function dateParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return { day: d.getDate(), month: MONTHS[d.getMonth()], dow: DOW[d.getDay()], year: d.getFullYear() };
}
export function longDate(iso) {
  const p = dateParts(iso);
  if (!p) return '';
  return new Date(p.year, MONTHS.indexOf(p.month), p.day).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
}
