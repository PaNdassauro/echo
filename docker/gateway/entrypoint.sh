#!/bin/sh
# Entrypoint do gateway (busybox ash). A cada subida:
#   1. valida o ambiente (exit 1 com mensagem clara);
#   2. escreve /srv/config.js (configuração de execução do front, seção 3.4 da SPEC);
#   3. escreve (ou apaga) /etc/caddy/gerado/servers-proxy.caddy: trusted_proxies só com ECHO_BEHIND_PROXY=true (D24);
#   4. exporta ECHO_CSP_WS e ECHO_CSP_HTTP (CSP do front quando a URL pública é http://);
#   5. exige ECHO_REDE_INTERNA (os upstreams do Caddyfile são `<serviço>.<rede>`) e confere que os que já resolvem
#      estão na sub-rede da rede interna;
#   6. descobre o IP do gateway na rede do compose e exporta ECHO_BIND_INTERNO (o listener :8000 só escuta nele e no
#      127.0.0.1 do healthcheck: com proxy-rede.yml a rede do proxy NÃO enxerga o :8000) e faz exec do Caddy.
# Nenhum segredo é impresso. Só a ANON_KEY (que é pública por desenho) entra no config.js; a SERVICE_ROLE_KEY nunca.
set -eu

falha() { echo "gateway: $*" >&2; exit 1; }

: "${ANON_KEY:?ANON_KEY ausente (rode ./install.sh)}"
: "${ECHO_PUBLIC_URL:?ECHO_PUBLIC_URL ausente (rode ./install.sh)}"
: "${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY ausente (rode ./install.sh)}"
SITE_ADDRESS="${SITE_ADDRESS:-:80}"; export SITE_ADDRESS
ECHO_BEHIND_PROXY="${ECHO_BEHIND_PROXY:-false}"
# Nome da rede interna do compose (`<projeto>_default`): o Caddyfile qualifica todo upstream com ele (auth.<rede>). Sem
# isto, com a rede do proxy ordenando antes, o DNS do Docker responderia `auth` com um vizinho dela.
: "${ECHO_REDE_INTERNA:?ECHO_REDE_INTERNA ausente (o compose passa <projeto>_default; rode ./install.sh)}"
case "$ECHO_REDE_INTERNA" in
  ''|*[!A-Za-z0-9_.-]*|.*|*.) falha "ECHO_REDE_INTERNA inválido (use o nome da rede do compose, ex.: echo_default)" ;;
esac
export ECHO_REDE_INTERNA

# JWT de três partes base64url (a ANON_KEY vai para o /config.js e as duas chaves entram no texto do Caddyfile).
jwt3() { # nome valor
  case "$2" in
    *[!A-Za-z0-9_.-]*|.*|*.|*..*) falha "$1 não é um JWT de 3 partes (rode ./install.sh)" ;;
  esac
  _pontos=$(printf '%s' "$2" | tr -cd '.')
  [ "${#_pontos}" -eq 2 ] || falha "$1 não é um JWT de 3 partes (rode ./install.sh)"
}
# Payload (2ª parte) decodificado: base64url -> base64 com padding.
jwt_payload() { # valor
  _p=$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')
  case $((${#_p} % 4)) in
    2) _p="$_p==" ;;
    3) _p="$_p=" ;;
    1) return 1 ;;
  esac
  printf '%s' "$_p" | base64 -d 2> /dev/null
}
jwt3 ANON_KEY "$ANON_KEY"
jwt3 SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY"
# Chaves trocadas no .env (edição manual, restore parcial) mandariam a service_role para todo navegador pelo /config.js.
[ "$ANON_KEY" != "$SERVICE_ROLE_KEY" ] || falha "ANON_KEY e SERVICE_ROLE_KEY são iguais (rode ./install.sh)"
case "$(jwt_payload "$ANON_KEY" | tr -d ' ')" in
  *'"role":"anon"'*) ;;
  *) falha "ANON_KEY não tem role anon (as chaves do .env estão trocadas? rode ./install.sh)" ;;
esac
case "$(jwt_payload "$SERVICE_ROLE_KEY" | tr -d ' ')" in
  *'"role":"service_role"'*) ;;
  *) falha "SERVICE_ROLE_KEY não tem role service_role (as chaves do .env estão trocadas? rode ./install.sh)" ;;
esac
# SITE_ADDRESS entra no Caddyfile por substituição de texto: ':porta' ou um nome de host, nada além disso.
case "$SITE_ADDRESS" in
  :[0-9]|:[0-9][0-9]|:[0-9][0-9][0-9]|:[0-9][0-9][0-9][0-9]|:[0-9][0-9][0-9][0-9][0-9]) ;;
  ''|*[!A-Za-z0-9.-]*|.*|-*) falha "SITE_ADDRESS precisa ser ':porta' ou um nome de host (rode ./install.sh)" ;;
