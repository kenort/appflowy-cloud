-- Se ejecuta en cada arranque, antes de las migraciones de gotrue, con el
-- usuario dueño de la base de datos. psql recibe -v auth_pw=...
--
-- Neon ignora el search_path que se manda al conectar, y gotrue crea tipos sin
-- esquema que deben acabar en "auth". Por eso gotrue usa su propio rol con
-- search_path fijado en el servidor.

\set ON_ERROR_STOP on

-- Restos de arranques fallidos (solo si AppFlowy aún no se inicializó).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'af_user')
     AND NOT EXISTS (
       SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
       WHERE n.nspname = 'auth' AND r.rolname = 'gotrue_auth'
     ) THEN
    RAISE NOTICE 'limpiando restos de arranques anteriores';
    DROP SCHEMA IF EXISTS auth CASCADE;
    DROP TABLE IF EXISTS public.schema_migrations;
    DROP TYPE IF EXISTS public.factor_type, public.factor_status, public.aal_level,
      public.code_challenge_method, public.one_time_token_type CASCADE;
  END IF;
END $$;

SELECT format('CREATE ROLE gotrue_auth LOGIN PASSWORD %L', :'auth_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gotrue_auth') \gexec
SELECT format('ALTER ROLE gotrue_auth PASSWORD %L', :'auth_pw') \gexec

ALTER ROLE gotrue_auth SET search_path = auth;
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION gotrue_auth;
-- appflowy_cloud (dueño de la base) crea triggers y consulta auth.users
GRANT gotrue_auth TO CURRENT_USER;

SELECT 'estado: auth=' || (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'auth')
  || ' tablas_auth=' || (SELECT count(*) FROM pg_tables WHERE schemaname = 'auth')
  || ' af_user=' || EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'af_user')
  AS estado;
