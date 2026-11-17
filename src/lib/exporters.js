import PDFDocument from 'pdfkit';
import { BIBLE_VERSION } from './bible.js';

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function humanDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
}

export function humanTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return '';
  const h = +m[1];
  const suffix = h < 12 ? 'a. m.' : 'p. m.';
  return `${h % 12 || 12}:${m[2]} ${suffix}`;
}

export function announcementLine(a) {
  const when = [humanDate(a.date) || a.when_text, humanTime(a.time)].filter(Boolean).join(' · ');
  const lines = [`📌 *${a.title}*`];
  if (when) lines.push(`🗓️ ${when}`);
  if (a.place) lines.push(`📍 ${a.place}`);
  if (a.description) lines.push(a.description);
  return lines.join('\n');
}

export function announcementsWhatsapp(note, list) {
  if (!list?.length) return '';
  return [`*Anuncios — ${note.title}*`, '', list.map(announcementLine).join('\n\n')].join('\n');
}

export function summaryWhatsapp(note, a) {
  const out = [`*${note.title}*`];
  const meta = [note.preacher, humanDate(note.preached_at)].filter(Boolean).join(' · ');
  if (meta) out.push(`_${meta}_`);
  out.push('', `💡 *Idea central*`, a.central_idea, '', `📖 *Puntos principales*`);
  a.main_points.forEach((p, i) => out.push(`${i + 1}. *${p.title}*: ${p.detail}`));
  if (a.strong_quotes?.length) {
    out.push('', `🔥 *Frases*`);
    a.strong_quotes.forEach((q) => out.push(`“${q.text}”`));
  }
  if (a.practical_application?.length) {
    out.push('', `✅ *Para aplicar*`);
    a.practical_application.forEach((x) => out.push(`• ${x}`));
  }
  if (a.verses?.length) out.push('', `📜 *Versículos*`, a.verses.map((v) => v.reference).join(' · '));
  if (a.weekly_task?.title) out.push('', `🎯 *Tarea de la semana*`, `${a.weekly_task.title}: ${a.weekly_task.description}`);
  out.push('', '— Notas con Selah');
  return out.join('\n');
}

const C = {
  ink: '#1d1a17',
  text: '#2b2621',
  soft: '#6b625a',
  faint: '#a39a90',
  accent: '#b5711c',
  accent2: '#d9a35a',
  wash: '#f7efe2',
  rule: '#e7ddd0',
  night: '#16120e',
  cream: '#f4e9d6',
};

