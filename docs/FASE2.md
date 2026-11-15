# Fase 2 — App Android (Play Store) con grabación en segundo plano

No está construida. La Fase 1 se diseñó para que este paso sea empaquetar, no reescribir.

## Qué ya quedó listo

1. **La app es estática + API REST.** `public/` no tiene compilación ni rutas de servidor; Capacitor
   puede empacarla tal cual (`webDir: public`) y apuntar la API a `https://selah.orbitix.app`.
2. **Grabadora detrás de una interfaz** (`public/js/recorder.js`): `start / pause / resume / stop → Blob /
   discard / level / elapsed / state`. En Android se reemplaza `WebRecorder` por un `NativeRecorder` con la
   misma forma; las vistas no cambian.
3. **Subida desacoplada:** `POST /api/notes` multipart acepta cualquier audio (m4a/AAC del grabador nativo
   incluido). El servidor normaliza con ffmpeg.
4. **Recuperación de grabaciones:** el patrón de fragmentos persistidos (IndexedDB) se replica en nativo
   escribiendo el archivo de forma incremental.
5. **Sesión por cookie HttpOnly** `SameSite=Lax`. Para la app nativa se agregará un token Bearer
   (misma tabla `sessions`) porque el WebView de Capacitor sirve desde `https://localhost`.

## Plan de trabajo

| Paso | Detalle |
|---|---|
| 1. Capacitor | `npm i @capacitor/core @capacitor/android`, `npx cap init Selah app.orbitix.selah --web-dir public`, `npx cap add android` |
| 2. API base | `api.js`: prefijo `API_BASE` (vacío en web, `https://selah.orbitix.app` en nativo); CORS solo para `https://localhost` y `capacitor://localhost` |
| 3. Auth nativa | `POST /api/login` devuelve también `token` cuando `X-Client: android`; guardado en `@capacitor/preferences`; middleware acepta `Authorization: Bearer` |
| 4. Grabación en segundo plano | Plugin propio (Kotlin): `ForegroundService` tipo `microphone` + notificación persistente con Pausa/Detener, `MediaRecorder` AAC 64 kbps mono, `PARTIAL_WAKE_LOCK`. Permisos: `RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS` (Android 13+). Expone `start/pause/resume/stop/getLevel/getElapsed` → `NativeRecorder` |
| 5. Subida robusta | `WorkManager` para subir al terminar aunque se cierre la app; reintentos con red disponible |
| 6. Play Store | Política de datos: el audio se envía al servidor propio y a los proveedores de transcripción/IA (declararlo en Data Safety). Declaración de servicio en primer plano de micrófono. Firma con Play App Signing, `targetSdk` vigente, ícono adaptativo desde `public/icons/maskable-512.png` |
| 7. Pruebas | Grabación de 60 min con pantalla apagada en 2 dispositivos (Samsung y Pixel por la gestión de batería), llamada entrante durante la grabación, pérdida de red al subir |

## Decisiones abiertas

- Nombre definitivo y `applicationId` (propuesto: `app.orbitix.selah`).
- Cuenta de Google Play Console (pago único de USD 25) a nombre de quién.
- ¿Multiusuario? Hoy es un solo usuario; la tabla `users` ya admite varios, pero las notas no tienen dueño (`user_id`). Agregarlo antes de abrir a más personas.
