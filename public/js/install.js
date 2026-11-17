// Guía para instalar Selah en el teléfono, según el sistema y el navegador.
// Funciona en iPhone (Safari, Chrome, Edge, Firefox), Android (Chrome, Samsung Internet,
// Firefox, Edge, Opera) y computadora. No depende de Chrome.
import { h, icon, sheet, copyText, shareText } from './ui.js';

// Android/Chrome/Edge/Samsung ofrecen un botón nativo de instalación.
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
window.addEventListener('appinstalled', () => (deferredPrompt = null));

export function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function detect(ua = navigator.userAgent, touch = navigator.maxTouchPoints || 0) {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1); // iPadOS se presenta como Mac
  const android = /Android/.test(ua);
  let browser = 'other';
  if (ios) {
    if (/CriOS/.test(ua)) browser = 'chrome';
    else if (/FxiOS/.test(ua)) browser = 'firefox';
    else if (/EdgiOS/.test(ua)) browser = 'edge';
    else if (/Safari/.test(ua) && !/(GSA|Instagram|FBAN|FBAV|Line|WhatsApp)/.test(ua)) browser = 'safari';
    else browser = 'inapp';
  } else if (android) {
    if (/SamsungBrowser/.test(ua)) browser = 'samsung';
    else if (/Firefox/.test(ua)) browser = 'firefox';
    else if (/EdgA/.test(ua)) browser = 'edge';
    else if (/OPR|Opera/.test(ua)) browser = 'opera';
    else if (/; wv\)|FBAN|FBAV|Instagram|WhatsApp/.test(ua)) browser = 'inapp';
    else if (/Chrome/.test(ua)) browser = 'chrome';
  } else {
    if (/Edg\//.test(ua)) browser = 'edge';
    else if (/Firefox/.test(ua)) browser = 'firefox';
    else if (/Chrome/.test(ua)) browser = 'chrome';
    else if (/Safari/.test(ua)) browser = 'safari';
  }
  return { os: ios ? 'ios' : android ? 'android' : 'desktop', browser };
}

const SHARE_IOS = 'el botón Compartir (el cuadrito con una flecha hacia arriba ⬆️)';
const ADD_IOS = '“Agregar a pantalla de inicio” (si no la ves, desliza hacia abajo en esa lista)';

export const GUIDES = {
  ios: {
    label: 'iPhone / iPad',
    safari: { name: 'Safari', steps: [`Toca ${SHARE_IOS}, abajo en el centro.`, `Elige ${ADD_IOS}.`, 'Toca “Agregar”, arriba a la derecha.'] },
    chrome: { name: 'Chrome', steps: [`Toca ${SHARE_IOS}, junto a la barra de dirección.`, `Elige ${ADD_IOS}.`, 'Toca “Agregar”.'] },
    edge: { name: 'Edge', steps: ['Toca ⋯ (abajo al centro) y luego “Compartir”.', `Elige ${ADD_IOS}.`, 'Toca “Agregar”.'] },
    firefox: { name: 'Firefox', steps: ['Toca el menú ☰ (abajo a la derecha) y luego “Compartir”.', `Elige ${ADD_IOS}.`, 'Toca “Agregar”.'] },
    inapp: { name: 'dentro de WhatsApp u otra app', steps: ['Toca ⋯ o el ícono de brújula y elige “Abrir en Safari”.', `En Safari, toca ${SHARE_IOS}.`, `Elige ${ADD_IOS} y luego “Agregar”.`] },
    other: { name: 'otro navegador', steps: ['Abre el enlace en Safari.', `Toca ${SHARE_IOS}.`, `Elige ${ADD_IOS} y luego “Agregar”.`] },
    note: 'Necesita iOS 16.4 o más reciente para instalar desde Chrome, Edge o Firefox y para recibir recordatorios. Con versiones anteriores, usa Safari.',
  },
  android: {
    label: 'Android',
    chrome: { name: 'Chrome', steps: ['Toca ⋮ (arriba a la derecha).', 'Elige “Instalar aplicación” o “Agregar a pantalla principal”.', 'Confirma con “Instalar”.'] },
    samsung: { name: 'Samsung Internet', steps: ['Toca el menú ☰ (abajo a la derecha).', 'Elige “Añadir página a” → “Pantalla de inicio”. Si ves un ícono de descarga en la barra de dirección, también sirve.', 'Confirma con “Añadir”.'] },
    firefox: { name: 'Firefox', steps: ['Toca ⋮ (arriba o abajo a la derecha).', 'Elige “Instalar” o “Agregar a pantalla de inicio”.', 'Confirma con “Agregar”.'] },
    edge: { name: 'Edge', steps: ['Toca ⋯ (abajo al centro).', 'Elige “Agregar al teléfono” o “Agregar a pantalla de inicio”.', 'Confirma con “Instalar”.'] },
    opera: { name: 'Opera', steps: ['Toca ⋮ o el menú de Opera.', 'Elige “Pantalla de inicio”.', 'Confirma con “Agregar”.'] },
    inapp: { name: 'dentro de WhatsApp u otra app', steps: ['Toca ⋮ (arriba a la derecha) y elige “Abrir en el navegador”.', 'En el navegador, toca ⋮.', 'Elige “Instalar aplicación” o “Agregar a pantalla principal”.'] },
    other: { name: 'tu navegador', steps: ['Abre el menú del navegador (⋮, ⋯ o ☰).', 'Busca “Instalar”, “Agregar a pantalla de inicio” o “Añadir a inicio”.', 'Confirma.'] },
    note: '',
  },
  desktop: {
    label: 'Computadora',
    chrome: { name: 'Chrome', steps: ['Haz clic en el ícono de instalar (monitor con flecha) al final de la barra de dirección.', 'Confirma con “Instalar”.'] },
    edge: { name: 'Edge', steps: ['Haz clic en ⋯ → “Aplicaciones” → “Instalar este sitio como aplicación”.', 'Confirma con “Instalar”.'] },
    safari: { name: 'Safari (Mac)', steps: ['En el menú “Archivo”, elige “Agregar al Dock”.', 'Confirma con “Agregar”.'] },
    firefox: { name: 'Firefox', steps: ['Firefox en computadora no instala apps web: guarda Selah en marcadores o ábrela en Chrome, Edge o Safari para instalarla.'] },
    other: { name: 'tu navegador', steps: ['Busca la opción “Instalar” en el menú del navegador, o guarda la página en marcadores.'] },
    note: '',
  },
};

