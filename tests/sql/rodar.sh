#!/usr/bin/env bash
# Roda os testes SQL do primeiro acesso contra o banco de um stack do Echo no ar.
#
#   bash tests/sql/rodar.sh <projeto-compose>      # por exemplo: bash tests/sql/rodar.sh echo-sh-db
#
# Pré-condição: instalação vazia (nenhum super admin, nenhuma organização) e migrações aplicadas. O script confere e
# recusa rodar fora disso. Ele acha o container do banco pelos rótulos do compose (projeto + serviço `db`), então
# não depende do arquivo do compose nem de COMPOSE_FILE, e conecta como `postgres` com a senha do próprio container.
#
# Duas partes:
#   1. tests/sql/primeiro-acesso.sql: asserções determinísticas numa transação que termina em ROLLBACK.
#   2. corrida entre duas sessões (precisa de COMMIT): a sessão 1 conclui o setup e segura o COMMIT até a sessão 2
#      aparecer esperando o advisory lock em pg_locks; depois do COMMIT a sessão 2 tem de terminar com PT409.
#      Os dados da corrida são apagados no fim (trap), então o script pode rodar de novo.
#
# Exit 0 = todas as asserções passaram. Imprime "ASSERCAO ok|FALHOU <nome>" por asserção e o total no fim.
set -uo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "uso: bash tests/sql/rodar.sh <projeto-compose>" >&2
  exit 2
fi
PROJETO="$1"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DB="$(docker ps -q \
  --filter "label=com.docker.compose.project=${PROJETO}" \
  --filter "label=com.docker.compose.service=db" | head -n 1)"
if [ -z "$DB" ]; then
  echo "rodar.sh: nenhum container 'db' rodando no projeto compose '${PROJETO}'" >&2
  exit 2
fi

# psql dentro do container do banco, como postgres, sem mostrar a senha. Argumentos do psql vão como "$@".
psql_db() {
  docker exec -i "$DB" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U postgres -d postgres -X --no-psqlrc -v ON_ERROR_STOP=1 -P pager=off -q "$@"' psql "$@"
}
consulta() { psql_db -tA -c "$1"; }

if ! consulta "SELECT to_regprocedure('public.instalacao_concluir_setup(uuid,text)') IS NOT NULL" | grep -qx t; then
  echo "rodar.sh: a migração 20260102000000_primeiro_acesso não está aplicada neste banco" >&2
  exit 2
fi
if [ "$(consulta 'SELECT public.instalacao_precisa_setup()')" != "t" ]; then
  echo "rodar.sh: a instalação já está configurada (há super admin ou organização). Use um stack vazio." >&2
  exit 2
fi

OK=0
FALHAS=0
# registrar <nome> <detalhe-se-falhar> <comando...>: passa se o comando sair com 0.
registrar() {
  local nome="$1" detalhe="$2"
  shift 2
  if "$@"; then
    OK=$((OK + 1)); echo "ASSERCAO ok      $nome"
  else
    FALHAS=$((FALHAS + 1)); echo "ASSERCAO FALHOU  $nome  [$detalhe]"
  fi
}

# ---------------------------------------------------------------------------------------------------------------
# Parte 1: asserções determinísticas
# ---------------------------------------------------------------------------------------------------------------
SAIDA1="$(psql_db < "$AQUI/primeiro-acesso.sql" 2>&1)"
STATUS1=$?
if [ "$STATUS1" -ne 0 ]; then
  echo "$SAIDA1" >&2
  echo "rodar.sh: primeiro-acesso.sql terminou com erro (psql exit $STATUS1)" >&2
  exit 1
fi
LINHAS1="$(echo "$SAIDA1" | sed -n 's/^.*NOTICE:  \(ASSERCAO .*\)$/\1/p')"
if [ -z "$LINHAS1" ]; then
  echo "$SAIDA1" >&2
  echo "rodar.sh: primeiro-acesso.sql não emitiu nenhuma asserção" >&2
  exit 1
fi
echo "$LINHAS1"
# Guarda contra bloco DO que deixe de emitir asserções em silêncio: o número tem de bater com o do arquivo SQL.
ESPERADAS1=33
TOTAL1="$(echo "$LINHAS1" | grep -c '^ASSERCAO ')"
if [ "$TOTAL1" -ne "$ESPERADAS1" ]; then
  echo "rodar.sh: primeiro-acesso.sql emitiu ${TOTAL1} asserções, esperava ${ESPERADAS1} (atualize ESPERADAS1 se o arquivo mudou de propósito)" >&2
  exit 1
fi
OK=$((OK + $(echo "$LINHAS1" | grep -c '^ASSERCAO ok')))
FALHAS=$((FALHAS + $(echo "$LINHAS1" | grep -c '^ASSERCAO FALHOU')))

# ---------------------------------------------------------------------------------------------------------------
# Parte 2: corrida determinística entre duas sessões
# ---------------------------------------------------------------------------------------------------------------
UA='00000000-0000-4000-8000-0000000000c1'
UB='00000000-0000-4000-8000-0000000000d2'

