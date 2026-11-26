#!/usr/bin/env bash
# Fumaça ponta a ponta do Echo auto-hospedado: sobe o stack REAL (docker-compose.yml) num projeto próprio, exercita a
# instalação do começo ao fim e derruba tudo. É a prova de que `git clone` + `./install.sh` funciona.
#
#   bash scripts/smoke-selfhost.sh [--manter]
#
# Variáveis: SMOKE_PROJECT=echo-smoke  SMOKE_HTTP_PORT=58290  SMOKE_HTTPS_PORT=58291  SMOKE_MAILPIT_PORT=58292
#            SMOKE_GEN_KEYS="node docker/tools/gen-keys.mjs"   (só para medir com outro gerador de .env)
# Pré-requisitos: Docker, Node >= 20 e `npm ci` na raiz (usa o supabase-js do repo com transport ws).
# Cada checagem imprime `OK <nome>` ou `FALHOU <nome>: <detalhe>`; termina com `SMOKE OK (<n> checagens)` e exit 0,
# ou exit 1 na primeira falha. O `trap` derruba o projeto (down -v) e apaga as pastas temporárias, salvo com --manter.
# Nunca abre sessão de WhatsApp: o webhook é chamado pelo gateway interno, como o qr-service faria.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO"

SMOKE_PROJECT=${SMOKE_PROJECT:-echo-smoke}
SMOKE_HTTP_PORT=${SMOKE_HTTP_PORT:-58290}
SMOKE_HTTPS_PORT=${SMOKE_HTTPS_PORT:-58291}
SMOKE_MAILPIT_PORT=${SMOKE_MAILPIT_PORT:-58292}
BASE="http://localhost:$SMOKE_HTTP_PORT"
MANTER=0
for arg in "$@"; do
  case "$arg" in
    --manter) MANTER=1 ;;
    -h | --help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "opção desconhecida: $arg" >&2
      exit 2
      ;;
  esac
done

TMP=$(mktemp -d "${TMPDIR:-/tmp}/echo-smoke.XXXXXX")
chmod 700 "$TMP"
ENVF="$TMP/.env"
ESTADO="$TMP/estado"
mkdir -p "$ESTADO"

# shellcheck source=scripts/smoke/lib.sh
source "$REPO/scripts/smoke/lib.sh"

limpar() {
  local rc=$?
  set +e
  if [ "$MANTER" = 1 ]; then
    log "--manter: stack $SMOKE_PROJECT de pé em $BASE (env em $ENVF, apague a pasta $TMP quando terminar)"
    return "$rc"
  fi
  if [ -f "$ENVF" ]; then
    dc down -v --remove-orphans > /dev/null 2>&1
  fi
  if [ -f "$TMP/neg/.env" ]; then
    dcenv "$TMP/neg/.env" echo-smoke-neg down -v --remove-orphans > /dev/null 2>&1
  fi
  for s in db gateway functions qr; do docker rmi "echo-smoke-neg-$s:local" > /dev/null 2>&1; done
  if [ -n "${ENVF2:-}" ] && [ "$ENVF2" != "$ENVF" ]; then
    dcenv "$ENVF2" "$SMOKE_PROJECT" down -v --remove-orphans > /dev/null 2>&1
  fi
  rm -rf "$TMP"
  return "$rc"
}
trap limpar EXIT

# ---------------------------------------------------------------------------------------------------------------
# Pré-requisitos
# ---------------------------------------------------------------------------------------------------------------
docker info > /dev/null 2>&1 || falhou "pré-requisito" "docker indisponível"
docker compose version > /dev/null 2>&1 || falhou "pré-requisito" "docker compose indisponível"
node_maior=$(node -p 'process.versions.node.split(".")[0]' 2> /dev/null || echo 0)
[ "$node_maior" -ge 20 ] || falhou "pré-requisito" "Node >= 20 (achei $node_maior)"
[ -f "$REPO/node_modules/@supabase/supabase-js/package.json" ] || falhou "pré-requisito" "rode npm ci na raiz do repo"
for porta in "$SMOKE_HTTP_PORT" "$SMOKE_HTTPS_PORT" "$SMOKE_MAILPIT_PORT"; do
  if (exec 3<> "/dev/tcp/127.0.0.1/$porta") 2> /dev/null; then falhou "pré-requisito" "porta $porta ocupada"; fi
done

read -r -a GEN_KEYS <<< "${SMOKE_GEN_KEYS:-node docker/tools/gen-keys.mjs}"
# Senhas descartáveis: geradas a cada execução, só existem neste stack temporário.
senha_descartavel() { printf 'Smoke%s1' "$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"; }
SENHA_A=$(senha_descartavel)
SENHA_NOVA=$(senha_descartavel)
SENHA_INTRUSO=$(senha_descartavel)
SENHA_ERRADA=$(senha_descartavel)
EMAIL_A='admin@example.com'
EMAIL_B='b@example.com'
SENHA_B=$(senha_descartavel)
COMPOSE_SMOKE='docker-compose.yml:scripts/smoke/compose.smoke.yml'

# Segredos que a guarda do passo 0 confere (mesma lista da seção 3.2 da SPEC).
SEGREDOS_GUARDA=(POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY VAULT_ROOT_KEY AI_KEY_SECRET
  REALTIME_SECRET_KEY_BASE REALTIME_DB_ENC_KEY REALTIME_RELEASE_COOKIE QR_WEBHOOK_SECRET WHATSAPP_VERIFY_TOKEN
  INSTAGRAM_OAUTH_STATE_SECRET ZAPO_DB_PASSWORD ECHO_SETUP_TOKEN)

# Tempos dos passos 1, 18 e 20 (registro, sem asserção).
T_PASSO1=0 T_PASSO18=0 T_PASSO20=0

gerar_env() { # ARQUIVO [COMPOSE_FILE]
  "${GEN_KEYS[@]}" --out "$1" --public-url "$BASE" --site-address ':80' --bind 127.0.0.1 \
    --http-port "$SMOKE_HTTP_PORT" --project "$SMOKE_PROJECT" > /dev/null
  senv "$1" COMPOSE_FILE "${2:-$COMPOSE_SMOKE}"
  senv "$1" SMOKE_MAILPIT_PORT "$SMOKE_MAILPIT_PORT"
}

# ---------------------------------------------------------------------------------------------------------------
# Construção das imagens, uma por vez (pico de RAM de um build só), antes do passo 0: o passo 0 reaproveita as imagens
# do projeto principal, em vez de construir tudo de novo para um stack que nunca sobe.
# ---------------------------------------------------------------------------------------------------------------
gerar_env "$ENVF"
t0=$(date +%s)
for servico in db gateway functions qr; do
  log "construindo $servico…"
  dc build "$servico" > "$TMP/build-$servico.log" 2>&1 || {
    tail -40 "$TMP/build-$servico.log" >&2
    falhou "construção" "docker compose build $servico falhou"
  }
done
log "imagens construídas em $(($(date +%s) - t0))s"

