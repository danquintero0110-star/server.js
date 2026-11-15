#!/usr/bin/env bash
# Revertir Selah en un comando:  sudo bash /opt/selah/current/scripts/rollback.sh
#   (sin opciones)  → vuelve a la versión anterior; si es la primera, desinstala.
#   --uninstall     → quita servicio y sitio de nginx (datos y respaldos se conservan).
#   --restore-db    → además restaura el respaldo de base de datos más reciente.
# Nunca reinicia nginx ni otros servicios: solo nginx -t + reload.
set -euo pipefail
APP=/opt/selah
DATA=/var/lib/selah
DOMAIN="${DOMAIN:-selah.orbitix.app}"
TS=$(date +%Y%m%d-%H%M%S)
log() { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Ejecuta con sudo." >&2; exit 1; }

uninstall() {
  log "Desinstalando Selah (los datos quedan en $DATA)"
  systemctl disable --now selah selah-backup.timer 2>/dev/null || true
  rm -f /etc/systemd/system/selah.service /etc/systemd/system/selah-backup.{service,timer}
  systemctl daemon-reload
  mkdir -p /var/backups/selah
  tar -czf "/var/backups/selah/nginx-before-uninstall-$TS.tgz" -C / etc/nginx
  rm -f "/etc/nginx/sites-enabled/$DOMAIN" "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/conf.d/$DOMAIN.conf"
  if nginx -t 2>/dev/null; then systemctl reload nginx; log "nginx recargado"; else
    log "nginx -t falló; restaurando respaldo"; tar -xzf "/var/backups/selah/nginx-before-uninstall-$TS.tgz" -C /; fi
  log "Hecho. Para borrar también los datos: rm -rf $APP $DATA /etc/selah"
}

restore_db() {
  local last; last=$(ls -1t "$DATA"/backups/selah-*.db 2>/dev/null | head -1 || true)
  [ -n "$last" ] || { log "No hay respaldos de base de datos"; return; }
  systemctl stop selah || true
  cp -a "$DATA/selah.db" "$DATA/backups/before-restore-$TS.db" 2>/dev/null || true
  rm -f "$DATA/selah.db-wal" "$DATA/selah.db-shm"
  install -o selah -g selah -m 640 "$last" "$DATA/selah.db"
  log "Base de datos restaurada desde $last"
}

case "${1:-}" in
  --uninstall) uninstall; exit 0 ;;
esac

PREV=$(cat "$APP/.previous" 2>/dev/null || true)
CUR=$(readlink -f "$APP/current" 2>/dev/null || true)
if [ -z "$PREV" ] || [ ! -d "$PREV" ] || [ "$PREV" = "$CUR" ]; then
  log "No hay versión anterior: esta fue la primera instalación."
  uninstall
  exit 0
fi
[ "${1:-}" = "--restore-db" ] && restore_db
ln -sfn "$PREV" "$APP/current"
echo "$CUR" > "$APP/.previous"
systemctl restart selah
sleep 2
systemctl is-active --quiet selah && log "Selah volvió a $(basename "$PREV")" || { journalctl -u selah -n 20 --no-pager; exit 1; }
