import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Directorio de datos aislado ANTES de cargar la configuración.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selah-test-'));
process.env.SELAH_DATA_DIR = dir;
process.env.SELAH_ENV_FILE = path.join(dir, 'none.env');
process.env.COOKIE_SECURE = 'false';
process.env.DEEPGRAM_API_KEY = 'test';

export const dataDir = dir;

export const SAMPLE_ANALYSIS = {
  title: 'Fe que camina sobre el agua',
  preacher: 'Pastor Andrés',
  central_idea: 'La fe verdadera mantiene la mirada en Jesús en medio de la tormenta.',
  main_points: [
    { title: 'La tormenta llega', detail: 'Las pruebas no significan ausencia de Dios.', timestamp_sec: 30 },
    { title: 'Jesús llama', detail: 'Él nos invita a salir de la barca.', timestamp_sec: 90 },
    { title: 'Mirar a Jesús', detail: 'Pedro se hundió cuando miró el viento.', timestamp_sec: 150 },
  ],
  strong_quotes: [{ text: 'El viento no decide tu destino, Jesús sí.', timestamp_sec: 160 }],
  practical_application: ['Ora cada mañana antes de ver el celular.', 'Escribe tu tormenta y entrégala.'],
  verses: [
    { book: 'Mateo', chapter: 14, verse_start: 29, verse_end: 31, how_cited: 'Mateo catorce', context: 'Pedro camina', timestamp_sec: 40 },
    { book: 'Juan', chapter: 3, verse_start: 16, verse_end: 16, how_cited: 'Juan 3:16', context: 'Amor de Dios', timestamp_sec: 200 },
    { book: 'Mateo', chapter: 14, verse_start: 29, verse_end: 31, how_cited: 'duplicado', context: '', timestamp_sec: 41 },
  ],
  sections: [
    { kind: 'anuncios', start_sec: 0, end_sec: 20 },
    { kind: 'predica', start_sec: 20, end_sec: 240 },
  ],
  announcements: [
    { title: 'Retiro de jóvenes', description: 'Inscripciones abiertas.', date: '2026-11-21', time: '18:00', place: 'Salón principal', when_text: 'este sábado', timestamp_sec: 5 },
  ],
  cell_questions: ['¿Cuál es tu tormenta hoy?', '¿Qué te distrae de mirar a Jesús?'],
  weekly_task: { title: 'Diario de fe', description: 'Anota cada día una promesa de Dios.' },
  devotional: [1, 2, 3, 4, 5].map((d) => ({
    day: d,
    title: `Día ${d}`,
    book: 'Salmos',
    chapter: 23,
    verse_start: d,
    verse_end: d,
    reflection: 'Reflexión breve.',
    action: 'Acción concreta.',
    prayer: 'Señor, ayúdame.',
  })),
  social_quotes: ['El viento no decide tu destino.'],
};

/** Cliente falso de Anthropic con la misma forma que beta.messages.stream(). */
export const SAMPLE_STUDY = {
  introduction: 'Una prédica sobre la fe en medio de la tormenta → con emoji 🙏 que el PDF debe limpiar.',
  points: [
    {
      title: 'La tormenta llega',
      timestamp_sec: 30,
      development: 'Primer párrafo del desarrollo.\n\nSegundo párrafo con aplicación.',
      verses: [
        { book: 'Mateo', chapter: 14, verse_start: 29, verse_end: 31, role: 'citado', why: 'Pedro camina sobre el agua.' },
        { book: 'Salmos', chapter: 46, verse_start: 1, verse_end: 1, role: 'complementario', why: 'Dios es nuestro amparo.' },
        { book: 'Mateo', chapter: 99, verse_start: 1, verse_end: 1, role: 'complementario', why: 'Referencia inexistente: se descarta.' },
      ],
      reflection_question: '¿Dónde está tu mirada hoy?',
    },
  ],
  conclusion: 'Conclusión breve.',
  prayer: 'Señor, ayúdame a mirarte.',
  memory_verse: { book: 'Juan', chapter: 3, verse_start: 16, verse_end: 16 },
};

export function fakeAnthropic({ analysis = SAMPLE_ANALYSIS, study = SAMPLE_STUDY, chatText = 'Según la prédica [2:30], Pedro se hundió al mirar el viento.' } = {}) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          const isAnalysis = Boolean(params.output_config?.format);
          const isStudy = Boolean(params.output_config?.format?.schema?.properties?.introduction);
          const text = isStudy ? JSON.stringify(study) : isAnalysis ? JSON.stringify(analysis) : chatText;
          const listeners = {};
          return {
            on(ev, fn) {
              (listeners[ev] ||= []).push(fn);
              return this;
            },
            async finalMessage() {
              if (!isAnalysis) for (const chunk of text.match(/.{1,12}/g)) (listeners.text || []).forEach((f) => f(chunk));
              return {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text }],
                usage: { input_tokens: 15000, output_tokens: 6000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              };
            },
          };
        },
      },
    },
  };
}

export const SAMPLE_SEGMENTS = [
  { start: 0, end: 18, text: 'Bienvenidos. Este sábado a las seis de la tarde tenemos el retiro de jóvenes en el salón principal.' },
  { start: 20, end: 60, text: 'Abramos la Biblia en Mateo catorce, versículo veintinueve.' },
  { start: 150, end: 170, text: 'El viento no decide tu destino, Jesús sí.' },
  { start: 200, end: 230, text: 'Porque de tal manera amó Dios al mundo, Juan tres dieciséis.' },
];
