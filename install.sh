#!/usr/bin/env bash
# Instalador do Echo auto-hospedado. Só precisa de bash, coreutils e Docker (com o plugin Compose) no host.
#
#   ./install.sh                                              # localhost, só para avaliar: http://localhost:8088
#   ./install.sh --domain echo.exemplo.com                    # HTTPS automático (portas 80 e 443)
#   ./install.sh --behind-proxy --url https://echo.exemplo.com --port 8088
#   ./install.sh --behind-proxy --url https://echo.exemplo.com --proxy-network traefik
#   ./install.sh --url http://10.0.0.5:8088                   # IP privado / VPN
#   ./install.sh --url http://203.0.113.10:8088 --insecure-http   # IP público, sem TLS (não recomendado)
#
# Passos: (1) checagens, (2) gera o .env (ou acrescenta as chaves novas), (3) para aí com --env-only,
# (4) baixa as imagens de terceiros e constrói as do Echo uma por vez, (5) sobe tudo e espera ficar saudável,
# (6) confere o gateway e o primeiro acesso, (7) imprime o endereço e o link de /setup.
#
# O `./echo` carrega este arquivo (source) para reaproveitar as funções abaixo: por isso o corpo só roda
# quando o arquivo é executado direto (última linha).
set -euo pipefail

ECHO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Menor versão do Compose medida (M-IN-6): a 2.24.7 sobe o stack inteiro, com os serviços de uma execução só
# (service_completed_successfully), contra o Docker atual. A 2.20.3 recusa o override só com comentários
# ("Top-level object must be a mapping") e não fala com o daemon do Docker 29 (API mínima 1.44).
MIN_COMPOSE="2.24.7"
NODE_IMAGEM="node:22.22.3-alpine3.24"
PORTA_PADRAO=8088

msg() { printf '[echo] %s\n' "$*"; }
aviso() { printf '[echo] AVISO: %s\n' "$*" >&2; }
erro() { printf '[echo] ERRO: %s\n' "$*" >&2; }
die() {
  erro "$*"
  exit 1
}
uso_erro() {
  erro "$*"
  printf '[echo] Rode %s para ver as opções.\n' "${ECHO_USO_DICA:-./install.sh --help}" >&2
  exit 2
}

# ---------------------------------------------------------------------------------------------------------------
# Funções compartilhadas com o ./echo
# ---------------------------------------------------------------------------------------------------------------

# Versão da árvore (package.json), sem Node: o primeiro "version" do arquivo é o do pacote.
ler_versao() {
  local v
  v="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$ECHO_DIR/package.json" 2>/dev/null | head -n1 || true)"
  printf '%s' "${v:-dev}"
}

