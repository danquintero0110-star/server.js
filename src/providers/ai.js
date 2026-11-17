import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { BOOK_NAMES } from '../lib/bible.js';

// USD por millón de tokens (Claude Opus 5.5).
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client = null;
export function getClient() {
  if (!client) client = new Anthropic();
  return client;
}
export function setClient(c) {
  client = c;
}

export function usageCost(u = {}) {
  const usd =
    ((u.input_tokens || 0) * PRICE.input +
      (u.output_tokens || 0) * PRICE.output +
      (u.cache_read_input_tokens || 0) * PRICE.cacheRead +
      (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite) /
    1e6;
  return Math.round(usd * 10000) / 10000;
}

const str = { type: 'string' };
const int = { type: 'integer' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });
const verseRef = {
  book: { type: 'string', enum: BOOK_NAMES },
  chapter: int,
  verse_start: { ...int, description: '0 si se cita el capítulo completo' },
  verse_end: { ...int, description: 'igual a verse_start si es un solo versículo' },
};

export const ANALYSIS_SCHEMA = obj({
  title: { ...str, description: 'Título sugerido, corto y memorable' },
  preacher: { ...str, description: 'Nombre del predicador si se menciona; si no, vacío' },
  central_idea: str,
  main_points: arr(obj({ title: str, detail: str, timestamp_sec: int })),
  strong_quotes: arr(obj({ text: str, timestamp_sec: int })),
  practical_application: arr(str),
  verses: arr(obj({ ...verseRef, how_cited: str, context: str, timestamp_sec: int })),
  sections: arr(
    obj({ kind: { type: 'string', enum: ['predica', 'anuncios', 'alabanza', 'oracion', 'otro'] }, start_sec: int, end_sec: int }),
  ),
  announcements: arr(
    obj({
      title: str,
      description: str,
      date: { ...str, description: 'AAAA-MM-DD o vacío' },
      time: { ...str, description: 'HH:MM 24h o vacío' },
      place: str,
      when_text: { ...str, description: 'Cómo se dijo la fecha, p. ej. "este sábado"' },
      timestamp_sec: int,
    }),
  ),
  cell_questions: arr(str),
  weekly_task: obj({ title: str, description: str }),
  devotional: arr(obj({ day: int, title: str, ...verseRef, reflection: str, action: str, prayer: str })),
  social_quotes: arr(str),
});

const SYSTEM = `Eres un asistente pastoral que convierte la transcripción de un servicio cristiano en notas de estudio en español.
Reglas:
- Trabaja solo con lo que se dijo. No inventes citas, nombres, fechas ni lugares.
- Separa la prédica de los anuncios, la alabanza y la oración. Los anuncios no van en el resumen.
- Los tiempos (timestamp_sec) son segundos desde el inicio, tomados de las marcas [mm:ss] más cercanas.
- Versículos: incluye cada pasaje bíblico citado o leído, aunque se mencione de forma informal ("en Juan tres dieciséis"). Usa el nombre canónico del libro. No dupliques.
- Anuncios: convierte fechas relativas a AAAA-MM-DD usando la fecha del servicio. Si no se dice la hora o el lugar, deja el campo vacío.
- main_points: 3 a 6 puntos. strong_quotes: 3 a 6 frases textuales o casi textuales del predicador.
- practical_application: 2 a 4 acciones concretas.
- cell_questions: 5 a 7 preguntas abiertas para célula o discipulado, de lo personal a lo práctico.
- devotional: exactamente 5 días, cada uno con un pasaje (preferiblemente de los citados), reflexión breve (80-120 palabras), una acción y una oración corta.
- social_quotes: 4 a 6 frases de menos de 140 caracteres, listas para redes, sin hashtags.
- Tono cálido, claro y fiel al mensaje.`;

export function formatTranscript(segments) {
  return segments.map((s) => `[${mmss(s.start)}] ${s.text}`).join('\n');
}

export function mmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function assertOk(msg) {
  if (msg.stop_reason === 'refusal') throw new Error('La IA no pudo procesar este contenido (rechazo de seguridad).');
  if (msg.stop_reason === 'max_tokens') throw new Error('La respuesta de la IA quedó incompleta (límite de tokens).');
}

