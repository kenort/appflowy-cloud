import { Container, switchPort } from "@cloudflare/containers";

// Puertos dentro del contenedor (ver container/start.sh)
const APPFLOWY_PORT = 8000;
const GOTRUE_PORT = 9999;

export interface Env {
  BACKEND: DurableObjectNamespace<AppflowyBackend>;

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
}

function withSearchPath(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set("search_path", schema);
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
      APPFLOWY_DATABASE_URL: env.DATABASE_URL,
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
      DATABASE_URL: withSearchPath(env.DATABASE_URL, "auth"),
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
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const backend = env.BACKEND.getByName("main");

    // /gotrue/* -> gotrue (sin el prefijo), igual que nginx/nginx.conf
    if (url.pathname.startsWith("/gotrue/")) {
      url.pathname = url.pathname.slice("/gotrue".length);
      return backend.fetch(switchPort(new Request(url, request), GOTRUE_PORT));
    }

    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) {
      return backend.fetch(switchPort(request, APPFLOWY_PORT));
    }

    return new Response("AppFlowy Cloud", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