# Valor de uma chave de um .env (último vence, sem aspas, sem CR). Vazio se ausente.
env_get() {
  local arquivo="$1" chave="$2" v
  [ -f "$arquivo" ] || return 0
  v="$(grep -E "^[[:space:]]*${chave}=" "$arquivo" | tail -n1 | cut -d= -f2- | tr -d '\r' || true)"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

# "2.24.7-desktop.1" -> "2.24.7"
versao_limpa() {
  local v="${1#v}"
  if [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    printf '%s.%s.%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  else
    printf '0.0.0'
  fi
}

# versao_ge A B: A >= B (X.Y.Z)
versao_ge() {
  local a b i
  a="$(versao_limpa "$1")"
  b="$(versao_limpa "$2")"
  local -a pa pb
  IFS=. read -r -a pa <<<"$a"
  IFS=. read -r -a pb <<<"$b"
  for i in 0 1 2; do
    if [ "${pa[$i]}" -gt "${pb[$i]}" ]; then return 0; fi
    if [ "${pa[$i]}" -lt "${pb[$i]}" ]; then return 1; fi
  done
  return 0
}

# Isola o compose do ambiente do shell: os arquivos vêm do COMPOSE_FILE do .env, não de uma variável exportada.
isolar_compose() {
  unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PATH_SEPARATOR COMPOSE_ENV_FILES
}

# Chama o compose sempre da pasta do projeto, com o .env e o projeto certos.
# Requer ECHO_DIR, ECHO_ENV_FILE e ECHO_PROJ.
compose() {
  docker compose --project-directory "$ECHO_DIR" --env-file "$ECHO_ENV_FILE" -p "$ECHO_PROJ" "$@"
}

# com_tentativas CMD...: até 3 tentativas, esperando 10 s e 30 s entre elas (ECR e Docker Hub limitam rajadas).
com_tentativas() {
  local n=1 espera
  while true; do
    if "$@"; then return 0; fi
    if [ "$n" -ge 3 ]; then return 1; fi
    espera=10
    [ "$n" -ge 2 ] && espera=30
    aviso "falhou (tentativa $n de 3): $*. Nova tentativa em ${espera}s."
    sleep "$espera"
    n=$((n + 1))
  done
}

# Constrói as quatro imagens do Echo uma por vez: o pico de RAM é o de um build só (cada um baixa a sua base).
construir_imagens() {
  local svc
  for svc in db gateway functions qr; do
    msg "Construindo a imagem de '$svc'…"
    com_tentativas compose build "$svc" || return 1
  done
}

# RAM total em MB (0 se não der para medir).
ram_mb() {
  local kb bytes
  if [[ "${ECHO_RAM_MB:-}" =~ ^[0-9]+$ ]]; then
    printf '%s' "$ECHO_RAM_MB" # só para teste e para quem sabe mais que o /proc/meminfo (contêiner com limite de memória)
  elif [ -r /proc/meminfo ]; then
    kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
    printf '%s' "$((kb / 1024))"
  elif bytes="$(sysctl -n hw.memsize 2>/dev/null)"; then
    printf '%s' "$((bytes / 1048576))"
  else
    printf '0'
  fi
}

# Espaço livre em MB onde o Docker guarda os dados (ou na pasta do projeto, se a raiz do Docker não for legível).
disco_livre_mb() {
  local raiz kb
  raiz="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [ -z "$raiz" ] || [ ! -d "$raiz" ] || [ ! -r "$raiz" ]; then raiz="$ECHO_DIR"; fi
  kb="$(df -Pk "$raiz" 2>/dev/null | awk 'NR==2 {print $4}')"
  printf '%s' "$(( ${kb:-0} / 1024 ))"
}

# Texto "7,7 GB" a partir de MB.
gb_texto() {
  awk -v m="$1" 'BEGIN { printf "%.1f GB", m / 1024 }' | tr . ,
}

# Porta TCP em uso no host? (sem `ss`, devolve "desconhecido" e o chamador só avisa)
porta_ocupada() {
  if ! command -v ss >/dev/null 2>&1; then return 2; fi
  local linhas
  linhas="$(ss -ltnH "sport = :$1" 2>/dev/null || true)"
  [ -n "$linhas" ]
}

# IPv4 privado/local? 10/8, 172.16/12, 192.168/16, 100.64/10, 127/8.
ip_privado() {
  local a b c d
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=$((10#${BASH_REMATCH[1]})); b=$((10#${BASH_REMATCH[2]})); c=$((10#${BASH_REMATCH[3]})); d=$((10#${BASH_REMATCH[4]}))
  if [ "$a" -gt 255 ] || [ "$b" -gt 255 ] || [ "$c" -gt 255 ] || [ "$d" -gt 255 ]; then return 1; fi
  [ "$a" -eq 10 ] && return 0
  [ "$a" -eq 127 ] && return 0
  [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  [ "$a" -eq 192 ] && [ "$b" -eq 168 ] && return 0
  [ "$a" -eq 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 0
  return 1
}

ip_literal() {
  [[ "$1" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]
}

# Cria o override do usuário só com comentários, se faltar (nunca edita um existente).
criar_override_vazio() {
  local alvo="$ECHO_DIR/docker-compose.override.yml"
  [ -f "$alvo" ] && return 0
  cat >"$alvo" <<'EOF'
# Ajustes avançados do Echo, só seus: este arquivo não vai para o git e o install.sh nunca o edita.
# O .env já lista este arquivo no COMPOSE_FILE. Exemplo (proteções do serviço de QR, limites do Realtime):
#
# services:
#   qr:
#     environment:
#       ALGUMA_VARIAVEL: "valor"
EOF
}

# ---------------------------------------------------------------------------------------------------------------
# install.sh
# ---------------------------------------------------------------------------------------------------------------

uso() {
  cat <<'EOF'
Uso: ./install.sh [opções]

Instala o Echo com Docker: gera o .env (segredos novos), constrói as imagens, sobe o stack e imprime o endereço.

Modos (sem opção = localhost, só para avaliar):
  --domain HOST         domínio próprio com HTTPS automático (portas 80 e 443 livres; DNS apontando para esta máquina)
  --url URL             endereço público, ex.: http://10.0.0.5:8088 (IP privado ou VPN)
  --behind-proxy        atrás de um proxy reverso que já existe; exige --url (o endereço público do proxy)
  --proxy-network NOME  proxy em container: liga o gateway a essa rede Docker externa (implica --behind-proxy)
  --port N              porta HTTP no host (padrão 8088; no modo --behind-proxy, a que o proxy repassa)
  --insecure-http       permite --url http:// com IP público (senha e conversas passam sem criptografia)

Controle:
  --yes                 não pergunta nada (avisos de RAM, disco e WSL seguem como aviso)
  --env-only            só gera ou completa o .env e o override; não constrói nem sobe nada
  --help                esta ajuda

Variável de ambiente: COMPOSE_PROJECT_NAME muda o nome do projeto numa instalação nova (padrão: echo).

Com um .env já existente, as opções de endereço são ignoradas (o endereço não muda depois da instalação)
e o instalador só acrescenta as chaves que a versão nova trouxe.

Depois de instalar, use ./echo (status, logs, upgrade, backup, doctor…).
EOF
}

# Estado resolvido pelas opções
OPT_DOMAIN=""
OPT_URL=""
OPT_BEHIND=false
OPT_NET=""
OPT_PORT=""
OPT_INSECURE=false
OPT_YES=false
OPT_ENV_ONLY=false

M_URL=""
M_SITE=":80"
M_BIND="127.0.0.1"
M_HTTP="$PORTA_PADRAO"
M_HTTPS=""
M_BEHIND=false
M_NET=""
M_MODO="localhost"
AVISOS=0

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) [ $# -ge 2 ] || uso_erro "--domain precisa de um valor"; OPT_DOMAIN="$2"; shift 2 ;;
      --url) [ $# -ge 2 ] || uso_erro "--url precisa de um valor"; OPT_URL="$2"; shift 2 ;;
      --behind-proxy) OPT_BEHIND=true; shift ;;
      --proxy-network) [ $# -ge 2 ] || uso_erro "--proxy-network precisa de um valor"; OPT_NET="$2"; shift 2 ;;
      --port) [ $# -ge 2 ] || uso_erro "--port precisa de um valor"; OPT_PORT="$2"; shift 2 ;;
      --insecure-http) OPT_INSECURE=true; shift ;;
      --yes | -y) OPT_YES=true; shift ;;
      --env-only) OPT_ENV_ONLY=true; shift ;;
      --help | -h) uso; exit 0 ;;
      *) uso_erro "opção desconhecida: $1" ;;
    esac
  done
}

