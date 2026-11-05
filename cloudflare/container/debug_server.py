# Diagnóstico (solo con DEBUG_TOKEN). Sirve el log del contenedor con los
# secretos ocultos. Dos modos:
#   fail: el arranque falló; responde en 8000 y 9999 (/api/<token>/log.txt)
#         y termina a los 10 min para que Cloudflare reinicie el contenedor.
#   live: el servidor funciona; responde en 8001 (el Worker lo expone en
#         /api/<token>/server-log) y mantiene el log por debajo de 20 MB.
import hashlib
import http.server
import os
import re
import socket
import sys
import threading
import urllib.parse

LOG_PATH = "/tmp/start.log"
SECRET_VARS = [
    "DATABASE_URL", "APPFLOWY_DATABASE_URL", "GOTRUE_JWT_SECRET",
    "APPFLOWY_GOTRUE_JWT_SECRET", "GOTRUE_ADMIN_PASSWORD", "APPFLOWY_S3_ACCESS_KEY",
    "APPFLOWY_S3_SECRET_KEY", "AI_OPENAI_API_KEY", "APPFLOWY_USERS", "DEBUG_TOKEN", "AUTH_PW",
]

mode = sys.argv[1] if len(sys.argv) > 1 else "fail"
token = os.environ["DEBUG_TOKEN"]

secrets = [os.environ.get(v, "") for v in SECRET_VARS]
for entry in os.environ.get("APPFLOWY_USERS", "").split(","):
    secrets.append(entry.partition(":")[2])
# Clave del rol gotrue_auth (start.sh la deriva igual; en modo live aún no existe)
jwt_secret = os.environ.get("GOTRUE_JWT_SECRET", "")
secrets.append(hashlib.sha256(f"gotrue_auth:{jwt_secret}".encode()).hexdigest()[:48])
for var in ("DATABASE_URL", "APPFLOWY_DATABASE_URL"):
    password = urllib.parse.urlsplit(os.environ.get(var, "")).password or ""
    secrets += [password, urllib.parse.unquote(password)]
secrets = sorted(filter(lambda s: len(s) >= 4, secrets), key=len, reverse=True)


def read_log(max_chars):
    with open(LOG_PATH, encoding="utf-8", errors="replace") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - max_chars * 2))
        log = f.read()[-max_chars:]
    for s in secrets:
        log = log.replace(s, "***")
    # user:password@ en cualquier URL que haya quedado
    log = re.sub(r"://([^:/@\s]+):[^@\s]+@", r"://\1:***@", log)
    # JWT (sesiones de usuario en peticiones)
    return re.sub(r"eyJ[\w-]+\.[\w-]+\.[\w-]+", "<jwt>", log)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path in (f"/api/{token}/log.txt", f"/api/{token}/server-log"):
            # ?chars=N para ver más (por defecto 20000)
            query = dict(p.partition("=")[::2] for p in self.path.partition("?")[2].split("&") if p)
            chars = min(int(query.get("chars", "20000") or 20000), 500000)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(read_log(chars).encode())
        else:
            self.send_response(503)
            self.end_headers()

    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6  # "::" escucha también en IPv4


ports = (9999, 8000) if mode == "fail" else (8001,)
for port in ports:
    server = Server(("::", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

if mode == "fail":
    # Termina a los 10 min para que Cloudflare reinicie el contenedor (y tome
    # una versión nueva si se desplegó otra mientras tanto).
    threading.Event().wait(600)
    os._exit(1)

# tee escribe con O_APPEND, así que truncar desde aquí es seguro
while not threading.Event().wait(60):
    if os.path.getsize(LOG_PATH) > 20 * 1024 * 1024:
        with open(LOG_PATH, "r+") as f:
            f.truncate(0)