export async function analyzeTranscript({ segments, serviceDate, hint = '' }) {
  const stream = getClient().beta.messages.stream({
    model: config.ai.model,
    max_tokens: 32000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: config.ai.effort, format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Fecha del servicio: ${serviceDate}${hint ? `\nContexto: ${hint}` : ''}\n\n<transcripcion>\n${formatTranscript(segments)}\n</transcripcion>`,
      },
    ],
  });
  const msg = await stream.finalMessage();
  assertOk(msg);
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const analysis = JSON.parse(text);
  return { analysis, costUsd: usageCost(msg.usage), usage: msg.usage };
}

export const STUDY_SCHEMA = obj({
  introduction: { ...str, description: 'Contexto y propósito del mensaje, 90-140 palabras' },
  points: arr(
    obj({
      title: str,
      timestamp_sec: int,
      development: { ...str, description: 'Desarrollo del punto en 2-3 párrafos (180-260 palabras), separados por \\n\\n' },
      verses: arr(
        obj({
          ...verseRef,
          role: { type: 'string', enum: ['citado', 'complementario'] },
          why: { ...str, description: 'Una o dos frases: cómo este pasaje sustenta el punto' },
        }),
      ),
      reflection_question: str,
    }),
  ),
  conclusion: { ...str, description: '80-130 palabras' },
  prayer: { ...str, description: 'Oración final de 50-80 palabras, en primera persona' },
  memory_verse: obj(verseRef),
});

const STUDY_SYSTEM = `Eres un maestro bíblico que convierte una prédica en un estudio escrito, profundo y fiel, en español.
Reglas:
- Fidelidad: desarrolla lo que el predicador enseñó. Explica, ordena y profundiza, pero no cambies el mensaje ni inventes anécdotas, nombres o citas del predicador.
- Desarrolla cada punto principal (usa los mismos puntos y su orden) en 2-3 párrafos: qué enseñó, por qué es bíblico y cómo se vive hoy.
- Sustento bíblico por punto: 2 a 4 pasajes. Primero los que el predicador citó o leyó (role "citado"). Añade como máximo 2 pasajes "complementario" por punto, solo si son claramente pertinentes y conocidos; nunca inventes referencias.
- Prefiere pasajes cortos (1 a 6 versículos). Usa el nombre canónico del libro.
- En "why" explica en una o dos frases cómo el pasaje respalda la enseñanza, considerando su contexto.
- memory_verse: el versículo que mejor resume el mensaje (preferiblemente uno citado).
- Tono pastoral, cálido, claro, sin tecnicismos. Sin markdown.`;

export async function developStudy({ segments, analysis, serviceDate }) {
  const points = (analysis.main_points || []).map((p, i) => `${i + 1}. ${p.title} — ${p.detail} [${mmss(p.timestamp_sec || 0)}]`).join('\n');
  const cited = (analysis.verses || []).map((v) => v.reference || `${v.book} ${v.chapter}:${v.verse_start}`).join(', ');
  const stream = getClient().beta.messages.stream({
    model: config.ai.model,
    max_tokens: 32000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: config.ai.effort, format: { type: 'json_schema', schema: STUDY_SCHEMA } },
    system: STUDY_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Fecha del servicio: ${serviceDate}\nTítulo: ${analysis.title}\nIdea central: ${analysis.central_idea}\n\nPuntos principales:\n${points}\n\nVersículos citados en la prédica: ${cited || 'ninguno detectado'}\n\n<transcripcion>\n${formatTranscript(segments)}\n</transcripcion>`,
      },
    ],
  });
  const msg = await stream.finalMessage();
  assertOk(msg);
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { study: JSON.parse(text), costUsd: usageCost(msg.usage) };
}

const CHAT_SYSTEM = `Eres Selah, un compañero de estudio. Respondes preguntas sobre UNA prédica usando su transcripción y notas.
- Responde en español, breve y cálido (máximo 180 palabras salvo que pidan más).
- Basa tus respuestas en la prédica. Si algo no se dijo, dilo con honestidad y ofrece una reflexión bíblica general marcada como tal.
- Cuando cites un momento, indica el tiempo como [mm:ss].
- Texto plano, sin encabezados markdown.`;

/** Chat sobre una nota. onText recibe fragmentos para streaming. */
export async function chatAboutNote({ note, segments, analysis, history, question, onText }) {
  const context = `Título: ${note.title}\nPredicador: ${note.preacher || 'no indicado'}\nFecha: ${note.preached_at}\n\nIdea central: ${
    analysis?.central_idea || ''
  }\n\n<transcripcion>\n${formatTranscript(segments)}\n</transcripcion>`;
  const stream = getClient().beta.messages.stream({
    model: config.ai.model,
    max_tokens: 4000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: config.ai.chatEffort },
    system: [
      { type: 'text', text: CHAT_SYSTEM },
      { type: 'text', text: context, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    messages: [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: question }],
  });
  if (onText) stream.on('text', onText);
  const msg = await stream.finalMessage();
  assertOk(msg);
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, costUsd: usageCost(msg.usage) };
}