function stepsList(steps) {
  return h('ol', { class: 'install-steps' }, steps.map((s) => h('li', {}, s)));
}

/** Texto corto para WhatsApp: pasos para iPhone y Android sin depender de Chrome. */
export function installText() {
  return [
    '📲 *Para tenerla como app:*',
    '*iPhone:* ábrela en Safari → botón Compartir ⬆️ → “Agregar a pantalla de inicio” → Agregar.',
    '*Android:* en el menú del navegador (⋮ o ☰) → “Instalar aplicación” o “Agregar a pantalla de inicio”. Funciona en Chrome, Samsung Internet, Firefox y Edge.',
    `Si la abriste desde WhatsApp, primero toca “Abrir en el navegador”. Guía completa: ${location.origin}/?instalar`,
  ].join('\n');
}

export function installSheet() {
  const me = detect();
  sheet(() => {
    const g = GUIDES[me.os];
    const cur = g[me.browser] || g.other;
    const others = h('div', { class: 'install-others', hidden: true });
    for (const [os, guide] of Object.entries(GUIDES)) {
      for (const [key, b] of Object.entries(guide)) {
        if (!b?.steps || key === 'other' || (os === me.os && key === me.browser)) continue;
        others.append(h('details', { class: 'card install-alt' }, h('summary', {}, `${guide.label} · ${b.name}`), stepsList(b.steps)));
      }
    }
    const installBtn =
      deferredPrompt && !isInstalled()
        ? h(
            'button',
            {
              class: 'btn primary block',
              style: { marginTop: '14px' },
              onclick: async () => {
                deferredPrompt.prompt();
                await deferredPrompt.userChoice.catch(() => {});
                deferredPrompt = null;
              },
            },
            icon('plus'),
            'Instalar Selah ahora',
          )
        : null;
    return [
      h('span', { class: 'eyebrow' }, 'Instalar en tu teléfono'),
      h('h3', {}, isInstalled() ? 'Ya la tienes instalada 🙌' : `${g.label} · ${cur.name}`),
      isInstalled()
        ? h('p', { class: 'muted' }, 'Estás usando Selah como app. Puedes compartir estas instrucciones con alguien más.')
        : [installBtn, stepsList(cur.steps), g.note ? h('p', { class: 'faint', style: { fontSize: '13px' } }, g.note) : null],
      h('button', { class: 'btn small ghost', style: { marginTop: '8px' }, onclick: (e) => ((others.hidden = !others.hidden), (e.currentTarget.textContent = others.hidden ? '¿Otro teléfono o navegador?' : 'Ocultar otros')) }, '¿Otro teléfono o navegador?'),
      others,
      h(
        'div',
        { class: 'export-row', style: { marginTop: '14px' } },
        h('button', { class: 'btn small', onclick: () => copyText(`Selah: ${location.origin}\n\n${installText()}`, 'Instrucciones copiadas') }, icon('copy'), 'Copiar'),
        h('button', { class: 'btn small primary', onclick: () => shareText(`Selah: ${location.origin}\n\n${installText()}`, 'Selah') }, icon('share'), 'Compartir'),
      ),
    ]
      .flat(3)
      .filter(Boolean);
  });
}
