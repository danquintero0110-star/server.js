// Estudio de imágenes: frases de la prédica listas para estados de WhatsApp, Instagram y Facebook,
// con el logo y el nombre del negocio de cada persona. Todo se dibuja en el teléfono (sin costo).
import { api } from './api.js';
import { h, icon, toast, vibrate } from './ui.js';
import { brandOptions } from './social.js';

const FORMATS = [
  { key: 'story', label: 'Estado / Historia', w: 1080, h: 1920 },
  { key: 'post', label: 'Post 4:5', w: 1080, h: 1350 },
  { key: 'square', label: 'Cuadrado', w: 1080, h: 1080 },
];

const STYLES = {
  noche: { label: 'Noche dorada', swatch: 'linear-gradient(135deg,#16120e,#3a2a17)', text: '#f6ead6', accent: '#f0a948', soft: 'rgba(246,234,214,.62)' },
  amanecer: { label: 'Amanecer', swatch: 'linear-gradient(160deg,#ffcf8a,#e2743a 55%,#7a2e3a)', text: '#ffffff', accent: '#fff1d6', soft: 'rgba(255,255,255,.78)' },
  papel: { label: 'Papel', swatch: 'linear-gradient(135deg,#f6efe3,#eadcc6)', text: '#2a211a', accent: '#b5711c', soft: 'rgba(42,33,26,.6)' },
  oceano: { label: 'Océano', swatch: 'linear-gradient(160deg,#0d2238,#1f5f7a)', text: '#f2f8fb', accent: '#8fd3e8', soft: 'rgba(242,248,251,.7)' },
  bosque: { label: 'Bosque', swatch: 'linear-gradient(160deg,#122019,#2f5240)', text: '#f1f5ec', accent: '#c9dd8f', soft: 'rgba(241,245,236,.7)' },
  minimal: { label: 'Minimal', swatch: '#ffffff', text: '#111111', accent: '#e2743a', soft: 'rgba(17,17,17,.55)' },
};