# ---------------------------------------------------------------------------------------------------------------
# 0. Guarda de segredos: o .env.example NÃO sobe.
# ---------------------------------------------------------------------------------------------------------------
passo0() {
  local d="$TMP/neg" s v n achados=0
  mkdir -p "$d"
  [ -f "$REPO/.env.example" ] || falhou "0 guarda de segredos" ".env.example ausente"
  cp "$REPO/.env.example" "$d/.env"
  senv "$d/.env" COMPOSE_PROJECT_NAME echo-smoke-neg
  senv "$d/.env" ECHO_HTTP_PORT "$SMOKE_HTTP_PORT"
  for s in db gateway functions qr; do docker tag "$SMOKE_PROJECT-$s:local" "echo-smoke-neg-$s:local"; done
  if dcenv "$d/.env" echo-smoke-neg up -d --wait --wait-timeout 300 > "$d/up.log" 2>&1; then
    falhou "0 guarda de segredos" "o stack subiu com o .env.example"
  fi
  ok "0 guarda: up com .env.example saiu com erro"
  n=$(dcenv "$d/.env" echo-smoke-neg ps --status running -q gateway | wc -l)
  igual "0 guarda: nenhum container gateway de pé" "$n" 0
  dcenv "$d/.env" echo-smoke-neg logs --no-color --no-log-prefix > "$d/logs.txt" 2>&1 || true
  cat "$d/up.log" >> "$d/logs.txt"
  contem "0 guarda: o log cita a variável recusada" "$(cat "$d/logs.txt")" "preflight:"
  for s in "${SEGREDOS_GUARDA[@]}"; do
    v=$(lenv "$d/.env" "$s")
    [ "${#v}" -ge 12 ] || continue
    if grep -qF -- "$v" "$d/logs.txt"; then achados=$((achados + 1)); fi
  done
  igual "0 guarda: o log não tem valor de segredo" "$achados" 0
  dcenv "$d/.env" echo-smoke-neg down -v --remove-orphans > /dev/null 2>&1
  for s in db gateway functions qr; do docker rmi "echo-smoke-neg-$s:local" > /dev/null 2>&1 || true; done
}
passo0

# ---------------------------------------------------------------------------------------------------------------
# 1. Subida
# ---------------------------------------------------------------------------------------------------------------
passo1() {
  senv "$ENVF" SMTP_HOST mailpit
  senv "$ENVF" SMTP_PORT 1025
  senv "$ENVF" SMTP_SECURE none
  senv "$ENVF" SMTP_ADMIN_EMAIL noreply@example.com
  local t0
  t0=$(date +%s)
  dc up -d --build --wait --wait-timeout 900 > "$TMP/up.log" 2>&1 || {
    tail -60 "$TMP/up.log" >&2
    dc ps -a >&2 || true
    falhou "1 subida" "up -d --wait falhou"
  }
  T_PASSO1=$(($(date +%s) - t0))
  # Instante do fim do `up --wait`, pelo relógio do banco (o passo 12 só conta respostas do pg_net depois dele).
  T_SUBIDA=$(sql "SELECT now()")
  ok "1 subida: stack saudável em ${T_PASSO1}s"
}
passo1

# ---------------------------------------------------------------------------------------------------------------
# 2. Gateway e superfície
# ---------------------------------------------------------------------------------------------------------------
csp_esperada() {
  node -e '
    const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const grupo = v.headers.find((g) => g.source === "/(.*)" && g.headers.some((h) => h.key === "Content-Security-Policy"));
    const csp = grupo.headers.find((h) => h.key === "Content-Security-Policy").value;
    // As duas exceções do gateway com ECHO_PUBLIC_URL http:// (ECHO_CSP_WS e ECHO_CSP_HTTP): ws:// só no connect-src,
    // http:// da origem canônica no img-src, media-src e connect-src. Diretiva ausente no vercel.json derruba o passo.
    const origem = "localhost:" + process.argv[2];
    const extras = { "img-src": " http://" + origem, "connect-src": " ws://" + origem + " http://" + origem, "media-src": " http://" + origem };
    let esperada = csp;
    for (const [diretiva, extra] of Object.entries(extras)) {
      const re = new RegExp("(" + diretiva + " [^;]*)");
      if (!re.test(esperada)) throw new Error("diretiva ausente no vercel.json: " + diretiva);
      esperada = esperada.replace(re, "$1" + extra);
    }
    process.stdout.write(esperada);
  ' "$REPO/vercel.json" "$SMOKE_HTTP_PORT"
}

passo2() {
  local anon srv csp raiz cfg
  anon=$(lenv "$ENVF" ANON_KEY)
  srv=$(lenv "$ENVF" SERVICE_ROLE_KEY)
  igual "2 GET / = 200" "$(status "$BASE/")" 200
  contem "2 GET / é text/html" "$(cabecalho "$BASE/" content-type)" "text/html"
  csp=$(csp_esperada)
  igual "2 CSP de / igual à do vercel.json (+ ws e http da origem canônica)" "$(cabecalho "$BASE/" content-security-policy)" "$csp"
  igual "2 /dashboard/x = 200" "$(status "$BASE/dashboard/x")" 200
  raiz=$(corpo "$BASE/dashboard/x")
  contem "2 /dashboard/x devolve o HTML do front" "$raiz" "<div id=\"root\">"
  igual "2 /assets/nao-existe.js = 404" "$(status "$BASE/assets/nao-existe.js")" 404
  cfg=$(corpo "$BASE/config.js")
  contem "2 /config.js tem a ANON_KEY" "$cfg" "$anon"
  contem "2 /config.js: e-mail ligado (SMTP do mailpit)" "$cfg" '"email":true'
  contem "2 /config.js: sem transformação de imagem" "$cfg" '"transformacaoImagem":false'
  nao_contem "2 /config.js não tem a SERVICE_ROLE_KEY" "$cfg" "$srv"
  igual "2 /rest/v1/ com a anon = 403" "$(status "$BASE/rest/v1/" -H "apikey: $anon")" 403
  igual "2 /auth/v1/health sem apikey = 401" "$(status "$BASE/auth/v1/health")" 401
  igual "2 /auth/v1/health com apikey = 200" "$(status "$BASE/auth/v1/health" -H "apikey: $anon")" 200
  igual "2 /auth/v1/admin/users com a anon = 404 no público" "$(status "$BASE/auth/v1/admin/users" -H "apikey: $anon")" 404
  igual "2 /qr/health = 404 no público" "$(status "$BASE/qr/health")" 404
  contem "2 /qr/health = 200 pelo interno" "$(dc exec -T gateway wget -qO- http://127.0.0.1:8000/qr/health)" '"status"'
  igual "2 /realtime/v1/api/tenants = 403" "$(status "$BASE/realtime/v1/api/tenants" -H "apikey: $anon")" 403
  local servico porta saida
  for par in 'db 5432' 'rest 3000' 'realtime 4000' 'functions 9000' 'qr 3000'; do
    servico=${par% *}
    porta=${par#* }
    saida=$(dc port "$servico" "$porta" 2> /dev/null || true)
    # `docker compose port` de porta não publicada imprime ":0" (Compose 5.0.2), "invalid IP:0" (Compose do runner
    # do GitHub) ou nada. Porta publicada nunca termina em ":0".
    case "$saida" in *:0) saida="" ;; esac
    igual "2 porta $servico:$porta não publicada" "$saida" ""
  done
}
passo2