opcoes_de_endereco_dadas() {
  [ -n "$OPT_DOMAIN" ] || [ -n "$OPT_URL" ] || [ "$OPT_BEHIND" = true ] || [ -n "$OPT_NET" ] || [ -n "$OPT_PORT" ]
}

validar_porta() {
  [[ "$2" =~ ^[0-9]{1,5}$ ]] && [ "$2" -ge 1 ] && [ "$2" -le 65535 ] || uso_erro "$1 precisa ser um número de 1 a 65535 (recebi '$2')"
}

# Traduz as opções em endereço, portas e modo (M_*). Só roda com .env ausente.
resolver_modo() {
  [ -n "$OPT_NET" ] && OPT_BEHIND=true
  [ -z "$OPT_PORT" ] || validar_porta "--port" "$OPT_PORT"

  if [ -n "$OPT_DOMAIN" ]; then
    [ -z "$OPT_URL" ] || uso_erro "--domain e --url não combinam: --domain já define o endereço (https://$OPT_DOMAIN)"
    [ "$OPT_BEHIND" = false ] || uso_erro "--domain e --behind-proxy não combinam: com proxy na frente, use --behind-proxy --url https://$OPT_DOMAIN"
    [ -z "$OPT_PORT" ] || uso_erro "--port não vale com --domain: o modo domínio usa as portas 80 e 443"
    [[ "$OPT_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] ||
      uso_erro "--domain precisa ser um nome de host (ex.: echo.exemplo.com), sem http:// nem barra"
    if ip_literal "$OPT_DOMAIN"; then uso_erro "--domain não aceita IP: use --url http://IP:porta"; fi
    M_MODO="dominio"
    M_URL="https://$OPT_DOMAIN"
    M_SITE="$OPT_DOMAIN"
    M_BIND="0.0.0.0"
    M_HTTP=80
    M_HTTPS=443
    return 0
  fi

  local url="${OPT_URL%/}" esquema="" host="" porta=""
  if [ -n "$url" ]; then
    if [[ "$url" =~ ^(https?)://(\[[^]]+\]|[^/:@\ ]+)(:([0-9]+))?$ ]]; then
      esquema="${BASH_REMATCH[1]}"
      host="${BASH_REMATCH[2]}"
      porta="${BASH_REMATCH[4]:-}"
    else
      uso_erro "--url precisa ser http(s)://host[:porta], sem caminho nem barra no fim (recebi '$OPT_URL')"
    fi
    [ -z "$porta" ] || validar_porta "a porta de --url" "$porta"
  fi

  # http:// em IP público vale em qualquer modo (também atrás de proxy): senha, JWT e conversas iriam em claro.
  if [ "$esquema" = "http" ] && ip_literal "$host" && ! ip_privado "$host" && [ "$OPT_INSECURE" = false ]; then
    erro "http:// com IP público ($host): senha, token e conversas passariam em claro pela internet."
    erro "Use um domínio (HTTPS automático): ./install.sh --domain echo.exemplo.com, ou uma rede privada/VPN."
    erro "Se mesmo assim quiser, acrescente --insecure-http."
    exit 1
  fi

  if [ "$OPT_BEHIND" = true ]; then
    [ -n "$url" ] || uso_erro "--behind-proxy exige --url com o endereço público do proxy (ex.: --url https://echo.exemplo.com)"
    M_MODO="proxy"
    M_URL="$url"
    M_SITE=":80"
    M_BIND="127.0.0.1"
    M_HTTP="${OPT_PORT:-$PORTA_PADRAO}"
    M_BEHIND=true
    M_NET="$OPT_NET"
    return 0
  fi

  if [ -n "$url" ]; then
    [ "$esquema" = "http" ] || uso_erro "--url https:// sem proxy não tem como obter certificado: use --domain $host (HTTPS automático) ou --behind-proxy --url $url"
    if [ -n "$OPT_PORT" ] && [ -n "$porta" ] && [ "$OPT_PORT" != "$porta" ]; then
      uso_erro "--port $OPT_PORT e a porta de --url ($porta) divergem"
    fi
    # Sem porta na URL o navegador lê 80: o endereço gravado (mídia, e-mail, CSP do Realtime) não bateria com a porta publicada.
    if [ -n "$OPT_PORT" ] && [ -z "$porta" ] && [ "$OPT_PORT" != "80" ]; then
      uso_erro "--port $OPT_PORT com --url sem porta: inclua a porta na URL (--url $url:$OPT_PORT), senão o navegador usa a 80"
    fi
    M_HTTP="${OPT_PORT:-${porta:-80}}"
    M_URL="$url"
    if [ "$host" = "localhost" ] || { ip_literal "$host" && [ "${host%%.*}" = "127" ]; }; then
      M_MODO="localhost"
      M_BIND="127.0.0.1"
    else
      M_MODO="ip"
      M_BIND="0.0.0.0"
    fi
    return 0
  fi

  M_MODO="localhost"
  M_HTTP="${OPT_PORT:-$PORTA_PADRAO}"
  M_URL="http://localhost:$M_HTTP"
  M_BIND="127.0.0.1"
}

passo_checagens() {
  docker info >/dev/null 2>&1 ||
    die "o Docker não responde. Confira se o serviço está rodando e se o seu usuário pode usá-lo (grupo 'docker' ou sudo)."

  local compose_v docker_v arq ram disco
  compose_v="$(docker compose version --short 2>/dev/null || true)"
  [ -n "$compose_v" ] || die "o plugin 'docker compose' não foi encontrado. Instale o Docker Compose v2 (https://docs.docker.com/compose/install/)."
  versao_ge "$compose_v" "$MIN_COMPOSE" ||
    die "Docker Compose $compose_v é antigo: o mínimo é $MIN_COMPOSE. Atualize o plugin (https://docs.docker.com/compose/install/)."

  arq="$(uname -m)"
  case "$arq" in
    x86_64 | aarch64 | arm64) ;;
    *) die "arquitetura '$arq' não suportada: as imagens existem só para x86_64 e aarch64/arm64." ;;
  esac
  [ "$arq" = "x86_64" ] || aviso "arquitetura $arq: as imagens existem, mas o build e a execução em ARM64 não foram testados."

  docker_v="$(docker version -f '{{.Server.Version}}' 2>/dev/null || echo '?')"
  ram="$(ram_mb)"
  disco="$(disco_livre_mb)"

  if [ "$ram" -gt 0 ] && [ "$ram" -lt 2048 ]; then
    aviso "só $(gb_texto "$ram") de RAM: o mínimo recomendado é 2 GB (com swap). O build pode falhar por falta de memória."
    AVISOS=$((AVISOS + 1))
  fi
  if [ "$disco" -gt 0 ] && [ "$disco" -lt 10240 ]; then
    aviso "só $(gb_texto "$disco") livres para o Docker: reserve pelo menos 10 GB (imagens, banco e arquivos)."
    AVISOS=$((AVISOS + 1))
  fi
  if grep -qi microsoft /proc/version 2>/dev/null; then
    aviso "WSL detectado: serve para avaliar. Para produção, use uma máquina Linux (o relógio do WSL salta e as sessões do WhatsApp caem quando o Windows hiberna)."
    AVISOS=$((AVISOS + 1))
  fi

  if [ -n "$M_NET" ]; then
    docker network inspect "$M_NET" >/dev/null 2>&1 ||
      die "a rede Docker '$M_NET' não existe. Ela precisa existir antes (é a do seu proxy): docker network ls"
  fi

  msg "Docker $docker_v, Compose $compose_v, $arq, $(gb_texto "$ram") RAM: ok"
}

# Portas do host que o stack vai publicar (só numa instalação nova; com .env o stack pode ser o nosso, já de pé).
checar_portas() {
  local p ocupada
  for p in "$@"; do
    [ -n "$p" ] || continue
    if porta_ocupada "$p"; then ocupada=0; else ocupada=$?; fi
    if [ "$ocupada" -eq 0 ]; then
      erro "a porta $p do host está em uso. Veja quem usa: ss -ltnp 'sport = :$p'"
      erro "Libere a porta, escolha outra com --port, ou, com um proxy já instalado, use --behind-proxy."
      exit 1
    elif [ "$ocupada" -eq 2 ]; then
      aviso "o comando 'ss' não existe: não deu para conferir se a porta $p está livre."
      return 0
    fi
  done
}

confirmar_avisos() {
  [ "$AVISOS" -gt 0 ] || return 0
  [ "$OPT_YES" = false ] || return 0
  [ -t 0 ] || return 0
  local r
  read -r -p "[echo] Há $AVISOS aviso(s) acima. Continuar mesmo assim? [s/N] " r
  case "$r" in
    s | S | sim | SIM | y | Y) return 0 ;;
    *) die "instalação cancelada." ;;
  esac
}

