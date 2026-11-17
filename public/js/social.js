// Grupos (familia / iglesia), compartir prédicas, mi cuenta, notificaciones y administración.
import { api } from './api.js';
import { h, icon, toast, sheet, copyText, shareText, vibrate } from './ui.js';
import { installText } from './install.js';

const KIND = { familia: 'Familia', iglesia: 'Iglesia' };
const roleLabel = (r) => (r === 'admin' ? 'Administra' : 'Miembro');

// ------------------------------------------------------------------ Notificaciones
function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function currentSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function enablePush(hour = 7) {
  if (!pushSupported()) throw new Error('Este navegador no permite notificaciones. En iPhone, primero agrega Selah a la pantalla de inicio (iOS 16.4 o más reciente).');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permite las notificaciones de Selah en los ajustes del teléfono');
  const { publicKey, available } = await api.get('/api/push');
  if (!available) throw new Error('Las notificaciones no están disponibles en el servidor');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api.post('/api/push/subscribe', { subscription: sub.toJSON(), hour, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  return sub;
}

async function disablePush() {
  const sub = await currentSub().catch(() => null);
  if (!sub) return;
  await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export function notificationsSheet() {
  sheet(() => {
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Cargando…'));
    (async () => {
      if (!pushSupported()) {
        body.replaceChildren(h('p', { class: 'muted' }, 'Este navegador no permite notificaciones. En iPhone, primero agrega Selah a la pantalla de inicio (iOS 16.4 o más reciente). En Android funcionan en Chrome, Samsung Internet, Edge y Firefox.'));
        return;
      }
      const [{ subscriptions }, sub] = await Promise.all([api.get('/api/push'), currentSub().catch(() => null)]);
      const mine = sub && subscriptions.find((s) => s.endpoint === sub.endpoint);
      const hourSel = h(
        'select',
        { class: 'input' },
        Array.from({ length: 18 }, (_, i) => i + 5).map((hh) => h('option', { value: hh, selected: (mine?.hour ?? 7) === hh }, `${hh % 12 || 12}:00 ${hh < 12 ? 'a. m.' : 'p. m.'}`)),
      );
      const on = h('button', { class: 'btn primary' }, icon('check'), mine ? 'Guardar hora' : 'Activar recordatorios');
      const off = mine ? h('button', { class: 'btn' }, 'Desactivar en este teléfono') : null;
      const test = mine ? h('button', { class: 'btn' }, 'Enviar una prueba') : null;
      on.onclick = async () => {
        on.disabled = true;
        try {
          await enablePush(Number(hourSel.value));
          toast('Recordatorios activados');
          vibrate([15, 40, 15]);
          notificationsRefresh();
        } catch (e) {
          toast(e.message, { error: true, ms: 5000 });
        }
        on.disabled = false;
      };
      if (off) off.onclick = async () => (await disablePush(), toast('Recordatorios desactivados'), notificationsRefresh());
      if (test) test.onclick = async () => (await api.post('/api/push/test').catch((e) => toast(e.message, { error: true })), toast('Enviada'));
      body.replaceChildren(
        h('p', { class: 'muted' }, 'Cada mañana Selah te avisa el día de tu devocional de la última prédica. También te avisa cuando alguien de tu familia o iglesia comparte una prédica contigo.'),
        h('label', { class: 'field' }, h('span', {}, 'Hora del recordatorio'), hourSel),
        on,
        test,
        off,
      );
      function notificationsRefresh() {
        document.querySelectorAll('.sheet, .scrim').forEach((x) => x.remove());
        notificationsSheet();
      }
    })().catch((e) => body.replaceChildren(h('p', { class: 'muted' }, e.message)));
    return [h('h3', {}, 'Recordatorios'), body];
  });
}

// ------------------------------------------------------------------ Mi cuenta
export function accountSheet(me, onUpdate) {
  sheet((close) => {
    const dn = h('input', { class: 'input', placeholder: 'Cómo quieres que te salude (p. ej. Mamá)', value: me?.displayName || '', maxlength: 40 });
    const saveName = h('button', { class: 'btn small' }, 'Guardar nombre');
    saveName.onclick = async () => {
      try {
        const r = await api.put('/api/me/profile', { displayName: dn.value });
        onUpdate?.({ displayName: r.displayName });
        toast('Nombre guardado');
      } catch (e) {
        toast(e.message, { error: true });
      }
    };
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Contraseña actual' });
    const nw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Nueva contraseña (mínimo 8)' });
    const nw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Repite la nueva contraseña' });
    const save = h('button', { class: 'btn primary' }, 'Cambiar contraseña');
    save.onclick = async () => {
      if (nw.value !== nw2.value) return toast('Las contraseñas nuevas no coinciden', { error: true });
      save.disabled = true;
      try {
        await api.post('/api/me/password', { current: cur.value, next: nw.value });
        toast('Contraseña cambiada');
        close();
      } catch (e) {
        toast(e.message, { error: true });
      }
      save.disabled = false;
    };
    return [
      h('h3', {}, 'Mi cuenta'),
      h('p', { class: 'muted' }, `Usuario: ${me?.username || ''}`),
      h('div', { class: 'field' }, h('label', {}, 'Tu nombre'), h('div', { class: 'fx-custom' }, dn, saveName)),
      h('div', { class: 'field', style: { marginTop: '16px' } }, h('label', {}, 'Cambiar contraseña'), h('div', { class: 'stack' }, cur, nw, nw2, save)),
    ];
  });
}

// ------------------------------------------------------------------ Administración (cuentas)
const credText = (u, p) => `Hola 🙌 Te comparto Selah, la app para las notas de las prédicas.\n\nEntra aquí: ${location.origin}\nUsuario: ${u}\nContraseña: ${p}\n\n${installText()}`;

function credsBox(u, p) {
  const t = credText(u, p);
  return h(
    'div',
    { class: 'card creds' },
    h('p', {}, h('b', {}, u), ' · contraseña: ', h('code', {}, p)),
    h('div', { class: 'export-row' }, h('button', { class: 'btn small', onclick: () => copyText(t, 'Mensaje copiado') }, icon('copy'), 'Copiar mensaje'), h('button', { class: 'btn small primary', onclick: () => shareText(t, 'Selah') }, icon('wa'), 'Enviar')),
  );
}

export function adminSheet() {
  sheet(() => {
    const list = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Cargando…'));
    const out = h('div');
    const nu = h('input', { class: 'input', placeholder: 'Nuevo usuario (p. ej. tia_ana)', autocapitalize: 'off' });
    const add = h('button', { class: 'btn primary small' }, icon('plus'), 'Crear');
    add.onclick = async () => {
      try {
        const r = await api.post('/api/admin/users', { username: nu.value });
        nu.value = '';
        out.replaceChildren(credsBox(r.username, r.password));
        load();
      } catch (e) {
        toast(e.message, { error: true });
      }
    };
    async function load() {
      const users = await api.get('/api/admin/users');
      list.replaceChildren(
        ...users.map((u) =>
          h(
            'div',
            { class: 'row-item' },
            h(
              'div',
              {},
              h('b', {}, u.displayName ? `${u.displayName} ` : '', h('span', { class: 'faint' }, `@${u.username}`)),
              h('small', {}, `${u.notes} ${u.notes === 1 ? 'nota' : 'notas'}${u.isAdmin ? ' · administrador' : ''} · ${planLabel(u)}`),
              u.account.state !== 'ok' ? h('span', { class: `status ${u.account.state === 'blocked' ? 'err' : ''}` }, u.account.state === 'blocked' ? (u.status === 'suspended' ? 'En pausa' : 'Vencida') : 'En gracia') : null,
            ),
            h('button', { class: 'btn small', onclick: () => editUserSheet(u, { onChange: load, out }) }, icon('edit'), 'Editar'),
          ),
        ),
      );
    }
    load().catch((e) => list.replaceChildren(h('p', { class: 'muted' }, e.message)));
    return [h('h3', {}, 'Cuentas'), h('div', { class: 'fx-custom' }, nu, add), out, list];
  });
}

const fmtDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const planLabel = (u) => `${u.plan || 'familia'}${u.paidUntil ? ` · pagado hasta ${fmtDate(u.paidUntil)}` : ' · sin vencimiento'}`;
const addMonths = (iso, n) => {
  const base = iso && iso > new Date().toISOString().slice(0, 10) ? new Date(`${iso}T12:00:00`) : new Date();
  base.setMonth(base.getMonth() + n);
  return base.toISOString().slice(0, 10);
};

function editUserSheet(u, { onChange, out }) {
  sheet((close) => {
    const dn = h('input', { class: 'input', value: u.displayName || '', placeholder: 'Nombre visible (p. ej. Mamá)', maxlength: 40 });
    const un = h('input', { class: 'input', value: u.username, autocapitalize: 'off' });
    const plan = h('input', { class: 'input', value: u.plan || 'familia', placeholder: 'familia, personal, iglesia…', maxlength: 30 });
    const paid = h('input', { class: 'input', type: 'date', value: u.paidUntil || '' });
    const active = h('input', { type: 'checkbox', checked: u.status !== 'suspended' });
    const admin = h('input', { type: 'checkbox', checked: u.isAdmin });
    const toggle = (input, title, sub) => h('label', { class: 'card check toggle' }, input, h('span', {}, h('b', {}, title), h('br'), h('small', { class: 'muted' }, sub)));
    const save = h('button', { class: 'btn primary block' }, 'Guardar cambios');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api.patch(`/api/admin/users/${u.id}`, { displayName: dn.value, username: un.value, plan: plan.value, paidUntil: paid.value, status: active.checked ? 'active' : 'suspended', isAdmin: admin.checked });
        toast('Cuenta actualizada');
        close();
        onChange?.();
      } catch (e) {
        toast(e.message, { error: true });
        save.disabled = false;
      }
    };
    const quick = (n, label) => h('button', { class: 'chip', type: 'button', onclick: () => (paid.value = addMonths(paid.value, n)) }, label);
    return [
      h('span', { class: 'eyebrow' }, 'Editar cuenta'),
      h('h3', {}, u.displayName || u.username),
      h('div', { class: 'stack', style: { marginTop: '14px' } },
        h('div', { class: 'field' }, h('label', {}, 'Nombre visible'), dn),
        h('div', { class: 'field' }, h('label', {}, 'Usuario para entrar'), un),
        h('div', { class: 'field' }, h('label', {}, 'Plan'), plan),
        h(
          'div',
          { class: 'field' },
          h('label', {}, 'Pagado hasta (vacío = no vence)'),
          paid,
          h('div', { class: 'suggest', style: { marginTop: '6px' } }, quick(1, '+1 mes'), quick(12, '+1 año'), h('button', { class: 'chip', type: 'button', onclick: () => (paid.value = '') }, 'Sin vencimiento')),
        ),
        toggle(active, 'Cuenta activa', 'Si la desactivas, puede ver sus notas pero no crear nuevas ni usar la IA.'),
        toggle(admin, 'Administrador', 'Puede crear, editar y eliminar cuentas.'),
        save,
        h('div', { class: 'export-row' },
          h('button', { class: 'btn small', onclick: async () => {
            if (!confirm(`¿Generar una contraseña nueva para ${u.username}? Se cerrará su sesión.`)) return;
            const r = await api.post(`/api/admin/users/${u.id}/reset`);
            close();
            out.replaceChildren(credsBox(r.username, r.password));
          } }, icon('refresh'), 'Nueva contraseña'),
          h('button', { class: 'btn small danger-btn', onclick: async () => {
            const typed = prompt(`Esto borra para siempre la cuenta de ${u.username}, sus ${u.notes} notas, audios y conversaciones.\n\nEscribe "${u.username}" para confirmar:`);
            if (typed == null) return;
            try {
              const r = await api.del(`/api/admin/users/${u.id}`, { confirm: typed.trim() });
              toast(`Cuenta eliminada (${r.deletedNotes} notas)`);
              close();
              onChange?.();
            } catch (e) {
              toast(e.message, { error: true });
            }
          } }, icon('trash'), 'Eliminar cuenta'),
        ),
      ),
    ];
  });
}

// ------------------------------------------------------------------ Grupos
async function uploadGroupLogo(gid, file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 700 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const res = await fetch(`/api/groups/${gid}/logo`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Image-Mime': 'image/png' }, body: blob });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || 'No se pudo subir');
  return d;
}

function inviteText(g) {
  return `Te invito a ${g.kind === 'iglesia' ? 'la iglesia' : 'nuestro grupo'} "${g.name}" en Selah 🙌\nAhí compartimos las prédicas con su resumen, versículos y devocional.\n\n1. Entra a ${location.origin}\n2. Menú ⋯ → Grupos → "Unirme con código"\n3. Código: ${g.code}`;
}

export async function groupsView({ me, go }) {
  const list = h('div', { class: 'list' }, h('div', { class: 'skeleton' }));
  async function load() {
    const groups = await api.get('/api/groups');
    list.replaceChildren(
      ...(groups.length
        ? groups.map((g) =>
            h(
              'button',
              { class: 'card group-card', onclick: () => groupSheet(g.id, load, me) },
              h('span', { class: `g-ic ${g.kind}` }, icon(g.kind === 'iglesia' ? 'book' : 'heart')),
              h('span', {}, h('b', {}, g.name), h('small', {}, `${KIND[g.kind]} · ${g.members} ${g.members === 1 ? 'persona' : 'personas'} · ${g.notes} ${g.notes === 1 ? 'prédica' : 'prédicas'}`)),
              icon('chev'),
            ),
          )
        : [h('div', { class: 'empty' }, h('h3', {}, 'Comparte la palabra'), h('p', { class: 'muted' }, 'Crea un grupo para tu familia o tu iglesia y compartan las prédicas con su resumen, versículos y devocional.'))]),
    );
  }
  load().catch((e) => toast(e.message, { error: true }));

  const createBtn = h('button', { class: 'btn primary' }, icon('plus'), 'Crear grupo');
  const joinBtn = h('button', { class: 'btn' }, 'Unirme con código');
  createBtn.onclick = () =>
    sheet((close) => {
      const name = h('input', { class: 'input', placeholder: 'Nombre (p. ej. Familia Quintero, Casa de Fe)', maxlength: 60 });
      let kind = 'familia';
      const seg = h(
        'div',
        { class: 'st-seg' },
        ['familia', 'iglesia'].map((k) =>
          h('button', { class: k === kind ? 'on' : '', onclick: (e) => ((kind = k), e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget))) }, KIND[k]),
        ),
      );
      const ok = h('button', { class: 'btn primary' }, 'Crear');
      ok.onclick = async () => {
        try {
          const g = await api.post('/api/groups', { name: name.value, kind });
          close();
          load();
          setTimeout(() => groupSheet(g.id, load, me), 320);
        } catch (e) {
          toast(e.message, { error: true });
        }
      };
      return [
        h('h3', {}, 'Nuevo grupo'),
        h(
          'div',
          { class: 'stack' },
          name,
          seg,
          h('p', { class: 'muted', style: { margin: 0, fontSize: '13.5px' } }, 'Familia: todos pueden compartir prédicas. Iglesia: solo quienes administran comparten, y las imágenes llevan el logo de la iglesia.'),
          ok,
        ),
      ];
    });
  joinBtn.onclick = () =>
    sheet((close) => {
      const code = h('input', { class: 'input', placeholder: 'Código de 6 letras', maxlength: 8, autocapitalize: 'characters', style: { textTransform: 'uppercase', letterSpacing: '0.2em', fontWeight: '800' } });
      const ok = h('button', { class: 'btn primary' }, 'Unirme');
      ok.onclick = async () => {
        try {
          const g = await api.post('/api/groups/join', { code: code.value });
          toast(`Te uniste a ${g.name}`);
          close();
          load();
        } catch (e) {
          toast(e.message, { error: true });
        }
      };
      return [h('h3', {}, 'Unirme a un grupo'), h('div', { class: 'stack' }, code, ok)];
    });

  return h(
    'main',
    { class: 'view' },
    h('header', { class: 'topbar' }, h('button', { class: 'icon-btn', 'aria-label': 'Volver', onclick: () => (history.length > 1 ? history.back() : go('/')) }, icon('back')), h('span', { class: 'eyebrow' }, 'Grupos'), h('span', { style: { width: '44px' } })),
    h('div', { style: { marginTop: '18px' } }, h('h1', { class: 'display', style: { fontSize: '40px' } }, 'Familia ', h('em', {}, 'e iglesia'))),
    h('div', { class: 'export-row', style: { marginTop: '18px' } }, createBtn, joinBtn),
    list,
  );
}

