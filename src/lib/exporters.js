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

const C = { ink: '#1d1a17', soft: '#6b625a', accent: '#b5711c', rule: '#e7ddd0' };

/** PDF del resumen. passages: Map referencia → texto RV1909. */
export function summaryPdf(note, a, passages = new Map()) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 64, left: 64, right: 64 }, info: { Title: note.title } });
  const W = doc.page.width - 128;

  const heading = (t) => {
    doc.moveDown(1.1).fillColor(C.accent).font('Helvetica-Bold').fontSize(9).text(t.toUpperCase(), { characterSpacing: 1.6 });
    doc.moveDown(0.35).strokeColor(C.rule).lineWidth(0.7).moveTo(doc.x, doc.y).lineTo(doc.x + W, doc.y).stroke().moveDown(0.5);
    doc.fillColor(C.ink).font('Helvetica').fontSize(11);
  };

  doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(9).text('SELAH · NOTAS DE PRÉDICA', { characterSpacing: 2 });
  doc.moveDown(0.6).fillColor(C.ink).font('Times-Bold').fontSize(26).text(note.title, { lineGap: 2 });
  const meta = [note.preacher, humanDate(note.preached_at)].filter(Boolean).join('  ·  ');
  if (meta) doc.moveDown(0.3).fillColor(C.soft).font('Helvetica').fontSize(10.5).text(meta);

  heading('Idea central');
  doc.font('Times-Italic').fontSize(14).fillColor(C.ink).text(a.central_idea, { lineGap: 3 });

  heading('Puntos principales');
  a.main_points.forEach((p, i) => {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink).text(`${i + 1}. ${p.title}`);
    doc.font('Helvetica').fontSize(10.5).fillColor(C.soft).text(p.detail, { lineGap: 2 }).moveDown(0.5);
  });

  if (a.strong_quotes?.length) {
    heading('Frases fuertes');
    a.strong_quotes.forEach((q) => doc.font('Times-Italic').fontSize(12).fillColor(C.ink).text(`“${q.text}”`, { lineGap: 2 }).moveDown(0.4));
  }
  if (a.practical_application?.length) {
    heading('Aplicación práctica');
    a.practical_application.forEach((x) => doc.text(`•  ${x}`, { lineGap: 2 }).moveDown(0.25));
  }
  if (a.verses?.length) {
    heading(`Versículos (${BIBLE_VERSION.name})`);
    a.verses.forEach((v) => {
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.ink).text(v.reference);
      const t = passages.get(v.reference);
      if (t) doc.font('Times-Roman').fontSize(10.5).fillColor(C.soft).text(t, { lineGap: 1.5 });
      doc.moveDown(0.4);
    });
  }
  if (a.weekly_task?.title) {
    heading('Tarea de la semana');
    doc.font('Helvetica-Bold').text(a.weekly_task.title).font('Helvetica').fillColor(C.soft).text(a.weekly_task.description);
  }
  if (a.cell_questions?.length) {
    heading('Preguntas para célula');
    a.cell_questions.forEach((q, i) => doc.fillColor(C.ink).text(`${i + 1}. ${q}`, { lineGap: 2 }).moveDown(0.25));
  }
  doc.moveDown(2).fillColor(C.soft).fontSize(8).text(`Texto bíblico: ${BIBLE_VERSION.name} (${BIBLE_VERSION.license}).`, { align: 'center' });
  doc.end();
  return doc;
}
