#!/usr/bin/env bash
# Testes dos scripts e arquivos de infraestrutura que a fumaça só exercita de ponta a ponta: guarda de segredos
# (preflight.sh), chave-raiz do Vault (getkey.sh), entrypoint do gateway, Caddyfile e arquivos do compose. Roda cada
# script na MESMA imagem em que ele roda em produção (busybox ash), sem subir o stack e sem rede.
#
#   bash scripts/smoke/testes-infra.sh
#
# Pré-requisitos: Docker e as imagens public.ecr.aws/supabase/postgres:17.6.1.095 e caddy:2.10.2-alpine (as mesmas
# do compose; o Docker baixa se faltar) e Node >= 20 (`node --test` do realtime-lib). Sai 0 com "TESTES INFRA OK (<n>)" ou 1 na primeira falha.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PG_IMG=${PG_IMG:-public.ecr.aws/supabase/postgres:17.6.1.095}
CADDY_IMG=${CADDY_IMG:-caddy:2.10.2-alpine}
N=0

passou() {
  N=$((N + 1))
  printf 'OK %s\n' "$1"
}
quebrou() {
  printf 'FALHOU %s: %s\n' "$1" "$2" >&2
  exit 1
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/echo-testes-infra.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
jwt() { printf '%s.%s.%s' "$(hex 18)" "$(hex 30)" "$(hex 24)"; }

# Ambiente válido (formatos da seção 3.2 da SPEC), um por linha no arquivo "$TMP/env.base".
{
  echo "POSTGRES_PASSWORD=$(hex 24)"
  echo "JWT_SECRET=$(hex 32)"
  echo "ANON_KEY=$(jwt)"
  echo "SERVICE_ROLE_KEY=$(jwt)"
  echo "VAULT_ROOT_KEY=$(hex 32)"
  echo "AI_KEY_SECRET=$(hex 32)"
  echo "REALTIME_SECRET_KEY_BASE=$(hex 48)"
  echo "REALTIME_DB_ENC_KEY=$(hex 8)"
  echo "REALTIME_RELEASE_COOKIE=$(hex 28)"
  echo "QR_WEBHOOK_SECRET=$(hex 32)"
  echo "WHATSAPP_VERIFY_TOKEN=$(hex 32)"
  echo "INSTAGRAM_OAUTH_STATE_SECRET=$(hex 32)"
  echo "ZAPO_DB_PASSWORD=$(hex 24)"
  echo "ECHO_SETUP_TOKEN=$(hex 16)"
} > "$TMP/env.base"

# preflight [VAR=valor …] -- ARGS: roda o preflight.sh com o ambiente base trocado pelos VAR=valor; guarda saída e código.
preflight() {
  local trocas=() args=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do trocas+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  args=("$@")
  local envf="$TMP/env.caso"
  cp "$TMP/env.base" "$envf"
  local t k
  for t in "${trocas[@]}"; do
    k=${t%%=*}
    grep -v "^$k=" "$envf" > "$envf.novo" || true
    printf '%s\n' "$t" >> "$envf.novo"
    mv "$envf.novo" "$envf"
  done
  RC=0
  SAIDA=$(docker run --rm --entrypoint sh --env-file "$envf" -v "$REPO/docker/db:/echo:ro" "$PG_IMG" /echo/preflight.sh "${args[@]}" 2>&1) || RC=$?
}

esperar_recusa() { # NOME VAR [VALOR_QUE_NAO_PODE_VAZAR] ARGS_DO_PREFLIGHT_VIA_VAR_MODO
  local nome=$1 var=$2 valor=${3:-}
  [ "$RC" -eq 1 ] || quebrou "$nome" "esperava exit 1, veio $RC: $SAIDA"
  case "$SAIDA" in *"preflight: $var recusada"*) ;; *) quebrou "$nome" "a saída não cita $var: $SAIDA" ;; esac
  case "$SAIDA" in *"rode ./install.sh"*) ;; *) quebrou "$nome" "a saída não manda rodar ./install.sh: $SAIDA" ;; esac
  if [ -n "$valor" ]; then
    case "$SAIDA" in *"$valor"*) quebrou "$nome" "a saída imprimiu o VALOR da variável" ;; esac
  fi
  passou "$nome"
}

# --- preflight.sh ---------------------------------------------------------------------------------------------------
preflight --
[ "$RC" -eq 0 ] || quebrou "preflight: ambiente válido" "exit $RC: $SAIDA"
case "$SAIDA" in *"segredos ok"*) passou "preflight: ambiente válido passa" ;; *) quebrou "preflight: ambiente válido" "sem 'segredos ok'" ;; esac

preflight "ECHO_SETUP_TOKEN=" --
[ "$RC" -eq 0 ] || quebrou "preflight: ECHO_SETUP_TOKEN vazio" "exit $RC: $SAIDA"
passou "preflight: ECHO_SETUP_TOKEN vazio (/setup desligado) é aceito"

preflight "JWT_SECRET=" --
esperar_recusa "preflight: variável vazia" JWT_SECRET
preflight "JWT_SECRET=__GERE_COM_install.sh__" --
esperar_recusa "preflight: placeholder do .env.example" JWT_SECRET "__GERE_COM_install.sh__"
Z64=$(printf '0%.0s' $(seq 1 64))
preflight "VAULT_ROOT_KEY=$Z64" --
esperar_recusa "preflight: chave do Vault só de zeros" VAULT_ROOT_KEY
A48=$(printf 'a%.0s' $(seq 1 48))
preflight "POSTGRES_PASSWORD=$A48" --
esperar_recusa "preflight: um caractere repetido" POSTGRES_PASSWORD "$A48"
preflight "QR_WEBHOOK_SECRET=abc123" --
esperar_recusa "preflight: tamanho errado" QR_WEBHOOK_SECRET "abc123"
G64=$(printf 'g%.0s' $(seq 1 64))
preflight "AI_KEY_SECRET=$G64" --
esperar_recusa "preflight: caractere fora de hex" AI_KEY_SECRET "$G64"
UP64=$(printf 'A1%.0s' $(seq 1 32))
preflight "VAULT_ROOT_KEY=$UP64" --
esperar_recusa "preflight: chave do Vault em maiúsculas (o getkey exige minúsculas)" VAULT_ROOT_KEY
preflight "ANON_KEY=nao-e-jwt" --
esperar_recusa "preflight: JWT de uma parte" ANON_KEY "nao-e-jwt"
preflight "SERVICE_ROLE_KEY=a.b" --
esperar_recusa "preflight: JWT de duas partes" SERVICE_ROLE_KEY
S16=$(hex 8)
preflight "ECHO_SETUP_TOKEN=$S16" --
esperar_recusa "preflight: código de setup com menos de 32 hex" ECHO_SETUP_TOKEN "$S16"
preflight "ECHO_SETUP_TOKEN=__GERE_COM_install.sh__" --
esperar_recusa "preflight: código de setup placeholder" ECHO_SETUP_TOKEN

