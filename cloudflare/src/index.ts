import { DurableObject } from "cloudflare:workers";
import { Container, switchPort } from "@cloudflare/containers";

// Puertos dentro del contenedor (ver container/start.sh)
const APPFLOWY_PORT = 8000;
const GOTRUE_PORT = 9999;

export interface Env {
  BACKEND: DurableObjectNamespace<AppflowyBackend>;
  REQUEST_LOG: DurableObjectNamespace<RequestLog>;

  // Variables (wrangler.jsonc -> vars)
  APPFLOWY_BASE_URL: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  GOTRUE_DISABLE_SIGNUP: string;
  RUST_LOG: string;

  // Secretos (GitHub Actions -> wrangler secret)
  DATABASE_URL: string;
  GOTRUE_JWT_SECRET: string;
  GOTRUE_ADMIN_EMAIL: string;
  GOTRUE_ADMIN_PASSWORD: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  APPFLOWY_USERS?: string;
  AI_OPENAI_API_KEY?: string;
  DEBUG_TOKEN?: string;
}

// Neon añade channel_binding=require, que gotrue y sqlx no reconocen
// (lo envían a Postgres como parámetro y la conexión falla).
// Además el pooler de Neon (host "-pooler") descarta search_path, y las
// migraciones de gotrue crean tipos sin esquema que acaban en "public":
// siempre se usa la conexión directa.
function cleanDatabaseUrl(url: string, searchPath?: string): string {
  const u = new URL(url);
  u.hostname = u.hostname.replace("-pooler.", ".");
  u.searchParams.delete("channel_binding");
  u.searchParams.set("sslmode", "require");
  if (searchPath) u.searchParams.set("search_path", searchPath);
  return u.toString();
}

// Un solo contenedor con redis + gotrue + appflowy_cloud.
export class AppflowyBackend extends Container<Env> {
  defaultPort = APPFLOWY_PORT;
  requiredPorts = [APPFLOWY_PORT, GOTRUE_PORT];
  // Se apaga tras 15 min sin peticiones ni mensajes de websocket.
  sleepAfter = "15m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const baseUrl = env.APPFLOWY_BASE_URL.replace(/\/$/, "");
    this.envVars = {
      RUST_LOG: env.RUST_LOG,
      APPFLOWY_ENVIRONMENT: "production",
      APPFLOWY_BASE_URL: baseUrl,
      APPFLOWY_WEB_URL: baseUrl,
      APPFLOWY_DATABASE_URL: cleanDatabaseUrl(env.DATABASE_URL),
      APPFLOWY_DATABASE_REQUIRE_SSL: "true",
      APPFLOWY_DATABASE_MAX_CONNECTIONS: "10",
      APPFLOWY_REDIS_URI: "redis://127.0.0.1:6379",
      APPFLOWY_ACCESS_CONTROL: "true",
      APPFLOWY_GOTRUE_BASE_URL: `http://127.0.0.1:${GOTRUE_PORT}`,
      APPFLOWY_GOTRUE_JWT_SECRET: env.GOTRUE_JWT_SECRET,

      // R2 vía API compatible con S3
      APPFLOWY_S3_USE_MINIO: "true",
      APPFLOWY_S3_CREATE_BUCKET: "false",
      APPFLOWY_S3_MINIO_URL: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      APPFLOWY_S3_ACCESS_KEY: env.R2_ACCESS_KEY_ID,
      APPFLOWY_S3_SECRET_KEY: env.R2_SECRET_ACCESS_KEY,
      APPFLOWY_S3_BUCKET: env.R2_BUCKET,
      APPFLOWY_S3_REGION: "auto",

      AI_ENABLED: env.AI_OPENAI_API_KEY ? "true" : "false",
      AI_OPENAI_API_KEY: env.AI_OPENAI_API_KEY ?? "",

      // GoTrue
      PORT: String(GOTRUE_PORT),
      DATABASE_URL: cleanDatabaseUrl(env.DATABASE_URL, "auth"),
      GOTRUE_DB_DRIVER: "postgres",
      API_EXTERNAL_URL: `${baseUrl}/gotrue`,
      GOTRUE_SITE_URL: "appflowy-flutter://",
      GOTRUE_URI_ALLOW_LIST: "**",
      GOTRUE_JWT_SECRET: env.GOTRUE_JWT_SECRET,
      GOTRUE_JWT_EXP: "604800",
      GOTRUE_JWT_ADMIN_GROUP_NAME: "supabase_admin",
      GOTRUE_ADMIN_EMAIL: env.GOTRUE_ADMIN_EMAIL,
      GOTRUE_ADMIN_PASSWORD: env.GOTRUE_ADMIN_PASSWORD,
      GOTRUE_DISABLE_SIGNUP: env.GOTRUE_DISABLE_SIGNUP,
      // Sin SMTP: las cuentas se confirman solas.
      GOTRUE_MAILER_AUTOCONFIRM: "true",
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: "/gotrue/verify",
      GOTRUE_MAILER_URLPATHS_INVITE: "/gotrue/verify",
      GOTRUE_MAILER_URLPATHS_RECOVERY: "/gotrue/verify",
      GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: "/gotrue/verify",

      // "email:password,email2:password2" -> cuentas creadas al arrancar
      APPFLOWY_USERS: env.APPFLOWY_USERS ?? "",

      // Si existe, un arranque fallido sirve su log en /api/<token>/log.txt
      DEBUG_TOKEN: env.DEBUG_TOKEN ?? "",
    };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const log = env.REQUEST_LOG.getByName("main");

