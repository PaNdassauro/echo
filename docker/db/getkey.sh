#!/bin/sh
# Chave-raiz do Vault (supabase_vault) e do pgsodium, lida do ambiente do container do banco.
#
# A imagem supabase/postgres traz /usr/lib/postgresql/bin/pgsodium_getkey.sh, que GERA a chave na primeira subida e a
# grava dentro do container; recriar o container gera outra chave e todo segredo do Vault vira ilegível. Aqui a chave
# vem do .env (VAULT_ROOT_KEY: 64 caracteres hex minúsculos, gerados pelo install.sh) e entra no backup junto com o
# resto dos segredos. O postgres chama este script (caminho de arquivo executável: comando inline e arquivo sem +x
# derrubam o banco) e o ambiente do postmaster é herdado. Por isso a imagem copia o arquivo com --chmod=0755.
#
# Recusa: ausente, fora do formato e chave de um caractere só (zeros): `cp .env.example .env` não pode cifrar o
# Vault com uma chave conhecida. A mensagem não imprime o valor.
set -eu
case "${VAULT_ROOT_KEY:-}" in
  *[!0-9a-f]*|"")
    echo "VAULT_ROOT_KEY ausente ou não é hex minúsculo (rode ./install.sh)" >&2
    exit 1
    ;;
esac
if [ "${#VAULT_ROOT_KEY}" -ne 64 ]; then
  echo "VAULT_ROOT_KEY precisa de 64 caracteres hex (rode ./install.sh)" >&2
  exit 1
fi
primeiro=${VAULT_ROOT_KEY%"${VAULT_ROOT_KEY#?}"}
if [ -z "$(printf '%s' "$VAULT_ROOT_KEY" | tr -d "$primeiro")" ]; then
  echo "VAULT_ROOT_KEY é um valor de exemplo (um caractere repetido): rode ./install.sh" >&2
  exit 1
fi
printf '%s' "$VAULT_ROOT_KEY"
