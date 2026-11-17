# Planes y cobros (preparado, sin pasarela todavía)

## Cómo funciona hoy
Cada cuenta tiene `plan`, `paid_until` (fecha) y `status` (activa o en pausa). Se editan en **⋯ → Cuentas → Editar**.

| Situación | Qué ve la persona | Qué puede hacer |
|---|---|---|
| Sin fecha de pago | nada | todo (familia, cortesía) |
| Faltan 3 días o menos | aviso "tu plan vence en N días" | todo |
| Venció, dentro de los días de gracia (5, `BILLING_GRACE_DAYS`) | aviso "renueva en N días" | todo |
| Venció y pasó la gracia, o cuenta en pausa | aviso "plan en pausa" | ver, escuchar, buscar y copiar sus notas, cambiar contraseña |

**Se pausa (cuesta dinero):** crear notas nuevas (grabar, subir, YouTube), volver a transcribir o analizar, preguntas a la IA, enfoques, voz de Selah, conversar por voz y generar PDF. La lista está en `src/lib/billing.js` → `BILLABLE`.

**No se pausa:** ver notas, transcripción, versículos, audio, búsqueda, copiar texto para WhatsApp, grupos, borrar sus notas. Así los datos siguen siendo de la persona y le conviene regresar a pagar.

Los administradores nunca se bloquean. La respuesta del servidor al bloquear es HTTP 402 con un mensaje en español.

## Para comercializar (pendiente)
1. Elegir pasarela: Stripe (tarjetas, suscripciones automáticas) o Mercado Pago (OXXO, tarjetas en México).
2. Agregar un endpoint `POST /api/billing/webhook` que verifique la firma de la pasarela y, al confirmarse un pago, mueva `paid_until` (+1 mes o +1 año). No hace falta nada más: el bloqueo y el aviso ya se calculan con esa fecha.
3. Registro público con prueba gratis (p. ej. 14 días = `paid_until` de hoy + 14).
4. Límites por plan (minutos de audio al mes) usando `cost_json` de cada nota, que ya guarda el costo real.
5. Aviso por notificación 3 días antes de vencer (los recordatorios push ya existen).
6. Aviso de privacidad y términos antes de cobrar.