# várias recusas na mesma rodada, todas nomeadas
preflight "JWT_SECRET=" "ZAPO_DB_PASSWORD=curto" --
case "$SAIDA" in
  *"preflight: JWT_SECRET recusada"*"preflight: ZAPO_DB_PASSWORD recusada"*) passou "preflight: lista todas as variáveis recusadas, não só a primeira" ;;
  *) quebrou "preflight: lista todas as recusadas" "$SAIDA" ;;
esac
case "$SAIDA" in *curto*) quebrou "preflight: não imprime valor" "imprimiu 'curto'" ;; esac

# modo db: só POSTGRES_PASSWORD e VAULT_ROOT_KEY (o container do banco não recebe os outros)
preflight "JWT_SECRET=" -- db
[ "$RC" -eq 0 ] || quebrou "preflight db: ignora o resto" "exit $RC: $SAIDA"
passou "preflight db: confere só os dois segredos que o container do banco recebe"
preflight "POSTGRES_PASSWORD=__GERE_COM_install.sh__" -- db
esperar_recusa "preflight db: recusa a senha de exemplo antes do initdb" POSTGRES_PASSWORD

# --- getkey.sh ------------------------------------------------------------------------------------------------------
getkey() { # VALOR
  RC=0
  SAIDA=$(docker run --rm --entrypoint sh -e "VAULT_ROOT_KEY=$1" -v "$REPO/docker/db:/echo:ro" "$PG_IMG" /echo/getkey.sh 2>&1) || RC=$?
}
K=$(hex 32)
getkey "$K"
[ "$RC" -eq 0 ] && [ "$SAIDA" = "$K" ] || quebrou "getkey: chave válida" "exit $RC saída '$SAIDA'"
passou "getkey: devolve a chave válida, sem quebra de linha"
getkey "$Z64"
[ "$RC" -ne 0 ] || quebrou "getkey: zeros" "aceitou"
passou "getkey: recusa chave só de zeros"
getkey "abc"
[ "$RC" -ne 0 ] || quebrou "getkey: curta" "aceitou"
passou "getkey: recusa chave curta"
getkey ""
[ "$RC" -ne 0 ] || quebrou "getkey: vazia" "aceitou"
passou "getkey: recusa chave vazia"
getkey "$UP64"
[ "$RC" -ne 0 ] || quebrou "getkey: maiúsculas" "aceitou"
passou "getkey: recusa hex em maiúsculas"
case "$SAIDA" in *"$UP64"*) quebrou "getkey: não imprime o valor" "imprimiu a chave" ;; esac

# --- entrypoint.sh do gateway ---------------------------------------------------------------------------------------
# Um `caddy` falso na frente do PATH mostra o que o entrypoint deixou pronto (config.js, snippet de trusted_proxies e
# ECHO_CSP_WS) em vez de subir o servidor.
cat > "$TMP/caddy-falso" << 'EOF'
#!/bin/sh
echo "CSP_WS=[$ECHO_CSP_WS]"
echo "CSP_HTTP=[$ECHO_CSP_HTTP]"
echo "REDE=[$ECHO_REDE_INTERNA]"
echo "SITE=[$SITE_ADDRESS]"
echo "BIND=[$ECHO_BIND_INTERNO]"
if [ -f /etc/caddy/gerado/servers-proxy.caddy ]; then echo "PROXY_SNIPPET=sim"; else echo "PROXY_SNIPPET=nao"; fi
cat /srv/config.js
EOF
chmod 0755 "$TMP/caddy-falso"

# JWTs com o payload que o entrypoint confere (role anon / service_role), em base64url sem padding.
b64u() { printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
JWT_H=$(b64u '{"alg":"HS256","typ":"JWT"}')
ANON_OK="$JWT_H.$(b64u '{"role":"anon","iss":"echo"}').assinatura-anon"
SERV_OK="$JWT_H.$(b64u '{"role":"service_role","iss":"echo"}').assinatura-service"
entrypoint() { # VAR=valor …: ambiente do entrypoint (o base abaixo vale para o que não for trocado)
  local envf="$TMP/gw.env" t k
  {
    echo "ANON_KEY=$ANON_OK"
    echo "SERVICE_ROLE_KEY=$SERV_OK"
    echo "ECHO_PUBLIC_URL=http://localhost:8088"
    echo "SITE_ADDRESS=:80"
    echo "ECHO_BEHIND_PROXY=false"
    echo "ECHO_REDE_INTERNA=echo_default"
  } > "$envf"
  for t in "$@"; do
    k=${t%%=*}
    grep -v "^$k=" "$envf" > "$envf.novo" || true
    printf '%s\n' "$t" >> "$envf.novo"
    mv "$envf.novo" "$envf"
  done
  RC=0
  SAIDA=$(docker run --rm --entrypoint sh --env-file "$envf" \
    -v "$REPO/docker/gateway/entrypoint.sh:/ep.sh:ro" -v "$TMP/caddy-falso:/usr/local/bin/caddy:ro" "$CADDY_IMG" /ep.sh 2>&1) || RC=$?
}

entrypoint
[ "$RC" -eq 0 ] || quebrou "entrypoint: ambiente válido" "exit $RC: $SAIDA"
case "$SAIDA" in *'CSP_WS=[ ws://localhost:8088]'*) passou "entrypoint: URL http:// acrescenta ' ws://host:porta' ao connect-src" ;; *) quebrou "entrypoint: ECHO_CSP_WS" "$SAIDA" ;; esac
case "$SAIDA" in *'CSP_HTTP=[ http://localhost:8088]'*) passou "entrypoint: URL http:// acrescenta ' http://host:porta' (a origem canônica da mídia gravada)" ;; *) quebrou "entrypoint: ECHO_CSP_HTTP" "$SAIDA" ;; esac
case "$SAIDA" in *'REDE=[echo_default]'*) passou "entrypoint: ECHO_REDE_INTERNA chega ao Caddy" ;; *) quebrou "entrypoint: ECHO_REDE_INTERNA" "$SAIDA" ;; esac
case "$SAIDA" in *'PROXY_SNIPPET=nao'*) passou "entrypoint: sem proxy, nenhum servers-proxy.caddy" ;; *) quebrou "entrypoint: snippet fora do modo proxy" "$SAIDA" ;; esac
case "$SAIDA" in *"\"supabaseAnonKey\":\"$ANON_OK\""*'"siteUrl":"http://localhost:8088"'*) passou "entrypoint: config.js com a ANON_KEY e o siteUrl" ;; *) quebrou "entrypoint: config.js" "$SAIDA" ;; esac
case "$SAIDA" in *"$SERV_OK"*) quebrou "entrypoint: config.js sem a SERVICE_ROLE_KEY" "a chave apareceu" ;; *) passou "entrypoint: a SERVICE_ROLE_KEY não aparece no config.js" ;; esac
case "$SAIDA" in *'"features":{"email":false,"recuperacaoSenha":false,"feedback":false,"transformacaoImagem":false}'*) passou "entrypoint: sem e-mail, tudo desligado" ;; *) quebrou "entrypoint: flags sem e-mail" "$SAIDA" ;; esac

