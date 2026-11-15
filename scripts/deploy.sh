#!/usr/bin/env bash
# Instala o actualiza Selah en el droplet. Idempotente.
# - No toca otros servicios. nginx: respaldo + nginx -t + reload (nunca restart).
# - Cada despliegue es una carpeta nueva en /opt/selah/releases; "current" apunta a la activa.
# - Si la verificación de salud falla, vuelve sola a la versión anterior.
# Uso (desde una copia del repo en el servidor):  sudo bash scripts/deploy.sh
set -euo pipefail

DOMAIN="${DOMAIN:-selah.orbitix.app}"
APP=/opt/selah
DATA=/var/lib/selah
ETC=/etc/selah
ENVF=$ETC/selah.env
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TS=$(date +%Y%m%d-%H%M%S)
BK=/var/backups/selah
log() { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Ejecuta con sudo."
command -v node >/dev/null || die "Falta Node.js (>= 20)."
NODE=$(readlink -f "$(command -v node)")
case "$NODE" in /root/*|/home/*) die "Node está en $NODE (nvm de un usuario); el servicio no puede usarlo. Instala Node del sistema (p. ej. /usr/bin/node).";; esac
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node.js debe ser >= 20."
mkdir -p "$BK"

# --- Dependencias del sistema (solo si faltan) ---------------------------------
if ! command -v ffmpeg >/dev/null; then log "Instalando ffmpeg"; apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg; fi
if ! command -v yt-dlp >/dev/null; then
  log "Instalando yt-dlp en /usr/local/bin"
  curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && chmod 755 /usr/local/bin/yt-dlp
fi

# --- Usuario, carpetas y configuración ----------------------------------------
id selah >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin selah
install -d -o selah -g selah -m 750 "$DATA" "$DATA/backups"
install -d -m 755 "$APP/releases"
install -d -o root -g selah -m 750 "$ETC"
if [ ! -f "$ENVF" ]; then
  PORT=""
  for p in $(seq 3070 3099); do ss -ltn | grep -q ":$p " || { PORT=$p; break; }; done
  [ -n "$PORT" ] || die "No hay puertos libres entre 3070 y 3099."
  install -o root -g selah -m 640 /dev/null "$ENVF"
  cat > "$ENVF" <<EOF
# Selah — configuración. Este archivo NO va al repositorio.
PORT=$PORT
HOST=127.0.0.1
# Llaves (pon solo las que uses):
ANTHROPIC_API_KEY=
DEEPGRAM_API_KEY=
ELEVENLABS_API_KEY=
OPENAI_API_KEY=
# TRANSCRIBE_PROVIDER=deepgram   # deepgram | elevenlabs | openai (vacío = automático)
EOF
  log "Creado $ENVF (puerto $PORT)"
fi
PORT=$(grep -E '^PORT=' "$ENVF" | cut -d= -f2 || true)
[ -n "$PORT" ] || die "Falta PORT= en $ENVF"
grep -qE '^ANTHROPIC_API_KEY=.+' "$ENVF" || log "AVISO: falta ANTHROPIC_API_KEY en $ENVF"
grep -qE '^(DEEPGRAM|ELEVENLABS|OPENAI)_API_KEY=.+' "$ENVF" || log "AVISO: falta una llave de transcripción en $ENVF"

# --- Nueva versión -------------------------------------------------------------
REL="$APP/releases/$TS"
log "Copiando versión $TS"
mkdir -p "$REL"
tar -C "$SRC" --exclude=.git --exclude=node_modules --exclude=data/runtime --exclude=.env -cf - . | tar -C "$REL" -xf -
(cd "$REL" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$REL"

if [ -f "$DATA/selah.db" ]; then
  log "Respaldando base de datos antes de cambiar"
  sudo -u selah SELAH_DATA_DIR="$DATA" SELAH_ENV_FILE=/nonexistent "$NODE" "$REL/scripts/backup-db.js" "$DATA/backups" --keep 30 >/dev/null
fi

PREV=""; [ -L "$APP/current" ] && PREV=$(readlink -f "$APP/current")
ln -sfn "$REL" "$APP/current.new" && mv -T "$APP/current.new" "$APP/current"

sed "s#/usr/bin/env node#$NODE#" "$REL/deploy/selah.service" > /etc/systemd/system/selah.service
chmod 644 /etc/systemd/system/selah.service
install -m 644 "$REL/deploy/selah-backup.service" /etc/systemd/system/selah-backup.service
install -m 644 "$REL/deploy/selah-backup.timer" /etc/systemd/system/selah-backup.timer
systemctl daemon-reload
systemctl enable --now selah-backup.timer >/dev/null 2>&1
systemctl enable selah >/dev/null 2>&1
systemctl restart selah   # solo el servicio de Selah

log "Verificando salud en 127.0.0.1:$PORT"
ok=""
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
if [ -z "$ok" ]; then
  journalctl -u selah -n 30 --no-pager || true
  if [ -n "$PREV" ]; then log "Falló: regresando a la versión anterior"; ln -sfn "$PREV" "$APP/current"; systemctl restart selah
  else systemctl disable --now selah >/dev/null 2>&1 || true; fi
  die "La nueva versión no respondió."
fi
# Solo una versión sana se vuelve "anterior" de la siguiente.
[ -n "$PREV" ] && [ "$PREV" != "$REL" ] && echo "$PREV" > "$APP/.previous"

# --- nginx + certificado (solo la primera vez) ---------------------------------
if [ -d /etc/nginx/sites-available ]; then SITE=/etc/nginx/sites-available/$DOMAIN; LINK=/etc/nginx/sites-enabled/$DOMAIN
else SITE=/etc/nginx/conf.d/$DOMAIN.conf; LINK=""; fi

NGV=$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo 0.0.0)
render() {
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$1" > "$2"
  # nginx < 1.25.1 no entiende "http2 on;"
  if [ "$(printf '%s\n1.25.1\n' "$NGV" | sort -V | head -1)" != "1.25.1" ]; then
    sed -i -e '/^\s*http2 on;/d' -e 's/listen 443 ssl;/listen 443 ssl http2;/' -e 's/listen \[::\]:443 ssl;/listen [::]:443 ssl http2;/' "$2"
  fi
}
nginx_apply() { # $1 = plantilla
  local tmp; tmp=$(mktemp)
  render "$1" "$tmp"
  if [ -f "$SITE" ] && cmp -s "$tmp" "$SITE"; then rm -f "$tmp"; return 0; fi
  if [ ! -f "$BK/nginx-$TS.tgz" ]; then   # un respaldo por despliegue, tomado ANTES del primer cambio
    tar -czf "$BK/nginx-$TS.tgz" -C / etc/nginx
    log "Respaldo de nginx: $BK/nginx-$TS.tgz"
  fi
  local had=""; [ -f "$SITE" ] && { cp -a "$SITE" "$SITE.bak-$TS"; had=1; }
  install -m 644 "$tmp" "$SITE"; rm -f "$tmp"
  [ -n "$LINK" ] && ln -sfn "$SITE" "$LINK"
  if nginx -t 2>/dev/null; then systemctl reload nginx; log "nginx recargado (reload)"
  else
    nginx -t || true
    if [ -n "$had" ]; then mv -f "$SITE.bak-$TS" "$SITE"; else rm -f "$SITE"; [ -n "$LINK" ] && rm -f "$LINK"; fi
    die "nginx -t falló; se restauró la configuración anterior. No se recargó nada."
  fi
}

install -d -m 755 /var/www/selah-acme
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  command -v certbot >/dev/null || { apt-get update -qq && apt-get install -y -qq certbot; }
  nginx_apply "$REL/deploy/nginx-http.conf"
  log "Emitiendo certificado para $DOMAIN"
  certbot certonly --webroot -w /var/www/selah-acme -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email \
    --deploy-hook "nginx -t && systemctl reload nginx"
fi
nginx_apply "$REL/deploy/nginx-https.conf"

# Limpieza: conserva las 5 versiones más recientes.
ls -1dt "$APP"/releases/* | tail -n +6 | xargs -r rm -rf

curl -fsS --max-time 10 "https://$DOMAIN/api/health" && echo || log "AVISO: no pude verificar https://$DOMAIN desde el propio servidor (puede ser DNS/hairpin); revisa desde el teléfono."
log "Listo: https://$DOMAIN  (versión $TS, puerto $PORT)"
log "Revertir: sudo bash $APP/current/scripts/rollback.sh"