async function groupSheet(gid, onChange, me) {
  const g = await api.get(`/api/groups/${gid}`);
  const admin = g.role === 'admin';
  sheet((close) => {
    const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' } });
    fileIn.onchange = async () => {
      try {
        await uploadGroupLogo(g.id, fileIn.files[0]);
        toast('Logo guardado');
      } catch (e) {
        toast(e.message, { error: true });
      }
    };
    return [
      h('h3', {}, g.name),
      h('p', { class: 'muted', style: { margin: 0 } }, `${KIND[g.kind]} · ${roleLabel(g.role)}`),
      h(
        'div',
        { class: 'card invite' },
        h('small', {}, 'Código para unirse'),
        h('b', { class: 'code' }, g.code),
        h('div', { class: 'export-row' }, h('button', { class: 'btn small', onclick: () => copyText(g.code, 'Código copiado') }, icon('copy'), 'Copiar'), h('button', { class: 'btn small primary', onclick: () => shareText(inviteText(g), g.name) }, icon('wa'), 'Invitar')),
      ),
      admin && g.kind === 'iglesia'
        ? h('div', { class: 'stack' }, h('button', { class: 'btn', onclick: () => fileIn.click() }, icon('upload'), g.brand?.logo ? 'Cambiar logo de la iglesia' : 'Subir logo de la iglesia'), fileIn)
        : null,
      h('h4', { class: 'eyebrow', style: { margin: '18px 0 8px' } }, 'Personas'),
      h(
        'div',
        { class: 'stack' },
        g.memberList.map((m) =>
          h(
            'div',
            { class: 'row-item' },
            h('div', {}, h('b', {}, m.username), h('small', {}, roleLabel(m.role))),
            admin && m.id !== me?.id
              ? h(
                  'div',
                  { style: { display: 'flex', gap: '6px' } },
                  m.role !== 'admin' ? h('button', { class: 'btn small', onclick: async () => (await api.post(`/api/groups/${g.id}/members/${m.id}/role`, { role: 'admin' }), close(), groupSheet(g.id, onChange, me)) }, 'Hacer admin') : null,
                  h('button', { class: 'icon-btn small', 'aria-label': `Quitar a ${m.username}`, onclick: async () => {
                    if (!confirm(`¿Quitar a ${m.username} del grupo?`)) return;
                    await api.del(`/api/groups/${g.id}/members/${m.id}`);
                    close();
                    onChange?.();
                  } }, icon('x')),
                )
              : null,
          ),
        ),
      ),
      h(
        'button',
        {
          class: 'btn danger-text',
          style: { marginTop: '16px' },
          onclick: async () => {
            if (!confirm(`¿Salir de ${g.name}? Dejarás de ver sus prédicas compartidas.`)) return;
            await api.del(`/api/groups/${g.id}/members/${me.id}`);
            close();
            onChange?.();
          },
        },
        'Salir del grupo',
      ),
    ];
  });
}