case "$SAIDA" in *'BIND=[127.0.0.1 '[0-9]*'.'[0-9]*'.'[0-9]*'.'[0-9]*']'*) passou "entrypoint: ECHO_BIND_INTERNO = 127.0.0.1 + o IP do container (uma rede só)" ;; *) quebrou "entrypoint: ECHO_BIND_INTERNO" "$SAIDA" ;; esac

entrypoint "ECHO_PUBLIC_URL=https://echo.exemplo.com" "SITE_ADDRESS=echo.exemplo.com"
case "$SAIDA" in *'CSP_WS=[]'*) passou "entrypoint: URL https:// deixa ECHO_CSP_WS vazio" ;; *) quebrou "entrypoint: https" "$SAIDA" ;; esac
case "$SAIDA" in *'CSP_HTTP=[]'*) passou "entrypoint: URL https:// deixa ECHO_CSP_HTTP vazio (nenhuma origem http liberada)" ;; *) quebrou "entrypoint: https sem origem http" "$SAIDA" ;; esac
case "$SAIDA" in *'SITE=[echo.exemplo.com]'*) passou "entrypoint: SITE_ADDRESS do domínio chega ao Caddy" ;; *) quebrou "entrypoint: SITE_ADDRESS" "$SAIDA" ;; esac

entrypoint "ECHO_BEHIND_PROXY=true"
case "$SAIDA" in *'PROXY_SNIPPET=sim'*) passou "entrypoint: ECHO_BEHIND_PROXY=true escreve o trusted_proxies" ;; *) quebrou "entrypoint: modo proxy" "$SAIDA" ;; esac

entrypoint "SMTP_HOST=smtp.exemplo.com" "SMTP_ADMIN_EMAIL=echo@exemplo.com"
case "$SAIDA" in *'"features":{"email":true,"recuperacaoSenha":true,"feedback":false,'*) passou "entrypoint: SMTP com remetente liga e-mail e recuperação de senha" ;; *) quebrou "entrypoint: flags com SMTP" "$SAIDA" ;; esac
# Decisão 7 (a mesma regra de _shared/email.ts e do doctor): SMTP_HOST sozinho não envia nada, então não liga nada.
entrypoint "SMTP_HOST=smtp.exemplo.com"
case "$SAIDA" in *'"features":{"email":false,"recuperacaoSenha":false,"feedback":false,'*) passou "entrypoint: SMTP_HOST sem remetente não liga e-mail nem recuperação" ;; *) quebrou "entrypoint: flags com SMTP sem remetente" "$SAIDA" ;; esac
entrypoint "SMTP_HOST=   " "SMTP_ADMIN_EMAIL=echo@exemplo.com"
case "$SAIDA" in *'"features":{"email":false,"recuperacaoSenha":false,'*) passou "entrypoint: SMTP_HOST só com espaços vale como vazio" ;; *) quebrou "entrypoint: SMTP_HOST em branco" "$SAIDA" ;; esac
entrypoint "SMTP_HOST=smtp.exemplo.com" "EMAIL_FROM=echo@exemplo.com"
case "$SAIDA" in *'"features":{"email":true,"recuperacaoSenha":false,'*) passou "entrypoint: SMTP com EMAIL_FROM liga o e-mail das edges, mas a recuperação (GoTrue) pede SMTP_ADMIN_EMAIL" ;; *) quebrou "entrypoint: flags com SMTP e EMAIL_FROM" "$SAIDA" ;; esac
entrypoint "RESEND_API_KEY=chave-de-teste"
case "$SAIDA" in *'"features":{"email":false,"recuperacaoSenha":false,'*) passou "entrypoint: Resend sem EMAIL_FROM não liga e-mail" ;; *) quebrou "entrypoint: flags com Resend sem remetente" "$SAIDA" ;; esac
entrypoint "RESEND_API_KEY=chave-de-teste" "EMAIL_FROM=Echo <echo@exemplo.com>" "FEEDBACK_EMAILS=a@exemplo.com"
# EMAIL_FROM tem espaço: o --env-file do Docker preserva, o entrypoint só o lê para a flag
case "$SAIDA" in *'"features":{"email":true,"recuperacaoSenha":false,"feedback":true,'*) passou "entrypoint: Resend liga e-mail mas não a recuperação; feedback por e-mail" ;; *) quebrou "entrypoint: flags com Resend" "$SAIDA" ;; esac
entrypoint "FEEDBACK_WEBHOOK_URL=https://hooks.exemplo.com/feedback"
case "$SAIDA" in *'"feedback":true'*'"feedbackWebhookUrl":"https://hooks.exemplo.com/feedback"'* | *'"feedbackWebhookUrl":"https://hooks.exemplo.com/feedback"'*'"feedback":true'*) passou "entrypoint: webhook de feedback liga o feedback" ;; *) quebrou "entrypoint: feedback por webhook" "$SAIDA" ;; esac

recusa_entrypoint() { # NOME VAR=valor…
  local nome=$1
  shift
  entrypoint "$@"
  [ "$RC" -eq 1 ] || quebrou "$nome" "esperava exit 1, veio $RC: $SAIDA"
  case "$SAIDA" in *"gateway: "*) passou "$nome" ;; *) quebrou "$nome" "sem mensagem 'gateway: …': $SAIDA" ;; esac
}
recusa_entrypoint "entrypoint: ECHO_REDE_INTERNA com caractere fora do nome de rede" "ECHO_REDE_INTERNA=echo default;x"
recusa_entrypoint "entrypoint: ECHO_REDE_INTERNA terminando em ponto" "ECHO_REDE_INTERNA=echo_default."
recusa_entrypoint "entrypoint: ANON_KEY que não é JWT" "ANON_KEY=nao-e-jwt"
recusa_entrypoint "entrypoint: ECHO_PUBLIC_URL com barra final" "ECHO_PUBLIC_URL=http://localhost:8088/"
recusa_entrypoint "entrypoint: ECHO_PUBLIC_URL sem esquema" "ECHO_PUBLIC_URL=localhost:8088"
recusa_entrypoint "entrypoint: ECHO_PUBLIC_URL com aspas" 'ECHO_PUBLIC_URL=http://local"host:8088'
recusa_entrypoint "entrypoint: ECHO_BEHIND_PROXY inválido" "ECHO_BEHIND_PROXY=talvez"
recusa_entrypoint "entrypoint: SERVICE_ROLE_KEY que não é JWT" "SERVICE_ROLE_KEY=nao-e-jwt"
recusa_entrypoint "entrypoint: ANON_KEY igual à SERVICE_ROLE_KEY" "ANON_KEY=$SERV_OK"
recusa_entrypoint "entrypoint: chaves trocadas (a service_role no lugar da anon)" "ANON_KEY=$SERV_OK" "SERVICE_ROLE_KEY=$ANON_OK"
recusa_entrypoint "entrypoint: ANON_KEY com role que não é anon" "ANON_KEY=$JWT_H.$(b64u '{"role":"authenticated"}').x"
recusa_entrypoint "entrypoint: payload da ANON_KEY que não é base64" "ANON_KEY=$JWT_H.!!!.x"
recusa_entrypoint "entrypoint: SITE_ADDRESS com espaço e diretiva" "SITE_ADDRESS=echo.exemplo.com respond 200"
recusa_entrypoint "entrypoint: SITE_ADDRESS com chave de substituição" 'SITE_ADDRESS={env.ANON_KEY}'
recusa_entrypoint "entrypoint: SITE_ADDRESS com porta que não é número" "SITE_ADDRESS=:80a"
recusa_entrypoint "entrypoint: SITE_ADDRESS com esquema e barra" "SITE_ADDRESS=https://echo.exemplo.com/"
recusa_entrypoint "entrypoint: FEEDBACK_WEBHOOK_URL sem http(s)" "FEEDBACK_WEBHOOK_URL=hooks.exemplo.com/feedback"
recusa_entrypoint "entrypoint: FEEDBACK_WEBHOOK_URL com outro esquema" "FEEDBACK_WEBHOOK_URL=ftp://hooks.exemplo.com/feedback"
case "$SAIDA" in *"$SERV_OK"* | *"$ANON_OK"*) quebrou "entrypoint: recusa não imprime chave" "a saída tem uma chave" ;; esac
passou "entrypoint: a mensagem de recusa não imprime chave"
# Sem ECHO_REDE_INTERNA o gateway recusa subir (o `:?` do shell, mensagem própria), nunca cai no nome curto.
entrypoint "ECHO_REDE_INTERNA="
[ "$RC" -ne 0 ] || quebrou "entrypoint: sem ECHO_REDE_INTERNA" "subiu"
case "$SAIDA" in *"ECHO_REDE_INTERNA ausente"*) passou "entrypoint: sem ECHO_REDE_INTERNA recusa subir, com mensagem" ;; *) quebrou "entrypoint: mensagem sem ECHO_REDE_INTERNA" "$SAIDA" ;; esac
entrypoint "SITE_ADDRESS=:8080"
[ "$RC" -eq 0 ] || quebrou "entrypoint: SITE_ADDRESS=:8080" "exit $RC: $SAIDA"
passou "entrypoint: SITE_ADDRESS=':porta' é aceito"

