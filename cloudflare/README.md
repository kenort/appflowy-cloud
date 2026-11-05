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

## 6. Conectar la app

En la app AppFlowy, ve a **Ajustes → Cloud → AppFlowy Cloud Self-hosted**, pon `https://appflowy.tudominio.com`, reinicia la app e inicia sesión con email y contraseña.

Este servidor dejó de actualizarse en septiembre de 2026. Si una versión nueva de la app no conecta, usa una versión de la app de esa época.

## Logs y costes

```bash
cd cloudflare && npx wrangler tail
```

El contenedor `basic` (1 GiB, 1/4 vCPU) solo cobra mientras está encendido. Workers Paid incluye 25 GiB-h de memoria al mes:

- Unas 8 h diarias en días laborables (~176 h/mes) cuestan alrededor de 1–2 $ extra al mes.
- Encendido 24/7 cuesta unos 6–8 $ al mes.

Si ves errores de memoria, cambia `instance_type` a `standard-1` en `wrangler.jsonc`.
