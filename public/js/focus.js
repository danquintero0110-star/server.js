// "Aplícalo": la prédica enfocada a un área de la vida o del ministerio.
import { api } from './api.js';
import { h, icon, toast, copyText, shareText, vibrate } from './ui.js';
import * as V from './voice.js';
import { openStudio, phrasesFrom } from './studio.js';

export const AREAS = [
  'Mi trabajo',
  'Mi negocio',
  'Mi familia',
  'Mi matrimonio',
  'Jóvenes',
  'Intercesión',
  'Servicio',
  'Alabanza',
  'Liderazgo y células',
  'Mis finanzas',
  'Mis estudios',
  'Evangelismo',
];

const keyOf = (area) =>
  String(area || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

async function verseText(v) {
  try {
    const p = await api.get(`/api/bible?code=${v.code}&chapter=${v.chapter}&from=${v.verse_start || 0}&to=${v.verse_end || 0}`);
    return p.verses.map((x) => x.text).join(' ');
  } catch {
    return '';
  }
}

function focusText(note, f) {
  return [
    `*${f.title}*`,
    `_${note.title}_`,
    '',
    f.message,
    '',
    '✅ *Para aplicar*',
    ...f.applications.map((x) => `• ${x}`),
    '',
    f.verses.length ? `📖 ${f.verses.map((v) => v.reference).join(' · ')}` : '',
    f.challenge ? `🎯 *Reto:* ${f.challenge}` : '',
    '',
    `🙏 ${f.prayer}`,
    '',
    '— Selah',
  ]
    .filter((x, i, arr) => x !== '' || arr[i - 1] !== '')
    .join('\n');
}

export function focusPanel(note, { me, onChange }) {
  const a = note.analysis;
  a.focus ||= {};
  const list = h('div', { class: 'fx-list' });
  const custom = h('input', { class: 'input', placeholder: 'Otra área: p. ej. "mi equipo de ujieres"', maxlength: 80, enterkeyhint: 'go' });
  const go = h('button', { class: 'btn primary small' }, 'Enfocar');

  function card(f, key) {
    const verses = h('div', { class: 'fx-verses' });
    const el = h(
      'article',
      { class: 'card fx-card', 'data-key': key },
      h('div', { class: 'fx-head' }, h('span', { class: 'eyebrow' }, f.area), h('button', { class: 'icon-btn small', 'aria-label': 'Quitar enfoque', onclick: remove }, icon('x'))),
      h('h3', {}, f.title),
      ...String(f.message || '')
        .split(/\n\s*\n/)
        .map((p) => h('p', { class: 'fx-p' }, p)),
      h('h4', {}, 'Para aplicar'),
      h('ul', { class: 'fx-apps' }, f.applications.map((x) => h('li', {}, x))),
      verses,
      f.challenge ? h('div', { class: 'fx-challenge' }, h('b', {}, 'Reto de la semana'), h('span', {}, f.challenge)) : null,
      h('p', { class: 'fx-prayer' }, f.prayer),
      f.phrase
        ? h(
            'button',
            {
              class: 'fx-phrase',
              onclick: () => {
                const phrases = phrasesFrom(note);
                openStudio({ note, phrases, start: Math.max(0, phrases.findIndex((p) => p.text === f.phrase)), me });
              },
            },
            h('span', {}, `“${f.phrase}”`),
            h('small', {}, icon('spark'), 'Crear imagen'),
          )
        : null,
      h(
        'div',
        { class: 'fx-actions' },
        h('button', { class: 'btn small', onclick: () => listen() }, icon('headphones'), 'Escuchar'),
        h('button', { class: 'btn small', onclick: () => copyText(focusText(note, f), 'Copiado para WhatsApp') }, icon('wa'), 'WhatsApp'),
        h('button', { class: 'icon-btn small', 'aria-label': 'Compartir', onclick: () => shareText(focusText(note, f), f.title) }, icon('share')),
      ),
    );
    Promise.all(f.verses.map(async (v) => [v, await verseText(v)])).then((rows) =>
      verses.replaceChildren(
        ...rows
          .filter(([, t]) => t)
          .map(([v, t]) => h('blockquote', { class: 'fx-verse' }, h('b', {}, v.reference), h('span', {}, t), v.why ? h('small', {}, v.why) : null)),
      ),
    );
    let speaking = false;
    async function listen() {
      if (speaking) {
        V.stopSpeaking();
        speaking = false;
        return;
      }
      speaking = true;
      const texts = await Promise.all(f.verses.map(verseText));
      const script = [
        f.title,
        f.message,
        `Para aplicar: ${f.applications.join('. ')}.`,
        ...f.verses.map((v, i) => (texts[i] ? `${v.reference}. ${texts[i]}` : '')),
        f.challenge ? `Tu reto de la semana: ${f.challenge}` : '',
        `Oremos. ${f.prayer}`,
      ]
        .filter(Boolean)
        .join(' ');
      await V.speak(script);
      speaking = false;
    }
    async function remove() {
      if (!confirm(`¿Quitar el enfoque "${f.area}"?`)) return;
      await api.del(`/api/notes/${note.id}/focus/${encodeURIComponent(key)}`).catch(() => {});
      delete a.focus[key];
      el.remove();
      renderChips();
      onChange?.();
    }
    return el;
  }

  const chipsBox = h('div', { class: 'fx-chips' });
  function renderChips() {
    chipsBox.replaceChildren(
      ...AREAS.map((area) =>
        h('button', { class: `chip${a.focus[keyOf(area)] ? ' on' : ''}`, onclick: () => request(area) }, area),
      ),
    );
  }

  async function request(area) {
    area = String(area || '').trim();
    const key = keyOf(area);
    if (!key) return;
    const existing = list.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (existing) {
      existing.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    vibrate(8);
    const loading = h(
      'article',
      { class: 'card fx-card fx-loading', 'data-key': key },
      h('span', { class: 'eyebrow' }, area),
      h('h3', {}, 'Preparando el enfoque…'),
      h('p', { class: 'muted' }, 'Selah está llevando la prédica a esta área. Tarda unos 20 a 40 segundos.'),
      h('div', { class: 'skeleton', style: { height: '90px', marginTop: '10px' } }),
    );
    list.prepend(loading);
    loading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const r = await api.post(`/api/notes/${note.id}/focus`, { area });
      a.focus[r.key] = r.focus;
      loading.replaceWith(card(r.focus, r.key));
      renderChips();
      onChange?.();
      vibrate([15, 50, 15]);
    } catch (e) {
      loading.remove();
      toast(e.status ? e.message : 'Sin conexión. Intenta de nuevo.', { error: true });
    }
  }
  go.onclick = () => {
    const v = custom.value.trim();
    if (!v) return custom.focus();
    custom.value = '';
    request(v);
  };
  custom.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), go.click()));

  Object.entries(a.focus)
    .sort((x, y) => String(y[1].created_at || '').localeCompare(String(x[1].created_at || '')))
    .forEach(([k, f]) => list.append(card(f, k)));
  renderChips();

  return [
    h('div', { class: 'section-title' }, h('span', { class: 'eyebrow' }, 'Aplica esta prédica a…')),
    chipsBox,
    h('div', { class: 'fx-custom' }, custom, go),
    list,
  ];
}