limpar() {
  psql_db -c "
    DELETE FROM public.organization_members WHERE user_id IN ('$UA', '$UB');
    DELETE FROM public.organizations WHERE name IN ('Acme Corrida', 'Beta Corrida');
    DELETE FROM auth.users WHERE id IN ('$UA', '$UB');" >/dev/null 2>&1
}
trap limpar EXIT
limpar

psql_db -c "
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
    ('$UA', 'authenticated', 'authenticated', 'corrida-a@example.com', '{}', now(), now()),
    ('$UB', 'authenticated', 'authenticated', 'corrida-b@example.com', '{}', now(), now());" >/dev/null || {
  echo "rodar.sh: não consegui criar os usuários da corrida" >&2; exit 1; }

# Só o lock desta função conta (o Auth e outros podem segurar advisory locks próprios). Um advisory lock de bigint
# aparece em pg_locks como classid = 32 bits altos e objid = 32 bits baixos da chave.
CHAVE="((classid::bigint::numeric * 4294967296 + objid::bigint::numeric)
        = (hashtextextended('echo:primeiro-acesso', 0)::numeric
           + CASE WHEN hashtextextended('echo:primeiro-acesso', 0) < 0 THEN 18446744073709551616 ELSE 0 END))"

TMP="$(mktemp -d)"
trap 'limpar; rm -rf "$TMP"' EXIT

# Sessão 1: conclui, e só faz COMMIT depois de ver (em pg_locks) um advisory lock esperando. Limite de 30 s.
psql_db >"$TMP/s1.out" 2>"$TMP/s1.err" <<SQL &
BEGIN;
SELECT 'S1_CONCLUIU ' || (public.instalacao_concluir_setup('$UA', 'Acme Corrida') ->> 'organization_id');
DO \$\$
DECLARE
    v_limite timestamptz := clock_timestamp() + interval '30 seconds';
    v_viu boolean := false;
BEGIN
    WHILE clock_timestamp() < v_limite LOOP
        SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND $CHAVE) INTO v_viu;
        EXIT WHEN v_viu;
        PERFORM pg_sleep(0.05);
    END LOOP;
    IF NOT v_viu THEN
        RAISE EXCEPTION 'a sessão 2 nunca apareceu esperando o advisory lock';
    END IF;
END \$\$;
SELECT 'S1_VIU_ESPERA';
COMMIT;
SELECT 'S1_COMMIT';
SQL
PID1=$!

# Espera a sessão 1 segurar o lock (a transação dela aberta) antes de largar a sessão 2.
for _ in $(seq 1 100); do
  if [ "$(consulta "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND $CHAVE)")" = "t" ]; then break; fi
  sleep 0.1
done

# Sessão 2: tenta concluir com outro usuário enquanto a 1 ainda não fez commit; deve esperar e depois levar PT409.
psql_db >"$TMP/s2.out" 2>"$TMP/s2.err" <<SQL &
DO \$\$
BEGIN
    PERFORM public.instalacao_concluir_setup('$UB', 'Beta Corrida');
    RAISE NOTICE 'S2_SEM_ERRO';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'S2_SQLSTATE=%', SQLSTATE;
END \$\$;
SQL
PID2=$!

wait "$PID1"; STATUS_S1=$?
wait "$PID2"; STATUS_S2=$?

sessao1_ok() { [ "$STATUS_S1" -eq 0 ] && grep -q S1_VIU_ESPERA "$TMP/s1.out" && grep -q S1_COMMIT "$TMP/s1.out"; }
sessao2_pt409() { [ "$STATUS_S2" -eq 0 ] && grep -q 'S2_SQLSTATE=PT409' "$TMP/s2.err"; }
registrar "corrida: a sessão 1 terminou sem erro e viu a sessão 2 esperando o advisory lock" \
  "exit=$STATUS_S1 $(tr '\n' ' ' < "$TMP/s1.err")" sessao1_ok
registrar "corrida: a sessão 2 terminou com SQLSTATE PT409" \
  "exit=$STATUS_S2 $(tr '\n' ' ' < "$TMP/s2.err")" sessao2_pt409

ORGS="$(consulta "SELECT count(*) FROM public.organizations")"
registrar "corrida: exatamente 1 organização depois da corrida" "organizações=$ORGS" [ "$ORGS" = "1" ]
VENCEDOR="$(consulta "SELECT count(*) FROM public.profiles WHERE is_super_admin AND id = '$UA'")"
PERDEDOR="$(consulta "SELECT count(*) FROM public.profiles WHERE is_super_admin AND id = '$UB'")"
registrar "corrida: só o vencedor virou super admin" "vencedor=$VENCEDOR perdedor=$PERDEDOR" \
  [ "$VENCEDOR$PERDEDOR" = "10" ]
PRECISA="$(consulta 'SELECT public.instalacao_precisa_setup()')"
registrar "depois da corrida: instalacao_precisa_setup() = false" "precisa_setup=$PRECISA" [ "$PRECISA" = "f" ]

limpar
PRECISA="$(consulta 'SELECT public.instalacao_precisa_setup()')"
registrar "limpeza: instalação voltou a ficar vazia" "precisa_setup=$PRECISA" [ "$PRECISA" = "t" ]

echo "RESUMO ${OK} asserções ok, ${FALHAS} falhas"
[ "$FALHAS" -eq 0 ]