# ---------------------------------------------------------------------------------------------------------------
# 3. Primeiro acesso
# ---------------------------------------------------------------------------------------------------------------
passo3() {
  local anon codigo corpo_ok r
  anon=$(lenv "$ENVF" ANON_KEY)
  codigo=$(lenv "$ENVF" ECHO_SETUP_TOKEN)
  igual "3 GET primeiro-acesso: precisa_setup" "$(corpo "$BASE/functions/v1/primeiro-acesso" | json precisa_setup)" true
  corpo_ok="{\"codigo\":\"$codigo\",\"nome\":\"Admin Fumaça\",\"email\":\"$EMAIL_A\",\"senha\":\"$SENHA_A\",\"organizacao\":\"Org Fumaça\"}"
  igual "3 POST com código errado = 403" "$(status "$BASE/functions/v1/primeiro-acesso" -X POST -H 'content-type: application/json' \
    -d "{\"codigo\":\"codigo-errado\",\"nome\":\"Admin\",\"email\":\"$EMAIL_A\",\"senha\":\"$SENHA_A\",\"organizacao\":\"Org Fumaça\"}")" 403
  r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/functions/v1/primeiro-acesso" -H 'content-type: application/json' -d "$corpo_ok")
  igual "3 POST certo = 201" "${r##*$'\n'}" 201
  contem "3 POST certo devolve organization_id" "$r" '"organization_id"'
  igual "3 POST de novo = 409" "$(status "$BASE/functions/v1/primeiro-acesso" -X POST -H 'content-type: application/json' -d "$corpo_ok")" 409
  igual "3 GET primeiro-acesso: precisa_setup = false" "$(corpo "$BASE/functions/v1/primeiro-acesso" | json precisa_setup)" false
  igual "3 signup sem convite = 403 (hook)" "$(status "$BASE/auth/v1/signup" -X POST -H "apikey: $anon" -H 'content-type: application/json' \
    -d "{\"email\":\"intruso@example.com\",\"password\":\"$SENHA_INTRUSO\"}")" 403
}
passo3

# ---------------------------------------------------------------------------------------------------------------
# 4. Login
# ---------------------------------------------------------------------------------------------------------------
passo4() {
  local r
  r=$(login "$EMAIL_A" "$SENHA_A")
  TOKEN_A=$(printf '%s' "$r" | json access_token)
  UID_A=$(printf '%s' "$r" | json user.id)
  [ -n "$TOKEN_A" ] || falhou "4 login" "sem access_token: ${r:0:200}"
  ok "4 login do admin = 200 (token A)"
}
passo4

# ---------------------------------------------------------------------------------------------------------------
# 5. Dados: linha QR da organização A (pelo REST, com o token A) e a organização B (service_role, controle de RLS)
# ---------------------------------------------------------------------------------------------------------------
passo5() {
  local anon r saida
  anon=$(lenv "$ENVF" ANON_KEY)
  ORG_A=$(corpo "$BASE/rest/v1/organization_members?select=organization_id&user_id=eq.$UID_A" -H "apikey: $anon" -H "Authorization: Bearer $TOKEN_A" | json '[0].organization_id')
  [ -n "$ORG_A" ] || falhou "5 dados" "o admin não tem organização"
  r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/rest/v1/phone_numbers" -H "apikey: $anon" -H "Authorization: Bearer $TOKEN_A" \
    -H 'content-type: application/json' -H 'Prefer: return=representation' \
    -d "{\"organization_id\":\"$ORG_A\",\"connection_type\":\"qr\",\"qr_provider\":\"baileys\",\"is_active\":true,\"phone_number_id\":\"smoke-5511999990001\",\"phone_number\":\"5511999990001\",\"display_name\":\"Linha Fumaça A\"}")
  igual "5 POST phone_numbers (linha QR) com o token A = 201" "${r##*$'\n'}" 201
  LINHA_A=$(printf '%s' "${r%$'\n'*}" | json '[0].id')
  [ -n "$LINHA_A" ] || falhou "5 dados" "linha A sem id: ${r:0:200}"

  saida=$(no_qr <<EOF
const U = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_KEY;
const h = { apikey: SR, Authorization: 'Bearer ' + SR, 'content-type': 'application/json', Prefer: 'return=representation' };
const post = async (caminho, corpo) => {
  const r = await fetch(U + caminho, { method: 'POST', headers: h, body: JSON.stringify(corpo) });
  const t = await r.text();
  if (!r.ok) throw new Error(caminho + ' ' + r.status + ' ' + t.slice(0, 200));
  return JSON.parse(t);
};
(async () => {
  const u = await post('/auth/v1/admin/users', { email: '$EMAIL_B', password: '$SENHA_B', email_confirm: true });
  const org = (await post('/rest/v1/organizations', { name: 'Org Fumaça B', slug: 'org-fumaca-b' }))[0];
  await post('/rest/v1/organization_members', { organization_id: org.id, user_id: u.id, role: 'admin' });
  const linha = (await post('/rest/v1/phone_numbers', { organization_id: org.id, connection_type: 'qr', qr_provider: 'baileys', is_active: true, phone_number_id: 'smoke-5511999990002', phone_number: '5511999990002', display_name: 'Linha Fumaça B' }))[0];
  console.log(JSON.stringify({ uid: u.id, org: org.id, linha: linha.id }));
})().catch((e) => { console.error(String(e)); process.exit(1); });
EOF
  ) || falhou "5 dados" "criação da organização B falhou: $saida"
  UID_B=$(printf '%s' "$saida" | json uid)
  LINHA_B=$(printf '%s' "$saida" | json linha)
  [ -n "$UID_B" ] && [ -n "$LINHA_B" ] || falhou "5 dados" "saída inesperada do script B: $saida"
  ok "5 usuário B, organização B e linha B criados com a service_role (controle negativo de RLS)"
}
passo5

# ---------------------------------------------------------------------------------------------------------------
# 6. Entrada + Realtime com RLS; 10 variantes de subcaminho do webhook no público
# ---------------------------------------------------------------------------------------------------------------
exec_qr_prefixo() {
  printf "cd '%s' && docker compose --env-file '%s' -p '%s' exec -T qr" "$REPO" "$ENVF" "$SMOKE_PROJECT"
}

rodar_node_smoke() { # ARQUIVO [ARGS…]: roda o script, conta as linhas OK dele e propaga a falha
  local arq=$1 saida rc=0 n
  shift
  saida="$TMP/$(basename "$arq").out"
  node "$arq" "$@" > "$saida" 2>&1 || rc=$?
  cat "$saida"
  [ "$rc" -eq 0 ] || falhou "$(basename "$arq")" "saiu com $rc"
  n=$(grep -c '^OK ' "$saida" || true)
  SMOKE_N_OK=$((SMOKE_N_OK + n))
}

env_node_usuarios() {
  export ECHO_URL="$1" ANON_KEY SMOKE_A_EMAIL="$EMAIL_A" SMOKE_A_PASSWORD="$SENHA_A" SMOKE_B_EMAIL="$EMAIL_B" SMOKE_B_PASSWORD="$SENHA_B"
  ANON_KEY=$(lenv "$ENVF" ANON_KEY)
}