    if (env.DEBUG_TOKEN && url.pathname === `/api/${env.DEBUG_TOKEN}/requests`) {
      return Response.json(await log.list());
    }

    const { response, routed } = await route(request, url, env);
    // Peticiones fallidas o que el Worker no sabe a dónde mandar
    if (response.status >= 400 || !routed) {
      const copy = response.status !== 101 && response.body ? response.clone() : null;
      ctx.waitUntil(recordRequest(log, request, url, response.status, copy, routed));
    }
    return response;
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  url: URL,
  env: Env,
): Promise<{ response: Response; routed: boolean }> {
  const backend = env.BACKEND.getByName("main");

  // /gotrue/* -> gotrue (sin el prefijo), igual que nginx/nginx.conf
  if (url.pathname.startsWith("/gotrue/")) {
    const target = new URL(url);
    target.pathname = url.pathname.slice("/gotrue".length);
    const response = await backend.fetch(switchPort(new Request(target, request), GOTRUE_PORT));
    return { response, routed: true };
  }

  // Las apps recientes comprueban /api/health; este servidor lo tiene en /health
  if (url.pathname === "/api/health" || url.pathname === "/health") {
    const target = new URL(url);
    target.pathname = "/health";
    const response = await backend.fetch(switchPort(new Request(target, request), APPFLOWY_PORT));
    return { response, routed: true };
  }

  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) {
    return { response: await backend.fetch(switchPort(request, APPFLOWY_PORT)), routed: true };
  }

  return { response: new Response("AppFlowy Cloud", { status: 200 }), routed: false };
}

async function recordRequest(
  log: DurableObjectStub<RequestLog>,
  request: Request,
  url: URL,
  status: number,
  copy: Response | null,
  routed: boolean,
): Promise<void> {
  const body = copy ? (await copy.text()).slice(0, 500) : "";
  await log.record({
    time: new Date().toISOString(),
    method: request.method,
    path: url.pathname + url.search,
    status,
    routed,
    body,
  });
}

interface LoggedRequest {
  time: string;
  method: string;
  path: string;
  status: number;
  routed: boolean;
  body: string;
}

// Últimas 200 peticiones fallidas; se consultan en /api/<DEBUG_TOKEN>/requests
export class RequestLog extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)",
    );
  }

  async record(entry: LoggedRequest): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO requests (entry) VALUES (?)", JSON.stringify(entry));
    sql.exec("DELETE FROM requests WHERE id <= (SELECT max(id) - 200 FROM requests)");
  }

  async list(): Promise<LoggedRequest[]> {
    return this.ctx.storage.sql
      .exec<{ entry: string }>("SELECT entry FROM requests ORDER BY id DESC")
      .toArray()
      .map((row) => JSON.parse(row.entry));
  }
}
