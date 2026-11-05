# AppFlowy Cloud en Cloudflare

Despliegue del servidor AppFlowy Cloud (versión open source AGPL, archivada) en Cloudflare, pensado para un equipo pequeño. No hace falta VPS ni Docker en tu Mac.

```
App AppFlowy (escritorio/móvil)
        │  https://tu-dominio
        ▼
Worker "appflowy"  (cloudflare/src/index.ts)
   ├─ /gotrue/*  ──► contenedor :9999  gotrue (login)
   └─ /api, /ws  ──► contenedor :8000  appflowy_cloud (+ redis interno)
                              │
              Neon (Postgres) ┘└ R2 (archivos)
```

- **Contenedor único** (`container/Dockerfile`): redis + gotrue + appflowy_cloud, compilados desde el código fuente. No usa las imágenes de Docker Hub, que ahora son la versión comercial.
- **Se apaga solo** tras 15 min sin uso y arranca con la siguiente petición (tarda unos segundos).
- **GitHub Actions** (`.github/workflows/cloudflare-deploy.yml`) compila la imagen amd64, la sube al registro de Cloudflare y despliega.

## Qué no incluye

- **App web** (AppFlowy-Web): solo apps de escritorio y móvil, de momento.
- **Panel de administración** (`admin_frontend`) y **correo** (SMTP): las cuentas se crean con `APPFLOWY_USERS` y se confirman solas.
- **Chat de IA**: el servicio `appflowy_ai` es una imagen cerrada de AppFlowy. `AI_OPENAI_API_KEY` es opcional.

## 1. Neon (Postgres)

1. Crea un proyecto en <https://neon.tech> (plan Free), en la región más cercana a ti.
2. En **Connect**, copia la cadena de conexión:
   ```
   postgresql://usuario:clave@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require
   ```
   Será el secreto `DATABASE_URL`. Las tablas, el esquema `auth` y la extensión pgvector se crean solas en el primer arranque.

   No hace falta limpiarla. El Worker ya se ocupa de esto:
   - Usa siempre la conexión directa: quita `-pooler` del host.
   - Quita el parámetro `channel_binding`, que gotrue no entiende.
   - Crea un rol propio para gotrue (`gotrue_auth`) con `search_path=auth`, porque Neon ignora el `search_path` que se manda al conectar. Ver `container/prepare_db.sql`.

## 2. R2 (archivos)

1. En Cloudflare, ve a **R2 → Create bucket** y crea uno llamado `appflowy`.
2. Ve a **R2 → Manage API tokens → Create API token**, con permiso **Object Read & Write** limitado al bucket `appflowy`.
3. Guarda el **Access Key ID** y el **Secret Access Key**.

## 3. Token de API de Cloudflare

En **My Profile → API Tokens → Create Token**, usa la plantilla **Edit Cloudflare Workers**. Añade también **Account → Containers → Edit**, y en **Zone resources** elige la zona de tu dominio. Si al desplegar falta algún permiso, el log de Actions dice cuál.

Tu **Account ID** aparece en la barra lateral del panel de Cloudflare.

## 4. Repositorio en GitHub

Crea un repo **privado** y sube este código:

El clon es superficial (`--depth 1`) y GitHub no acepta un push así, por eso primero se descarga el historial completo:

```bash
cd /Users/kortiz/Documents/appflowy/AppFlowy-Cloud
git remote rename origin upstream
git fetch --unshallow upstream
git add -A && git commit -m "Deploy on Cloudflare Containers"
gh repo create appflowy-cloud --private --source . --push
```

En el repo, ve a **Settings → Secrets and variables → Actions**.

**Variables** (pestaña *Variables*):

| Nombre | Ejemplo |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `0123456789abcdef...` |
| `APPFLOWY_DOMAIN` | `appflowy.tudominio.com` (debe ser una zona de tu cuenta) |

**Secrets** (pestaña *Secrets*):

| Nombre | Valor |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token del paso 3 |
| `DATABASE_URL` | Cadena de Neon del paso 1 |
| `GOTRUE_JWT_SECRET` | Genera uno con `openssl rand -hex 32` |
| `GOTRUE_ADMIN_EMAIL` | Tu email de administrador |
| `GOTRUE_ADMIN_PASSWORD` | Una clave larga |
| `R2_ACCESS_KEY_ID` | Del paso 2 |
| `R2_SECRET_ACCESS_KEY` | Del paso 2 |
| `APPFLOWY_USERS` | `ana@x.com:clave1,luis@x.com:clave2` (cuentas de tus compañeros) |
| `AI_OPENAI_API_KEY` | Opcional |