passo6() {
  local v codigo
  env_node_usuarios "$BASE"
  export SMOKE_LINHA_A="$LINHA_A" SMOKE_EXEC_QR
  SMOKE_EXEC_QR=$(exec_qr_prefixo)
  rodar_node_smoke "$REPO/scripts/smoke/realtime.mjs"
  WAMID_6=$(grep '^WAMID ' "$TMP/realtime.mjs.out" | tail -1 | cut -d' ' -f2)
  [ -n "$WAMID_6" ] || falhou "6 realtime" "o script não informou o wamid"
  # As variantes de subcaminho do webhook no público (todo subcaminho = 404; a raiz exata e a raiz com query seguem).
  for v in "/functions/v1/whatsapp-webhook/qr-message" "/functions/v1/whatsapp-webhook/a/qr-message" \
    "/functions/v1/whatsapp-webhook//qr-message" "/functions/v1/whatsapp-webhook/%71r-message" \
    "/functions/v1/Whatsapp-webhook/qr-message" "/functions/v1/whatsapp-webhook%2Fqr-message" \
    "/functions/v1//whatsapp-webhook/qr-message" "/functions/v1/./whatsapp-webhook/qr-message" \
    "/functions/v1/x/../whatsapp-webhook/qr-message" "/functions/v1/whatsapp-webhook/"; do
    codigo=$(status "$BASE$v" -X POST -H 'content-type: application/json' -H "x-qr-secret: $(lenv "$ENVF" QR_WEBHOOK_SECRET)" -d '{}')
    igual "6 público: $v = 404" "$codigo" 404
  done
  codigo=$(status "$BASE/functions/v1/whatsapp-webhook" -X POST -H 'content-type: application/json' -d '{}')
  [ "$codigo" != 404 ] || falhou "6 público: a raiz do webhook segue para a função" "404"
  ok "6 público: a raiz exata do webhook segue para a função (HTTP $codigo)"
}
passo6

# ---------------------------------------------------------------------------------------------------------------
# 7. Mídia gravada pela edge: media_url com a base PÚBLICA, abrindo do host
# ---------------------------------------------------------------------------------------------------------------
PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
passo7() {
  local wamid saida url esperado_sha obtido
  wamid="3EB0SMKMEDIA$(date +%s)"
  saida=$(no_qr <<EOF
(async () => {
  const r = await fetch(process.env.WEBHOOK_URL + '/qr-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qr-secret': process.env.QR_WEBHOOK_SECRET },
    body: JSON.stringify({ phone_number_id: '$LINHA_A', from: '5511988887777', content: '', contact_name: 'Contato Fumaça',
      message_id: '$wamid', timestamp: Math.floor(Date.now() / 1000), message_type: 'image', is_group: false, from_me: false,
      media_base64: '$PNG_B64', media_mime_type: 'image/png', media_filename: 'fumaca.png' }),
  });
  console.log(r.status, (await r.text()).slice(0, 200));
})();
EOF
  )
  igual "7 /qr-message com imagem = 200" "${saida%% *}" 200
  url=$(sql "SELECT media_url FROM messages WHERE whatsapp_message_id = '$wamid'")
  case "$url" in
    "$BASE/storage/v1/object/public/attachments/"*) ok "7 media_url começa com a base pública" ;;
    *) falhou "7 media_url com a base pública" "obtido '$url'" ;;
  esac
  curl -s --max-time 60 -o "$TMP/midia.bin" -w '%{http_code}' "$url" > "$TMP/midia.status"
  igual "7 GET da mídia pelo host = 200" "$(cat "$TMP/midia.status")" 200
  esperado_sha=$(printf '%s' "$PNG_B64" | base64 -d | sha256sum | cut -d' ' -f1)
  obtido=$(sha_arquivo "$TMP/midia.bin")
  igual "7 sha256 da mídia igual ao do PNG enviado" "$obtido" "$esperado_sha"
  MIDIA_URL_7=$url
}
passo7

# ---------------------------------------------------------------------------------------------------------------
# 8. Storage com o token A
# ---------------------------------------------------------------------------------------------------------------
passo8() {
  env_node_usuarios "$BASE"
  export SMOKE_STATE_DIR="$ESTADO"
  rodar_node_smoke "$REPO/scripts/smoke/storage.mjs"
}
passo8

# ---------------------------------------------------------------------------------------------------------------
# 9. TUS de 20 MiB, de dentro do qr, pelo gateway interno com a service_role
# ---------------------------------------------------------------------------------------------------------------
passo9() {
  local saida sha_dentro objeto url sha_fora
  saida=$(no_qr <<'EOF'
(async () => {
  const { writeFileSync, rmSync } = await import('node:fs');
  const { randomBytes, createHash } = await import('node:crypto');
  const { uploadFileResumable } = await import('/app/dist/lib/resumableUpload.js');
  const tamanho = 20 * 1024 * 1024;
  const dados = randomBytes(tamanho);
  const caminho = '/tmp/tus-fumaca.bin';
  writeFileSync(caminho, dados);
  const objeto = 'inbound/smoke/' + Date.now() + '_tus.bin';
  await uploadFileResumable({
    endpoint: process.env.SUPABASE_URL + '/storage/v1/upload/resumable', apiKey: process.env.SUPABASE_SERVICE_KEY,
    bucket: 'attachments', objectName: objeto, contentType: 'application/octet-stream', filePath: caminho, size: tamanho,
    fetchImpl: fetch, retryDelaysMs: [200, 1000], requestTimeoutMs: 60000,
  });
  rmSync(caminho, { force: true });
  console.log(JSON.stringify({ objeto, sha: createHash('sha256').update(dados).digest('hex') }));
})().catch((e) => { console.error(String(e && e.message ? e.message : e)); process.exit(1); });
EOF
  ) || falhou "9 TUS" "upload resumível falhou: $saida"
  objeto=$(printf '%s' "$saida" | json objeto)
  sha_dentro=$(printf '%s' "$saida" | json sha)
  url="$BASE/storage/v1/object/public/attachments/$objeto"
  igual "9 TUS de 20 MiB: GET público pelo host = 200" "$(curl -s --max-time 120 -o "$TMP/tus.bin" -w '%{http_code}' "$url")" 200
  sha_fora=$(sha_arquivo "$TMP/tus.bin")
  igual "9 TUS de 20 MiB: sha256 igual ao enviado" "$sha_fora" "$sha_dentro"
  rm -f "$TMP/tus.bin"
}
passo9

# 9b. Arquivo guardado com tipo ativo (SVG) sai do storage com CSP sandbox e nosniff, pelo site público (o gateway serve o
# Storage na mesma origem do app: sem isso o SVG rodaria script lendo o token de sessão do localStorage).
passo9b() {
  local sr cab
  sr=$(lenv "$ENVF" SERVICE_ROLE_KEY)
  printf '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>' > "$TMP/ativo.svg"
  igual "9b upload de SVG pelo gateway = 200" "$(curl -s --max-time 60 -o /dev/null -w '%{http_code}' -X POST "$BASE/storage/v1/object/attachments/inbound/smoke/ativo-$$.svg" \
    -H "apikey: $sr" -H "Authorization: Bearer $sr" -H 'content-type: image/svg+xml' --data-binary "@$TMP/ativo.svg")" 200
  cab=$(curl -s --max-time 60 -D - -o /dev/null "$BASE/storage/v1/object/public/attachments/inbound/smoke/ativo-$$.svg" | tr -d '\r')
  contem "9b SVG guardado volta como image/svg+xml (controle: o storage não o neutraliza)" "${cab,,}" "content-type: image/svg+xml"
  contem "9b SVG guardado: CSP com sandbox" "${cab,,}" "content-security-policy: default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"
  contem "9b SVG guardado: nosniff" "${cab,,}" "x-content-type-options: nosniff"
  rm -f "$TMP/ativo.svg"
}
passo9b

