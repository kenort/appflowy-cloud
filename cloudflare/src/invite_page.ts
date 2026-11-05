// Página para aceptar invitaciones a un espacio de trabajo. Reemplaza las
// pantallas de AppFlowy-Web (que no desplegamos) a las que apuntan:
//   - el enlace de invitación de la app:  /app/invited/<code>
//   - el enlace del correo de invitación: /accept-invitation?invited_id=<id>
//   - sin parámetros (/invitaciones): lista las invitaciones pendientes
// Inicia sesión contra gotrue y llama a la API de appflowy_cloud del mismo origen.

export function isInvitePath(pathname: string): boolean {
  return (
    pathname.startsWith("/app/invited/") ||
    pathname === "/accept-invitation" ||
    pathname === "/invitaciones"
  );
}

export function invitePage(): Response {
  return new Response(HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unirse al espacio de trabajo</title>
<style>
  :root { --bg: #f6f7f9; --card: #fff; --text: #1f2328; --muted: #656d76; --accent: #00b5ff;
          --border: #d0d7de; --ok: #1a7f37; --err: #cf222e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d1117; --card: #161b22; --text: #e6edf3; --muted: #8d96a0;
            --border: #30363d; --ok: #3fb950; --err: #f85149; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
         background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--border);
         border-radius: 12px; padding: 28px; }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: var(--muted); }
  label { display: block; font-size: .9rem; margin: 12px 0 4px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
          background: transparent; color: var(--text); font: inherit; }
  button { width: 100%; margin-top: 20px; padding: 10px; border: 0; border-radius: 8px;
           background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  #msg { margin-top: 16px; }
  .ok { color: var(--ok); } .err { color: var(--err); }
  ul { list-style: none; padding: 0; margin: 16px 0 0; }
  li { border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 8px; }
  li button { margin-top: 8px; }
</style>
</head>
<body>
<main>
  <h1>Unirse a un espacio de trabajo</h1>
  <p id="intro">Inicia sesión con tu cuenta de AppFlowy para aceptar la invitación.</p>
  <form id="form">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" required>
    <label for="password">Contraseña</label>
    <input id="password" type="password" autocomplete="current-password" required>
    <button id="submit" type="submit">Aceptar invitación</button>
  </form>
  <ul id="list"></ul>
  <div id="msg" role="status"></div>
</main>
<script>
const params = new URLSearchParams(location.search);
const code = location.pathname.startsWith("/app/invited/")
  ? decodeURIComponent(location.pathname.split("/").pop()) : "";
const invitedId = params.get("invited_id") || "";
const msg = document.getElementById("msg");
const list = document.getElementById("list");
let token = "";

if (!code && !invitedId) {
  document.getElementById("intro").textContent =
    "Inicia sesión para ver las invitaciones pendientes de tu cuenta.";
  document.getElementById("submit").textContent = "Ver invitaciones";
}

function show(text, cls) { msg.textContent = text; msg.className = cls || ""; }

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(json.message || ("Error " + res.status));
  }
  return json.data;
}

function done() {
  document.getElementById("form").hidden = true;
  list.textContent = "";
  show("Listo, ya eres miembro. Cierra y vuelve a abrir AppFlowy: el espacio de trabajo " +
       "aparecerá en el selector de arriba a la izquierda.", "ok");
}

async function accept(id) {
  show("Aceptando…");
  try { await api("POST", "/api/workspace/accept-invite/" + id); done(); }
  catch (e) { show("No se pudo aceptar: " + e.message, "err"); }
}

document.getElementById("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const button = document.getElementById("submit");
  button.disabled = true;
  show("Iniciando sesión…");
  try {
    const res = await fetch("/gotrue/token?grant_type=password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("email").value.trim(),
        password: document.getElementById("password").value,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("email o contraseña incorrectos");
    token = json.access_token;

    if (code) {
      await api("POST", "/api/workspace/join-by-invite-code", { code });
      return done();
    }
    if (invitedId) return accept(invitedId);

    const invites = (await api("GET", "/api/workspace/invite") || [])
      .filter((i) => i.status === "Pending");
    list.textContent = "";
    if (!invites.length) return show("No tienes invitaciones pendientes.");
    show("");
    for (const inv of invites) {
      const li = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = inv.workspace_name || "Espacio de trabajo";
      const from = document.createElement("div");
      from.textContent = "Invita: " + (inv.inviter_name || inv.inviter_email || "—");
      const b = document.createElement("button");
      b.textContent = "Aceptar";
      b.onclick = () => accept(inv.invite_id);
      li.append(name, from, b);
      list.append(li);
    }
  } catch (e) {
    show("Error: " + e.message + ". Si es tu primera vez, inicia sesión antes en la app.", "err");
  } finally {
    button.disabled = false;
  }
});
</script>
</body>
</html>`;