El registro público está desactivado (`GOTRUE_DISABLE_SIGNUP` en `wrangler.jsonc`). Para añadir a alguien, agrégalo a `APPFLOWY_USERS` y vuelve a desplegar.

## 5. Desplegar

Ve a **Actions → Deploy to Cloudflare → Run workflow**. También se lanza solo con cada push a `main` que toque el servidor o `cloudflare/`.

La primera compilación de Rust tarda entre 40 y 60 min. Las siguientes usan caché y tardan menos.

Para comprobar que funciona:

```bash
curl https://appflowy.tudominio.com/api/server
curl https://appflowy.tudominio.com/gotrue/health
```

Los dos deben devolver JSON. La primera petición despierta el contenedor y puede tardar entre 10 y 30 s.

Cloudflare mantiene vivo el contenedor mientras recibe peticiones, así que después de desplegar puede seguir respondiendo la versión anterior hasta 15 min.

### Si el contenedor no arranca

Con el secreto opcional `DEBUG_TOKEN`, un arranque fallido no termina el contenedor. Durante 10 min sirve su log, con las claves ocultas, en:

```
https://appflowy.tudominio.com/api/<DEBUG_TOKEN>/log.txt
```

Sin ese secreto, el contenedor simplemente termina y Cloudflare lo reinicia.

Con `DEBUG_TOKEN` también hay otras herramientas:

| Ruta | Qué hace |
|---|---|
| `GET /api/<DEBUG_TOKEN>/server-log?chars=20000` | Final del log de redis, gotrue y appflowy_cloud (secretos y JWT ocultos) |
| `GET /api/<DEBUG_TOKEN>/requests` | Últimas 1000 peticiones fallidas (método, ruta, estado, `client-version`, inicio del cuerpo) |
| `POST /api/<DEBUG_TOKEN>/restart` | Reinicia el contenedor. Sirve para tomar una imagen recién desplegada cuando hay clientes conectados que no lo dejan dormir |

## 6. Conectar la app

**Usa AppFlowy 0.9.4** ([descargas](https://github.com/AppFlowy-IO/AppFlowy/releases/tag/0.9.4)) en escritorio y Android, y desactiva las actualizaciones automáticas.

Es la última versión compilada desde código público. Las versiones 0.10 en adelante se compilan con código privado de AppFlowy para su servidor comercial: llaman a APIs que este servidor no tiene (`/view/{id}/navigation`, `/server-info`…), y no se pueden crear ni guardar páginas. Los tags públicos de esas versiones apuntan casi al mismo commit, así que el código del repo no lo refleja. En iOS, la App Store solo ofrece la última versión, que no es compatible.

En la app, ve a **Ajustes → Cloud → AppFlowy Cloud Self-hosted**, pon `https://appflowy.tudominio.com`, reinicia la app e inicia sesión con email y contraseña. Si antes usaste una versión más nueva, borra primero sus datos locales.

## 7. Invitar a otras personas

1. Crea su cuenta en `APPFLOWY_USERS` y vuelve a desplegar. La persona inicia sesión una vez en la app.
2. En **Settings → Members**, copia el enlace de invitación (**Copy link**) y envíaselo.
3. La persona abre el enlace en el navegador, inicia sesión y acepta. Luego reinicia la app.

AppFlowy manda esos enlaces (y los del correo de invitación) a su app web, que no se despliega aquí. Por eso el Worker sirve su propia página para aceptar invitaciones (`src/invite_page.ts`). Las invitaciones por email se pueden aceptar en `https://appflowy.tudominio.com/invitaciones`.

Para compartir contenido, crea espacios con permiso **Público**.

## Logs y costes

```bash
cd cloudflare && npx wrangler tail
```

El contenedor `basic` (1 GiB, 1/4 vCPU) solo cobra mientras está encendido. Workers Paid incluye 25 GiB-h de memoria al mes:

- Unas 8 h diarias en días laborables (~176 h/mes) cuestan alrededor de 1–2 $ extra al mes.
- Encendido 24/7 cuesta unos 6–8 $ al mes.

Si ves errores de memoria, cambia `instance_type` a `standard-1` en `wrangler.jsonc`.
