#!/bin/sh
# Migrações do Echo + Vault. One-shot `migrate`: roda a cada `docker compose up` e sai 0. Usa a imagem do `db`
# (psql e as migrações em /echo/migrations, do mesmo build do esquema; `git pull` sem rebuild não aplica nada novo).
#
# Ordem (seção 2.3 da SPEC):
#   1. Vault ANTES das migrações: `CREATE EXTENSION IF NOT EXISTS supabase_vault` + os 4 segredos, para nenhum cron
#      achar o Vault vazio na 1ª subida (a migração de cron lê o Vault).
#   2. Migrações, em ordem de nome, uma vez cada, como o papel postgres (o mesmo do `supabase db push`, então os
#      objetos têm o mesmo dono). Cada arquivo roda com `psql --single-transaction` junto do INSERT do controle: ou
#      entra inteiro e registrado, ou nada. Controle: echo_meta.schema_migrations (version, name, checksum sha256,
#      applied_at), fora do PostgREST. Arquivo já aplicado com checksum diferente = exit 1 (migração aplicada não
#      se edita; mudança vai em arquivo novo).
#   3. O mesmo bloco do Vault (idempotente).
#   4. NOTIFY pgrst, 'reload schema'.
#
# Segredos do Vault: project_url, service_role_key e qr_service_url seguem o ambiente (cria, ou atualiza se mudou).
# ai_key_secret só cria: trocar tornaria ilegíveis as chaves de IA já cifradas (WARNING se divergir). Os valores
# entram por \getenv + \gset e nunca vão para argv nem para o log.
set -eu
export PGHOST="${PGHOST:-db}" PGPORT="${PGPORT:-5432}" PGDATABASE=postgres PGUSER=postgres
export PGPASSWORD="$POSTGRES_PASSWORD"
DIR="${MIGRATIONS_DIR:-/echo/migrations}"
PSQL="psql -v ON_ERROR_STOP=1 --no-psqlrc -q -X"

: "${PROJECT_URL:?}" "${SERVICE_ROLE_KEY:?}" "${QR_SERVICE_URL:?}" "${AI_KEY_SECRET:?}"

i=0
until pg_isready -q; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "migrate: banco não respondeu em 60 s" >&2; exit 1; }
  sleep 1
done

vault() {
  $PSQL <<'SQL'
\getenv project_url PROJECT_URL
\getenv service_role_key SERVICE_ROLE_KEY
\getenv qr_service_url QR_SERVICE_URL
\getenv ai_key_secret AI_KEY_SECRET
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
SELECT set_config('echo.s_project_url', :'project_url', false),
       set_config('echo.s_service_role_key', :'service_role_key', false),
       set_config('echo.s_qr_service_url', :'qr_service_url', false),
       set_config('echo.s_ai_key_secret', :'ai_key_secret', false) \gset x_
DO $$
DECLARE
    v_nome  text;
    v_valor text;
    v_id    uuid;
    v_atual text;
BEGIN
    FOREACH v_nome IN ARRAY ARRAY['project_url', 'service_role_key', 'qr_service_url', 'ai_key_secret'] LOOP
        v_valor := current_setting('echo.s_' || v_nome);
        SELECT id, decrypted_secret INTO v_id, v_atual FROM vault.decrypted_secrets WHERE name = v_nome;
        IF v_id IS NULL THEN
            PERFORM vault.create_secret(v_valor, v_nome, 'Echo self-host (migrate)');
            RAISE NOTICE 'vault: % criado', v_nome;
        ELSIF v_atual IS DISTINCT FROM v_valor THEN
            IF v_nome = 'ai_key_secret' THEN
                RAISE WARNING 'vault: ai_key_secret no banco difere do .env; mantido o do banco (trocar tornaria ilegíveis as chaves de IA)';
            ELSE
                PERFORM vault.update_secret(v_id, v_valor);
                RAISE NOTICE 'vault: % atualizado', v_nome;
            END IF;
        END IF;
    END LOOP;
END
$$;
SQL
}

$PSQL <<'SQL'
CREATE SCHEMA IF NOT EXISTS echo_meta;
REVOKE ALL ON SCHEMA echo_meta FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS echo_meta.schema_migrations (
    version    text PRIMARY KEY,
    name       text NOT NULL,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON echo_meta.schema_migrations FROM PUBLIC, anon, authenticated, service_role;
SQL

vault
echo "migrate: vault ok (antes das migrações)"

aplicadas=0; puladas=0
for f in $(ls "$DIR"/*.sql | sort); do
  nome=$(basename "$f")
  versao=${nome%%_*}
  soma=$(sha256sum "$f" | cut -d' ' -f1)
  # psql -c não interpola :'v'; vai por stdin
  atual=$(printf "SELECT checksum FROM echo_meta.schema_migrations WHERE version = :'v';\n" | $PSQL -tA -v v="$versao")
  if [ -n "$atual" ]; then
    if [ "$atual" != "$soma" ]; then
      echo "migrate: $nome já foi aplicada com outro conteúdo (checksum $atual, arquivo $soma). Migração aplicada não se edita: crie uma nova." >&2
      exit 1
    fi
    puladas=$((puladas + 1))
    continue
  fi
  echo "migrate: aplicando $nome"
  t0=$(date +%s)
  {
    cat "$f"
    printf "\n;\nINSERT INTO echo_meta.schema_migrations (version, name, checksum) VALUES (:'v', :'n', :'c');\n"
  } | $PSQL --single-transaction -v v="$versao" -v n="$nome" -v c="$soma"
  echo "migrate: $nome ok ($(( $(date +%s) - t0 )) s)"
  aplicadas=$((aplicadas + 1))
done
echo "migrate: $aplicadas aplicada(s), $puladas já estavam"

vault
echo "migrate: vault ok"
$PSQL -c "NOTIFY pgrst, 'reload schema'"
echo "migrate: concluído"
