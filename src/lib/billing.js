// Planes y suspensión por falta de pago.
//
// Cada cuenta tiene:
//   status      'active' | 'suspended'   (suspended = pausa manual del administrador)
//   paid_until  'AAAA-MM-DD' o ''        ('' = no vence: familia, cortesía)
//   plan        nombre libre del plan    ('familia', 'personal', 'iglesia'…)
//
// Al vencer paid_until hay GRACE_DAYS de gracia (aviso, todo funciona).
// Después se pausan SOLO las funciones que cuestan dinero (transcripción, IA, voz,
// generación de archivos). Ver, escuchar, copiar y descargar lo ya hecho sigue
// funcionando: los datos son de la persona y eso ayuda a que regrese y pague.
// Un proveedor de pagos (Stripe, Mercado Pago…) solo tiene que mover paid_until.

export const GRACE_DAYS = Number(process.env.BILLING_GRACE_DAYS || 5);

// "MÉTODO /ruta" tal como la resuelve Fastify.
export const BILLABLE = new Set([
  'POST /api/notes', // nueva nota (YouTube) → transcripción + IA
  'POST /api/uploads', // nueva nota por subida
  'PUT /api/uploads/:id',
  'POST /api/uploads/:id/finish',
  'POST /api/notes/:id/reprocess', // volver a transcribir / analizar
  'POST /api/notes/:id/chat', // preguntas a la IA
  'POST /api/notes/:id/focus', // enfoques por área (IA)
  'POST /api/tts', // voz de Selah
  'POST /api/notes/:id/listen', // conversar por voz
  'GET /api/notes/:id/export.pdf', // generación de archivos
]);

const DAY = 864e5;
const today = (now) => new Date(now).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** Estado de acceso de una cuenta. state: 'ok' | 'grace' | 'blocked'. */
export function accessOf(u, now = Date.now()) {
  const base = { plan: u.plan || 'familia', paidUntil: u.paid_until || '', status: u.status || 'active' };
  if (u.is_admin) return { ...base, state: 'ok', reason: '' };
  if (base.status === 'suspended') return { ...base, state: 'blocked', reason: 'suspended', message: 'Tu cuenta está en pausa. Comunícate con el administrador para reactivarla.' };
  if (!base.paidUntil) return { ...base, state: 'ok', reason: '' };
  const t = today(now);
  const overdue = daysBetween(base.paidUntil, t); // > 0: días desde el vencimiento
  if (overdue <= 0) {
    const left = -overdue;
    return { ...base, state: 'ok', reason: '', daysLeft: left, ...(left <= 3 && { message: left === 0 ? 'Tu plan vence hoy.' : `Tu plan vence en ${left} ${left === 1 ? 'día' : 'días'}.` }) };
  }
  if (overdue <= GRACE_DAYS) {
    const left = GRACE_DAYS - overdue + 1;
    return { ...base, state: 'grace', reason: 'overdue', graceLeft: left, message: `Tu plan venció. Renueva en los próximos ${left} ${left === 1 ? 'día' : 'días'} para seguir creando notas.` };
  }
  return { ...base, state: 'blocked', reason: 'overdue', message: 'Tu plan venció. Puedes ver y descargar tus notas; para crear nuevas, transcribir o usar la IA, renueva tu plan.' };
}

export function isBillable(method, route) {
  return BILLABLE.has(`${method} ${route}`);
}
