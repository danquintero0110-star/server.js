#!/usr/bin/env bash
# Revisión del droplet ANTES de instalar Selah. Solo lee; no cambia nada.
# Nunca imprime valores de llaves: solo el NOMBRE de la variable y el archivo donde está.
# Uso: sudo bash scripts/preflight.sh [dominio]
set -uo pipefail
DOMAIN="${1:-selah.orbitix.app}"
hr() { printf '\n== %s\n' "$1"; }

hr "Sistema"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "CPU: $(nproc) · RAM: $(free -h | awk '/Mem:/{print $2" total, "$7" libre"}') · Disco libre: $(df -h / | awk 'NR==2{print $4}')"

hr "Herramientas"
for b in node npm pm2 docker nginx certbot ffmpeg ffprobe yt-dlp sqlite3 git; do
  if command -v "$b" >/dev/null 2>&1; then
    v=$("$b" --version 2>&1 | head -1); [ "$b" = nginx ] && v=$(nginx -v 2>&1)
    printf '  %-8s %s\n' "$b" "$v"
  else printf '  %-8s (no instalado)\n' "$b"; fi
done

hr "Cómo corren los otros proyectos"
systemctl list-units --type=service --state=running --no-pager 2>/dev/null | grep -Ei 'node|pm2|docker|gunicorn|uvicorn|axon|orbitix|maker|casa' || echo "  (sin servicios con nombres conocidos)"
command -v pm2 >/dev/null && { echo "  pm2:"; pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s).forEach(p=>console.log("   -",p.name,p.pm2_env.status,p.pm2_env.pm_cwd))}catch{console.log("   (sin procesos pm2 para root)")}})'; }
command -v docker >/dev/null && docker ps --format '  docker: {{.Names}} {{.Image}} {{.Ports}}' 2>/dev/null

hr "Puertos en uso (TCP, escucha)"
ss -ltnp 2>/dev/null | awk 'NR>1{print "  "$4" "$6}' | sort -u
for p in $(seq 3070 3099); do ss -ltn | grep -q ":$p " || { echo "  Primer puerto libre desde 3070: $p"; break; }; done

hr "nginx"
nginx -t 2>&1 | sed 's/^/  /'
ls /etc/nginx/sites-enabled 2>/dev/null | sed 's/^/  sites-enabled: /'
ls /etc/nginx/conf.d 2>/dev/null | sed 's/^/  conf.d: /'
grep -rl "server_name[^;]*$DOMAIN" /etc/nginx 2>/dev/null | sed 's/^/  ya existe config para el dominio: /'

hr "Certificados"
ls /etc/letsencrypt/live 2>/dev/null | sed 's/^/  /' || echo "  (sin /etc/letsencrypt/live)"
systemctl list-timers --no-pager 2>/dev/null | grep -i certbot | sed 's/^/  /'

hr "DNS"
MYIP=$(curl -s -4 --max-time 5 https://ifconfig.me || hostname -I | awk '{print $1}')
DNSIP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
echo "  IP del droplet: $MYIP · $DOMAIN → ${DNSIP:-NO RESUELVE}"
[ -n "$DNSIP" ] && [ "$DNSIP" = "$MYIP" ] && echo "  OK" || echo "  ATENCIÓN: el registro A debe apuntar a $MYIP"

hr "Llaves de transcripción e IA (solo nombres)"
KEYS='ANTHROPIC_API_KEY|OPENAI_API_KEY|DEEPGRAM_API_KEY|ELEVENLABS_API_KEY|ASSEMBLYAI_API_KEY|GROQ_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY'
found=0
while IFS= read -r f; do
  grep -oE "^\s*(export\s+)?($KEYS)\s*=" "$f" 2>/dev/null | sed -E 's/^\s*(export\s+)?//; s/\s*=$//' | sort -u | while read -r k; do
    echo "  $k  →  $f"
  done
  found=1
done < <(find /etc /opt /srv /var/www /root /home -maxdepth 5 \( -name '*.env' -o -name '.env' -o -name '.env.*' -o -name 'ecosystem.config.*' \) -type f 2>/dev/null | grep -v node_modules)
for k in ANTHROPIC_API_KEY OPENAI_API_KEY DEEPGRAM_API_KEY ELEVENLABS_API_KEY; do
  [ -n "${!k:-}" ] && echo "  $k  →  entorno de esta sesión"
done
echo "  (fin de la lista)"