node_do_host_serve() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 18 ]
}

# rodar_genkeys ARGS...: o gerador no Node do host (>= 18) ou, sem ele, num contêiner descartável.
rodar_genkeys() {
  if node_do_host_serve; then
    node docker/tools/gen-keys.mjs "$@"
  else
    msg "Sem Node 18+ no host: gerando com um contêiner descartável ($NODE_IMAGEM)."
    # Um .env fora do repo (ECHO_ENV_FILE) não existe dentro do contêiner, que só monta $PWD: monta a pasta dele em /e.
    local -a args=() montar=()
    local a="" prox_e_caminho=false
    for a in "$@"; do
      if [ "$prox_e_caminho" = true ]; then
        prox_e_caminho=false
        case "$a" in
          /*)
            if [ "${a#"$PWD"/}" = "$a" ]; then
              montar=(-v "$(dirname "$a"):/e")
              a="/e/$(basename "$a")"
            else
              a="${a#"$PWD"/}" # dentro da árvore: o contêiner a monta em /w, então vale o caminho relativo
            fi
            ;;
        esac
      fi
      [ "$a" != "--completar" ] || prox_e_caminho=true
      args+=("$a")
    done
    com_tentativas docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/w" ${montar[@]+"${montar[@]}"} -w /w "$NODE_IMAGEM" \
      node docker/tools/gen-keys.mjs "${args[@]}"
  fi
}

# Volumes que o Compose já criou para este projeto (rótulo com.docker.compose.project). Um por linha; vazio se nenhum.
volumes_do_compose() {
  docker volume ls -q --filter "label=com.docker.compose.project=$ECHO_PROJ" 2>/dev/null || true
}

# Sem .env mas com volumes do projeto = segredos novos sobre dados antigos: o Postgres guarda a senha no volume e o
# db-init não autentica; mexer no Vault para "consertar" perderia a chave das IAs. Sai antes de gerar qualquer segredo
# (vale também com --env-only: gerar um .env novo sobre volumes velhos é o defeito).
checar_volumes_antigos() {
  local lista v conts
  lista="$(volumes_do_compose)"
  [ -n "$lista" ] || return 0
  # Containers do projeto (rodando ou parados): o Docker recusa 'volume rm' de volume que algum deles usa.
  conts="$(docker ps -aq --filter "label=com.docker.compose.project=$ECHO_PROJ" 2>/dev/null || true)"
  erro "não há .env, mas o Docker já tem volumes do projeto '$ECHO_PROJ' (dados de uma instalação anterior):"
  while IFS= read -r v; do [ -z "$v" ] || printf '    %s\n' "$v" >&2; done <<<"$lista"
  {
    printf '  Gerar segredos novos sobre esses dados não funciona: o banco guarda a senha antiga e o Vault não abre. Escolha uma saída:\n'
    if [ -n "$conts" ]; then
      printf '  ATENÇÃO: containers dessa instalação anterior ainda existem e continuam ocupando as portas dela.\n'
    fi
    printf '  1. Manter os dados: restaure o .env da instalação anterior (backups/*/.env ou .env.bak.*) e rode ./install.sh de novo.\n'
    printf '  2. Começar do zero APAGANDO os dados (faça ./echo backup antes, se houver algo a guardar):\n'
    if [ -n "$conts" ]; then
      printf '       docker ps -aq --filter label=com.docker.compose.project=%s | xargs -r docker rm -f\n' "$ECHO_PROJ"
      printf '       docker volume rm %s\n' "$(printf '%s' "$lista" | tr '\n' ' ')"
      printf '     e rode ./install.sh de novo (o volume só sai depois que os containers saem: "volume is in use" quer dizer que sobrou um).\n'
    else
      printf '       docker volume rm %s\n' "$(printf '%s' "$lista" | tr '\n' ' ')"
      printf '     e rode ./install.sh de novo. (Com o .env antigo ainda no lugar, "docker compose -p %s down -v" faz o mesmo.)\n' "$ECHO_PROJ"
    fi
    printf '  3. Instalar ao lado, sem tocar nesses dados: COMPOSE_PROJECT_NAME=outro-nome ./install.sh (portas diferentes: --port).\n'
  } >&2
  exit 1
}