# --- Caddyfile: validate com os três SITE_ADDRESS, com e sem o snippet de proxy ------------------------------------
caddy_validate() { # SITE_ADDRESS com|sem [ECHO_BIND_INTERNO]
  RC=0
  SAIDA=$(docker run --rm --entrypoint sh -e "SITE_ADDRESS=$1" -e ANON_KEY=a.b.c -e SERVICE_ROLE_KEY=d.e.f -e REALTIME_TENANT=echo \
    -e ECHO_CSP_WS= -e ECHO_REDE_INTERNA=echo_default -e "ECHO_BIND_INTERNO=${3-127.0.0.1 172.30.0.2}" \
    -v "$REPO/docker/gateway/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMG" -c "
      mkdir -p /etc/caddy/gerado
      if [ $2 = com ]; then printf 'trusted_proxies static private_ranges\ntrusted_proxies_strict\n' > /etc/caddy/gerado/servers-proxy.caddy; fi
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" 2>&1) || RC=$?
}
for sitio in ':80' 'localhost' 'echo.exemplo.com'; do
  for proxy in sem com; do
    caddy_validate "$sitio" "$proxy"
    case "$SAIDA" in *"Valid configuration"*) passou "caddy validate: SITE_ADDRESS=$sitio, $proxy servers-proxy.caddy" ;; *) quebrou "caddy validate $sitio $proxy" "$SAIDA" ;; esac
  done
done

# O `bind` do :8000 nunca pode ficar vazio (vazio = todas as interfaces): `caddy adapt` mostra onde cada servidor escuta.
escutas() { # [ECHO_BIND_INTERNO]: endereços "listen" do config adaptado
  docker run --rm --entrypoint sh -e SITE_ADDRESS=:80 -e ANON_KEY=a.b.c -e SERVICE_ROLE_KEY=d.e.f -e REALTIME_TENANT=echo -e ECHO_CSP_WS= -e ECHO_REDE_INTERNA=echo_default \
    ${1+-e "ECHO_BIND_INTERNO=$1"} -v "$REPO/docker/gateway/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMG" -c \
    "mkdir -p /etc/caddy/gerado; caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null | tr -d ' \n' | grep -oE '\"listen\":\[[^]]*\]'"
}
SAIDA=$(escutas) || quebrou "caddy adapt sem ECHO_BIND_INTERNO" "falhou"
case "$SAIDA" in *'":8000"'*) quebrou "caddy adapt sem ECHO_BIND_INTERNO" "o :8000 escuta em todas as interfaces: $SAIDA" ;; esac
case "$SAIDA" in *'"127.0.0.1:8000"'*) passou "caddy adapt: sem ECHO_BIND_INTERNO o :8000 escuta só no 127.0.0.1 (falha fechada)" ;; *) quebrou "caddy adapt sem ECHO_BIND_INTERNO" "$SAIDA" ;; esac
SAIDA=$(escutas "127.0.0.1 172.30.0.2") || quebrou "caddy adapt com ECHO_BIND_INTERNO" "falhou"
case "$SAIDA" in *'"172.30.0.2:8000"'*'"127.0.0.1:8000"'* | *'"127.0.0.1:8000"'*'"172.30.0.2:8000"'*) ;; *) quebrou "caddy adapt com ECHO_BIND_INTERNO" "$SAIDA" ;; esac
case "$SAIDA" in *'":8000"'*) quebrou "caddy adapt com ECHO_BIND_INTERNO" "o :8000 escuta em todas as interfaces: $SAIDA" ;; esac
passou "caddy adapt: com ECHO_BIND_INTERNO o :8000 escuta só em 127.0.0.1 e no IP da rede do compose"