esac

# Valores que entram em JSON e em cabeçalho: sem aspas, barra invertida, espaço nem quebra de linha.
seguro() { # nome valor
  case "$2" in
    *\"*|*\\*|*[[:space:]]*) falha "$1 contém aspas, barra invertida ou espaço" ;;
  esac
}
seguro ECHO_PUBLIC_URL "$ECHO_PUBLIC_URL"
seguro VAPID_PUBLIC_KEY "${VAPID_PUBLIC_KEY:-}"
seguro FEEDBACK_WEBHOOK_URL "${FEEDBACK_WEBHOOK_URL:-}"
case "${FEEDBACK_WEBHOOK_URL:-}" in
  ''|http://*|https://*) ;;
  *) falha "FEEDBACK_WEBHOOK_URL precisa começar com http:// ou https:// (ou ficar vazia)" ;;
esac

case "$ECHO_PUBLIC_URL" in
  http://*|https://*) ;;
  *) falha "ECHO_PUBLIC_URL precisa começar com http:// ou https://" ;;
esac
case "$ECHO_PUBLIC_URL" in
  */) falha "ECHO_PUBLIC_URL não pode terminar com barra" ;;
esac
case "$ECHO_BEHIND_PROXY" in
  true|false) ;;
  *) falha "ECHO_BEHIND_PROXY precisa ser true ou false" ;;
esac

# Flags (calculadas só aqui). `email:true` só quando o envio funciona de verdade, a mesma regra de
# supabase/functions/_shared/email.ts (`lerConfigEmail`) e do `./echo doctor`: SMTP_HOST com remetente (EMAIL_FROM ou
# SMTP_ADMIN_EMAIL), ou RESEND_API_KEY com EMAIL_FROM. Mudou aqui, muda lá. A recuperação de senha é do GoTrue, que
# só lê SMTP_HOST e SMTP_ADMIN_EMAIL (EMAIL_FROM é das edges).
vazio() { [ -z "$(printf '%s' "${1:-}" | tr -d '[:space:]')" ]; }
smtp=false
if ! vazio "${SMTP_HOST:-}" && { ! vazio "${EMAIL_FROM:-}" || ! vazio "${SMTP_ADMIN_EMAIL:-}"; }; then smtp=true; fi
resend=false; if ! vazio "${RESEND_API_KEY:-}" && ! vazio "${EMAIL_FROM:-}"; then resend=true; fi
email=false; if [ "$smtp" = true ] || [ "$resend" = true ]; then email=true; fi
recuperacao=false
if ! vazio "${SMTP_HOST:-}" && ! vazio "${SMTP_ADMIN_EMAIL:-}"; then recuperacao=true; fi
feedback=false
if ! vazio "${FEEDBACK_WEBHOOK_URL:-}"; then
  feedback=true
elif ! vazio "${FEEDBACK_EMAILS:-}" && [ "$email" = true ]; then
  feedback=true
fi

tmp=/srv/.config.js.tmp
printf 'window.__ECHO_CONFIG__ = {"supabaseAnonKey":"%s","siteUrl":"%s","vapidPublicKey":"%s","feedbackWebhookUrl":"%s","features":{"email":%s,"recuperacaoSenha":%s,"feedback":%s,"transformacaoImagem":false}};\n' \
  "$ANON_KEY" "$ECHO_PUBLIC_URL" "${VAPID_PUBLIC_KEY:-}" "${FEEDBACK_WEBHOOK_URL:-}" "$email" "$recuperacao" "$feedback" > "$tmp"
mv "$tmp" /srv/config.js

# trusted_proxies: só atrás de proxy. Em outro modo o Caddy não confia em nenhum X-Forwarded-For e o limite por IP do
# GoTrue usa o IP da conexão. O arquivo some se o modo mudou (o container reinicia com a camada gravável antiga).
mkdir -p /etc/caddy/gerado
rm -f /etc/caddy/gerado/servers-proxy.caddy
if [ "$ECHO_BEHIND_PROXY" = true ]; then
  printf 'trusted_proxies static private_ranges\ntrusted_proxies_strict\n' > /etc/caddy/gerado/servers-proxy.caddy
fi