function background(ctx, W, H, key) {
  const g = (stops, x0 = 0, y0 = 0, x1 = W, y1 = H) => {
    const gr = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([o, c]) => gr.addColorStop(o, c));
    return gr;
  };
  const glow = (x, y, r, color) => {
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, color);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, W, H);
  };
  if (key === 'noche') {
    ctx.fillStyle = g([[0, '#1b150f'], [1, '#0e0b08']]);
    ctx.fillRect(0, 0, W, H);
    glow(W * 0.85, H * 0.12, W * 0.9, 'rgba(240,169,72,.28)');
    glow(W * 0.1, H * 0.95, W * 0.7, 'rgba(226,116,58,.16)');
    ctx.strokeStyle = 'rgba(240,169,72,.14)';
    ctx.lineWidth = 2;
    for (const r of [0.38, 0.52, 0.66]) {
      ctx.beginPath();
      ctx.arc(W * 0.85, H * 0.12, W * r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (key === 'amanecer') {
    ctx.fillStyle = g([[0, '#ffd59a'], [0.45, '#ec8a4a'], [1, '#6e2a3c']], 0, 0, W * 0.3, H);
    ctx.fillRect(0, 0, W, H);
    glow(W * 0.5, H * 0.18, W * 0.75, 'rgba(255,245,220,.55)');
  } else if (key === 'papel') {
    ctx.fillStyle = g([[0, '#f7f0e4'], [1, '#ebdec9']]);
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.05;
    for (let i = 0; i < 1600; i++) {
      ctx.fillStyle = i % 2 ? '#6b4b2a' : '#ffffff';
      ctx.fillRect((i * 9973) % W, (i * 7919) % H, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(181,113,28,.35)';
    ctx.lineWidth = 3;
    ctx.strokeRect(46, 46, W - 92, H - 92);
  } else if (key === 'oceano') {
    ctx.fillStyle = g([[0, '#0b1d30'], [1, '#1d5c75']], 0, 0, W * 0.4, H);
    ctx.fillRect(0, 0, W, H);
    glow(W * 0.2, H * 0.15, W * 0.8, 'rgba(143,211,232,.22)');
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    for (let i = 0; i < 70; i++) {
      const x = (i * 7919) % W;
      const y = ((i * 104729) % (H * 0.55)) | 0;
      ctx.globalAlpha = 0.15 + (i % 5) * 0.08;
      ctx.beginPath();
      ctx.arc(x, y, 1.5 + (i % 3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else if (key === 'bosque') {
    ctx.fillStyle = g([[0, '#0f1b15'], [1, '#2e5040']], 0, 0, 0, H);
    ctx.fillRect(0, 0, W, H);
    glow(W * 0.5, H * 0.08, W * 0.9, 'rgba(201,221,143,.2)');
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }
}

function wrap(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

/** Dibuja la tarjeta. */
export function drawCard(canvas, o) {
  const F = FORMATS.find((f) => f.key === o.format) || FORMATS[0];
  const W = (canvas.width = F.w);
  const H = (canvas.height = F.h);
  const S = STYLES[o.style] || STYLES.noche;
  const ctx = canvas.getContext('2d');
  background(ctx, W, H, o.style);
  const minimal = o.style === 'minimal';
  const serif = '"Fraunces", Georgia, serif';
  const sans = '"Manrope", system-ui, sans-serif';
  const pad = W * 0.11;
  const maxW = W - pad * 2;
  const isVerse = Boolean(o.reference);
  const text = String(o.text || '').trim();

  // Encabezado: marca (si hay) o la prédica.
  ctx.textAlign = 'center';
  ctx.fillStyle = S.accent;
  ctx.font = `800 ${W * 0.024}px ${sans}`;
  const eyebrow = (isVerse ? 'PALABRA PARA HOY' : o.eyebrow || 'DE LA PRÉDICA').split('').join(String.fromCharCode(8202));
  const topY = F.key === 'story' ? H * 0.16 : H * 0.12;
  ctx.fillText(eyebrow, W / 2, topY);
  ctx.fillRect(W / 2 - W * 0.04, topY + W * 0.025, W * 0.08, 4);

  // Frase + firma centradas entre el encabezado y el pie.
  const sig = isVerse ? o.reference : [o.author, o.title].filter(Boolean).join('  ·  ');
  const hasFoot = Boolean(o.logo || o.brandName || o.handle);
  const boxTop = topY + W * 0.08;
  const boxBottom = H - (hasFoot ? (F.key === 'story' ? H * 0.22 : H * 0.2) : H * 0.1);
  const showQuote = !minimal && !isVerse;
  const fam = minimal ? `800 SIZEpx ${sans}` : `italic 400 SIZEpx ${serif}`;
  ctx.font = `600 ${W * 0.026}px ${sans}`;
  const sigLines = sig ? wrap(ctx, isVerse ? sig : `— ${sig}`, maxW).slice(0, 2) : [];
  const sigH = sigLines.length ? W * 0.05 + sigLines.length * W * 0.036 : 0;
  let size = W * 0.105;
  let lines;
  let quoteH = 0;
  for (; size > W * 0.035; size -= 2) {
    ctx.font = fam.replace('SIZE', size);
    lines = wrap(ctx, text, maxW);
    quoteH = showQuote ? size * 1.15 : minimal ? size * 0.7 : 0;
    if (quoteH + lines.length * size * 1.28 + sigH <= boxBottom - boxTop) break;
  }
  const lh = size * 1.28;
  const total = quoteH + lines.length * lh + sigH;
  let y = boxTop + (boxBottom - boxTop - total) / 2;
  if (showQuote) {
    ctx.fillStyle = S.accent;
    ctx.globalAlpha = 0.9;
    ctx.font = `400 ${size * 2.2}px ${serif}`;
    ctx.fillText('“', W / 2, y + size * 1.55);
    ctx.globalAlpha = 1;
  }
  if (minimal) {
    ctx.fillStyle = S.accent;
    ctx.fillRect(pad, y + size * 0.1, W * 0.12, 10);
  }
  y += quoteH + size * 0.95;
  ctx.fillStyle = S.text;
  ctx.font = fam.replace('SIZE', size);
  if (minimal) ctx.textAlign = 'left';
  for (const l of lines) {
    ctx.fillText(l, minimal ? pad : W / 2, y);
    y += lh;
  }
  ctx.textAlign = 'center';
  if (sigLines.length) {
    ctx.fillStyle = isVerse ? S.accent : S.soft;
    ctx.font = `${isVerse ? 800 : 600} ${W * (isVerse ? 0.032 : 0.026)}px ${sans}`;
    sigLines.forEach((l, i) => ctx.fillText(l, W / 2, y - lh + size * 0.3 + W * 0.05 + i * W * 0.036));
  }

  // Pie: logo + nombre del negocio / redes.
  const footY = H - (F.key === 'story' ? H * 0.1 : H * 0.075);
  const brandLine = [o.brandName, o.handle].filter(Boolean).join('  ·  ');
  if (o.logo) {
    const lh2 = F.key === 'story' ? H * 0.06 : H * 0.075;
    const ratio = o.logo.width / o.logo.height || 1;
    const lw = Math.min(W * 0.42, lh2 * ratio);
    const lhh = lw / ratio;
    const ly = footY - lhh - (brandLine ? W * 0.035 : 0);
    ctx.drawImage(o.logo, W / 2 - lw / 2, ly, lw, lhh);
  }
  if (brandLine) {
    ctx.fillStyle = S.soft;
    ctx.font = `700 ${W * 0.026}px ${sans}`;
    ctx.fillText(brandLine, W / 2, footY + (o.logo ? W * 0.012 : 0));
  }
  return canvas;
}

async function loadLogo(brand) {
  if (!brand?.logo) return null;
  try {
    const r = await fetch(`/api/me/logo?v=${encodeURIComponent(brand.logo)}`, { credentials: 'same-origin' });
    if (!r.ok) return null;
    return await createImageBitmap(await r.blob());
  } catch {
    return null;
  }
}

/** Reduce el logo a máx. 700 px (PNG con transparencia) antes de subirlo. */
async function shrinkLogo(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 700 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

/**
 * Abre el estudio. phrases: [{ text, kind: 'frase'|'versiculo'|'enfoque', reference?, label? }]
 */
export async function openStudio({ note, phrases, start = 0, me }) {
  let brand = {};
  try {
    brand = (await api.get('/api/me')).brand || {};
  } catch {}
  const fontsReady = Promise.all([
    document.fonts?.load('italic 400 80px Fraunces'),
    document.fonts?.load('400 80px Fraunces'),
    document.fonts?.load('800 40px Manrope'),
    document.fonts?.load('600 40px Manrope'),
  ]).catch(() => {});
  let logo = await loadLogo(brand);
  // Marcas: la mía y la de mis iglesias.
  const brands = await brandOptions().catch(() => []);
  let brandKey = localStorage.getItem('selah-studio-brand') || 'me';
  if (!brands.some((b) => b.key === brandKey)) brandKey = 'me';
  const groupLogos = new Map();
  async function groupLogo(b) {
    if (!b?.logoUrl) return null;
    if (!groupLogos.has(b.key)) groupLogos.set(b.key, fetch(b.logoUrl, { credentials: 'same-origin' }).then((r) => (r.ok ? r.blob().then((x) => createImageBitmap(x)) : null)).catch(() => null));
    return groupLogos.get(b.key);
  }
  let activeLogo = brandKey === 'me' ? logo : await groupLogo(brands.find((b) => b.key === brandKey));
  const st = {
    i: Math.min(start, phrases.length - 1),
    format: localStorage.getItem('selah-studio-format') || 'story',
    style: localStorage.getItem('selah-studio-style') || 'noche',
    showLogo: brand.showLogo !== false,
    showAuthor: true,
    text: phrases[start]?.text || '',
  };
  const canvas = h('canvas', { class: 'st-canvas' });
  const draw = () =>
    drawCard(canvas, {
      format: st.format,
      style: st.style,
      text: st.text,
      reference: phrases[st.i]?.reference || '',
      eyebrow: phrases[st.i]?.label,
      author: st.showAuthor ? note.preacher : '',
      title: st.showAuthor ? note.title : '',
      logo: st.showLogo ? (brandKey === 'me' ? logo : activeLogo) : null,
      brandName: st.showLogo ? (brandKey === 'me' ? brand.name : brands.find((b) => b.key === brandKey)?.name) : '',
      handle: st.showLogo ? (brandKey === 'me' ? brand.handle : brands.find((b) => b.key === brandKey)?.handle) : '',
    });

  const textArea = h('textarea', { class: 'input st-text', rows: 3 });
  textArea.value = st.text;
  textArea.addEventListener('input', () => {
    st.text = textArea.value;
    draw();
  });
  const phraseChips = h(
    'div',
    { class: 'st-phrases' },
    phrases.map((p, i) =>
      h(
        'button',
        {
          class: `st-phrase${i === st.i ? ' on' : ''}`,
          onclick: (e) => {
            st.i = i;
            st.text = p.text;
            textArea.value = p.text;
            phraseChips.querySelectorAll('.st-phrase').forEach((b, j) => b.classList.toggle('on', j === i));
            e.currentTarget.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
            vibrate(5);
            draw();
          },
        },
        h('small', {}, p.kind === 'versiculo' ? p.reference : p.label || 'Frase'),
        h('span', {}, p.text),
      ),
    ),
  );
  const seg = (items, cur, onPick, cls) =>
    h(
      'div',
      { class: `st-seg ${cls || ''}` },
      items.map(([k, label, extra]) =>
        h(
          'button',
          {
            class: k === cur() ? 'on' : '',
            style: extra ? { background: extra } : null,
            'aria-label': label,
            title: label,
            onclick: (e) => {
              onPick(k);
              e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
              vibrate(5);
              draw();
            },
          },
          extra ? '' : label,
        ),
      ),
    );
  const formats = seg(FORMATS.map((f) => [f.key, f.label]), () => st.format, (k) => (st.format = k, localStorage.setItem('selah-studio-format', k)));
  const brandSeg =
    brands.length > 1
      ? seg(
          brands.map((b) => [b.key, b.label]),
          () => brandKey,
          (k) => {
            brandKey = k;
            localStorage.setItem('selah-studio-brand', k);
            groupLogo(brands.find((b) => b.key === k)).then((l) => {
              activeLogo = k === 'me' ? logo : l;
              draw();
            });
          },
        )
      : null;
  const styles = seg(Object.entries(STYLES).map(([k, s]) => [k, s.label, s.swatch]), () => st.style, (k) => (st.style = k, localStorage.setItem('selah-studio-style', k)), 'swatches');

  // Mi marca
  const nameIn = h('input', { class: 'input', placeholder: 'Nombre de tu negocio o ministerio', value: brand.name || '', maxlength: 60 });
  const handleIn = h('input', { class: 'input', placeholder: '@tu_cuenta o sitio web', value: brand.handle || '', maxlength: 40 });
  const saveBrand = async () => {
    brand = { ...brand, ...(await api.put('/api/me/brand', { name: nameIn.value, handle: handleIn.value }).catch(() => ({}))) };
  };
  nameIn.addEventListener('input', () => ((brand.name = nameIn.value), draw()));
  handleIn.addEventListener('input', () => ((brand.handle = handleIn.value), draw()));
  nameIn.addEventListener('change', saveBrand);
  handleIn.addEventListener('change', saveBrand);
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' } });
  const logoBtn = h('button', { class: 'btn small' }, icon('upload'), brand.logo ? 'Cambiar logo' : 'Subir logo');
  const logoDel = h('button', { class: 'btn small', style: { display: brand.logo ? '' : 'none' } }, icon('trash'), 'Quitar');
  logoBtn.onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    try {
      const blob = await shrinkLogo(f);
      const r = await fetch('/api/me/logo', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Image-Mime': 'image/png' }, body: blob });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo subir');
      brand = d;
      logo = await createImageBitmap(blob);
      st.showLogo = true;
      logoToggle.checked = true;
      logoBtn.lastChild.textContent = 'Cambiar logo';
      logoDel.style.display = '';
      toast('Logo guardado');
      draw();
    } catch (e) {
      toast(e.message || 'No se pudo subir el logo', { error: true });
    }
    fileIn.value = '';
  };
  logoDel.onclick = async () => {
    await api.del('/api/me/logo').catch(() => {});
    brand.logo = null;
    logo = null;
    logoDel.style.display = 'none';
    logoBtn.lastChild.textContent = 'Subir logo';
    draw();
  };
  const toggle = (label, get, set) => {
    const cb = h('input', { type: 'checkbox', checked: get() });
    cb.addEventListener('change', () => {
      set(cb.checked);
      draw();
    });
    return [cb, h('label', { class: 'st-toggle' }, cb, h('span', {}, label))];
  };
  const [logoToggle, logoRow] = toggle('Mostrar mi marca', () => st.showLogo, (v) => (st.showLogo = v));
  const [, authorRow] = toggle('Mostrar predicador y prédica', () => st.showAuthor, (v) => (st.showAuthor = v));

  const fileName = () => `selah-${(note.title || 'frase').normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40)}-${st.format}.png`;
  const toBlob = () => new Promise((r) => canvas.toBlob(r, 'image/png'));
  async function share() {
    const blob = await toBlob();
    const file = new File([blob], fileName(), { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: st.text });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    save(blob);
  }
  async function save(blob) {
    blob ||= await toBlob();
    const a = h('a', { href: URL.createObjectURL(blob), download: fileName() });
    document.body.append(a);
    a.click();
    a.remove();
    toast('Imagen guardada');
  }

  const el = h(
    'div',
    { class: 'studio', role: 'dialog', 'aria-modal': 'true' },
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Cerrar', onclick: () => close() }, icon('x')),
      h('span', { class: 'eyebrow' }, 'Crear imagen'),
      h('span', { style: { width: '44px' } }),
    ),
    h('div', { class: 'st-preview' }, canvas),
    h(
      'div',
      { class: 'st-panel' },
      phraseChips,
      textArea,
      formats,
      styles,
      brandSeg,
      h(
        'details',
        { class: 'st-brand card', open: !brand.logo && !brand.name ? true : null },
        h('summary', {}, icon('pin'), 'Mi marca (logo de tu negocio o ministerio)'),
        h('div', { class: 'st-brand-body' }, h('div', { class: 'st-row' }, logoBtn, logoDel, fileIn), nameIn, handleIn, logoRow, authorRow),
      ),
    ),
    h(
      'footer',
      { class: 'st-actions' },
      h('button', { class: 'btn', onclick: () => save() }, icon('pdf'), 'Guardar'),
      h('button', { class: 'btn primary', onclick: share }, icon('share'), 'Compartir'),
    ),
  );
  function close() {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
    window.removeEventListener('popstate', close);
  }
  window.addEventListener('popstate', close);
  document.body.append(el);
  draw();
  fontsReady.then(draw);
}

/** Frases disponibles de una nota para el estudio. */
export function phrasesFrom(note, { memoryText = '' } = {}) {
  const a = note.analysis || {};
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const k = p.text.trim().toLowerCase();
    if (!p.text.trim() || seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  for (const f of Object.values(a.focus || {})) if (f.phrase) add({ text: f.phrase, kind: 'enfoque', label: f.area });
  (a.strong_quotes || []).forEach((q) => add({ text: q.text, kind: 'frase', label: 'Frase de la prédica' }));
  (a.social_quotes || []).forEach((q) => add({ text: q, kind: 'frase', label: 'Para redes' }));
  if (memoryText && a.study?.memory_verse) add({ text: memoryText, kind: 'versiculo', reference: `${a.study.memory_verse.reference} (RV1909)` });
  if (a.central_idea) add({ text: a.central_idea, kind: 'frase', label: 'Idea central' });
  return out;
}