# --- listener interno do gateway: a rede do proxy NÃO chega ao :8000 ---------------------------------------------------
# Container com o entrypoint e o Caddyfile reais em duas redes (uma "default" com o apelido interno, outra "proxy" com o
# apelido público, como docker/compose/proxy-rede.yml) e um vizinho só na rede do proxy. O que o vizinho NÃO pode:
# chegar ao :8000. O que ele pode: o :80. O que o gateway pode: o :8000 pelo nome do serviço e pelo 127.0.0.1.
# ECHO_TESTE_PREFIXO troca o prefixo dos containers e redes de teste (a fumaça de um stack separado usa echo-sh-…).
P="${ECHO_TESTE_PREFIXO:-echo-testes-infra}-$$"
limpar_redes() { docker rm -f "$P-gw" "$P-gw2" "$P-gw3" "$P-gw4" "$P-viz" "$P-vizinho" "$P-hostil" "$P-storage" > /dev/null 2>&1 || true; docker network rm "$P-default" "$P-coolify" "$P-depois" > /dev/null 2>&1 || true; }
trap 'limpar_redes; rm -rf "$TMP"' EXIT
# A rede do proxy se chama "<prefixo>-coolify" DE PROPÓSITO: ordena antes de "<prefixo>-default", que é o caso em que o
# DNS do Docker responde o nome curto de um serviço pela rede do proxy (como `coolify` antes de `echo_default`).
docker network create "$P-default" > /dev/null
docker network create "$P-coolify" > /dev/null
gw_duas_redes() { # NOME [VAR=valor …]: cria o gateway nas duas redes e inicia
  local nome=$1 extra=() t
  shift
  for t in "$@"; do extra+=(-e "$t"); done
  docker create --name "$nome" --network "$P-default" --network-alias gateway --network-alias "$P-gateway-interno" \
    -e "ANON_KEY=$ANON_OK" -e "SERVICE_ROLE_KEY=$SERV_OK" -e ECHO_PUBLIC_URL=http://localhost:8088 -e SITE_ADDRESS=:80 \
    -e REALTIME_TENANT=echo -e ECHO_BEHIND_PROXY=true -e "ECHO_REDE_INTERNA=$P-default" "${extra[@]}" \
    -v "$REPO/docker/gateway/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$REPO/docker/gateway/entrypoint.sh:/ep.sh:ro" \
    --entrypoint sh "$CADDY_IMG" /ep.sh > /dev/null
  docker network connect --alias "$P-gateway" "$P-coolify" "$nome"
  docker start "$nome" > /dev/null
}
# Storage "de verdade" (um file-server com um SVG de arquivo guardado) só na rede interna, e um vizinho só na rede do
# proxy com os apelidos dos serviços do Echo (auth, rest, storage…) respondendo VIZINHO: o gateway tem de chegar ao real.
mkdir -p "$TMP/storage-real/object/public/attachments"
printf '<svg xmlns="http://www.w3.org/2000/svg"><!-- STORAGE-REAL --></svg>' > "$TMP/storage-real/object/public/attachments/evil.svg"
docker run -d --name "$P-storage" --network "$P-default" --network-alias storage -v "$TMP/storage-real:/srv:ro" \
  "$CADDY_IMG" caddy file-server --root /srv --listen :5000 > /dev/null
docker run -d --name "$P-vizinho" --network "$P-coolify" --network-alias auth --network-alias rest --network-alias storage \
  --network-alias realtime --network-alias functions --network-alias qr "$CADDY_IMG" caddy respond --listen :5000 VIZINHO > /dev/null
gw_duas_redes "$P-gw" "ECHO_ALIAS_REDE_INTERNA=$P-gateway-interno"
docker run -d --name "$P-viz" --network "$P-coolify" --entrypoint sleep "$CADDY_IMG" 300 > /dev/null
esperar_gw() { for _ in $(seq 1 20); do docker exec "$P-gw" wget -q -O /dev/null --timeout=2 http://127.0.0.1:8000/config.js 2> /dev/null && return 0; sleep 1; done; return 1; }
esperar_gw || quebrou "listener interno: o gateway de duas redes não subiu" "$(docker logs "$P-gw" 2>&1 | tail -5)"
viz() { docker exec "$P-viz" wget -q -O /dev/null --timeout=5 "$1" > /dev/null 2>&1; }
viz "http://$P-gateway:80/config.js" || quebrou "listener interno: o proxy não chega ao :80 do gateway" "$P-gateway:80"
passou "listener interno: o container da rede do proxy chega ao :80 do gateway (200)"
if viz "http://$P-gateway:8000/qr/health"; then quebrou "listener interno: :8000 visível na rede do proxy" "GET /qr/health respondeu"; fi
passou "listener interno: o container da rede do proxy NÃO chega ao :8000 (/qr/health recusado)"
if viz "http://$P-gateway:8000/config.js"; then quebrou "listener interno: :8000 visível na rede do proxy" "GET /config.js respondeu"; fi
passou "listener interno: nem o /config.js sai pelo :8000 na rede do proxy"
docker exec "$P-gw" wget -q -O /dev/null --timeout=5 http://gateway:8000/config.js || quebrou "listener interno: o gateway não chega ao próprio :8000 pelo nome do serviço" "gateway:8000"
passou "listener interno: o :8000 responde pelo nome do serviço na rede do compose"
docker exec "$P-gw" wget -q -O /dev/null --timeout=5 http://127.0.0.1:8000/config.js || quebrou "listener interno: 127.0.0.1:8000 (healthcheck)" "sem resposta"
passou "listener interno: o 127.0.0.1:8000 do healthcheck responde"
# Uma rede conectada DEPOIS da subida (docker network connect do painel) também não abre o :8000: o bind é no IP.
docker network create "$P-depois" > /dev/null
docker network connect "$P-depois" "$P-gw"
IP_DEPOIS=$(docker inspect --format "{{(index .NetworkSettings.Networks \"$P-depois\").IPAddress}}" "$P-gw")
docker network connect "$P-depois" "$P-viz"
docker exec "$P-viz" wget -q -O /dev/null --timeout=5 "http://$IP_DEPOIS:80/config.js" || quebrou "listener interno: rede conectada depois" "o :80 não responde em $IP_DEPOIS (controle positivo)"
if docker exec "$P-viz" wget -q -O /dev/null --timeout=3 "http://$IP_DEPOIS:8000/config.js" > /dev/null 2>&1; then quebrou "listener interno: rede conectada depois" ":8000 respondeu em $IP_DEPOIS"; fi
passou "listener interno: rede conectada depois da subida também não chega ao :8000"
docker rm -f "$P-viz" > /dev/null

# Upstream QUALIFICADO pela rede interna: com a rede do proxy ordenando antes, o vizinho com apelido `storage` NÃO recebe o
# tráfego do gateway (o nome curto resolveria para ele). Medido no achado: sem a qualificação, 8 de 8 respostas VIZINHO.
CORPO=$(docker exec "$P-gw" wget -q -O - --timeout=5 http://127.0.0.1:8000/storage/v1/object/public/attachments/evil.svg 2>&1 || true)
case "$CORPO" in *VIZINHO*) quebrou "upstream qualificado" "o gateway mandou o /storage para o vizinho da rede do proxy: $CORPO" ;; esac
case "$CORPO" in *STORAGE-REAL*) passou "upstream qualificado: com um vizinho de apelido storage na rede do proxy, o gateway chega ao storage real" ;; *) quebrou "upstream qualificado" "sem o conteúdo do storage real: $CORPO" ;; esac
RESP=$(docker exec "$P-gw" wget -q -O - --timeout=5 --header "apikey: $ANON_OK" "http://127.0.0.1:8000/auth/v1/health" 2>&1 || true)
case "$RESP" in *VIZINHO*) quebrou "upstream qualificado" "o /auth foi para o vizinho: $RESP" ;; esac
passou "upstream qualificado: /auth (apelido auth no vizinho) não chega ao vizinho nem com ele ordenando primeiro"

# LIMITE, documentado e não corrigido: a qualificação evita a colisão ACIDENTAL do nome curto, mas um container hostil da
# rede do proxy com o apelido LITERAL `qr.<rede interna>` casa o nome inteiro antes (o DNS do Docker procura o nome todo
# em todas as redes do container antes de separar serviço e rede). Este teste mede e registra; não afirma proteção.
# O vizinho nasce DEPOIS da subida do gateway, que é o caso que a conferência de sub-rede do entrypoint não alcança. Usa o
# `qr` porque ele ainda não tem upstream real aqui: o Caddy reaproveita conexão já aberta com o storage real (keep-alive) e
# só um discado novo consulta o DNS de novo.
docker run -d --name "$P-hostil" --network "$P-coolify" --network-alias "qr.$P-default" \
  "$CADDY_IMG" caddy respond --listen :3000 HOSTIL > /dev/null