# CSP quando a URL pública é http:// (os dois vazios com https://):
#   ECHO_CSP_WS   ' ws://host[:porta]'   no connect-src (o 'self' não cobre ws:);
#   ECHO_CSP_HTTP ' http://host[:porta]' em img-src, media-src e connect-src: a mídia gravada leva a base
#                 ECHO_PUBLIC_URL, e quem abre o painel por outro endereço do mesmo gateway não a teria como 'self'.
# A origem liberada é só a canônica (a do próprio ECHO_PUBLIC_URL).
ECHO_CSP_WS=""
ECHO_CSP_HTTP=""
case "$ECHO_PUBLIC_URL" in
  http://*)
    host=${ECHO_PUBLIC_URL#http://}
    host=${host%%/*}
    ECHO_CSP_WS=" ws://$host"
    ECHO_CSP_HTTP=" http://$host"
    ;;
esac
export ECHO_CSP_WS ECHO_CSP_HTTP

# Listener interno (:8000): só na rede do compose. Sem isto ele escutaria em TODAS as interfaces, e com a rede externa do
# proxy (proxy-rede.yml, ou um `docker network connect` do Coolify/Traefik) qualquer container vizinho chegaria a
# http://<projeto>-gateway:8000, que não tem limite de login por IP nem os bloqueios do site público.
#   - uma interface (o caso normal): o IP dela;
#   - mais de uma: o IP que o apelido ECHO_ALIAS_REDE_INTERNA tem (o proxy-rede.yml o põe SÓ na rede default) e que
#     tem de ser de uma das interfaces; sem isso o gateway recusa subir, em vez de escolher uma rede no chute.
# Um `docker network connect` depois da subida não abre nada: o bind é no IP.
ips=$(ip -4 -o addr show scope global | awk '{ sub(/\/.*/, "", $4); print $4 }')
n_ips=$(printf '%s\n' "$ips" | grep -c . || true)
ip_interno=""
if [ "$n_ips" -eq 1 ]; then
  ip_interno=$ips
elif [ "$n_ips" -gt 1 ]; then
  [ -n "${ECHO_ALIAS_REDE_INTERNA:-}" ] || falha "o gateway está em $n_ips redes e ECHO_ALIAS_REDE_INTERNA não está definido: ligue o proxy com ./install.sh --proxy-network (docker/compose/proxy-rede.yml)"
  tentativa=0
  while [ -z "$ip_interno" ] && [ "$tentativa" -lt 10 ]; do
    ip_interno=$(getent hosts "$ECHO_ALIAS_REDE_INTERNA" 2> /dev/null | awk 'NR == 1 { print $1 }' || true)
    [ -n "$ip_interno" ] || { tentativa=$((tentativa + 1)); sleep 1; }
  done
  [ -n "$ip_interno" ] || falha "não resolvi o apelido $ECHO_ALIAS_REDE_INTERNA (rede interna do compose)"
  printf '%s\n' "$ips" | grep -qxF "$ip_interno" || falha "o apelido $ECHO_ALIAS_REDE_INTERNA resolveu para $ip_interno, que não é IP deste container"
else
  falha "nenhuma interface de rede com IPv4 no gateway"
fi
ECHO_BIND_INTERNO="127.0.0.1 $ip_interno"; export ECHO_BIND_INTERNO

# Os upstreams qualificados (<serviço>.<rede>) evitam a colisão ACIDENTAL do nome curto (um vizinho da rede do proxy com
# apelido `auth`, `rest`… que o DNS do Docker ordenasse antes). NÃO protegem contra um container hostil da rede do proxy
# que escolha o apelido literal `<serviço>.<rede>` (medido: o DNS do Docker casa o nome inteiro antes de separar o
# serviço da rede). Esta conferência de sub-rede é cinto e suspensório e só vale NA SUBIDA: pega o vizinho que já existe,
# não o que nascer depois. A rede do proxy tem de ter só containers de confiança (docs/reverse-proxy.md).
# Os upstreams que ainda não subiram (qr e functions podem nascer depois do gateway) não resolvem e ficam de fora.
ip_int() { # a.b.c.d -> inteiro
  _o1=${1%%.*}; _r=${1#*.}; _o2=${_r%%.*}; _r=${_r#*.}; _o3=${_r%%.*}; _o4=${_r#*.}
  echo $(( (_o1 << 24) | (_o2 << 16) | (_o3 << 8) | _o4 ))
}
prefixo=$(ip -4 -o addr show scope global | awk -v ip="$ip_interno" '{ split($4, a, "/"); if (a[1] == ip) print a[2] }' | head -n 1)
case "$prefixo" in ''|*[!0-9]*) falha "não achei a máscara da rede interna ($ip_interno)" ;; esac
if [ "$prefixo" -eq 0 ]; then mascara=0; else mascara=$(( (0xFFFFFFFF << (32 - prefixo)) & 0xFFFFFFFF )); fi
for servico in auth rest storage realtime functions qr; do
  ip_servico=$(getent hosts "$servico.$ECHO_REDE_INTERNA" 2> /dev/null | awk 'NR == 1 { print $1 }' || true)
  [ -n "$ip_servico" ] || continue
  [ $(( $(ip_int "$ip_servico") & mascara )) -eq $(( $(ip_int "$ip_interno") & mascara )) ] \
    || falha "$servico.$ECHO_REDE_INTERNA resolveu para $ip_servico, fora da sub-rede da rede interna ($ip_interno/$prefixo)"
done

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