# ---------------------------------------------------------------------------------------------------------------
# 10. Mídia nossa no qr sem sessão: nunca 400 de SSRF
# ---------------------------------------------------------------------------------------------------------------
passo10() {
  local r codigo corpo_r
  # O qr baixa a mídia (fetchMediaUrl) ANTES de procurar a sessão: só o 400 com "Session not found" prova que o
  # download da mídia do nosso Storage (URL interna, sem a guarda SSRF) funcionou. Qualquer outro 400 (SSRF, URL
  # inválida, fetch falho) e qualquer 401/403/404 (JWT do usuário recusado, linha sem acesso) reprovam.
  r=$(curl -s -w '\n%{http_code}' --max-time 60 -X POST "$BASE/qr/message/send-media/$LINHA_A" \
    -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
    -d "{\"to\":\"5511988887777\",\"media_url\":\"$MIDIA_URL_7\",\"mime_type\":\"image/png\",\"filename\":\"fumaca.png\",\"skipSave\":true}")
  codigo=${r##*$'\n'}
  corpo_r=${r%$'\n'*}
  igual "10 send-media sem sessão = 400" "$codigo" 400
  igual "10 send-media: error = Session not found (a mídia foi baixada)" "$(printf '%s' "$corpo_r" | json error)" "Session not found"
  nao_contem "10 send-media com mídia nossa: sem 'blocked address'" "$corpo_r" "blocked address"
  nao_contem "10 send-media com mídia nossa: sem 'host is not allowed'" "$corpo_r" "host is not allowed"
  nao_contem "10 send-media com mídia nossa: o fetch da URL não falhou" "$corpo_r" "Failed to fetch"
  nao_contem "10 send-media com mídia nossa: sem 'Invalid media_url'" "$corpo_r" "Invalid media_url"
  nao_contem "10 send-media com mídia nossa: sem 'must use http'" "$corpo_r" "must use http"
}
passo10

# ---------------------------------------------------------------------------------------------------------------
# 11. Função com JWT
# ---------------------------------------------------------------------------------------------------------------
passo11() {
  local r
  r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/functions/v1/whatsapp-send" -H 'content-type: application/json' -d '{}')
  igual "11 whatsapp-send sem Authorization = 401" "${r##*$'\n'}" 401
  contem "11 whatsapp-send sem Authorization: UNAUTHORIZED_NO_AUTH_HEADER" "$r" UNAUTHORIZED_NO_AUTH_HEADER
  igual "11 whatsapp-send com o token A e {} = 400" "$(status "$BASE/functions/v1/whatsapp-send" -X POST \
    -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' -d '{}')" 400
}
passo11

# ---------------------------------------------------------------------------------------------------------------
# 12. Cron via pg_net (a tabela de respostas não guarda a URL: a identidade é o corpo, ver SMOKE_CRON_URLS)
# ---------------------------------------------------------------------------------------------------------------
cron_cobertura() { # sucesso quando toda URL da lista tem >= 1 resposta 200 sem erro
  local item trecho n
  for item in "${SMOKE_CRON_URLS[@]}"; do
    trecho=${item#*|}
    n=$(sql "SELECT count(*) FROM net._http_response WHERE status_code = 200 AND error_msg IS NULL AND position(\$q\$$trecho\$q\$ in coalesce(content, '')) > 0")
    [ "$n" -ge 1 ] || return 1
  done
}

passo12() {
  local falhas atrasos ruins frias item nome trecho n
  esperar_ate "12 cron: 1 resposta 200 por URL de job de minuto em até 150 s" 150 cron_cobertura
  for item in "${SMOKE_CRON_URLS[@]}"; do
    nome=${item%%|*}
    trecho=${item#*|}
    n=$(sql "SELECT count(*) FROM net._http_response WHERE status_code = 200 AND error_msg IS NULL AND position(\$q\$$trecho\$q\$ in coalesce(content, '')) > 0")
    ok "12 cron: $nome com $n resposta(s) 200"
  done
  # `job startup timeout` é o pg_cron avisando que ele mesmo começou o minuto com mais de 10 s de atraso (máquina
  # carregada, 2 vCPU do CI): o job não chegou a rodar e repete no minuto seguinte. Não diz nada sobre o stack, então só
  # é registrado, com a contagem. Qualquer outra falha (inclusive o 55000 do pg_net) continua reprovando.
  atrasos=$(sql "SELECT count(*) FROM cron.job_run_details WHERE status = 'failed' AND return_message = 'job startup timeout'")
  log "12 cron: $atrasos linha(s) 'job startup timeout' em cron.job_run_details (o pg_cron atrasou o minuto; registro, sem asserção)"
  falhas=$(sql "SELECT count(*) FROM cron.job_run_details WHERE status = 'failed' AND return_message IS DISTINCT FROM 'job startup timeout'")
  igual "12 cron.job_run_details sem nenhuma linha failed além de 'job startup timeout' (inclusive 55000)" "$falhas" 0
  # O pg_cron dispara no primeiro minuto cheio depois do `migrate`, ANTES de gateway, functions e qr estarem no ar
  # (a subida leva ~35 s e o minuto cheio cai em qualquer ponto dela): essas chamadas dão erro de DNS ou 502 de
  # propósito inofensivo (o job repete no minuto seguinte). Por isso o critério vale a partir do fim do `up --wait`.
  # As anteriores são só registradas.
  frias=$(sql "SELECT count(*) FROM net._http_response WHERE created < '$T_SUBIDA' AND (status_code IS DISTINCT FROM 200 OR error_msg IS NOT NULL)")
  log "12 cron: $frias chamada(s) pg_net sem 200 durante a subida a frio (registro, sem asserção)"
  ruins=$(sql "SELECT count(*) FROM net._http_response WHERE created >= '$T_SUBIDA' AND (status_code IS DISTINCT FROM 200 OR error_msg IS NOT NULL)")
  igual "12 net._http_response: toda resposta depois da subida é 200 e sem erro" "$ruins" 0
}
passo12

mailpit_mais_que() { [ "$(mailpit_total)" -gt "$1" ]; }

# ---------------------------------------------------------------------------------------------------------------
# 13. E-mail com SMTP (mailpit)
# ---------------------------------------------------------------------------------------------------------------
passo13() {
  local anon antes r id html
  anon=$(lenv "$ENVF" ANON_KEY)
  antes=$(mailpit_total)
  igual "13 POST /auth/v1/recover = 200" "$(status "$BASE/auth/v1/recover?redirect_to=$BASE/auth" -X POST -H "apikey: $anon" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL_A\"}")" 200
  esperar_ate "13 mailpit recebeu o e-mail de recuperação" 60 mailpit_mais_que "$antes"
  contem "13 assunto do e-mail de recuperação" "$(mailpit_assuntos)" "Redefinir sua senha do Echo"
  id=$(corpo "http://127.0.0.1:$SMOKE_MAILPIT_PORT/api/v1/messages" | json 'messages[0].ID')
  html=$(corpo "http://127.0.0.1:$SMOKE_MAILPIT_PORT/api/v1/message/$id" | json HTML)
  contem "13 o link do e-mail abre /auth?token_hash=" "$html" "/auth?token_hash="
  antes=$(mailpit_total)
  r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/functions/v1/send-invitation" -H "Authorization: Bearer $TOKEN_A" \
    -H 'content-type: application/json' -d "{\"email\":\"convidado1@example.com\",\"phoneNumberId\":\"$LINHA_A\"}")
  igual "13 send-invitation com SMTP = 200" "${r##*$'\n'}" 200
  igual "13 send-invitation: email = enviado" "$(printf '%s' "${r%$'\n'*}" | json email)" enviado
  esperar_ate "13 mailpit recebeu o convite" 60 mailpit_mais_que "$antes"
  ok "13 o convite chegou ao mailpit"
}
passo13

# ---------------------------------------------------------------------------------------------------------------
# 14. Sem SMTP (o caminho padrão de quem instala): a variável do shell vence o --env-file
# ---------------------------------------------------------------------------------------------------------------
passo14() {
  local anon r antes_log depois_log total_antes
  anon=$(lenv "$ENVF" ANON_KEY)
  SMTP_HOST='' dc up -d --wait --wait-timeout 300 auth functions gateway > "$TMP/up14.log" 2>&1 || {
    tail -30 "$TMP/up14.log" >&2
    falhou "14 sem SMTP" "up de auth/functions/gateway sem SMTP_HOST falhou"
  }
  contem "14 /config.js: email e recuperacaoSenha desligados" "$(corpo "$BASE/config.js")" '"email":false,"recuperacaoSenha":false'
  total_antes=$(mailpit_total)

  r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/functions/v1/send-invitation" -H "Authorization: Bearer $TOKEN_A" \
    -H 'content-type: application/json' -d "{\"email\":\"convidado2@example.com\",\"phoneNumberId\":\"$LINHA_A\"}")
  igual "14 send-invitation sem SMTP = 200" "${r##*$'\n'}" 200
  igual "14 send-invitation: email = nao_configurado" "$(printf '%s' "${r%$'\n'*}" | json email)" nao_configurado
  contem "14 send-invitation devolve o inviteUrl" "$(printf '%s' "${r%$'\n'*}" | json invitation.inviteUrl)" "/auth?invite="

  r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/functions/v1/send-feedback-email" -H "Authorization: Bearer $TOKEN_A" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"other\",\"title\":\"Fumaça ponta a ponta\",\"details\":\"Teste automático da fumaça sem SMTP.\",\"organization_id\":\"$ORG_A\"}")
  igual "14 send-feedback-email sem SMTP = 200" "${r##*$'\n'}" 200
  igual "14 send-feedback-email: motivo = nao_configurado" "$(printf '%s' "${r%$'\n'*}" | json motivo)" nao_configurado

  sql "UPDATE phone_numbers SET disconnect_alert_enabled = true, disconnect_alert_emails = ARRAY['alerta@example.com'], disconnect_alert_threshold_minutes = 1 WHERE id = '$LINHA_A'" > /dev/null
  antes_log=$(sql "SELECT count(*) FROM disconnect_alert_log WHERE phone_number_id = '$LINHA_A'")
  r=$(no_qr <<EOF
(async () => {
  const U = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(U + '/functions/v1/send-disconnect-alert', {
    method: 'POST',
    headers: { apikey: SR, Authorization: 'Bearer ' + SR, 'content-type': 'application/json' },
    body: JSON.stringify({ phone_number_id: '$LINHA_A', disconnected_at: new Date(Date.now() - 10 * 60000).toISOString() }),
  });
  console.log(r.status + ' ' + (await r.text()));
})();
EOF
  )
  igual "14 send-disconnect-alert sem SMTP = 200" "${r%% *}" 200
  contem "14 send-disconnect-alert: email = nao_configurado" "$r" '"email":"nao_configurado"'
  depois_log=$(sql "SELECT count(*) FROM disconnect_alert_log WHERE phone_number_id = '$LINHA_A'")
  igual "14 send-disconnect-alert gravou a linha em disconnect_alert_log" "$depois_log" "$((antes_log + 1))"

  # Outro usuário (B): o GoTrue recusa com 429 um 2º pedido de recuperação do MESMO e-mail em menos de 60 s (passo 13).
  igual "14 POST /auth/v1/recover sem SMTP = 200" "$(status "$BASE/auth/v1/recover?redirect_to=$BASE/auth" -X POST -H "apikey: $anon" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL_B\"}")" 200
  sleep 5
  igual "14 o mailpit continua com o mesmo número de mensagens" "$(mailpit_total)" "$total_antes"

  dc up -d --wait --wait-timeout 300 auth functions gateway > "$TMP/up14b.log" 2>&1 || falhou "14 SMTP de volta" "up de auth/functions/gateway falhou"
  contem "14 SMTP de volta: /config.js com e-mail ligado" "$(corpo "$BASE/config.js")" '"email":true'
}
passo14