CORPO=
for _ in $(seq 1 10); do
  CORPO=$(docker exec "$P-gw" wget -q -O - --timeout=5 http://127.0.0.1:8000/qr/x 2>&1 || true)
  case "$CORPO" in *HOSTIL*) break ;; esac
  sleep 1
done
case "$CORPO" in
  *HOSTIL*) passou "limite conhecido: vizinho hostil da rede do proxy com apelido literal qr.<rede> RECEBE o tráfego do gateway (a rede do proxy tem de ser de confiança)" ;;
  *) quebrou "limite conhecido (apelido literal)" "o gateway não chegou ao vizinho (o limite mudou? revise o aviso em docs/reverse-proxy.md): $CORPO" ;;
esac
# E a conferência de sub-rede NA SUBIDA pega o mesmo vizinho quando ele já existe (um segundo gateway recusa subir).
docker create --name "$P-gw4" --network "$P-default" --network-alias gateway4 --network-alias "$P-gw4-interno" \
  -e "ANON_KEY=$ANON_OK" -e "SERVICE_ROLE_KEY=$SERV_OK" -e ECHO_PUBLIC_URL=http://localhost:8088 -e SITE_ADDRESS=:80 \
  -e REALTIME_TENANT=echo -e ECHO_BEHIND_PROXY=true -e "ECHO_REDE_INTERNA=$P-default" -e "ECHO_ALIAS_REDE_INTERNA=$P-gw4-interno" \
  -v "$REPO/docker/gateway/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$REPO/docker/gateway/entrypoint.sh:/ep.sh:ro" \
  --entrypoint sh "$CADDY_IMG" /ep.sh > /dev/null
docker network connect --alias "$P-gateway4" "$P-coolify" "$P-gw4"
docker start "$P-gw4" > /dev/null
for _ in $(seq 1 20); do [ "$(docker inspect --format '{{.State.Running}}' "$P-gw4")" = false ] && break; sleep 1; done
LOG4=$(docker logs "$P-gw4" 2>&1 || true)
case "$LOG4" in
  *"fora da sub-rede da rede interna"*) passou "subida: com o vizinho de apelido literal qr.<rede> já de pé, o gateway recusa subir (conferência de sub-rede)" ;;
  *) quebrou "conferência de sub-rede na subida" "o gateway não recusou o vizinho hostil já existente: $LOG4" ;;
esac
docker rm -f "$P-hostil" "$P-gw4" > /dev/null

# --- storage: CSP sandbox e nosniff nos arquivos guardados (SVG/XHTML rodariam script na origem do app) ---------------
# Pelo site público (o que o navegador usa) e pelo interno. O header tem de estar DENTRO do handle_path do storage.
for porta in 80 8000; do
  CAB=$(docker exec "$P-gw" wget -S -q -O /dev/null --timeout=5 "http://127.0.0.1:$porta/storage/v1/object/public/attachments/evil.svg" 2>&1 || true)
  case "$CAB" in *"image/svg+xml"*) ;; *) quebrou "storage CSP :$porta" "o storage não devolveu image/svg+xml (controle): $CAB" ;; esac
  case "$CAB" in *"Content-Security-Policy: default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"*) ;; *) quebrou "storage CSP :$porta" "sem o CSP sandbox em /storage/v1: $CAB" ;; esac
  case "$CAB" in *"X-Content-Type-Options: nosniff"*) passou "storage: SVG guardado sai com CSP sandbox e nosniff (:$porta)" ;; *) quebrou "storage CSP :$porta" "sem nosniff: $CAB" ;; esac
done

# --- CSP do front: com URL http:// libera a origem canônica em img/media/connect; com https:// não libera nenhuma -----
CAB=$(docker exec "$P-gw" wget -S -q -O /dev/null --timeout=5 http://127.0.0.1:80/config.js 2>&1 || true)
case "$CAB" in *"img-src 'self' https: data: blob: http://localhost:8088;"*"connect-src 'self' https: wss: ws://localhost:8088 http://localhost:8088;"*"media-src 'self' https: blob: http://localhost:8088"*) passou "CSP do front: com URL http:// img-src, media-src e connect-src aceitam a origem canônica" ;; *) quebrou "CSP do front (http)" "$CAB" ;; esac
docker run -d --name "$P-gw3" --network "$P-default" --network-alias gateway3 \
  -e "ANON_KEY=$ANON_OK" -e "SERVICE_ROLE_KEY=$SERV_OK" -e ECHO_PUBLIC_URL=https://echo.exemplo.com -e SITE_ADDRESS=:80 \
  -e REALTIME_TENANT=echo -e "ECHO_REDE_INTERNA=$P-default" \
  -v "$REPO/docker/gateway/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$REPO/docker/gateway/entrypoint.sh:/ep.sh:ro" \
  --entrypoint sh "$CADDY_IMG" /ep.sh > /dev/null
for _ in $(seq 1 20); do docker exec "$P-gw3" wget -q -O /dev/null --timeout=2 http://127.0.0.1:80/config.js 2> /dev/null && break; sleep 1; done
CAB=$(docker exec "$P-gw3" wget -S -q -O /dev/null --timeout=5 http://127.0.0.1:80/config.js 2>&1 || true)
case "$CAB" in *"connect-src 'self' https: wss:;"*"media-src 'self' https: blob:"*) ;; *) quebrou "CSP do front (https)" "$CAB" ;; esac
case "$CAB" in *"http://"*) quebrou "CSP do front (https)" "a CSP libera uma origem http: $CAB" ;; esac
passou "CSP do front: com URL https:// nenhuma origem http é liberada"
docker rm -f "$P-gw3" > /dev/null

# --- logs: nenhum caminho (acesso OU erro de proxy) imprime a service_role, o X-Qr-Secret nem o ?access_token= ----------
# `rest` e `functions` não existem na rede interna (só o vizinho, que o nome qualificado não alcança): o proxy dá 502 e o
# Caddy loga o erro com headers e URI, que é exatamente o caminho que vazava. Nos dois sites (:8000 e o público).
docker exec "$P-gw" wget -q -O /dev/null --timeout=5 --header "apikey: $SERV_OK" --header "X-Qr-Secret: SEGREDO-QR-LOG" \
  "http://127.0.0.1:8000/rest/v1/x?apikey=$SERV_OK&token=TOKEN-NA-QUERY" > /dev/null 2>&1 || true
docker exec "$P-gw" wget -q -O /dev/null --timeout=5 --header "apikey: $SERV_OK" --header "X-Qr-Secret: SEGREDO-QR-PUBLICO" \
  "http://127.0.0.1:80/functions/v1/x?access_token=TOKEN-PUBLICO" > /dev/null 2>&1 || true
