# Modo diagnóstico temporal: si el arranque falla, sirve el log (con secretos
# ocultos) en /api/<DEBUG_TOKEN>/log.txt por los puertos 8000 y 9999.
import http.server
import os
import re
import socket
import threading

SECRET_VARS = [
    "DATABASE_URL", "APPFLOWY_DATABASE_URL", "GOTRUE_JWT_SECRET",
    "APPFLOWY_GOTRUE_JWT_SECRET", "GOTRUE_ADMIN_PASSWORD", "APPFLOWY_S3_ACCESS_KEY",
    "APPFLOWY_S3_SECRET_KEY", "AI_OPENAI_API_KEY", "APPFLOWY_USERS", "DEBUG_TOKEN",
]

token = os.environ["DEBUG_TOKEN"]
log = open("/tmp/start.log", encoding="utf-8", errors="replace").read()

secrets = [os.environ.get(v, "") for v in SECRET_VARS]
for entry in os.environ.get("APPFLOWY_USERS", "").split(","):
    secrets.append(entry.partition(":")[2])
for s in sorted(filter(lambda s: len(s) >= 4, secrets), key=len, reverse=True):
    log = log.replace(s, "***")
# user:password@ en cualquier URL que haya quedado
log = re.sub(r"://([^:/@\s]+):[^@\s]+@", r"://\1:***@", log)

body = log[-20000:].encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] == f"/api/{token}/log.txt":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(503)
            self.end_headers()

    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6  # "::" escucha también en IPv4


for port in (9999, 8000):
    server = Server(("::", port), Handler)
    t = threading.Thread(target=server.serve_forever)
    t.start()
t.join()
