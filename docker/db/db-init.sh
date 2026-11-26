#!/bin/sh
# Init do banco: roda em TODA subida (one-shot `db-init`), antes de auth, storage e realtime. Idempotente. O 1º
# passo é a guarda de segredos (preflight.sh); aqui só entra o que a imagem supabase/postgres não faz sozinha.
# Conecta como supabase_admin (o superusuário da imagem), pela rede do compose.
#
#   1. Senha dos papéis de LOGIN que os serviços usam. A imagem cria authenticator, supabase_auth_admin e
#      supabase_storage_admin SEM senha (o compose oficial dá a senha só no initdb). Aqui roda a cada subida, então
#      a senha segue o .env.
#   2. Papel supabase_realtime_admin. O esquema do Echo faz REVOKE/GRANT para ele e quebra se o papel não existir.
#      Quem cria é o Realtime; o bloco abaixo é cópia literal do dele (mesmo IF NOT EXISTS), então o Realtime
#      reconhece o papel e segue.
#   3. Schema _realtime (onde o Realtime self-host guarda os tenants).
#   4. Banco da zapo (seção 3.8 da SPEC): database `zapo` e papel `zapo` no MESMO Postgres, criados e mantidos aqui.
#      O papel separa os dados da zapo do resto, mas NÃO é fronteira de segurança (ele conecta em `postgres`, o
#      PUBLIC tem CONNECT, e o serviço qr já tem a service_role).
#
# NÃO faz: app.settings.jwt_secret (nada do Echo lê), banco _supabase (logflare/supavisor), webhooks.sql.
set -eu
export PGHOST="${PGHOST:-db}" PGPORT="${PGPORT:-5432}" PGDATABASE=postgres PGUSER=supabase_admin
export PGPASSWORD="$POSTGRES_PASSWORD"

i=0
until pg_isready -q; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "db-init: banco não respondeu em 60 s" >&2; exit 1; }
  sleep 1
done

# As senhas entram por \getenv (não aparecem em argv nem em log). psql lê o script do stdin.
psql -v ON_ERROR_STOP=1 --no-psqlrc -q <<'SQL'
\getenv pw POSTGRES_PASSWORD
\getenv zpw ZAPO_DB_PASSWORD

ALTER ROLE authenticator          WITH PASSWORD :'pw';
ALTER ROLE supabase_auth_admin    WITH PASSWORD :'pw';
ALTER ROLE supabase_storage_admin WITH PASSWORD :'pw';
ALTER ROLE postgres               WITH PASSWORD :'pw';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    CREATE ROLE supabase_realtime_admin;
    ALTER ROLE supabase_realtime_admin WITH NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
    ALTER ROLE supabase_realtime_admin SET search_path TO 'public', 'extensions', 'realtime';
    GRANT anon TO supabase_realtime_admin WITH INHERIT FALSE GRANTED BY supabase_admin;
    GRANT authenticated TO supabase_realtime_admin WITH INHERIT FALSE GRANTED BY supabase_admin;
    GRANT service_role TO supabase_realtime_admin WITH INHERIT FALSE GRANTED BY supabase_admin;
    GRANT SET ON PARAMETER log_min_messages TO supabase_realtime_admin;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS _realtime;
ALTER SCHEMA _realtime OWNER TO supabase_admin;

-- zapo: papel (sem superuser/createdb/createrole), senha sempre do .env, database próprio.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'zapo') THEN
    CREATE ROLE zapo LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE zapo WITH PASSWORD :'zpw';
SELECT 'CREATE DATABASE zapo OWNER zapo' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'zapo') \gexec
REVOKE ALL ON DATABASE zapo FROM PUBLIC;
SQL
echo "db-init: ok"