// ------------------------------------------------------------------ Compartir una nota
export async function shareSheet(note, onChange) {
  const groups = await api.get('/api/groups');
  sheet((close) => {
    const shared = new Set((note.shares || []).map((s) => s.id));
    const body = h('div', { class: 'stack' });
    const render = () =>
      body.replaceChildren(
        ...(groups.length
          ? groups.map((g) => {
              const on = shared.has(g.id);
              const blocked = g.kind === 'iglesia' && g.role !== 'admin';
              return h(
                'button',
                {
                  class: `row-item share-row${on ? ' on' : ''}`,
                  disabled: blocked && !on,
                  onclick: async () => {
                    try {
                      const r = on ? await api.del(`/api/notes/${note.id}/share/${g.id}`) : await api.post(`/api/notes/${note.id}/share`, { groupId: g.id });
                      note.shares = r.shares;
                      shared.clear();
                      r.shares.forEach((s) => shared.add(s.id));
                      vibrate(10);
                      toast(on ? `Ya no se comparte con ${g.name}` : `Compartida con ${g.name}`);
                      render();
                      onChange?.();
                    } catch (e) {
                      toast(e.message, { error: true });
                    }
                  },
                },
                h('div', {}, h('b', {}, g.name), h('small', {}, blocked ? 'Solo quien administra puede compartir aquí' : `${KIND[g.kind]} · ${g.members} ${g.members === 1 ? 'persona' : 'personas'}`)),
                h('span', { class: 'share-check' }, on ? icon('check') : null),
              );
            })
          : [h('p', { class: 'muted' }, 'Aún no estás en ningún grupo.'), h('button', { class: 'btn primary', onclick: () => (close(), history.pushState({}, '', '/grupos'), dispatchEvent(new PopStateEvent('popstate'))) }, 'Crear un grupo')]),
      );
    render();
    return [h('h3', {}, 'Compartir prédica'), h('p', { class: 'muted', style: { margin: '0 0 10px' } }, 'Quien esté en el grupo verá esta prédica completa: resumen, versículos, devocional y Selah habla. Cada quien tiene su propia plática.'), body];
  });
}

/** Marcas disponibles para las imágenes: la mía y la de mis iglesias. */
export async function brandOptions() {
  const [me, groups] = await Promise.all([api.get('/api/me').catch(() => ({})), api.get('/api/groups').catch(() => [])]);
  return [
    { key: 'me', label: 'Mi marca', name: me.brand?.name || '', handle: me.brand?.handle || '', logoUrl: me.brand?.logo ? `/api/me/logo?v=${encodeURIComponent(me.brand.logo)}` : '' },
    ...groups
      .filter((g) => g.kind === 'iglesia')
      .map((g) => ({ key: `g${g.id}`, label: g.name, name: g.name, handle: g.brand?.handle || '', logoUrl: g.brand?.logo ? `/api/groups/${g.id}/logo?v=${encodeURIComponent(g.brand.logo)}` : '' })),
  ];
}