# Conferência informativa do HTTPS público (modo domínio, instalação nova). Nunca falha o instalador: DNS, firewall e
# limite da autoridade de certificados são do ambiente de quem instala. HTTPS_OK: "" (não conferido), true ou false.
# ECHO_HTTPS_ESPERA = segundos de espera (padrão 90).
HTTPS_OK=""
conferir_https() {
  local url="$1" espera="${ECHO_HTTPS_ESPERA:-90}" fim resta mt
  command -v curl >/dev/null 2>&1 || return 0
  msg "Conferindo o certificado HTTPS de $url (até ${espera}s; só informativo)…"
  # O prazo é de relógio (SECONDS): o tempo do próprio curl conta, e cada tentativa é limitada ao que falta.
  fim=$((SECONDS + espera))
  while true; do
    resta=$((fim - SECONDS))
    [ "$resta" -ge 1 ] || resta=1
    mt=$((resta < 10 ? resta : 10))
    if curl -fsS --connect-timeout 5 --max-time "$mt" -o /dev/null "$url/config.js" >/dev/null 2>&1; then
      HTTPS_OK=true
      return 0
    fi
    [ "$SECONDS" -lt "$fim" ] || break
    sleep 5
  done
  HTTPS_OK=false
}

passo_env() {
  if [ ! -f "$ECHO_ENV_FILE" ]; then
    local -a args=(--out .env --public-url "$M_URL" --site-address "$M_SITE" --bind "$M_BIND" --http-port "$M_HTTP" --project "$ECHO_PROJ" --com-override)
    [ -z "$M_HTTPS" ] || args+=(--https-port "$M_HTTPS")
    [ "$M_BEHIND" = false ] || args+=(--behind-proxy)
    [ -z "$M_NET" ] || args+=(--proxy-network "$M_NET")
    msg "Gerando .env (segredos novos; modo 600)"
    rodar_genkeys "${args[@]}"
  else
    # O .env.example da raiz já foi o do front (VITE_*): um .env só com isso não é de instalação nenhuma.
    if [ -z "$(env_get "$ECHO_ENV_FILE" COMPOSE_PROJECT_NAME)" ] && [ -z "$(env_get "$ECHO_ENV_FILE" ECHO_PUBLIC_URL)" ] &&
      grep -Eq '^VITE_[A-Z0-9_]+=' "$ECHO_ENV_FILE"; then
      uso_erro "este .env é do desenvolvimento do front (só tem VITE_*): mova para .env.development.local (mv .env .env.development.local) e rode ./install.sh de novo. Para hospedagem estática do front, as VITE_* vão no ambiente do build ou em .env.local, porque o vite build não lê .env.development.local."
    fi
    msg ".env já existe: mantido (os segredos de uma instalação não se trocam)."
    if opcoes_de_endereco_dadas; then
      aviso "as opções de endereço foram ignoradas: o endereço desta instalação é $(env_get "$ECHO_ENV_FILE" ECHO_PUBLIC_URL). Para mudar o endereço, os dados não migram sozinhos: ./echo backup, depois docker compose -p $ECHO_PROJ down -v (apaga os volumes; faça isso ANTES de remover o .env), remova o .env e rode ./install.sh com as opções de endereço."
    fi
    rodar_genkeys --completar .env
  fi
  chmod 600 "$ECHO_ENV_FILE"
  criar_override_vazio
}

