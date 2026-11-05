#!/usr/bin/env bash
# Arranca redis -> gotrue -> appflowy_cloud dentro de un solo contenedor.
# Si cualquiera de los tres muere, el contenedor termina y Cloudflare lo reinicia
# (o, con DEBUG_TOKEN, se queda sirviendo el log; ver debug_server.py).
set -uo pipefail

exec > >(tee -a /tmp/start.log) 2>&1

fail() {
  echo "[start] ERROR: $*"
  if [ -n "${DEBUG_TOKEN:-}" ]; then
    echo "[start] modo diagnóstico: sirviendo el log"
    exec python3 /app/debug_server.py
  fi
  exit 1
}

if [ -n "${DEBUG_TOKEN:-}" ]; then
  python3 /app/debug_server.py live &
fi

# Redis solo en memoria: cola de mensajes en tiempo real, los datos viven en Postgres.
redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no --maxmemory 128mb \
  --maxmemory-policy noeviction &
REDIS_PID=$!

# gotrue usa su propio rol (gotrue_auth) con search_path=auth fijado en
# Postgres; ver prepare_db.sql. La clave se deriva del JWT secret.
echo "[start] preparando base de datos"
export AUTH_PW
AUTH_PW=$(printf '%s' "gotrue_auth:${GOTRUE_JWT_SECRET}" | sha256sum | cut -c1-48)
psql "$APPFLOWY_DATABASE_URL" -X -q -v auth_pw="$AUTH_PW" -f /app/prepare_db.sql \
  || fail "preparar base de datos"
DATABASE_URL=$(python3 -c '
import os, urllib.parse as u
p = u.urlsplit(os.environ["DATABASE_URL"])
host = p.hostname + (":%d" % p.port if p.port else "")
print(u.urlunsplit(p._replace(netloc="gotrue_auth:" + os.environ["AUTH_PW"] + "@" + host)))
') || fail "URL de gotrue"
export DATABASE_URL

cd /app/gotrue
echo "[start] gotrue: migraciones"
./auth migrate || fail "gotrue migrate"

if [ -n "${GOTRUE_ADMIN_EMAIL:-}" ] && [ -n "${GOTRUE_ADMIN_PASSWORD:-}" ]; then
  ./auth admin createuser --admin --confirm "$GOTRUE_ADMIN_EMAIL" "$GOTRUE_ADMIN_PASSWORD" 2>&1 \
    | grep -v "user already exists" || true
fi

# APPFLOWY_USERS="ana@x.com:clave1,luis@x.com:clave2"
IFS=',' read -ra USERS <<< "${APPFLOWY_USERS:-}"
for entry in "${USERS[@]}"; do
  [ -z "$entry" ] && continue
  email="${entry%%:*}"
  password="${entry#*:}"
  ./auth admin createuser --confirm "$email" "$password" 2>&1 \
    | grep -v "user already exists" || true
done

echo "[start] gotrue: arrancando en :${PORT}"
./auth &
GOTRUE_PID=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null && break
  kill -0 "$GOTRUE_PID" 2>/dev/null || fail "gotrue terminó al arrancar"
  sleep 1
done

echo "[start] appflowy_cloud: arrancando en :${APPFLOWY_APPLICATION_PORT}"
cd /app
env -u DATABASE_URL -u PORT appflowy_cloud &
APPFLOWY_PID=$!

wait -n "$REDIS_PID" "$GOTRUE_PID" "$APPFLOWY_PID"
kill "$REDIS_PID" "$GOTRUE_PID" "$APPFLOWY_PID" 2>/dev/null
wait 2>/dev/null
fail "un proceso terminó"