sleep 1
LOGS=$(docker logs "$P-gw" 2>&1)
case "$LOGS" in *'"logger":"http.log.error'*'"uri":"/rest/v1/x'*) ;; *) quebrou "logs de erro" "o erro de proxy do :8000 não apareceu no log (controle): $(printf '%s' "$LOGS" | tail -5)" ;; esac
case "$LOGS" in *'"logger":"http.log.error'*'"uri":"/functions/v1/x'*) ;; *) quebrou "logs de erro" "o erro de proxy do site público não apareceu no log (controle): $(printf '%s' "$LOGS" | tail -5)" ;; esac
for segredo in "$SERV_OK" SEGREDO-QR-LOG SEGREDO-QR-PUBLICO TOKEN-NA-QUERY TOKEN-PUBLICO; do
  case "$LOGS" in *"$segredo"*) quebrou "logs de erro" "o log do gateway tem '${segredo:0:20}…'" ;; esac
done
passou "logs: o erro de proxy (:8000 e site público) não imprime Apikey, X-Qr-Secret, ?apikey=, ?token= nem ?access_token="

# --- logs: o healthcheck (/config.js vindo de 127.0.0.1) fica fora do log de acesso; qualquer outro pedido continua nele ---
docker exec "$P-gw" wget -q -O /dev/null --timeout=5 "http://127.0.0.1:8000/config.js?sonda=SAUDE-FORA-DO-LOG" > /dev/null 2>&1 || true
docker exec "$P-gw" wget -q -O /dev/null --timeout=5 "http://127.0.0.1:8000/outro-caminho?sonda=CONTROLE-NO-LOG" > /dev/null 2>&1 || true
sleep 1
LOGS=$(docker logs "$P-gw" 2>&1)
case "$LOGS" in *CONTROLE-NO-LOG*) ;; *) quebrou "logs: healthcheck" "o pedido de controle não apareceu no log do :8000: $(printf '%s' "$LOGS" | tail -3)" ;; esac
case "$LOGS" in *SAUDE-FORA-DO-LOG*) quebrou "logs: healthcheck" "o /config.js vindo de 127.0.0.1 entrou no log de acesso" ;; *) passou "logs: o /config.js do healthcheck (127.0.0.1) não entra no log de acesso do :8000, e outro caminho entra" ;; esac

# Rede interna errada: o serviço qualificado resolve FORA da sub-rede do gateway (aqui o vizinho, pela rede do proxy) e o
# entrypoint recusa subir em vez de mandar o tráfego para lá.
docker rm -f "$P-gw" > /dev/null # o apelido interno tem de resolver só para o gw2
gw_duas_redes "$P-gw2" "ECHO_ALIAS_REDE_INTERNA=$P-gateway-interno" "ECHO_REDE_INTERNA=$P-coolify"
sleep 3
case "$(docker logs "$P-gw2" 2>&1)" in *"fora da sub-rede da rede interna"*) passou "upstream qualificado: serviço que resolve fora da sub-rede interna faz o gateway recusar subir" ;; *) quebrou "upstream fora da sub-rede" "$(docker logs "$P-gw2" 2>&1 | tail -3)" ;; esac
docker rm -f "$P-gw2" > /dev/null

# Duas redes sem o apelido interno: o gateway recusa subir em vez de escolher uma rede no chute.
gw_duas_redes "$P-gw2"
sleep 3
[ "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$P-gw2")" = "exited 1" ] || quebrou "listener interno: duas redes sem ECHO_ALIAS_REDE_INTERNA" "o gateway subiu: $(docker inspect --format '{{.State.Status}}' "$P-gw2")"
case "$(docker logs "$P-gw2" 2>&1)" in *"gateway: o gateway está em 2 redes e ECHO_ALIAS_REDE_INTERNA não está definido"*) passou "listener interno: duas redes sem o apelido interno recusam subir, com mensagem" ;; *) quebrou "listener interno: mensagem" "$(docker logs "$P-gw2" 2>&1 | tail -3)" ;; esac
docker rm -f "$P-gw2" > /dev/null
# Apelido que resolve para outro IP que não o deste container (rede compartilhada com apelido igual): recusa.
docker run -d --name "$P-viz" --network "$P-default" --network-alias "$P-intruso" --entrypoint sleep "$CADDY_IMG" 300 > /dev/null
gw_duas_redes "$P-gw2" "ECHO_ALIAS_REDE_INTERNA=$P-intruso"
sleep 3
case "$(docker logs "$P-gw2" 2>&1)" in *"que não é IP deste container"*) passou "listener interno: apelido que resolve para IP de outro container é recusado" ;; *) quebrou "listener interno: apelido alheio" "$(docker logs "$P-gw2" 2>&1 | tail -3)" ;; esac
limpar_redes

# --- arquivos do compose --------------------------------------------------------------------------------------------
compose_config() { # ARQUIVO_ENV
  RC=0
  SAIDA=$(cd "$REPO" && docker compose --env-file "$1" config 2>&1) || RC=$?
}
cp "$TMP/env.base" "$TMP/compose.env"
{
  echo "COMPOSE_PROJECT_NAME=echo-teste"
  echo "COMPOSE_FILE=docker-compose.yml"
  echo "ECHO_PUBLIC_URL=http://localhost:8088"
  echo "ECHO_SITE_ADDRESS=:80"
  echo "ECHO_BIND=127.0.0.1"
  echo "ECHO_HTTP_PORT=8088"
  echo "ECHO_HTTPS_PORT="
  echo "ECHO_BEHIND_PROXY=false"
  echo "ECHO_PROXY_NETWORK="
} >> "$TMP/compose.env"
compose_config "$TMP/compose.env"
[ "$RC" -eq 0 ] || quebrou "compose: config do modo localhost" "$SAIDA"
passou "compose: config do modo localhost (exit 0)"
portas=$(printf '%s\n' "$SAIDA" | grep -c 'published:')
[ "$portas" -eq 1 ] || quebrou "compose: só uma porta publicada no modo localhost" "$portas"
passou "compose: o modo localhost publica uma porta só (a 80 do gateway)"
case "$SAIDA" in *"container_name"*) quebrou "compose: sem container_name" "achou container_name" ;; *) passou "compose: nenhum container_name" ;; esac
case "$SAIDA" in *"type: bind"*) quebrou "compose: sem bind mount" "achou bind mount" ;; *) passou "compose: nenhum bind mount" ;; esac

sed -i 's/^COMPOSE_FILE=.*/COMPOSE_FILE=docker-compose.yml:docker\/compose\/dominio.yml/; s/^ECHO_HTTPS_PORT=.*/ECHO_HTTPS_PORT=8443/' "$TMP/compose.env"
compose_config "$TMP/compose.env"
[ "$RC" -eq 0 ] || quebrou "compose: config do modo domínio" "$SAIDA"
case "$SAIDA" in *"protocol: udp"*) passou "compose: o modo domínio publica a 443 também em UDP (HTTP/3)" ;; *) quebrou "compose: 443/udp" "sem protocol: udp" ;; esac

