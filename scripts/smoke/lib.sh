#!/usr/bin/env bash
# Funções comuns da fumaça ponta a ponta (scripts/smoke-selfhost.sh). Só é lido por `source`; quem chama define
# REPO, TMP, ENVF, SMOKE_PROJECT, BASE, SMOKE_HTTP_PORT, SMOKE_HTTPS_PORT e SMOKE_MAILPIT_PORT antes de usar.
# shellcheck shell=bash

SMOKE_N_OK=0

# Chamadas ao stack a partir do servidor, pela rede do compose, onde estão as variáveis certas.
# Cron que chama função ou o qr a cada minuto SEM depender de dados (lista fixada na 1ª execução da fumaça, medida em
# 4 minutos de stack novo, sem linha de WhatsApp conectada). Cada item: nome|trecho do corpo da resposta no
# net._http_response (a tabela não guarda a URL, então o corpo é a identidade).
#   process-survey-timeouts -> POST gateway:8000/functions/v1/survey-timeout-execute  -> {"success":true,"processed":0}
#   qr-service-health       -> GET  qr:3000/health (direto, sem o gateway)            -> {"status":"ok","version":…}
# Os demais jobs de minuto (broadcasts, mensagens agendadas, alertas de falha) só chamam função quando há dado.
# shellcheck disable=SC2034  # usado por scripts/smoke-selfhost.sh
SMOKE_CRON_URLS=(
  'process-survey-timeouts|"success":true,"processed":'
  'qr-service-health|"status":"ok"'
)

# Segredos que nunca podem aparecer em log (passo 0 e 16). Nomes das variáveis do .env.
# shellcheck disable=SC2034
SMOKE_SEGREDOS_DE_LOG=(SERVICE_ROLE_KEY QR_WEBHOOK_SECRET JWT_SECRET)

log() { printf '[smoke] %s\n' "$*"; }

ok() {
  SMOKE_N_OK=$((SMOKE_N_OK + 1))
  printf 'OK %s\n' "$1"
}

falhou() {
  printf 'FALHOU %s: %s\n' "$1" "${2:-sem detalhe}" >&2
  exit 1
}

# igual NOME OBTIDO ESPERADO
igual() {
  [ "$2" = "$3" ] || falhou "$1" "obtido '$2', esperado '$3'"
  ok "$1"
}

# contem NOME TEXTO TRECHO
contem() {
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) falhou "$1" "não contém '$3' (obtido: ${2:0:200})" ;;
  esac
}

# nao_contem NOME TEXTO TRECHO
nao_contem() {
  case "$2" in
    *"$3"*) falhou "$1" "contém '$3'" ;;
    *) ok "$1" ;;
  esac
}

# dc ARGS...: docker compose do stack da fumaça (sempre da pasta do repo: o COMPOSE_FILE do .env é relativo a ela).
dc() {
  (cd "$REPO" && docker compose --env-file "$ENVF" -p "$SMOKE_PROJECT" "$@")
}

# dcenv ARQUIVO_ENV PROJETO ARGS...: o mesmo para outro .env e outro projeto (passos 0 e 20).
dcenv() {
  local arq=$1 projeto=$2
  shift 2
  (cd "$REPO" && docker compose --env-file "$arq" -p "$projeto" "$@")
}

# lenv ARQUIVO CHAVE: valor da chave no .env (sem aspas).
lenv() {
  awk -F= -v k="$2" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$1"
}

# senv ARQUIVO CHAVE VALOR: troca (ou acrescenta) a chave no .env, sem tocar nas outras.
senv() {
  local arq=$1 chave=$2 valor=$3 tmp
  tmp=$(mktemp "$arq.XXXXXX")
  awk -v k="$chave" -v v="$valor" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; f = 1; next } { print } END { if (!f) print k "=" v }' "$arq" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$arq"
}

# json EXPR: lê JSON do stdin e imprime o caminho (a.b[0]).
json() {
  node "$REPO/scripts/smoke/json.mjs" "$1"
}

# status URL [ARGS_CURL...]: só o código HTTP (--path-as-is: o curl não "limpa" ../ e //).
status() {
  local url=$1
  shift
  curl -s --path-as-is -o /dev/null -w '%{http_code}' --max-time 60 "$@" "$url"
}

# corpo URL [ARGS_CURL...]: o corpo da resposta.
corpo() {
  local url=$1
  shift
  curl -s --path-as-is --max-time 60 "$@" "$url"
}

# cabecalho URL NOME [ARGS_CURL...]: valor do cabeçalho de resposta (sem CR), vazio se ausente.
cabecalho() {
  local url=$1 nome=$2
  shift 2
  curl -sI --path-as-is --max-time 60 "$@" "$url" | tr -d '\r' | awk -v n="$(printf '%s' "$nome" | tr '[:upper:]' '[:lower:]')" '{ i = index($0, ":"); if (i > 0 && tolower(substr($0, 1, i - 1)) == n) { v = substr($0, i + 1); sub(/^ /, "", v); print v; exit } }'
}

sha_arquivo() { sha256sum "$1" | cut -d' ' -f1; }

# sql CONSULTA: roda como o papel postgres no banco do stack (uma linha por registro, sem cabeçalho). Só o último
# statement devolve resultado.
sql() {
  dc exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tA -c "$1"
}

# no_qr: roda um script Node (stdin) dentro do container qr, onde SUPABASE_URL=http://gateway:8000 e as chaves de
# serviço já estão no ambiente. É por onde o fumaça faz o que só o servidor faz (admin API, webhook do qr).
no_qr() {
  dc exec -T qr node -
}

# esperar_ate NOME SEGUNDOS COMANDO...: repete o comando a cada 3 s até ele sair 0 (ou falha no prazo).
esperar_ate() {
  local nome=$1 prazo=$2 inicio
  shift 2
  inicio=$(date +%s)
  until "$@" > /dev/null 2>&1; do
    [ $(($(date +%s) - inicio)) -ge "$prazo" ] && falhou "$nome" "não aconteceu em ${prazo}s"
    sleep 3
  done
}

# Token (access_token) de um usuário por senha, pelo endereço público.
login() {
  local email=$1 senha=$2 anon
  anon=$(lenv "$ENVF" ANON_KEY)
  curl -s --max-time 30 -X POST "$BASE/auth/v1/token?grant_type=password" \
    -H "apikey: $anon" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$senha\"}"
}

# Mensagens do mailpit: total e assuntos.
mailpit_total() {
  corpo "http://127.0.0.1:$SMOKE_MAILPIT_PORT/api/v1/messages" | json total
}
mailpit_assuntos() {
  corpo "http://127.0.0.1:$SMOKE_MAILPIT_PORT/api/v1/messages" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).messages.map(m=>m.Subject).join("\n")))'
}