# Mostra os logs dos serviços com problema e o ./echo doctor; sai com 1.
falhou() {
  erro "$*"
  local linha svc estado saude codigo
  if [ -x "$ECHO_DIR/echo" ]; then
    printf '\n[echo] ./echo doctor:\n' >&2
    "$ECHO_DIR/echo" doctor >&2 || true
  fi
  if compose logs --no-color --tail 50 db-init 2>/dev/null | grep -q 'password authentication failed'; then
    printf '\n[echo] CAUSA PROVÁVEL: o .env não é o desta base de dados (segredos novos sobre um volume de instalação anterior).\n' >&2
    printf '[echo] Restaure o .env anterior (backups/*/.env ou .env.bak.*) ou apague os volumes do projeto %s e instale de novo. Não mexa no Vault.\n' "$ECHO_PROJ" >&2
  fi
  while IFS='|' read -r svc estado saude codigo; do
    [ -n "$svc" ] || continue
    linha=false
    case "$estado" in
      running) [ -z "$saude" ] || [ "$saude" = "healthy" ] || linha=true ;;
      exited) [ "${codigo:-0}" = "0" ] || linha=true ;;
      created) ;; # nunca iniciou (esperava um serviço de que depende): não tem log
      *) linha=true ;;
    esac
    if [ "$linha" = true ]; then
      printf '\n[echo] Últimas 50 linhas de %s (%s %s):\n' "$svc" "$estado" "$saude" >&2
      compose logs --no-color --tail 50 "$svc" >&2 || true
    fi
  done < <(compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' 2>/dev/null || true)
  exit 1
}

