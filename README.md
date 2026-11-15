# Selah — notas de prédicas

PWA en español para grabar (o subir, o traer de YouTube) una prédica y obtener:
transcripción con marcas de tiempo, resumen estructurado, versículos con su texto,
anuncios como agenda (copiables para WhatsApp), preguntas de célula, tarea semanal,
devocional de 5 días, frases para redes, reproductor sincronizado, carpetas,
búsqueda entre notas, chat por nota y exportación a PDF/WhatsApp.

Proyecto independiente: su propio repo, carpeta (`/opt/selah`), base de datos
(`/var/lib/selah/selah.db`), servicio (`selah.service`) y sitio nginx (`selah.orbitix.app`).

## Stack

| Capa | Elección |
|---|---|
| Servidor | Node.js ≥ 20 + Fastify 5 |
| Datos | SQLite (better-sqlite3) con FTS5 para búsqueda sin acentos |
| Transcripción | Deepgram Nova-3 · ElevenLabs Scribe · OpenAI Whisper (la primera llave disponible, o `TRANSCRIBE_PROVIDER`) |
| IA | Claude Opus 5.5, salida JSON con esquema estricto; chat con caché de la transcripción |
| Biblia | **Reina-Valera 1909, dominio público** (eBible.org `spaRV1909`), guardada localmente |
| Audio | ffmpeg (compresión Opus 24 kbps para transcribir; AAC si el navegador no reproduce el original), yt-dlp para YouTube |
| Frontend | HTML/CSS/JS sin compilación, PWA instalable, View Transitions, animaciones CSS + canvas |

## Desarrollo

```bash
npm install
npm test                       # 20 pruebas (API completa con proveedores simulados)
node scripts/create-user.js danny
npm run dev                    # http://127.0.0.1:3070  (COOKIE_SECURE=false para HTTP local)
```

Configuración por variables de entorno (ver `scripts/deploy.sh` → `/etc/selah/selah.env`):
`ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY` | `ELEVENLABS_API_KEY` | `OPENAI_API_KEY`, `PORT`,
`AI_EFFORT` (medium), `TRANSCRIBE_PROVIDER`.

## Producción (droplet)

```bash
sudo bash scripts/preflight.sh          # solo lee: stack, puertos, nginx, certificados, DNS y NOMBRES de llaves
sudo bash scripts/deploy.sh             # instala/actualiza; respaldo de nginx + nginx -t + reload
sudo -u selah SELAH_DATA_DIR=/var/lib/selah node /opt/selah/current/scripts/create-user.js danny
SELAH_URL=https://selah.orbitix.app SELAH_USER=danny SELAH_PASS=… node scripts/e2e.js   # prueba real de punta a punta
```

**Revertir en un comando:** `sudo bash /opt/selah/current/scripts/rollback.sh`
(versión anterior; si era la primera instalación, desinstala servicio y sitio nginx, conservando datos).
Opciones: `--restore-db`, `--uninstall`.

Respaldos: base de datos antes de cada despliegue y diario a las 03:40 (`selah-backup.timer`, 14 copias)
en `/var/lib/selah/backups`; configuración de nginx en `/var/backups/selah/`.

## Costo estimado por prédica de 45 min

| Concepto | Supuesto | USD |
|---|---|---|
| Transcripción | 45 min × $0.0043 (Deepgram) – $0.0067 (ElevenLabs) | 0.19 – 0.30 |
| Análisis Claude Opus 5.5 | ~15 k tokens entrada × $4/M + ~8 k salida (incl. razonamiento) × $20/M | ~0.22 |
| **Total** | | **≈ 0.40 – 0.55** |
| Cada pregunta del chat | transcripción en caché (lectura $0.20/M) | ~0.01 – 0.03 |

Cada nota guarda su costo real en `cost_json` (visible en la API).

## Fase 2

Ver [docs/FASE2.md](docs/FASE2.md).