# ---------------------------------------------------------------------------------------------------------------
# 15. CLI (./echo)
# ---------------------------------------------------------------------------------------------------------------
echo_cli() { ECHO_ENV_FILE="${ENVF2:-$ENVF}" "$REPO/echo" "$@"; }

passo15() {
  local rc=0 saida
  [ -x "$REPO/echo" ] || falhou "15 CLI" "./echo ausente ou sem permissão de execução"
  echo_cli status > "$TMP/echo-status.txt" 2>&1 || rc=$?
  igual "15 ./echo status = 0" "$rc" 0
  rc=0
  saida=$(echo_cli doctor 2>&1) || rc=$?
  igual "15 ./echo doctor = 0" "$rc" 0
  nao_contem "15 ./echo doctor sem ERRO" "$saida" "ERRO"
  rc=0
  printf '%s\n' "$SENHA_NOVA" | echo_cli reset-password "$EMAIL_A" --senha-stdin > "$TMP/echo-reset.txt" 2>&1 || rc=$?
  igual "15 ./echo reset-password = 0" "$rc" 0
  SENHA_ANTIGA=$SENHA_A
  SENHA_A=$SENHA_NOVA
  igual "15 login com a senha nova = 200" "$(status "$BASE/auth/v1/token?grant_type=password" -X POST -H "apikey: $(lenv "$ENVF" ANON_KEY)" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL_A\",\"password\":\"$SENHA_A\"}")" 200
  igual "15 login com a senha antiga = 400" "$(status "$BASE/auth/v1/token?grant_type=password" -X POST -H "apikey: $(lenv "$ENVF" ANON_KEY)" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL_A\",\"password\":\"$SENHA_ANTIGA\"}")" 400
}
passo15