sed -i 's/^COMPOSE_FILE=.*/COMPOSE_FILE=docker-compose.yml:docker\/compose\/proxy-rede.yml/; s/^ECHO_PROXY_NETWORK=.*/ECHO_PROXY_NETWORK=rede-do-proxy/' "$TMP/compose.env"
compose_config "$TMP/compose.env"
[ "$RC" -eq 0 ] || quebrou "compose: config com --proxy-network" "$SAIDA"
case "$SAIDA" in *"echo-teste-gateway-interno"*) ;; *) quebrou "compose: proxy-rede" "falta o apelido echo-teste-gateway-interno na rede default" ;; esac
case "$SAIDA" in *"ECHO_ALIAS_REDE_INTERNA: echo-teste-gateway-interno"*) passou "compose: --proxy-network passa ECHO_ALIAS_REDE_INTERNA ao gateway (apelido só na rede default)" ;; *) quebrou "compose: ECHO_ALIAS_REDE_INTERNA" "ausente" ;; esac
case "$SAIDA" in *"echo-teste-gateway"*"rede-do-proxy"* | *"rede-do-proxy"*"echo-teste-gateway"*) passou "compose: --proxy-network liga o gateway à rede externa com o apelido <projeto>-gateway" ;; *) quebrou "compose: proxy-rede" "$SAIDA" ;; esac

case "$SAIDA" in *"ECHO_REDE_INTERNA: echo-teste_default"*) passou "compose: o gateway recebe ECHO_REDE_INTERNA = <projeto>_default" ;; *) quebrou "compose: ECHO_REDE_INTERNA" "ausente ou diferente de echo-teste_default" ;; esac
case "$SAIDA" in *"name: echo-teste_default"*) passou "compose: a rede default tem o nome fixado <projeto>_default" ;; *) quebrou "compose: nome da rede default" "falta name: echo-teste_default" ;; esac

grep -v '^POSTGRES_PASSWORD=' "$TMP/compose.env" > "$TMP/compose-sem.env"
compose_config "$TMP/compose-sem.env"
[ "$RC" -ne 0 ] || quebrou "compose: variável obrigatória ausente" "o compose aceitou"
case "$SAIDA" in *"restaure o .env (backups/*/.env); numa instalação nova, ./install.sh"*) passou "compose: segredo imutável ausente recusa mandando restaurar o .env do backup" ;; *) quebrou "compose: mensagem" "$SAIDA" ;; esac

grep -v '^QR_WEBHOOK_SECRET=' "$TMP/compose.env" > "$TMP/compose-sem.env"
compose_config "$TMP/compose-sem.env"
[ "$RC" -ne 0 ] || quebrou "compose: segredo gerável ausente" "o compose aceitou"
case "$SAIDA" in *"rode ./install.sh (QR_WEBHOOK_SECRET ausente)"*) passou "compose: segredo gerável ausente recusa com a mensagem 'rode ./install.sh'" ;; *) quebrou "compose: mensagem do gerável" "$SAIDA" ;; esac

# ---------------------------------------------------------------------------------------------------------------
# Robustez da fumaça com a máquina carregada (o que dá para provar sem stack): assinatura do Realtime com tentativas,
# sonda no canal filtrado e a contagem de `job startup timeout` do passo 12.
# ---------------------------------------------------------------------------------------------------------------
if SAIDA=$(cd "$REPO" && node --test scripts/smoke/realtime-lib.test.mjs 2>&1); then
  RT=$(printf '%s\n' "$SAIDA" | awk '/^# pass /{print $3}')
  passou "realtime-lib: assinatura com tentativas e espera crescente, remoção do canal antes de recriar, sondas e tentativas da mensagem principal (node --test: $RT testes)"
else
  quebrou "realtime-lib: node --test" "$(printf '%s\n' "$SAIDA" | tail -40)"
fi
RT_SMOKE=$(cat "$REPO/scripts/smoke/realtime.mjs")
case "$RT_SMOKE" in *"sondarAte("*) ;; *) quebrou "realtime.mjs" "não usa sondarAte" ;; esac
case "$RT_SMOKE" in *"assinarComTentativas("*) passou "realtime.mjs: as assinaturas passam por assinarComTentativas" ;; *) quebrou "realtime.mjs" "não usa assinarComTentativas" ;; esac
case "$RT_SMOKE" in *"dorme(2000)"*) quebrou "realtime.mjs" "voltou a espera fixa de 2 s antes de mandar a mensagem no canal filtrado" ;; *) passou "realtime.mjs: sonda no canal filtrado, sem espera fixa de 2 s" ;; esac
case "$RT_SMOKE" in
  *"tentarMensagem("*"principais.has("*) passou "realtime.mjs: a mensagem principal tem até 3 tentativas (wamid novo), e a checagem de B cobre todas as enviadas" ;;
  *) quebrou "realtime.mjs" "a mensagem principal não passa por tentarMensagem ou a checagem de B não cobre todas as tentativas" ;;
esac
case "$RT_SMOKE" in *"sondas.has("*) passou "realtime.mjs: a checagem de RLS com B vale para todas as sondas enviadas" ;; *) quebrou "realtime.mjs" "a checagem de B não cobre as sondas" ;; esac
# Os imports do realtime.mjs resolvem (um `node --check` não pega nome importado que não existe no módulo): sem ambiente, o
# script passa dos imports e morre na validação do ambiente (Zod); um SyntaxError ou módulo ausente é falha.
if [ -d "$REPO/node_modules/zod" ] && [ -d "$REPO/node_modules/@supabase/supabase-js" ]; then
  SAIDA=$(cd "$REPO" && env -i PATH="$PATH" node scripts/smoke/realtime.mjs 2>&1 || true)
  case "$SAIDA" in
    *SyntaxError* | *ERR_MODULE_NOT_FOUND* | *"Cannot find"*) quebrou "realtime.mjs: imports" "$(printf '%s\n' "$SAIDA" | head -8)" ;;
    *ZodError*) passou "realtime.mjs: os imports resolvem (sem ambiente, morre na validação do Zod, depois dos imports)" ;;
    *) quebrou "realtime.mjs: sem ambiente" "esperava ZodError: $(printf '%s\n' "$SAIDA" | head -8)" ;;
  esac
else
  printf 'PULADO realtime.mjs: imports (sem node_modules; rode npm ci)\n'
fi
SM_SMOKE=$(cat "$REPO/scripts/smoke-selfhost.sh")
case "$SM_SMOKE" in
  *'esperar_ate "19 TLS: o certificado interno do localhost já vale'*'igual "19 TLS: GET /config.js por HTTPS com a CA interna = 200"'*)
    passou "smoke passo 19: espera o certificado interno valer (relógio do host que salta) antes do GET estrito" ;;
  *) quebrou "smoke passo 19" "o GET por HTTPS não espera o certificado interno valer" ;;
esac
case "$SM_SMOKE" in
  *"status = 'failed' AND return_message = 'job startup timeout'"*"status = 'failed' AND return_message IS DISTINCT FROM 'job startup timeout'"*)
    passou "smoke passo 12: 'job startup timeout' é só registro com a contagem; qualquer outra falha (inclusive 55000) reprova" ;;
  *) quebrou "smoke passo 12" "a contagem de failed não separa 'job startup timeout' das demais" ;;
esac

printf 'TESTES INFRA OK (%d)\n' "$N"