passo_subir() {
  msg "Baixando as imagens de terceiros…"
  com_tentativas compose pull auth storage realtime rest || falhou "não consegui baixar as imagens (registro fora do ar ou limite de pulls). Tente de novo em alguns minutos."
  msg "Construindo as imagens do Echo (primeira vez: alguns minutos; uma por vez para não estourar a memória)…"
  construir_imagens || falhou "o build de uma imagem falhou."
  msg "Subindo… (aguarda todos os serviços saudáveis; até 15 min)"
  compose up -d --wait --wait-timeout 900 || falhou "o stack não ficou saudável."
}

passo_conferir() {
  local config_js setup
  config_js="$(compose exec -T gateway wget -qO- http://127.0.0.1:8000/config.js 2>/dev/null || true)"
  case "$config_js" in
    *__ECHO_CONFIG__*) ;;
    *) falhou "o gateway não serviu o /config.js." ;;
  esac
  setup="$(compose exec -T functions echo-admin setup-status 2>/dev/null || true)"
  case "$setup" in
    *'"precisa_setup":true'*) PRECISA_SETUP=true ;;
    *'"precisa_setup":false'*) PRECISA_SETUP=false ;;
    *) falhou "as funções não responderam ao 'echo-admin setup-status' (saída: ${setup:-vazia})." ;;
  esac
  local url_https
  url_https="$(env_get "$ECHO_ENV_FILE" ECHO_PUBLIC_URL)"
  if [ "$INSTALACAO_NOVA" = true ] && [[ "$url_https" == https://* ]] && [ "$(env_get "$ECHO_ENV_FILE" ECHO_BEHIND_PROXY)" != "true" ]; then
    conferir_https "$url_https"
  fi
}

passo_imprimir() {
  local url token
  url="$(env_get "$ECHO_ENV_FILE" ECHO_PUBLIC_URL)"
  token="$(env_get "$ECHO_ENV_FILE" ECHO_SETUP_TOKEN)"
  msg "Pronto."
  printf '\n  Echo:            %s\n' "$url"
  if [ "$HTTPS_OK" = false ]; then
    printf '\n  AVISO: o certificado HTTPS de %s ainda não respondeu desta máquina: o link abaixo pode falhar com erro de TLS.\n' "$url"
    printf '  Confira se o DNS do domínio aponta para o IP desta máquina (dig +short <domínio>), se as portas 80 e 443 estão abertas\n'
    printf '  no firewall e veja ./echo logs gateway (procure por "acme" ou "obtain"). O Caddy continua tentando sozinho.\n\n'
  fi
  if [ "$PRECISA_SETUP" = true ] && [ -n "$token" ]; then
    printf '  Primeiro acesso: %s/setup?codigo=%s\n' "$url" "$token"
  else
    printf '  Esta instalação já tem administrador: entre em %s/auth\n' "$url"
  fi
  printf '\n  Guarde o arquivo .env: ele tem as chaves do banco e do Vault. Sem ele um backup não restaura.\n'
  if [ "$M_MODO_FINAL" = "localhost" ]; then
    printf '  Modo avaliação: o endereço fica fixo e só abre nesta máquina (127.0.0.1). Para usar um domínio depois, os dados não migram\n'
    printf '  sozinhos: ./echo backup, docker compose -p %s down -v (apaga os volumes), remova o .env e rode ./install.sh --domain …\n' "$ECHO_PROJ"
  fi
  if [[ "$url" == http://* ]]; then
    local host="${url#http://}"
    host="${host%%[:/]*}"
    if [ "$host" != "localhost" ] && ! [[ "$host" =~ ^127\. ]]; then
      printf '\n  AVISO: HTTP fora de localhost não é contexto seguro: sem instalação como app (PWA), sem notificações push\n'
      printf '  e sem gravação de áudio no navegador. Para ter tudo isso, use um domínio com HTTPS (--domain).\n'
    fi
  fi
  if [ "$PRECISA_SETUP" = true ] && [ -n "$token" ]; then
    printf '  Próximos passos: crie o administrador no link acima, depois Configurações > Números, aba QR Code: digite um nome de exibição e clique em Gerar QR.\n'
  else
    printf '  Próximos passos: Configurações > Números, aba QR Code: digite um nome de exibição e clique em Gerar QR.\n'
  fi
  printf '  Operação do dia a dia: ./echo status | logs | backup | upgrade | doctor\n'
}

INSTALACAO_NOVA=false

main() {
  parse_args "$@"
  cd "$ECHO_DIR"
  isolar_compose

  ECHO_ENV_FILE="$ECHO_DIR/.env"
  export ECHO_VERSION
  ECHO_VERSION="$(ler_versao)"
  if git -C "$ECHO_DIR" rev-parse --short HEAD >/dev/null 2>&1; then
    GIT_SHA="$(git -C "$ECHO_DIR" rev-parse --short HEAD)"
    export GIT_SHA
  fi

  if [ -f "$ECHO_ENV_FILE" ]; then
    ECHO_PROJ="$(env_get "$ECHO_ENV_FILE" COMPOSE_PROJECT_NAME)"
    ECHO_PROJ="${ECHO_PROJ:-echo}"
    M_MODO_FINAL="existente"
    local url_existente host_existente
    url_existente="$(env_get "$ECHO_ENV_FILE" ECHO_PUBLIC_URL)"
    host_existente="${url_existente#*://}"
    host_existente="${host_existente%%[:/]*}"
    if [ "$host_existente" = "localhost" ] && [ "$(env_get "$ECHO_ENV_FILE" ECHO_BEHIND_PROXY)" != "true" ]; then M_MODO_FINAL="localhost"; fi
  else
    ECHO_PROJ="${COMPOSE_PROJECT_NAME:-echo}"
    [[ "$ECHO_PROJ" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || uso_erro "COMPOSE_PROJECT_NAME inválido ('$ECHO_PROJ'): só letras minúsculas, dígitos, '-' e '_'"
    resolver_modo
    M_MODO_FINAL="$M_MODO"
    INSTALACAO_NOVA=true
  fi

  passo_checagens
  if [ ! -f "$ECHO_ENV_FILE" ]; then
    checar_volumes_antigos
    if [ "$M_MODO" = "dominio" ]; then checar_portas 80 443; else checar_portas "$M_HTTP"; fi
  fi
  confirmar_avisos

  passo_env
  if [ "$OPT_ENV_ONLY" = true ]; then
    msg "--env-only: .env pronto em $ECHO_ENV_FILE. Nada foi construído nem iniciado."
    return 0
  fi

  passo_subir
  PRECISA_SETUP=false
  passo_conferir
  passo_imprimir
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
