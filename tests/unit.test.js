import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { bookCode, getPassage, parseRef } from '../src/lib/bible.js';
import { hashPassword, verifyPassword } from '../src/lib/auth.js';
import { groupWords } from '../src/providers/transcribe.js';
import { youtubeId } from '../src/lib/media.js';
import { announcementLine, clean, humanDate, humanTime } from '../src/lib/exporters.js';
import { ANALYSIS_SCHEMA, mmss, usageCost } from '../src/providers/ai.js';
import { resolveVerses } from '../src/lib/pipeline.js';

const db = openDb(':memory:', { bibleFile: config.bibleFile });

test('la Biblia RV1909 se carga completa', () => {
  assert.equal(db.prepare('SELECT count(*) AS n FROM bible').get().n, 31084); // 18 versículos vacíos por versificación
  const p = getPassage(db, parseRef('Juan 3:16'));
  assert.equal(p.reference, 'Juan 3:16');
  assert.match(p.verses[0].text, /de tal manera amó Dios al mundo/);
});

test('referencias en formatos informales', () => {
  assert.deepEqual(parseRef('1 Co 13:4-7'), { code: '1CO', chapter: 13, verseStart: 4, verseEnd: 7 });
  assert.equal(parseRef('Primera de Juan 1:9')?.code, '1JO');
  assert.equal(bookCode('segunda a los Corintios'), '2CO');
  assert.equal(bookCode('Evangelio de Lucas'), 'LUK');
  assert.equal(bookCode('Primera Juan'), '1JO');
  assert.equal(bookCode('San Juan'), 'JOH');
  assert.equal(bookCode('salmo'), 'PSA');
  assert.equal(bookCode('Éxodo'), 'EXO');
  assert.equal(parseRef('Salmos 23').verseStart, 0);
  assert.equal(getPassage(db, parseRef('Salmos 23')).verses.length, 6);
  assert.equal(parseRef('Libro inventado 3:1'), null);
});

test('resolveVerses quita duplicados y marca pasajes inexistentes', () => {
  const out = resolveVerses(db, [
    { book: 'Mateo', chapter: 14, verse_start: 29, verse_end: 31 },
    { book: 'Mateo', chapter: 14, verse_start: 29, verse_end: 31 },
    { book: 'Juan', chapter: 99, verse_start: 1, verse_end: 1 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].reference, 'Mateo 14:29-31');
  assert.equal(out[1].found, false);
});

test('contraseñas con scrypt', () => {
  const h = hashPassword('secreto-123');
  assert.ok(verifyPassword('secreto-123', h));
  assert.ok(!verifyPassword('otra', h));
});

test('agrupación de palabras en frases con tiempo', () => {
  const words = 'Dios es fiel. Siempre cumple sus promesas aunque tarden mucho tiempo en llegar a nuestra vida.'
    .split(' ')
    .map((t, i) => ({ text: t, start: i, end: i + 0.8 }));
  words.push({ text: 'Amén.', start: 40, end: 41 });
  const s = groupWords(words);
  assert.ok(s.length >= 2);
  assert.equal(s.at(-1).text, 'Amén.');
  assert.equal(s[0].start, 0);
});

test('enlaces de YouTube', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtube.com/live/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://vimeo.com/123'), null);
});

test('formato de anuncios para WhatsApp', () => {
  assert.equal(humanDate('2026-11-21'), 'sábado 21 de noviembre');
  assert.equal(humanTime('18:00'), '6:00 p. m.');
  const line = announcementLine({ title: 'Retiro', date: '2026-11-21', time: '18:00', place: 'Salón', description: '' });
  assert.match(line, /\*Retiro\*/);
  assert.match(line, /sábado 21 de noviembre · 6:00 p\. m\./);
});

test('esquema estricto y costo', () => {
  const walk = (s) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual(s.required.sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === 'array') walk(s.items);
  };
  walk(ANALYSIS_SCHEMA);
  assert.equal(ANALYSIS_SCHEMA.properties.verses.items.properties.book.enum.length, 66);
  assert.equal(mmss(3725), '1:02:05');
  assert.equal(usageCost({ input_tokens: 1e6, output_tokens: 1e5 }), 6);
});

test('el PDF limpia caracteres que las fuentes estándar no tienen', () => {
  assert.equal(clean('Fe 🙏 → “amor” ñ á —'), 'Fe -> “amor” ñ á —');
});

test('voz: lectura natural de referencias y calificación al recitar', async () => {
  const V = await import('../public/js/voice.js');
  assert.equal(V.forSpeech('Lee Juan 3:16 y Mateo 14:29-31 [2:30] **ya**'), 'Lee Juan 3, versículo 16 y Mateo 14, versículos 29 al 31 ya');
  const r = V.compareRecital('Por lo cual dice: Despiértate, tú que duermes.', 'por lo cual dice despiertate tu que duermes');
  assert.equal(r.score, 100);
  const r2 = V.compareRecital('Por lo cual dice: Despiértate, tú que duermes.', 'por lo cual');
  assert.ok(r2.score < 50);
  assert.deepEqual(r2.missing, ['dice:', 'Despiértate,', 'tú', 'que', 'duermes.']);
});