// Las fuentes estándar del PDF solo cubren Latin-1 (+ comillas tipográficas): se limpia el resto.
const KEEP = new Set([...'“”‘’–—…•€']);
export function clean(s) {
  return String(s ?? '')
    .replace(/[→⇒]/g, '->')
    .replace(/[✓✔]/g, '')
    .replace(/[  ]/g, ' ')
    .split('')
    .filter((ch) => ch.charCodeAt(0) <= 0xff || KEEP.has(ch))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function mmssLabel(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/**
 * PDF de estudio de la prédica.
 * textFor(v) → texto RV1909 del pasaje { code, chapter, verse_start, verse_end } o ''.
 */
export function summaryPdf(note, a, textFor = () => '') {
  const M = { top: 84, bottom: 72, left: 64, right: 64 };
  const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: { Title: clean(note.title), Author: clean(note.preacher || 'Selah'), Creator: 'Selah' } });
  const PW = doc.page.width;
  const PH = doc.page.height;
  const W = PW - M.left - M.right;
  const L = M.left;
  const study = a.study || null;
  const bottom = () => PH - M.bottom;
  const ensure = (h) => {
    if (doc.y + h > bottom()) doc.addPage();
  };
  const passage = (v) => {
    let t = clean(textFor(v));
    if (t.length > 1100) t = `${t.slice(0, 1100).replace(/\s+\S*$/, '')} […]`;
    return t;
  };

  // ---------- Portada ----------
  doc.rect(0, 0, PW, PH).fill(C.night);
  doc.rect(0, 0, PW, 6).fill(C.accent);
  doc.circle(PW - 40, 120, 210).fillOpacity(0.05).fill(C.accent2).fillOpacity(1);
  doc.circle(PW - 40, 120, 130).fillOpacity(0.05).fill(C.accent2).fillOpacity(1);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.accent2).text('SELAH  ·  ESTUDIO DE LA PRÉDICA', L, 92, { characterSpacing: 2.4, width: W });
  doc.font('Times-Bold').fontSize(38).fillColor(C.cream).text(clean(note.title), L, 150, { width: W - 30, lineGap: 2 });
  const meta = [clean(note.preacher), humanDate(note.preached_at)].filter(Boolean).join('   ·   ');
  if (meta) doc.moveDown(0.6).font('Helvetica').fontSize(11.5).fillColor(C.accent2).text(meta, { width: W });
  doc.moveDown(1.6);
  doc.rect(L, doc.y, 46, 2).fill(C.accent);
  doc.moveDown(1.2);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.faint).text('IDEA CENTRAL', L, doc.y, { characterSpacing: 2, width: W });
  doc.moveDown(0.5).font('Times-Italic').fontSize(16).fillColor(C.cream).text(clean(a.central_idea), { width: W - 20, lineGap: 4 });

  const mv = study?.memory_verse;
  const mvText = mv ? passage(mv) : '';
  if (mvText) {
    doc.font('Times-Italic').fontSize(13);
    const th = doc.heightOfString(`“${mvText}”`, { width: W - 48, lineGap: 3 });
    const bh = th + 64;
    const by = PH - 110 - bh;
    doc.roundedRect(L, by, W, bh, 14).fillOpacity(0.07).fill(C.cream).fillOpacity(1);
    doc.rect(L, by + 18, 3, bh - 36).fill(C.accent);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.accent2).text('VERSÍCULO PARA MEMORIZAR', L + 24, by + 18, { characterSpacing: 2, width: W - 48 });
    doc.font('Times-Italic').fontSize(13).fillColor(C.cream).text(`“${mvText}”`, L + 24, by + 36, { width: W - 48, lineGap: 3 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.accent2).text(clean(mv.reference), L + 24, doc.y + 6, { width: W - 48 });
  }
  doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(8).fillColor(C.faint).text(`Texto bíblico: ${BIBLE_VERSION.name}`, L, PH - 70, { width: W, align: 'left', lineBreak: false });
  doc.page.margins.bottom = M.bottom;

  // ---------- Bloques reutilizables ----------
  const section = (eyebrow, title) => {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.accent).text(eyebrow.toUpperCase(), L, doc.y, { characterSpacing: 2.2, width: W });
    doc.moveDown(0.35).font('Times-Bold').fontSize(24).fillColor(C.ink).text(title, { width: W });
    doc.moveDown(0.4);
    doc.rect(L, doc.y, 40, 2).fill(C.accent);
    doc.moveDown(1.2);
  };
  const subTitle = (eyebrow, title) => {
    ensure(90);
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.accent).text(eyebrow.toUpperCase(), L, doc.y, { characterSpacing: 2.2, width: W });
    if (title) doc.moveDown(0.3).font('Times-Bold').fontSize(18).fillColor(C.ink).text(title, { width: W });
    doc.moveDown(0.6);
  };
  const paragraphs = (text, { size = 11.5, color = C.text, font = 'Times-Roman', indent = 0 } = {}) => {
    for (const para of String(text || '').split(/\n\s*\n|\n/).map(clean).filter(Boolean)) {
      doc.font(font).fontSize(size);
      ensure(Math.min(60, doc.heightOfString(para, { width: W - indent }) + 6));
      doc.fillColor(color).text(para, L + indent, doc.y, { width: W - indent, align: 'justify', lineGap: 3.5 });
      doc.moveDown(0.6);
    }
  };
  const verseBoxHeight = (v, why = '') => {
    const text = passage(v);
    if (!text) return 0;
    const iw = W - 40;
    doc.font('Helvetica-Bold').fontSize(10);
    const h1 = doc.heightOfString(clean(v.reference), { width: iw });
    doc.font('Times-Italic').fontSize(11.5);
    const h2 = doc.heightOfString(text, { width: iw, lineGap: 2.5 });
    doc.font('Helvetica').fontSize(9.5);
    const h3 = why ? doc.heightOfString(clean(why), { width: iw, lineGap: 1.5 }) + 8 : 0;
    return 16 + h1 + 6 + h2 + h3 + 16;
  };
  const verseBox = (v, { tag = '', why = '' } = {}) => {
    const text = passage(v);
    if (!text) return;
    const iw = W - 40;
    doc.font('Helvetica-Bold').fontSize(10);
    const h1 = doc.heightOfString(clean(v.reference), { width: iw });
    doc.font('Times-Italic').fontSize(11.5);
    const h2 = doc.heightOfString(text, { width: iw, lineGap: 2.5 });
    doc.font('Helvetica').fontSize(9.5);
    const h3 = why ? doc.heightOfString(clean(why), { width: iw, lineGap: 1.5 }) + 8 : 0;
    const bh = 16 + h1 + 6 + h2 + h3 + 16;
    ensure(bh + 10);
    const y = doc.y;
    doc.roundedRect(L, y, W, bh, 10).fill(C.wash);
    doc.rect(L, y + 12, 3, bh - 24).fill(C.accent);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text(clean(v.reference), L + 22, y + 16, { width: iw, continued: Boolean(tag) });
    if (tag) doc.font('Helvetica').fontSize(8).fillColor(C.accent).text(`   ${tag.toUpperCase()}`, { characterSpacing: 1.2 });
    doc.font('Times-Italic').fontSize(11.5).fillColor(C.text).text(text, L + 22, y + 16 + h1 + 6, { width: iw, lineGap: 2.5 });
    if (why) doc.font('Helvetica').fontSize(9.5).fillColor(C.soft).text(clean(why), L + 22, doc.y + 8, { width: iw, lineGap: 1.5 });
    doc.x = L;
    doc.y = y + bh + 12;
  };
  const writeLines = (n) => {
    for (let i = 0; i < n; i++) {
      ensure(24);
      doc.y += 20;
      doc.moveTo(L + 18, doc.y).lineTo(L + W, doc.y).lineWidth(0.6).strokeColor(C.rule).stroke();
    }
    doc.y += 10;
  };

  // ---------- Desarrollo ----------
  section('El mensaje', 'Desarrollo de la prédica');
  if (study?.introduction) paragraphs(study.introduction, { size: 12.5, font: 'Times-Italic', color: C.soft });

  const points = study?.points?.length ? study.points : a.main_points.map((p) => ({ ...p, development: p.detail, verses: [] }));
  const citedByTime = (a.verses || []).filter((v) => v.found !== false);
  points.forEach((p, i) => {
    ensure(140);
    doc.moveDown(0.8);
    const y = doc.y;
    doc.circle(L + 15, y + 15, 15).fill(C.accent);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(String(i + 1), L, y + 8, { width: 30, align: 'center' });
    doc.font('Times-Bold').fontSize(17).fillColor(C.ink).text(clean(p.title), L + 44, y + 2, { width: W - 44, lineGap: 1 });
    if (p.timestamp_sec || p.timestamp_sec === 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.faint).text(`MINUTO ${mmssLabel(p.timestamp_sec)} DE LA GRABACIÓN`, L + 44, doc.y + 2, { characterSpacing: 1.2, width: W - 44 });
    }
    doc.x = L;
    doc.y = Math.max(doc.y, y + 32) + 12;
    paragraphs(p.development);
    let verses = p.verses || [];
    if (!study) {
      // Sin estudio: los versículos citados cerca de este punto.
      const next = points[i + 1]?.timestamp_sec ?? Infinity;
      verses = citedByTime.filter((v) => v.timestamp_sec >= (p.timestamp_sec || 0) && v.timestamp_sec < next).map((v) => ({ ...v, role: 'citado' }));
    }
    verses = verses.filter((v) => passage(v));
    if (verses.length) {
      ensure(30 + Math.min(260, verseBoxHeight(verses[0], verses[0].why || verses[0].context)));
      doc.moveDown(0.3).font('Helvetica-Bold').fontSize(8).fillColor(C.soft).text('SUSTENTO BÍBLICO', L, doc.y, { characterSpacing: 2 });
      doc.moveDown(0.5);
      verses.forEach((v) => verseBox(v, { tag: v.role === 'complementario' ? 'Para profundizar' : 'Citado en la prédica', why: v.why || v.context }));
    }
    if (p.reflection_question) {
      ensure(50);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.accent).text('Para reflexionar:  ', L, doc.y + 2, { continued: true, width: W });
      doc.font('Times-Italic').fontSize(12).fillColor(C.ink).text(clean(p.reflection_question), { lineGap: 2 });
      doc.moveDown(0.8);
    }
    if (i < points.length - 1) {
      ensure(30);
      doc.moveDown(0.6);
      const cx = L + W / 2;
      [-14, 0, 14].forEach((dx) => doc.circle(cx + dx, doc.y, 1.6).fill(C.accent2));
      doc.moveDown(1);
    }
  });

  // ---------- Frases ----------
  if (a.strong_quotes?.length) {
    subTitle('Frases para recordar');
    a.strong_quotes.forEach((q) => {
      const t = clean(q.text);
      doc.font('Times-Italic').fontSize(14);
      const h = doc.heightOfString(t, { width: W - 40, lineGap: 3 });
      ensure(h + 26);
      const y = doc.y;
      doc.font('Times-Bold').fontSize(40).fillColor(C.accent2).text('“', L, y - 8, { lineBreak: false });
      doc.font('Times-Italic').fontSize(14).fillColor(C.ink).text(t, L + 34, y, { width: W - 40, lineGap: 3 });
      doc.x = L;
      doc.moveDown(0.9);
    });
  }

  // ---------- Aplicación + tarea ----------
  if (a.practical_application?.length || a.weekly_task?.title) {
    section('Para vivirlo', 'Aplicación práctica');
    (a.practical_application || []).forEach((x) => {
      const t = clean(x);
      doc.font('Times-Roman').fontSize(12);
      const h = doc.heightOfString(t, { width: W - 30, lineGap: 3 });
      ensure(h + 14);
      const y = doc.y;
      doc.roundedRect(L, y + 2, 12, 12, 2.5).lineWidth(1.2).strokeColor(C.accent).stroke();
      doc.fillColor(C.text).text(t, L + 26, y, { width: W - 30, lineGap: 3 });
      doc.x = L;
      doc.moveDown(0.7);
    });
    if (a.weekly_task?.title) {
      const t1 = clean(a.weekly_task.title);
      const t2 = clean(a.weekly_task.description);
      doc.font('Times-Roman').fontSize(11.5);
      const h = doc.heightOfString(t2, { width: W - 44, lineGap: 3 }) + 62;
      doc.moveDown(0.8);
      ensure(h + 10);
      const y = doc.y;
      doc.roundedRect(L, y, W, h, 12).lineWidth(1.2).strokeColor(C.accent).stroke();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.accent).text('TAREA DE LA SEMANA', L + 22, y + 18, { characterSpacing: 2, width: W - 44 });
      doc.font('Times-Bold').fontSize(15).fillColor(C.ink).text(t1, L + 22, doc.y + 4, { width: W - 44 });
      doc.font('Times-Roman').fontSize(11.5).fillColor(C.text).text(t2, L + 22, doc.y + 3, { width: W - 44, lineGap: 3 });
      doc.x = L;
      doc.y = y + h + 14;
    }
  }

  // ---------- Célula ----------
  if (a.cell_questions?.length) {
    section('Para el grupo', 'Preguntas para célula');
    a.cell_questions.forEach((q, i) => {
      const t = clean(q);
      doc.font('Times-Roman').fontSize(12.5);
      ensure(doc.heightOfString(t, { width: W - 26 }) + 70);
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(C.accent).text(`${i + 1}`, L, y + 1, { width: 18 });
      doc.font('Times-Roman').fontSize(12.5).fillColor(C.ink).text(t, L + 26, y, { width: W - 26, lineGap: 3 });
      doc.x = L;
      writeLines(2);
    });
  }

  // ---------- Devocional ----------
  if (a.devotional?.length) {
    section('Durante la semana', 'Devocional de 5 días');
    a.devotional.forEach((d, i) => {
      if (i > 0) doc.moveDown(0.6);
      ensure(160);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.accent).text(`DÍA ${d.day || i + 1}`, L, doc.y, { characterSpacing: 2, width: W });
      doc.moveDown(0.2).font('Times-Bold').fontSize(16).fillColor(C.ink).text(clean(d.title), { width: W });
      doc.moveDown(0.5);
      if (d.code) verseBox(d);
      paragraphs(d.reflection, { size: 11.5 });
      if (d.action) {
        ensure(30);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.accent).text('Acción:  ', L, doc.y, { continued: true, width: W });
        doc.font('Times-Roman').fontSize(11.5).fillColor(C.text).text(clean(d.action), { lineGap: 2.5 });
        doc.moveDown(0.4);
      }
      if (d.prayer) {
        ensure(30);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.accent).text('Oración:  ', L, doc.y, { continued: true, width: W });
        doc.font('Times-Italic').fontSize(11.5).fillColor(C.text).text(clean(d.prayer), { lineGap: 2.5 });
      }
      doc.moveDown(0.6);
      if (i < a.devotional.length - 1) {
        ensure(20);
        doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.6).strokeColor(C.rule).stroke();
        doc.moveDown(0.6);
      }
    });
  }

  // ---------- Anuncios ----------
  if (a.announcements?.length) {
    subTitle('Anuncios de la iglesia');
    a.announcements.forEach((an) => {
      const when = [humanDate(an.date) || an.when_text, humanTime(an.time), an.place].map(clean).filter(Boolean).join('  ·  ');
      ensure(50);
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(C.ink).text(clean(an.title), L, doc.y, { width: W });
      if (when) doc.font('Helvetica').fontSize(9.5).fillColor(C.accent).text(when, { width: W });
      if (an.description) doc.font('Times-Roman').fontSize(11).fillColor(C.soft).text(clean(an.description), { width: W, lineGap: 2 });
      doc.moveDown(0.7);
    });
  }

  // ---------- Cierre ----------
  if (study?.conclusion || study?.prayer) {
    subTitle('Para cerrar', 'Conclusión');
    if (study.conclusion) paragraphs(study.conclusion);
    if (study.prayer) {
      const t = clean(study.prayer);
      doc.font('Times-Italic').fontSize(12.5);
      const h = doc.heightOfString(t, { width: W - 48, lineGap: 3.5 }) + 56;
      doc.moveDown(0.6);
      ensure(h + 10);
      const y = doc.y;
      doc.roundedRect(L, y, W, h, 12).fill(C.night);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.accent2).text('ORACIÓN', L + 24, y + 18, { characterSpacing: 2, width: W - 48 });
      doc.font('Times-Italic').fontSize(12.5).fillColor(C.cream).text(t, L + 24, y + 36, { width: W - 48, lineGap: 3.5 });
      doc.x = L;
      doc.y = y + h + 12;
    }
  }

  // ---------- Encabezado y pie en cada página (menos la portada) ----------
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 1; i < total; i++) {
    doc.switchToPage(range.start + i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.accent).text('SELAH', L, 40, { characterSpacing: 2.4, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(C.faint).text(clean(note.title).slice(0, 80), L + 60, 40, { width: W - 60, align: 'right', lineBreak: false });
    doc.moveTo(L, 56).lineTo(L + W, 56).lineWidth(0.5).strokeColor(C.rule).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(C.faint).text(`${i + 1} / ${total}`, L, PH - 44, { width: W, align: 'center', lineBreak: false });
    if (i === total - 1) {
      doc.fontSize(7).text(`Texto bíblico: ${BIBLE_VERSION.name} (${BIBLE_VERSION.license}). Estudio preparado con Selah a partir de la prédica.`, L, PH - 32, { width: W, align: 'center', lineBreak: false });
    }
    doc.page.margins.bottom = keep;
  }
  doc.end();
  return doc;
}
