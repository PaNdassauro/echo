#!/bin/sh
# Guarda de segredos (D43). Roda como 1º passo do db-init (todos os segredos) e, no container do banco, antes de o
# initdb existir (modo "db": só os dois que ele recebe). Objetivo: `cp .env.example .env && docker compose up` não pode
# subir com JWT, chave do Vault, código de setup ou segredo do QR conhecidos, nem criar o volume do banco com uma
# senha de exemplo (que depois ninguém consegue trocar sem apagar o volume).
#
# Recusa, por variável: vazia, placeholder (__GERE…), um caractere repetido (zeros), formato ou tamanho fora do que
# o gen-keys gera. IMPRIME SÓ O NOME da variável e o motivo, nunca o valor. Exit 1 com "rode ./install.sh".
# POSIX sh (busybox ash da imagem do banco).
#
#   preflight.sh        todos os segredos
#   preflight.sh db     só POSTGRES_PASSWORD e VAULT_ROOT_KEY
set -u
modo=${1:-todos}
ruins=0

recusa() { # nome motivo
  echo "preflight: $1 recusada ($2)" >&2
  ruins=$((ruins + 1))
}

repetido() { # valor: sucesso se for um único caractere repetido
  p=${1%"${1#?}"}
  [ -z "$(printf '%s' "$1" | tr -d "$p")" ]
}

hex() { # nome tamanho [minusculo]
  nome=$1; tam=$2
  eval "v=\${$nome:-}"
  if [ -z "$v" ]; then recusa "$nome" "vazia"; return; fi
  case "$v" in *__GERE*) recusa "$nome" "placeholder"; return ;; esac
  if [ "${3:-}" = minusculo ]; then
    case "$v" in *[!0-9a-f]*) recusa "$nome" "formato: hex minúsculo"; return ;; esac
  else
    case "$v" in *[!0-9a-fA-F]*) recusa "$nome" "formato: hex"; return ;; esac
  fi
  if [ "${#v}" -ne "$tam" ]; then recusa "$nome" "tamanho: esperado $tam caracteres"; return; fi
  if repetido "$v"; then recusa "$nome" "valor de exemplo (caractere repetido)"; return; fi
}

jwt() { # nome
  nome=$1
  eval "v=\${$nome:-}"
  if [ -z "$v" ]; then recusa "$nome" "vazia"; return; fi
  case "$v" in *__GERE*) recusa "$nome" "placeholder"; return ;; esac
  # três partes base64url separadas por ponto
  case "$v" in
    *[!A-Za-z0-9_.-]*|.*|*.|*..*) recusa "$nome" "formato: JWT de 3 partes"; return ;;
  esac
  pontos=$(printf '%s' "$v" | tr -cd '.')
  if [ "${#pontos}" -ne 2 ]; then recusa "$nome" "formato: JWT de 3 partes"; return; fi
}

hex POSTGRES_PASSWORD 48
hex VAULT_ROOT_KEY 64 minusculo

if [ "$modo" != db ]; then
  hex JWT_SECRET 64
  jwt ANON_KEY
  jwt SERVICE_ROLE_KEY
  hex AI_KEY_SECRET 64
  hex REALTIME_SECRET_KEY_BASE 96
  hex REALTIME_DB_ENC_KEY 16
  hex REALTIME_RELEASE_COOKIE 56
  hex QR_WEBHOOK_SECRET 64
  hex WHATSAPP_VERIFY_TOKEN 64
  hex INSTAGRAM_OAUTH_STATE_SECRET 64
  hex ZAPO_DB_PASSWORD 48
  # Código de setup: vazio = /setup desligado (permitido); preenchido, no mínimo 32 hex e não de exemplo.
  if [ -n "${ECHO_SETUP_TOKEN:-}" ]; then
    case "$ECHO_SETUP_TOKEN" in
      *__GERE*) recusa ECHO_SETUP_TOKEN "placeholder" ;;
      *[!0-9a-fA-F]*) recusa ECHO_SETUP_TOKEN "formato: hex" ;;
      *)
        if [ "${#ECHO_SETUP_TOKEN}" -lt 32 ]; then
          recusa ECHO_SETUP_TOKEN "tamanho: no mínimo 32 caracteres"
        elif repetido "$ECHO_SETUP_TOKEN"; then
          recusa ECHO_SETUP_TOKEN "valor de exemplo (caractere repetido)"
        fi
        ;;
    esac
  fi
fi

if [ "$ruins" -gt 0 ]; then
  echo "preflight: $ruins variável(is) com valor inválido ou de exemplo: rode ./install.sh (gera o .env com segredos novos)." >&2
  exit 1
fi
echo "preflight: segredos ok"