# ---------------------------------------------------------------------------------------------------------------
# 16. Logs sem segredo
# ---------------------------------------------------------------------------------------------------------------
passo16() {
  local nome valor n objeto token ctx
  # URL assinada do Storage buscada pelo listener interno, como o qr e as funções fazem com anexo nosso: o JWT do
  # `?token=` não pode ir em claro para o log de acesso do :8000 (D44). O container qr tem SUPABASE_URL e a service_role.
  objeto=${MIDIA_URL_7#"$BASE"/storage/v1/object/public/attachments/}
  token=$(no_qr <<EOF
(async () => {
  const U = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_KEY;
  const s = await fetch(U + '/storage/v1/object/sign/attachments/$objeto', {
    method: 'POST',
    headers: { apikey: SR, Authorization: 'Bearer ' + SR, 'content-type': 'application/json' },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  const assinada = JSON.parse(await s.text()).signedURL;
  const g = await fetch(U + '/storage/v1' + assinada);
  console.log(g.status, new URL(U + '/storage/v1' + assinada).searchParams.get('token'));
})();
EOF
  )
  igual "16 URL assinada buscada pelo listener interno = 200" "${token%% *}" 200
  token=${token#* }
  [ "${#token}" -gt 20 ] || falhou "16 URL assinada" "o token da URL assinada veio vazio"
  dc logs --no-color --no-log-prefix > "$TMP/logs-todos.txt" 2>&1 || true
  for nome in SERVICE_ROLE_KEY QR_WEBHOOK_SECRET JWT_SECRET; do
    valor=$(lenv "$ENVF" "$nome")
    n=$(grep -cF -- "$valor" "$TMP/logs-todos.txt" || true)
    igual "16 logs: $nome aparece 0 vez" "$n" 0
  done
  n=$(grep -cF -- "$TOKEN_A" "$TMP/logs-todos.txt" || true)
  igual "16 logs: o token A aparece 0 vez" "$n" 0
  # O pedido da URL assinada TEM de estar no log (senão a ausência do token não prova o filtro).
  ctx=$(grep -cF -- "/storage/v1/object/sign/attachments/$objeto" "$TMP/logs-todos.txt" || true)
  [ "$ctx" -ge 1 ] || falhou "16 logs: o pedido da URL assinada aparece no log do :8000" "0 linhas"
  ok "16 logs: o pedido da URL assinada aparece no log do :8000 ($ctx linha(s))"
  n=$(grep -cF -- "$token" "$TMP/logs-todos.txt" || true)
  igual "16 logs: o token da URL assinada aparece 0 vez" "$n" 0
  # Só as linhas do Caddy (`/storage/v1/...` com o prefixo do gateway) e só o GET: o Storage também loga a rota sem o
  # prefixo (com o `?token=` em minúsculas, mascarado por ele) e a ordem do `docker compose logs` entre serviços varia,
  # então um `head -3` das linhas que casam com o caminho nu às vezes não chegava na linha do Caddy.
  contem "16 logs: o ?token= foi mascarado" "$(grep -F -- "/storage/v1/object/sign/attachments/$objeto" "$TMP/logs-todos.txt" | grep -F '"method":"GET"')" "token=REDACTED"
  rm -f "$TMP/logs-todos.txt"
}
passo16

# ---------------------------------------------------------------------------------------------------------------
# 17. Reinício a frio
# ---------------------------------------------------------------------------------------------------------------
passo17() {
  local n chave lido
  echo_cli down > "$TMP/echo-down.txt" 2>&1 || falhou "17 reinício a frio" "./echo down falhou"
  echo_cli up > "$TMP/echo-up.txt" 2>&1 || {
    tail -30 "$TMP/echo-up.txt" >&2
    falhou "17 reinício a frio" "./echo up falhou"
  }
  contem "17 log do migrate: 0 aplicada(s), 5 já estavam" "$(dc logs --no-color --no-log-prefix migrate 2>&1)" "0 aplicada(s), 5 já estavam"
  igual "17 login depois do reinício = 200" "$(status "$BASE/auth/v1/token?grant_type=password" -X POST -H "apikey: $(lenv "$ENVF" ANON_KEY)" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL_A\",\"password\":\"$SENHA_A\"}")" 200
  n=$(sql "SELECT count(*) FROM messages WHERE whatsapp_message_id = '$WAMID_6'")
  igual "17 a mensagem do passo 6 continua lá" "$n" 1
  chave='chave-ia-fumaca-0001'
  # set_ai_api_key confere admin da organização por auth.uid(): com a service_role (sem usuário) dá "Unauthorized".
  igual "17 set_ai_api_key com o token do admin = 204" "$(status "$BASE/rest/v1/rpc/set_ai_api_key" -X POST \
    -H "apikey: $(lenv "$ENVF" ANON_KEY)" -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
    -d "{\"p_org_id\":\"$ORG_A\",\"p_raw_key\":\"$chave\"}")" 204
  # get_decrypted_ai_key só atende a service_role (auth.role()) ou admin da organização: chamada pelo REST, como as edges.
  lido=$(no_qr <<EOF
(async () => {
  const U = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(U + '/rest/v1/rpc/get_decrypted_ai_key', {
    method: 'POST',
    headers: { apikey: SR, Authorization: 'Bearer ' + SR, 'content-type': 'application/json' },
    body: JSON.stringify({ p_org_id: '$ORG_A' }),
  });
  console.log(JSON.parse(await r.text()));
})();
EOF
  )
  igual "17 get_decrypted_ai_key (service_role) devolve o valor: Vault e chave-raiz intactos" "$lido" "$chave"
}
passo17

# ---------------------------------------------------------------------------------------------------------------
# 18. Reinício pelo daemon (reboot): kill + UM docker start, sem depends_on nem one-shots
# ---------------------------------------------------------------------------------------------------------------
login_200() { [ "$(status "$BASE/auth/v1/token?grant_type=password" -X POST -H "apikey: $(lenv "$ENVF" ANON_KEY)" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL_A\",\"password\":\"$SENHA_A\"}")" = 200 ]; }

cron_novo_depois_de() { [ "$(sql "SELECT count(*) FROM net._http_response WHERE status_code = 200 AND created > '$1'")" -ge 1 ]; }

todos_saudaveis() {
  local id estado
  for id in $(dc ps -aq db auth storage realtime rest functions qr gateway); do
    estado=$(docker inspect --format '{{.State.Health.Status}}' "$id" 2> /dev/null || echo ausente)
    [ "$estado" = healthy ] || return 1
  done
}

passo18() {
  local t0 ids antes_cron novo
  t0=$(date +%s)
  dc kill > /dev/null 2>&1 || true
  # shellcheck disable=SC2046
  ids=$(dc ps -aq db auth storage realtime rest functions qr gateway | tr '\n' ' ')
  # shellcheck disable=SC2086
  docker start $ids > /dev/null
  esperar_ate "18 reboot: todos os serviços saudáveis em até 120 s" 120 todos_saudaveis
  T_PASSO18=$(($(date +%s) - t0))
  ok "18 reboot: todos healthy em ${T_PASSO18}s"
  esperar_ate "18 reboot: login = 200" 60 login_200
  ok "18 reboot: login = 200"
  antes_cron=$(sql "SELECT coalesce(max(created), 'epoch') FROM net._http_response WHERE status_code = 200")
  env_node_usuarios "$BASE"
  export SMOKE_LINHA_A="$LINHA_A" SMOKE_EXEC_QR
  SMOKE_EXEC_QR=$(exec_qr_prefixo)
  rodar_node_smoke "$REPO/scripts/smoke/realtime.mjs"
  esperar_ate "18 reboot: nova resposta 200 do cron em net._http_response" 150 cron_novo_depois_de "$antes_cron"
  novo=$(sql "SELECT count(*) FROM net._http_response WHERE status_code = 200 AND created > '$antes_cron'")
  ok "18 reboot: $novo nova(s) resposta(s) 200 do cron"
}
passo18

# ---------------------------------------------------------------------------------------------------------------
# 19. TLS, redirect e wss com a CA interna do Caddy
# ---------------------------------------------------------------------------------------------------------------
dc_tls() {
  ECHO_SITE_ADDRESS=localhost ECHO_HTTPS_PORT="$SMOKE_HTTPS_PORT" \
    COMPOSE_FILE="docker-compose.yml:docker/compose/dominio.yml:scripts/smoke/compose.smoke.yml" dc "$@"
}

passo19() {
  local raiz="$TMP/root.crt" r
  dc_tls up -d --wait --wait-timeout 300 gateway > "$TMP/up19.log" 2>&1 || {
    tail -30 "$TMP/up19.log" >&2
    falhou "19 TLS" "up do gateway em modo domínio (localhost) falhou"
  }
  esperar_ate "19 TLS: CA interna do Caddy disponível" 60 dc_tls cp gateway:/data/caddy/pki/authorities/local/root.crt "$raiz"
  # A CA interna emite o certificado com o relógio do host. Num host cujo relógio de parede salta para frente (medido no WSL2:
  # +16 s por frações de segundo, a cada ~5 s), o certificado nasce "ainda não válido" (`curl: (60) certificate is not yet
  # valid`, reproduzido) e passa a valer sozinho em segundos. Espera até valer (no máximo 45 s); o GET abaixo continua estrito.
  tls_responde() { [ "$(status "https://localhost:$SMOKE_HTTPS_PORT/config.js" --cacert "$raiz")" = 200 ]; }
  esperar_ate "19 TLS: o certificado interno do localhost já vale (até 45 s)" 45 tls_responde
  igual "19 TLS: GET /config.js por HTTPS com a CA interna = 200" "$(status "https://localhost:$SMOKE_HTTPS_PORT/config.js" --cacert "$raiz")" 200
  r=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 30 "$BASE/")
  igual "19 redirect: http responde 308" "${r%% *}" 308
  contem "19 redirect: Location em https" "$r" "https://"
  env_node_usuarios "https://localhost:$SMOKE_HTTPS_PORT"
  NODE_EXTRA_CA_CERTS="$raiz" rodar_node_smoke "$REPO/scripts/smoke/realtime.mjs" --so-assinar
  dc up -d --wait --wait-timeout 300 gateway > "$TMP/up19b.log" 2>&1 || falhou "19 volta ao modo avaliação" "up do gateway falhou"
  igual "19 gateway de volta ao HTTP do .env original" "$(status "$BASE/config.js")" 200
}
passo19

# ---------------------------------------------------------------------------------------------------------------
# 20. Backup e restore de desastre (em .env novo, com OUTROS segredos)
# ---------------------------------------------------------------------------------------------------------------
passo20() {
  local tmpB="$TMP/backup" tmp2="$TMP/novo" t0 f modo chave a b sha_obj esperado url
  t0=$(date +%s)
  echo_cli backup --dest "$tmpB" > "$TMP/echo-backup.txt" 2>&1 || {
    tail -30 "$TMP/echo-backup.txt" >&2
    falhou "20 backup" "./echo backup falhou"
  }
  igual "20 backup: pasta com modo 700" "$(stat -c %a "$tmpB")" 700
  for f in "$tmpB"/*; do
    modo=$(stat -c %a "$f")
    [ "$modo" = 600 ] || falhou "20 backup: arquivo com modo 600" "$(basename "$f") está com $modo"
  done
  ok "20 backup: todo arquivo com modo 600"
  igual "20 backup: quatro tars" "$(find "$tmpB" -maxdepth 1 -name '*.tar*' | wc -l | tr -d ' ')" 4
  [ -f "$tmpB/manifest.json" ] || falhou "20 backup" "manifest.json ausente"
  ok "20 backup: manifest.json presente"

  mkdir -m 700 "$tmp2"
  ENVF2="$tmp2/.env"
  gerar_env "$ENVF2" "$(lenv "$ENVF" COMPOSE_FILE)"
  [ "$(lenv "$ENVF2" JWT_SECRET)" != "$(lenv "$ENVF" JWT_SECRET)" ] || falhou "20 restore" "o .env novo saiu com o mesmo JWT_SECRET"
  printf '%s\n' "$SMOKE_PROJECT" | echo_cli restore "$tmpB" > "$TMP/echo-restore.txt" 2>&1 || {
    tail -30 "$TMP/echo-restore.txt" >&2
    falhou "20 restore" "./echo restore falhou"
  }
  T_PASSO20=$(($(date +%s) - t0))
  for chave in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY VAULT_ROOT_KEY AI_KEY_SECRET QR_WEBHOOK_SECRET ZAPO_DB_PASSWORD; do
    a=$(lenv "$ENVF2" "$chave")
    b=$(lenv "$ENVF" "$chave")
    [ "$a" = "$b" ] || falhou "20 restore: $chave do backup reposta no .env novo" "valores diferentes"
  done
  ok "20 restore: os segredos imutáveis do .env novo são os do backup"
  ENVF="$ENVF2"
  igual "20 restore: login com a senha nova = 200" "$(status "$BASE/auth/v1/token?grant_type=password" -X POST -H "apikey: $(lenv "$ENVF" ANON_KEY)" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL_A\",\"password\":\"$SENHA_A\"}")" 200
  url=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).url)' "$ESTADO/storage.json")
  esperado=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sha256)' "$ESTADO/storage.json")
  curl -s --max-time 60 -o "$TMP/obj.bin" "$url"
  sha_obj=$(sha_arquivo "$TMP/obj.bin")
  igual "20 restore: o objeto do passo 8 tem o mesmo sha256" "$sha_obj" "$esperado"
  igual "20 restore: Vault com 4 segredos decifráveis" "$(sql "SELECT count(*) FROM vault.decrypted_secrets WHERE decrypted_secret IS NOT NULL AND name IN ('project_url','service_role_key','qr_service_url','ai_key_secret')")" 4
}
passo20

# ---------------------------------------------------------------------------------------------------------------
# 21. Limite por IP, de dentro da rede do projeto (balde próprio)
# ---------------------------------------------------------------------------------------------------------------
passo21() {
  local saida anon
  anon=$(lenv "$ENVF" ANON_KEY)
  saida=$(no_qr <<EOF
(async () => {
  const tentar = async (extra) => (await fetch('http://gateway:80/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: '$anon', 'content-type': 'application/json', ...extra },
    body: JSON.stringify({ email: 'ninguem@example.com', password: '$SENHA_ERRADA' }),
  })).status;
  const codigos = [];
  for (let i = 0; i < 30; i++) codigos.push(await tentar({}));
  const trinta1 = await tentar({});
  const trinta2 = await tentar({ 'X-Forwarded-For': '6.6.6.6', 'X-Echo-Client-IP': '7.7.7.7' });
  console.log(JSON.stringify({ primeiros: [...new Set(codigos)], trinta1, trinta2 }));
})();
EOF
  )
  igual "21 limite por IP: as 30 primeiras senhas erradas = 400" "$(printf '%s' "$saida" | json primeiros)" '[400]'
  igual "21 limite por IP: a 31ª = 429" "$(printf '%s' "$saida" | json trinta1)" 429
  igual "21 limite por IP: a 32ª com XFF e X-Echo-Client-IP forjados = 429" "$(printf '%s' "$saida" | json trinta2)" 429
}
passo21

# ---------------------------------------------------------------------------------------------------------------
# 22. Registro (sem asserção)
# ---------------------------------------------------------------------------------------------------------------
log "tempos: passo 1 (subida) ${T_PASSO1}s; passo 18 (reboot) ${T_PASSO18}s; passo 20 (backup+restore) ${T_PASSO20}s"
log "RAM por serviço (docker stats --no-stream):"
mapfile -t CONTAINERES < <(dc ps -q 2> /dev/null)
if [ "${#CONTAINERES[@]}" -gt 0 ]; then
  docker stats --no-stream --format '  {{.Name}}\t{{.MemUsage}}' "${CONTAINERES[@]}" 2> /dev/null || true
fi

printf 'SMOKE OK (%d checagens)\n' "$SMOKE_N_OK"
