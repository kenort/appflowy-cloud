#!/usr/bin/env bash
# Arranca redis -> gotrue -> appflowy_cloud dentro de un solo contenedor.
# Si cualquiera de los tres muere, el contenedor termina y Cloudflare lo reinicia.
set -euo pipefail

# Redis solo en memoria: cola de mensajes en tiempo real, los datos viven en Postgres.
redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no --maxmemory 128mb \
  --maxmemory-policy noeviction &
REDIS_PID=$!

cd /app/gotrue
echo "[start] gotrue: migraciones"
./auth migrate

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
  sleep 1
done

echo "[start] appflowy_cloud: arrancando en :${APPFLOWY_APPLICATION_PORT}"
cd /app
env -u DATABASE_URL -u PORT appflowy_cloud &
APPFLOWY_PID=$!

wait -n "$REDIS_PID" "$GOTRUE_PID" "$APPFLOWY_PID"
echo "[start] un proceso terminó, saliendo"
exit 1
