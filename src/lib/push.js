// Notificaciones en el teléfono (Web Push): devocional diario y avisos de prédicas compartidas.
// Las llaves VAPID se generan una sola vez y se guardan en la carpeta de datos (permiso 600).
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { config } from '../config.js';

function vapidKeys() {
  const file = path.join(config.dataDir, 'vapid.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    return keys;
  }
}

/** Fecha y hora local (AAAA-MM-DD, hora 0-23) en una zona horaria. */
export function localNow(tz, now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    return localNow('America/Mexico_City', now);
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** Día del devocional (1-5) para hoy según la fecha de la prédica; null si ya pasó o no empieza. */
export function devotionalDay(preachedAt, today) {
  const a = Date.parse(`${preachedAt}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const n = Math.round((b - a) / 86400000);
  return n >= 1 && n <= 5 ? n : null;
}

export function createPush(db, { log = console, send = null } = {}) {
  const keys = vapidKeys();
  webpush.setVapidDetails('https://selah.orbitix.app', keys.publicKey, keys.privateKey);
  const sendOne = send || ((sub, payload) => webpush.sendNotification(sub, payload, { TTL: 6 * 3600 }));

  async function deliver(row, msg) {
    const sub = { endpoint: row.endpoint, keys: JSON.parse(row.keys_json) };
    try {
      await sendOne(sub, JSON.stringify(msg));
      return true;
    } catch (e) {
      // 404/410: la suscripción ya no existe (se desinstaló o se quitó el permiso).
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
      else log.warn?.(`Push falló (${e.statusCode || e.message})`);
      return false;
    }
  }

  async function notifyUsers(userIds, msg) {
    if (!userIds?.length) return;
    const rows = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${userIds.map(() => '?').join(',')})`).all(...userIds);
    await Promise.all(rows.map((r) => deliver(r, msg)));
  }

  /** La prédica más reciente (propia o compartida) que tiene devocional para hoy. */
  function todaysDevotional(userId, today) {
    const notes = db
      .prepare(
        `SELECT n.id, n.title, n.preached_at, n.analysis_json FROM notes n
         WHERE n.status = 'ready' AND (n.user_id = @uid OR n.id IN (
           SELECT s.note_id FROM note_shares s JOIN group_members m ON m.group_id = s.group_id WHERE m.user_id = @uid))
         ORDER BY n.preached_at DESC, n.created_at DESC LIMIT 5`,
      )
      .all({ uid: userId });
    for (const n of notes) {
      const day = devotionalDay(n.preached_at, today);
      if (!day) continue;
      const d = (JSON.parse(n.analysis_json || '{}').devotional || []).find((x) => x.day === day);
      if (d) return { note: n, day, d };
    }
    return null;
  }

  /** Revisa cada pocos minutos a quién le toca su recordatorio de hoy. */
  async function tick(now = new Date()) {
    const rows = db.prepare('SELECT * FROM push_subscriptions WHERE daily = 1').all();
    for (const r of rows) {
      const { date, hour } = localNow(r.tz, now);
      if (hour < r.hour || r.last_daily === date) continue;
      if (hour > r.hour + 3) {
        // Muy tarde para "buenos días": se marca para no mandarlo a deshoras.
        db.prepare('UPDATE push_subscriptions SET last_daily = ? WHERE id = ?').run(date, r.id);
        continue;
      }
      db.prepare('UPDATE push_subscriptions SET last_daily = ? WHERE id = ?').run(date, r.id);
      const t = todaysDevotional(r.user_id, date);
      if (!t) continue;
      await deliver(r, {
        title: `Día ${t.day} de tu devocional`,
        body: `${t.d.title}${t.d.reference ? ` · ${t.d.reference}` : ''}. Toca para vivirlo con Selah.`,
        url: `/nota/${t.note.id}?t=voz&dia=${t.day}`,
        tag: `dev-${t.note.id}-${t.day}`,
      });
    }
  }

  let timer = null;
  return {
    publicKey: keys.publicKey,
    notifyUsers,
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((e) => log.error?.(e)), 5 * 60 * 1000);
      timer.unref();
      setTimeout(() => tick().catch(() => {}), 20000).unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
