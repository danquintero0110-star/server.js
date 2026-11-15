// Reina-Valera 1909 (dominio público). Fuente: eBible.org, spaRV1909.
export const BIBLE_VERSION = {
  id: 'RV1909',
  name: 'Reina-Valera 1909',
  license: 'Dominio público',
  source: 'https://ebible.org/Scriptures/details.php?id=spaRV1909',
};

// [código VPL, nombre canónico, alias adicionales]
const BOOKS = [
  ['GEN', 'Génesis', ['gen', 'gn']], ['EXO', 'Éxodo', ['ex', 'exo']], ['LEV', 'Levítico', ['lv', 'lev']],
  ['NUM', 'Números', ['nm', 'num']], ['DEU', 'Deuteronomio', ['dt', 'deut']], ['JOS', 'Josué', ['jos']],
  ['JDG', 'Jueces', ['jue', 'jc']], ['RUT', 'Rut', ['rt']], ['1SA', '1 Samuel', ['1 sam', '1 s']],
  ['2SA', '2 Samuel', ['2 sam', '2 s']], ['1KI', '1 Reyes', ['1 re', '1 r']], ['2KI', '2 Reyes', ['2 re', '2 r']],
  ['1CH', '1 Crónicas', ['1 cr', '1 cro']], ['2CH', '2 Crónicas', ['2 cr', '2 cro']], ['EZR', 'Esdras', ['esd']],
  ['NEH', 'Nehemías', ['neh']], ['EST', 'Ester', ['est']], ['JOB', 'Job', ['jb']],
  ['PSA', 'Salmos', ['salmo', 'sal', 'sl']], ['PRO', 'Proverbios', ['pr', 'prov']], ['ECC', 'Eclesiastés', ['ec', 'ecl']],
  ['SOL', 'Cantares', ['cantar de los cantares', 'cnt', 'cant']], ['ISA', 'Isaías', ['is', 'isa']],
  ['JER', 'Jeremías', ['jer', 'jr']], ['LAM', 'Lamentaciones', ['lm', 'lam']], ['EZE', 'Ezequiel', ['ez', 'eze']],
  ['DAN', 'Daniel', ['dn', 'dan']], ['HOS', 'Oseas', ['os']], ['JOE', 'Joel', ['jl']], ['AMO', 'Amós', ['am']],
  ['OBA', 'Abdías', ['abd']], ['JON', 'Jonás', ['jon']], ['MIC', 'Miqueas', ['mi', 'miq']], ['NAH', 'Nahúm', ['nah']],
  ['HAB', 'Habacuc', ['hab']], ['ZEP', 'Sofonías', ['sof']], ['HAG', 'Hageo', ['hag']], ['ZEC', 'Zacarías', ['zac']],
  ['MAL', 'Malaquías', ['mal']], ['MAT', 'Mateo', ['mt', 'mat']], ['MAR', 'Marcos', ['mr', 'mc', 'mar']],
  ['LUK', 'Lucas', ['lc', 'luc']], ['JOH', 'Juan', ['jn']], ['ACT', 'Hechos', ['hch', 'hech']],
  ['ROM', 'Romanos', ['ro', 'rom']], ['1CO', '1 Corintios', ['1 co', '1 cor']], ['2CO', '2 Corintios', ['2 co', '2 cor']],
  ['GAL', 'Gálatas', ['ga', 'gal']], ['EPH', 'Efesios', ['ef']], ['PHI', 'Filipenses', ['fil', 'flp']],
  ['COL', 'Colosenses', ['col']], ['1TH', '1 Tesalonicenses', ['1 ts', '1 tes']], ['2TH', '2 Tesalonicenses', ['2 ts', '2 tes']],
  ['1TI', '1 Timoteo', ['1 ti', '1 tim']], ['2TI', '2 Timoteo', ['2 ti', '2 tim']], ['TIT', 'Tito', ['tit']],
  ['PHM', 'Filemón', ['flm']], ['HEB', 'Hebreos', ['he', 'heb']], ['JAM', 'Santiago', ['stg', 'sant']],
  ['1PE', '1 Pedro', ['1 p', '1 pe']], ['2PE', '2 Pedro', ['2 p', '2 pe']], ['1JO', '1 Juan', ['1 jn']],
  ['2JO', '2 Juan', ['2 jn']], ['3JO', '3 Juan', ['3 jn']], ['JUD', 'Judas', ['jud']], ['REV', 'Apocalipsis', ['ap', 'apoc']],
];

export const BOOK_NAMES = BOOKS.map((b) => b[1]);

const norm = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\./g, '')
    .replace(/\b(primera|primer|1ra|1era|i)\b/g, '1')
    .replace(/\b(segunda|segundo|2da|ii)\b/g, '2')
    .replace(/\b(tercera|tercer|3ra|iii)\b/g, '3')
    .replace(/(\d)\s*(?=[a-z])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(\d) (?:a los|a las|de|al|a) /, '$1 ')
    .replace(/^(?:libro de|evangelio de|carta a los|carta a) /, '');

const LOOKUP = new Map();
for (const [code, name, aliases] of BOOKS) {
  LOOKUP.set(norm(name), code);
  LOOKUP.set(code.toLowerCase(), code);
  for (const a of aliases) LOOKUP.set(norm(a), code);
}
LOOKUP.set('apocalipsis de juan', 'REV');
LOOKUP.set('san juan', 'JOH');
LOOKUP.set('san mateo', 'MAT');
LOOKUP.set('san marcos', 'MAR');
LOOKUP.set('san lucas', 'LUK');

export function bookCode(name) {
  return LOOKUP.get(norm(String(name || ''))) || null;
}

export function bookName(code) {
  return BOOKS.find((b) => b[0] === code)?.[1] || code;
}

export function formatRef(code, chapter, vStart, vEnd) {
  const base = `${bookName(code)} ${chapter}`;
  if (!vStart) return base;
  return vEnd && vEnd > vStart ? `${base}:${vStart}-${vEnd}` : `${base}:${vStart}`;
}

/** Interpreta "Juan 3:16-18", "1 Co 13:4", "Salmo 23". */
export function parseRef(input) {
  const m = /^\s*(.+?)\s+(\d{1,3})(?:\s*[:.,]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?)?\s*$/.exec(String(input || ''));
  if (!m) return null;
  const code = bookCode(m[1]);
  if (!code) return null;
  return { code, chapter: Number(m[2]), verseStart: m[3] ? Number(m[3]) : 0, verseEnd: m[4] ? Number(m[4]) : 0 };
}

const MAX_VERSES = 40;

export function getPassage(db, { code, chapter, verseStart = 0, verseEnd = 0 }) {
  if (!code || !chapter) return null;
  let rows;
  if (!verseStart) {
    rows = db.prepare('SELECT verse, text FROM bible WHERE book = ? AND chapter = ? ORDER BY verse LIMIT ?').all(code, chapter, MAX_VERSES);
  } else {
    const end = Math.max(verseStart, verseEnd || verseStart);
    rows = db
      .prepare('SELECT verse, text FROM bible WHERE book = ? AND chapter = ? AND verse BETWEEN ? AND ? ORDER BY verse LIMIT ?')
      .all(code, chapter, verseStart, end, MAX_VERSES);
  }
  if (!rows.length) return null;
  const last = rows[rows.length - 1].verse;
  return {
    reference: formatRef(code, chapter, verseStart ? rows[0].verse : 0, verseStart ? last : 0),
    code,
    chapter,
    verseStart: verseStart ? rows[0].verse : 0,
    verseEnd: verseStart ? last : 0,
    verses: rows,
    version: BIBLE_VERSION.id,
  };
}
