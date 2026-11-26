// Testes do install.sh e do ./echo SEM Docker de verdade: um `docker` de mentira no PATH (registra cada chamada e
// responde o mínimo) e uma cópia mínima da árvore numa pasta temporária. O que não dá para provar aqui (build,
// compose up, backup/restore de verdade) é medido contra um stack real em M-IN-1..6 (ver o relatório do instalador).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chavesDoEnv, gerarEnv, lerEnv } from "../docker/tools/gen-keys.mjs";

const RAIZ = resolve(import.meta.dirname, "..");
const PASTA_DO_NODE = dirname(process.execPath);
const pastas = [];

afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

const DOCKER_FALSO = `#!/bin/bash
printf '%s\\t' "$PWD" "$@" >>"$STUB_LOG"; printf '\\n' >>"$STUB_LOG"
case "$1" in
  info)
    if [ "\${STUB_DOCKER_DOWN:-}" = 1 ]; then exit 1; fi
    if [ "\${2:-}" = "-f" ]; then printf '%s\\n' "$STUB_DOCKER_ROOT"; fi
    exit 0 ;;
  version) printf '29.1.5\\n'; exit 0 ;;
  compose)
    if [ "$2" = "version" ]; then printf '%s\\n' "\${STUB_COMPOSE_VERSION:-5.0.2}"; exit 0; fi
    if [ -n "\${STUB_COMPOSE_FAIL:-}" ]; then case " $* " in *" $STUB_COMPOSE_FAIL "*) exit 1 ;; esac; fi
    case " $* " in
      *" logs "*) printf '%s' "\${STUB_DB_LOG:-}"; exit 0 ;;
      *" ps db --format {{.Health}} "*) printf '%s\\n' "\${STUB_DB_SAUDE:-}"; exit 0 ;;
      *" ps db --format {{.State}} "*) printf '%s\\n' "\${STUB_DB_ESTADO:-}"; exit 0 ;;
      *" exec -T db psql "*) printf '%s' "\${STUB_PSQL:-}"; exit 0 ;;
      *" port gateway 80 "*) printf '%s\\n' "\${STUB_GATEWAY_PORT:-}"; exit 0 ;;
      *" ps --status running -q"*) printf '%s' "\${STUB_RODANDO-abc123}"; exit 0 ;;
      *" exec -T gateway wget "*) if [ -n "\${STUB_INSTALL_OK:-}" ]; then printf '__ECHO_CONFIG__'; fi; exit 0 ;;
      *" exec -T functions echo-admin setup-status"*) if [ -n "\${STUB_INSTALL_OK:-}" ]; then printf '{"precisa_setup":true}'; fi; exit 0 ;;
      *" exec -T functions printenv "*)
        var="\${@: -1}"; nome="STUB_ENV_$var"
        if [ -n "\${!nome+x}" ]; then printf '%s\\n' "\${!nome}"; exit 0; fi
        exit 1 ;;
    esac
    exit 0 ;;
  image)
    if [ "$2" = inspect ] && [ "$3" = -f ]; then printf '%s\\n' "\${STUB_PG_BASE:-}"; fi
    exit 0 ;;
  volume)
    if [ "$2" = "ls" ]; then printf '%s' "\${STUB_VOLUMES:-}"; fi
    exit 0 ;;
  ps)
    if [ "$2" = "-aq" ]; then printf '%s' "\${STUB_PS_AQ:-}"; fi
    exit 0 ;;
  network)
    case ":\${STUB_NETWORKS:-}:" in *":$3:"*) exit 0 ;; esac
    exit 1 ;;
  run) exit "\${STUB_RUN_EXIT:-0}" ;;
esac
exit 0
`;

// git de mentira para o ./echo upgrade: nada escreve em repositório nenhum. Lê o comportamento de variáveis STUB_GIT_*.
const GIT_FALSO = `#!/bin/bash
versao_no_arquivo() {
  local q='"'
  sed -i "s/^  .version.: .[0-9.]*./  \${q}version\${q}: \${q}\${STUB_GIT_VERSAO_ALVO:-2.12.0}\${q}/" "$1/package.json"
}
printf 'git\t%s\n' "$*" >>"$STUB_LOG"
dir="$PWD"; if [ "$1" = "-C" ]; then dir="$2"; shift 2; fi
case "$1" in
  rev-parse)
    case "$*" in
      *--git-dir*) exit 0 ;;
      *"--short HEAD"*) printf 'abc1234\n'; exit 0 ;;
      *"--verify refs/tags/"*) todos="$*"; tag="\${todos##*refs/tags/}"; case " \${STUB_GIT_TAGS:-} " in *" $tag "*) exit 0 ;; esac; exit 1 ;;
      *"--abbrev-ref"*) printf '%s\n' "\${STUB_GIT_UPSTREAM-origin/main}"; exit 0 ;;
    esac ;;
  status) printf '%s' "\${STUB_GIT_SUJO:-}"; exit 0 ;;
  fetch) [ "\${STUB_GIT_FETCH_FAIL:-}" = 1 ] && exit 1; exit 0 ;;
  symbolic-ref) [ "\${STUB_GIT_DETACHED:-}" = 1 ] && exit 1; printf '%s\\n' "\${STUB_GIT_BRANCH:-main}"; exit 0 ;;
  show) printf '{\n  "name": "echo",\n  "version": "%s"\n}\n' "\${STUB_GIT_VERSAO_ALVO:-2.12.0}"; exit 0 ;;
  checkout)
    versao_no_arquivo "$dir"; exit 0 ;;
  pull) versao_no_arquivo "$dir"; exit 0 ;;
esac
exit 0
`;

// curl de mentira (conferência do HTTPS público): não registra no STUB_LOG; STUB_CURL_FAIL=1 simula certificado que não saiu.
const CURL_FALSO = `#!/bin/bash
printf '%s\\n' "$*" >>"\${STUB_CURL_LOG:-/dev/null}"
[ "\${STUB_CURL_FAIL:-}" = 1 ] && exit 7
exit 0
`;

const UNAME_FALSO = `#!/bin/bash
if [ "\${1:-}" = "-m" ]; then printf '%s\\n' "$STUB_UNAME"; else /usr/bin/uname "$@"; fi
`;

const SS_FALSO = `#!/bin/bash
# ss -ltnH "sport = :PORTA": imprime uma linha se a porta estiver na lista STUB_PORTAS_OCUPADAS
todos="$*"
porta="\${todos##*:}"
case " \${STUB_PORTAS_OCUPADAS:-} " in *" $porta "*) printf 'LISTEN 0 4096 0.0.0.0:%s 0.0.0.0:*\\n' "$porta" ;; esac
exit 0
`;

/** Árvore mínima em pasta temporária + pasta de stubs. */
function ambiente({ comNode = true, uname = null, ss = true } = {}) {
  const raiz = mkdtempSync(join(tmpdir(), "echo-cli-"));
  pastas.push(raiz);
  const arvore = join(raiz, "arvore");
  const stubs = join(raiz, "stubs");
  mkdirSync(join(arvore, "docker/tools"), { recursive: true });
  mkdirSync(stubs);
  for (const f of ["install.sh", "echo", "docker/tools/gen-keys.mjs", "package.json", ".env.example"]) {
    copyFileSync(join(RAIZ, f), join(arvore, f));
  }
  chmodSync(join(arvore, "install.sh"), 0o755);
  chmodSync(join(arvore, "echo"), 0o755);
  const escreve = (nome, texto) => {
    writeFileSync(join(stubs, nome), texto);
    chmodSync(join(stubs, nome), 0o755);
  };
  escreve("docker", DOCKER_FALSO);
  escreve("git", GIT_FALSO);
  escreve("curl", CURL_FALSO);
  escreve("sleep", "#!/bin/bash\nexit 0\n");
  if (uname) escreve("uname", UNAME_FALSO);
  if (ss) escreve("ss", SS_FALSO);
  const log = join(raiz, "docker.log");
  writeFileSync(log, "");
  const path = [stubs, ...(comNode ? [PASTA_DO_NODE] : []), "/usr/bin", "/bin"].join(":");
  const env = {
    PATH: path,
    HOME: raiz,
    STUB_LOG: log,
    STUB_DOCKER_ROOT: raiz,
    ...(uname ? { STUB_UNAME: uname } : {}),
  };
  const rodar = (script, args, extra = {}, input = undefined) =>
    spawnSync("bash", [join(arvore, script), ...args], { cwd: raiz, encoding: "utf8", env: { ...env, ...extra }, timeout: 60000, input });
  return {
    arvore,
    raiz,
    log,
    env,
    instalar: (args = ["--env-only", "--yes"], extra = {}) => rodar("install.sh", args, extra),
    echo: (args, extra = {}, input = undefined) => rodar("echo", args, extra, input),
    envLido: () => lerEnv(readFileSync(join(arvore, ".env"), "utf8")),
    chamadas: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t").filter((_, i, a) => i < a.length - 1 || a[i] !== "")),
  };
}

describe("install.sh: ajuda e opções", () => {
  it("--help sai 0 e lista todas as opções", () => {
    const e = ambiente();
    const r = e.instalar(["--help"]);
    expect(r.status).toBe(0);
    for (const opcao of ["--domain", "--url", "--behind-proxy", "--proxy-network", "--port", "--insecure-http", "--yes", "--env-only", "--help"]) {
      expect(r.stdout).toContain(opcao);
    }
    expect(e.chamadas()).toEqual([]);
  });

  it("opção desconhecida sai 2 e não toca o Docker", () => {
    const e = ambiente();
    const r = e.instalar(["--nao-existe"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("opção desconhecida");
    expect(existsSync(join(e.arvore, ".env"))).toBe(false);
  });

  it.each([
    ["--url sem valor", ["--url"]],
    ["porta inválida", ["--port", "99999"]],
    ["porta com letra", ["--port", "80a"]],
    ["--domain com --url", ["--domain", "echo.exemplo.com", "--url", "http://10.0.0.5:8088"]],
    ["--domain com --port", ["--domain", "echo.exemplo.com", "--port", "8088"]],
    ["--domain com --behind-proxy", ["--domain", "echo.exemplo.com", "--behind-proxy"]],
    ["--domain com IP", ["--domain", "10.0.0.5"]],
    ["--domain com esquema", ["--domain", "https://echo.exemplo.com"]],
    ["--behind-proxy sem --url", ["--behind-proxy"]],
    ["--url https sem proxy nem domínio", ["--url", "https://echo.exemplo.com"]],
    ["--url com caminho", ["--url", "http://10.0.0.5:8088/app"]],
    ["--port diverge da porta da URL", ["--url", "http://10.0.0.5:8088", "--port", "9000"]],
    ["--port com --url de IP sem porta (o navegador leria a 80)", ["--url", "http://10.0.0.5", "--port", "8088"]],
    ["--port com --url de localhost sem porta", ["--url", "http://localhost", "--port", "8088"]],
  ])("recusa com exit 2: %s", (_nome, args) => {
    const e = ambiente();
    const r = e.instalar([...args, "--env-only", "--yes"]);
    expect(r.status, r.stderr).toBe(2);
    expect(existsSync(join(e.arvore, ".env"))).toBe(false);
  });
});

describe("install.sh: o que vira .env em cada modo", () => {
  it("sem opção = localhost:8088, bind 127.0.0.1, override só com comentários, .env modo 600", () => {
    const e = ambiente();
    const r = e.instalar();
    expect(r.status, r.stderr).toBe(0);
    const env = e.envLido();
    expect(env.get("ECHO_PUBLIC_URL")).toBe("http://localhost:8088");
    expect(env.get("ECHO_SITE_ADDRESS")).toBe(":80");
    expect(env.get("ECHO_BIND")).toBe("127.0.0.1");
    expect(env.get("ECHO_HTTP_PORT")).toBe("8088");
    expect(env.get("ECHO_BEHIND_PROXY")).toBe("false");
    expect(env.get("COMPOSE_PROJECT_NAME")).toBe("echo");
    expect(env.get("COMPOSE_FILE")).toBe("docker-compose.yml:docker-compose.override.yml");
    expect(statSync(join(e.arvore, ".env")).mode & 0o777).toBe(0o600);
    const override = readFileSync(join(e.arvore, "docker-compose.override.yml"), "utf8");
    expect(override.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"))).toEqual([]);
  });

  it("COMPOSE_PROJECT_NAME do ambiente e --port valem numa instalação nova", () => {
    const e = ambiente();
    const r = e.instalar(["--port", "58230", "--env-only", "--yes"], { COMPOSE_PROJECT_NAME: "echo-sh-inst" });
    expect(r.status, r.stderr).toBe(0);
    const env = e.envLido();
    expect(env.get("COMPOSE_PROJECT_NAME")).toBe("echo-sh-inst");
    expect(env.get("ECHO_HTTP_PORT")).toBe("58230");
    expect(env.get("ECHO_PUBLIC_URL")).toBe("http://localhost:58230");
  });

  it("nome de projeto inválido sai 2", () => {
    const e = ambiente();
    expect(e.instalar(["--env-only", "--yes"], { COMPOSE_PROJECT_NAME: "Echo Ruim" }).status).toBe(2);
  });

  it("--domain: HTTPS, 0.0.0.0, 80/443 e dominio.yml no COMPOSE_FILE", () => {
    const e = ambiente();
    const r = e.instalar(["--domain", "echo.exemplo.com", "--env-only", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    const env = e.envLido();
    expect(env.get("ECHO_PUBLIC_URL")).toBe("https://echo.exemplo.com");
    expect(env.get("ECHO_SITE_ADDRESS")).toBe("echo.exemplo.com");
    expect(env.get("ECHO_BIND")).toBe("0.0.0.0");
    expect(env.get("ECHO_HTTP_PORT")).toBe("80");
    expect(env.get("ECHO_HTTPS_PORT")).toBe("443");
    expect(env.get("COMPOSE_FILE")).toBe("docker-compose.yml:docker/compose/dominio.yml:docker-compose.override.yml");
  });

  it("--domain com a 80 ocupada: recusa e diz qual porta", () => {
    const e = ambiente();
    const r = e.instalar(["--domain", "echo.exemplo.com", "--env-only", "--yes"], { STUB_PORTAS_OCUPADAS: "80" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("porta 80");
    expect(existsSync(join(e.arvore, ".env"))).toBe(false);
  });

  it("--domain com a 443 ocupada também recusa", () => {
    const e = ambiente();
    const r = e.instalar(["--domain", "echo.exemplo.com", "--env-only", "--yes"], { STUB_PORTAS_OCUPADAS: "443" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("porta 443");
  });

  it("porta 8088 ocupada no modo padrão: recusa e sugere --port ou --behind-proxy", () => {
    const e = ambiente();
    const r = e.instalar(["--env-only", "--yes"], { STUB_PORTAS_OCUPADAS: "8088" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--port");
    expect(r.stderr).toContain("--behind-proxy");
  });

  it("--behind-proxy no host: 127.0.0.1:porta, trusted_proxies ligado, sem arquivo extra", () => {
    const e = ambiente();
    const r = e.instalar(["--behind-proxy", "--url", "https://echo.exemplo.com", "--port", "8099", "--env-only", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    const env = e.envLido();
    expect(env.get("ECHO_PUBLIC_URL")).toBe("https://echo.exemplo.com");
    expect(env.get("ECHO_BEHIND_PROXY")).toBe("true");
    expect(env.get("ECHO_BIND")).toBe("127.0.0.1");
    expect(env.get("ECHO_HTTP_PORT")).toBe("8099");
    expect(env.get("ECHO_SITE_ADDRESS")).toBe(":80");
    expect(env.get("COMPOSE_FILE")).toBe("docker-compose.yml:docker-compose.override.yml");
  });

  it("--behind-proxy não confere porta 80/443 (o proxy é que usa)", () => {
    const e = ambiente();
    const r = e.instalar(["--behind-proxy", "--url", "https://echo.exemplo.com", "--env-only", "--yes"], { STUB_PORTAS_OCUPADAS: "80 443" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("--proxy-network liga proxy-rede.yml, implica --behind-proxy e exige a rede existente", () => {
    const e = ambiente();
    const r = e.instalar(["--proxy-network", "traefik", "--url", "https://echo.exemplo.com", "--env-only", "--yes"], { STUB_NETWORKS: "traefik" });
    expect(r.status, r.stderr).toBe(0);
    const env = e.envLido();
    expect(env.get("ECHO_BEHIND_PROXY")).toBe("true");
    expect(env.get("ECHO_PROXY_NETWORK")).toBe("traefik");
    expect(env.get("COMPOSE_FILE")).toBe("docker-compose.yml:docker/compose/proxy-rede.yml:docker-compose.override.yml");

    const outro = ambiente();
    const r2 = outro.instalar(["--proxy-network", "inexistente", "--url", "https://echo.exemplo.com", "--env-only", "--yes"], { STUB_NETWORKS: "traefik" });
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("inexistente");
    expect(existsSync(join(outro.arvore, ".env"))).toBe(false);
  });

  it.each(["10.0.0.5", "172.16.0.9", "172.31.255.1", "192.168.1.20", "100.64.0.1", "100.127.255.254"])("--url http://%s (IP privado) funciona sem --insecure-http e abre em 0.0.0.0", (ip) => {
    const e = ambiente();
    const r = e.instalar(["--url", `http://${ip}:8088`, "--env-only", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    const env = e.envLido();
    expect(env.get("ECHO_PUBLIC_URL")).toBe(`http://${ip}:8088`);
    expect(env.get("ECHO_BIND")).toBe("0.0.0.0");
    expect(env.get("ECHO_HTTP_PORT")).toBe("8088");
    expect(env.get("ECHO_BEHIND_PROXY")).toBe("false");
  });

  it.each(["203.0.113.10", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.128.0.1", "100.63.0.1", "192.169.0.1", "11.0.0.1"])("--url http://%s (IP público) é recusado com a mensagem do domínio", (ip) => {
    const e = ambiente();
    const r = e.instalar(["--url", `http://${ip}:8088`, "--env-only", "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("domínio");
    expect(r.stderr).toContain("VPN");
    expect(r.stderr).toContain("--insecure-http");
    expect(existsSync(join(e.arvore, ".env"))).toBe(false);
  });

  it("--insecure-http libera o IP público", () => {
    const e = ambiente();
    const r = e.instalar(["--url", "http://203.0.113.10:8088", "--insecure-http", "--env-only", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(e.envLido().get("ECHO_PUBLIC_URL")).toBe("http://203.0.113.10:8088");
  });

  it("--port 80 com --url sem porta coincide: aceita e grava a 80", () => {
    const e = ambiente();
    const r = e.instalar(["--url", "http://10.0.0.5", "--port", "80", "--env-only", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(e.envLido().get("ECHO_PUBLIC_URL")).toBe("http://10.0.0.5");
    expect(e.envLido().get("ECHO_HTTP_PORT")).toBe("80");
  });

  it("--behind-proxy também recusa http:// em IP público sem --insecure-http (a regra não é de um modo só)", () => {
    const e = ambiente();
    const r = e.instalar(["--behind-proxy", "--url", "http://203.0.113.10:8088", "--env-only", "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--insecure-http");
    expect(existsSync(join(e.arvore, ".env"))).toBe(false);

    const livre = ambiente();
    const r2 = livre.instalar(["--behind-proxy", "--url", "http://203.0.113.10:8088", "--insecure-http", "--env-only", "--yes"]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(livre.envLido().get("ECHO_BEHIND_PROXY")).toBe("true");

    const privado = ambiente();
    const r3 = privado.instalar(["--behind-proxy", "--url", "http://10.0.0.5:8088", "--env-only", "--yes"]);
    expect(r3.status, r3.stderr).toBe(0);

    const https = ambiente();
    const r4 = https.instalar(["--behind-proxy", "--url", "https://203.0.113.10", "--env-only", "--yes"]);
    expect(r4.status, r4.stderr).toBe(0);
  });

  it("--url http://localhost:PORTA fica em 127.0.0.1; nome de host que não é IP não é recusado", () => {
    const e = ambiente();
    const r = e.instalar(["--url", "http://localhost:9090", "--env-only", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(e.envLido().get("ECHO_BIND")).toBe("127.0.0.1");
    expect(e.envLido().get("ECHO_HTTP_PORT")).toBe("9090");

    const h = ambiente();
    const r2 = h.instalar(["--url", "http://echo.lan:8088", "--env-only", "--yes"]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(h.envLido().get("ECHO_BIND")).toBe("0.0.0.0");
  });
});

describe("install.sh: checagens do ambiente", () => {
  it("Docker parado: exit 1 e nada é escrito", () => {
    const e = ambiente();
    const r = e.instalar(["--env-only", "--yes"], { STUB_DOCKER_DOWN: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker");
    expect(existsSync(join(e.arvore, ".env"))).toBe(false);
  });

  it.each(["2.20.3", "2.24.6", "1.29.2"])("Compose %s é anterior ao mínimo 2.24.7: recusa", (versao) => {
    const e = ambiente();
    const r = e.instalar(["--env-only", "--yes"], { STUB_COMPOSE_VERSION: versao });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("2.24.7");
  });

  it.each(["2.24.7", "2.30.1", "v5.0.2", "2.40.0-desktop.1", "5.0.2"])("Compose %s serve", (versao) => {
    const e = ambiente();
    const r = e.instalar(["--env-only", "--yes"], { STUB_COMPOSE_VERSION: versao });
    expect(r.status, r.stderr).toBe(0);
  });

  it("arquitetura fora de x86_64/aarch64/arm64: recusa", () => {
    const e = ambiente({ uname: "armv7l" });
    const r = e.instalar(["--env-only", "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("armv7l");
  });

  it("aarch64 passa com aviso de não testado", () => {
    const e = ambiente({ uname: "aarch64" });
    const r = e.instalar(["--env-only", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("ARM64");
  });

  it("a linha de resumo diz Docker, Compose, arquitetura e RAM", () => {
    const e = ambiente();
    const r = e.instalar(["--env-only", "--yes"]);
    expect(r.stdout).toMatch(/\[echo\] Docker 29\.1\.5, Compose 5\.0\.2, \S+, \d+,\d GB RAM: ok/);
  });
});

describe("install.sh: .env existente (idempotência, D37)", () => {
  it("segunda execução não muda nenhum byte do .env e ignora as opções de endereço com aviso", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const antes = readFileSync(join(e.arvore, ".env"), "utf8");
    const r = e.instalar(["--domain", "outro.exemplo.com", "--env-only", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("ignoradas");
    expect(readFileSync(join(e.arvore, ".env"), "utf8")).toBe(antes);
    expect(e.envLido().get("ECHO_PUBLIC_URL")).toBe("http://localhost:8088");
  });

  it("com o .env existente a porta ocupada (o próprio stack) não bloqueia", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const r = e.instalar(["--env-only", "--yes"], { STUB_PORTAS_OCUPADAS: "8088" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("--env-only com uma chave apagada só a acrescenta (as outras ficam iguais) e guarda cópia", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const caminho = join(e.arvore, ".env");
    const original = readFileSync(caminho, "utf8");
    const semChave = original
      .split("\n")
      .filter((l) => !l.startsWith("QR_WEBHOOK_SECRET=") && !l.startsWith("FN_REQUEST_TIMEOUT_MS="))
      .join("\n");
    writeFileSync(caminho, semChave, { mode: 0o600 });
    const r = e.instalar();
    expect(r.status, r.stderr).toBe(0);
    const depois = e.envLido();
    const antesMapa = lerEnv(semChave);
    for (const [k, v] of antesMapa) expect(depois.get(k), k).toBe(v);
    expect(depois.get("QR_WEBHOOK_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(depois.get("QR_WEBHOOK_SECRET")).not.toBe(lerEnv(original).get("QR_WEBHOOK_SECRET"));
    expect(depois.has("FN_REQUEST_TIMEOUT_MS")).toBe(true);
    expect([...depois.keys()].sort()).toEqual([...chavesDoEnv()].sort());
    expect(statSync(caminho).mode & 0o777).toBe(0o600);
  });

  it("recria o override só com comentários se ele sumiu, sem tocar num existente", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const alvo = join(e.arvore, "docker-compose.override.yml");
    writeFileSync(alvo, "services:\n  qr:\n    environment:\n      X: '1'\n");
    expect(e.instalar().status).toBe(0);
    expect(readFileSync(alvo, "utf8")).toContain("X: '1'");
    rmSync(alvo);
    expect(e.instalar().status).toBe(0);
    expect(existsSync(alvo)).toBe(true);
  });
});

describe("install.sh: .env que não é de instalação", () => {
  it(".env só com VITE_* (o antigo do front) é recusado com a instrução de mover, sem alterar o arquivo", () => {
    const e = ambiente();
    const caminho = join(e.arvore, ".env");
    const conteudo = "VITE_SUPABASE_URL=https://exemplo.supabase.co\nVITE_SUPABASE_PUBLISHABLE_KEY=abc\n";
    writeFileSync(caminho, conteudo);
    const r = e.instalar(["--env-only", "--yes"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(".env.development.local");
    expect(readFileSync(caminho, "utf8")).toBe(conteudo);
    expect(existsSync(`${caminho}.bak`)).toBe(false);
  });

  it("instalação existente que tem também VITE_* segue o fluxo normal (completa, não recusa)", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const caminho = join(e.arvore, ".env");
    writeFileSync(caminho, `${readFileSync(caminho, "utf8")}VITE_EXTRA=1\n`, { mode: 0o600 });
    const r = e.instalar();
    expect(r.status, r.stderr).toBe(0);
  });
});

describe("install.sh: sem Node no host (M-IN-1 em versão de teste)", () => {
  it("gera o .env por um contêiner node:alpine descartável, com o usuário do host e a pasta montada", () => {
    const e = ambiente({ comNode: false });
    // O docker falso não executa o contêiner: só registra. O .env não nasce, e o instalador falha avisando.
    const r = e.instalar(["--env-only", "--yes"], { STUB_RUN_EXIT: "0" });
    const run = e.chamadas().find((c) => c.includes("run"));
    expect(run, r.stderr).toBeDefined();
    const texto = run.join(" ");
    expect(texto).toContain("node:22.22.3-alpine3.24");
    expect(texto).toContain("-u");
    expect(texto).toMatch(/-v \S+:\/w/);
    expect(texto).toContain("docker/tools/gen-keys.mjs");
    expect(texto).toContain("--out .env");
    expect(texto).toContain("--com-override");
    expect(texto).toContain("--public-url http://localhost:8088");
  });
});

describe("./echo: comandos que não precisam do Docker", () => {
  it("--help e sem argumento saem 0", () => {
    const e = ambiente();
    for (const args of [["--help"], []]) {
      const r = e.echo(args);
      expect(r.status).toBe(0);
      for (const c of ["status", "logs", "up", "down", "restart", "upgrade", "backup", "restore", "reset-password", "recovery-link", "setup-link", "doctor", "psql", "env check"]) {
        expect(r.stdout, c).toContain(c);
      }
    }
  });

  it("sem .env: exit 1 dizendo para rodar o install.sh", () => {
    const e = ambiente();
    const r = e.echo(["status"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("install.sh");
  });

  it("comando desconhecido: exit 2", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    expect(e.echo(["bobagem"]).status).toBe(2);
  });

  it("`down -v` e `down --volumes` são recusados antes de chamar o compose", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    for (const flag of ["-v", "--volumes"]) {
      const r = e.echo(["down", flag]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("nunca apaga volumes");
    }
    expect(e.chamadas().filter((c) => c.includes("down"))).toEqual([]);
  });

  it("env check: ok com todas as chaves; falta de chave dá exit 1; chave a mais é só aviso", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    let r = e.echo(["env", "check"]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("ok");

    const caminho = join(e.arvore, ".env");
    const original = readFileSync(caminho, "utf8");
    writeFileSync(caminho, original.replace(/^MAX_MEDIA_BYTES=.*$/m, "") + "\nMINHA_CHAVE=1\n");
    r = e.echo(["env", "check"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("faltando no .env: MAX_MEDIA_BYTES");
    expect(r.stdout).toContain("MINHA_CHAVE");
    expect(r.stdout).not.toMatch(/[0-9a-f]{48}/);
  });

  it.each([
    ["reset-password sem e-mail", ["reset-password"]],
    ["reset-password com e-mail inválido", ["reset-password", "isso-nao-e-email"]],
    ["recovery-link sem e-mail", ["recovery-link"]],
    ["restore sem diretório", ["restore"]],
    ["upgrade com tag inválida", ["upgrade", "--to", "1.2"]],
    ["backup com opção desconhecida", ["backup", "--nada"]],
    ["logs com --tail não numérico", ["logs", "--tail", "abc"]],
    ["env sem 'check'", ["env"]],
  ])("uso errado sai 2: %s", (_nome, args) => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    expect(e.echo(args).status).toBe(2);
  });

  it.each([
    ["restore sem diretório", ["restore"]],
    ["comando desconhecido", ["nao-existe"]],
    ["backup com opção desconhecida", ["backup", "--nada"]],
  ])("a dica de uso do ./echo aponta para o ./echo, não para o instalador: %s", (_nome, args) => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const r = e.echo(args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Rode ./echo --help para ver as opções.");
    expect(r.stderr).not.toContain("install.sh");
  });

  it("opção desconhecida no install.sh continua apontando para ./install.sh --help", () => {
    const e = ambiente();
    const r = e.instalar(["--nao-existe"]);
    expect(r.stderr).toContain("Rode ./install.sh --help para ver as opções.");
  });

  it("reset-password --senha-stdin recusa senha de menos de 8 caracteres (exit 2) sem chamar o compose exec", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const r = spawnSync("bash", [join(e.arvore, "echo"), "reset-password", "admin@example.com", "--senha-stdin"], {
      cwd: e.raiz,
      encoding: "utf8",
      env: e.env,
      input: "curta\n",
    });
    expect(r.status).toBe(2);
    expect(e.chamadas().filter((c) => c.includes("exec"))).toEqual([]);
  });

  it("restore de pasta que não é backup: exit 1 e nada é parado", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const vazia = join(e.raiz, "vazia");
    mkdirSync(vazia);
    const r = e.echo(["restore", vazia]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("manifest.json");
    expect(e.chamadas().filter((c) => c.includes("down") || c.includes("stop"))).toEqual([]);
  });
});

describe("./echo restore: o manifest tem de conferir os 5 arquivos", () => {
  const ARQUIVOS = ["db-data.tar", "qr-sessions.tar", "storage-data.tar", "caddy-data.tar", ".env"];
  const sha = (arq) => createHash("sha256").update(readFileSync(arq)).digest("hex");

  function backupCom(e, { arquivos = ARQUIVOS, manifest }) {
    const dir = join(e.raiz, "bkp");
    mkdirSync(dir);
    for (const nome of ARQUIVOS) writeFileSync(join(dir, nome), `conteudo de ${nome}`);
    const linhas = arquivos.map((nome) => `    "${nome}": {"bytes": ${readFileSync(join(dir, nome)).length}, "sha256": "${sha(join(dir, nome))}"}`);
    const corpo = manifest ?? `{\n  "echo_version": "2.12.0",\n  "postgres_base": "x",\n  "arquivos": {\n${linhas.join(",\n")}\n  }\n}\n`;
    writeFileSync(join(dir, "manifest.json"), corpo);
    return dir;
  }
  const paradas = (e) => e.chamadas().filter((c) => c.includes("down") || c.includes("stop"));

  it.each([
    ["vazio", "{}\n"],
    ["reformatado (uma entrada por linha, com espaços diferentes)", '{"arquivos":{"db-data.tar":{ "bytes":1, "sha256":"00"}}}'],
  ])("manifest %s: recusa antes de parar o stack", (_n, manifest) => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const dir = backupCom(e, { manifest });
    const r = e.echo(["restore", dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("manifest ilegível ou incompleto");
    expect(paradas(e)).toEqual([]);
  });

  it("manifest sem um dos arquivos (o .env) também é recusado", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const dir = backupCom(e, { arquivos: ARQUIVOS.filter((a) => a !== ".env") });
    const r = e.echo(["restore", dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("manifest ilegível ou incompleto");
    expect(r.stderr).toContain(".env");
    expect(paradas(e)).toEqual([]);
  });

  it("manifest completo passa da conferência (e só então esbarra em outra checagem, sem parar o stack)", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const dir = backupCom(e, {});
    const r = e.echo(["restore", dir]);
    expect(r.stderr).not.toContain("manifest ilegível");
    expect(r.stderr).not.toContain("sha256 diferente");
    expect(paradas(e)).toEqual([]);
  });

  it("arquivo alterado depois do backup: sha256 diferente, recusa", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const dir = backupCom(e, {});
    writeFileSync(join(dir, "db-data.tar"), "adulterado");
    const r = e.echo(["restore", dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("sha256 diferente");
    expect(paradas(e)).toEqual([]);
  });
});

describe("./echo: age só no projeto do ECHO_ENV_FILE (M-IN-4 em versão de teste)", () => {
  it("passa --env-file absoluto, -p do projeto do arquivo, --project-directory da árvore e roda da árvore", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const outraPasta = join(e.raiz, "outro");
    mkdirSync(outraPasta);
    const outroEnv = join(outraPasta, ".env");
    writeFileSync(outroEnv, gerarEnv({ publicUrl: "http://localhost:58231", httpPort: 58231, project: "projeto-x", comOverride: true }), { mode: 0o600 });

    const r = e.echo(["status"], { ECHO_ENV_FILE: outroEnv });
    expect(r.status, r.stderr).toBe(0);
    const compose = e.chamadas().filter((c) => c[1] === "compose" && c[2] === "--project-directory");
    expect(compose.length).toBeGreaterThan(0);
    for (const c of compose) {
      expect(c[0]).toBe(e.arvore.replace(/\/$/, ""));
      expect(c).toEqual(expect.arrayContaining(["--env-file", outroEnv, "-p", "projeto-x", "--project-directory", e.arvore]));
      expect(c).not.toContain("echo");
    }
  });

  it("caminho relativo em ECHO_ENV_FILE é resolvido contra o diretório de onde o comando foi chamado", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const r = spawnSync("bash", [join(e.arvore, "echo"), "status"], {
      cwd: e.arvore,
      encoding: "utf8",
      env: { ...e.env, ECHO_ENV_FILE: ".env" },
    });
    expect(r.status, r.stderr).toBe(0);
    const compose = e.chamadas().find((c) => c[1] === "compose" && c[2] === "--project-directory");
    expect(compose).toEqual(expect.arrayContaining(["--env-file", join(e.arvore, ".env")]));
  });

  it("COMPOSE_FILE e COMPOSE_PROFILES do shell não entram: os arquivos vêm do .env", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    // O docker falso registra o ambiente que recebeu: confirma que as variáveis foram removidas.
    writeFileSync(
      join(e.raiz, "stubs/docker"),
      DOCKER_FALSO.replace('printf \'%s\\t\' "$PWD" "$@"', 'printf "CF=%s PR=%s\\t" "${COMPOSE_FILE:-}" "${COMPOSE_PROFILES:-}" >>"$STUB_LOG"; printf \'%s\\t\' "$PWD" "$@"'),
    );
    const r = e.echo(["status"], { COMPOSE_FILE: "outro.yml", COMPOSE_PROFILES: "x" });
    expect(r.status, r.stderr).toBe(0);
    const bruto = readFileSync(e.log, "utf8");
    expect(bruto).toContain("CF= PR=");
    expect(bruto).not.toContain("outro.yml");
  });

  it("cria o override se o COMPOSE_FILE o lista e ele faltar", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    rmSync(join(e.arvore, "docker-compose.override.yml"));
    const r = e.echo(["status"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(e.arvore, "docker-compose.override.yml"))).toBe(true);
  });
});

describe("db em loop com linhas preflight: (o .env tem segredo de exemplo)", () => {
  const LOG = "preflight: POSTGRES_PASSWORD recusada (placeholder)\npreflight: JWT_SECRET recusada (placeholder)\n";

  it("status avisa em uma linha e manda rodar ./install.sh", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const r = e.echo(["status"], { STUB_DB_LOG: LOG, STUB_DB_SAUDE: "" });
    expect(r.status, r.stderr).toBe(0);
    const linhas = r.stdout.split("\n").filter((l) => l.includes("preflight"));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatch(/^AVISO: o banco recusou os segredos do \.env .*segredo de exemplo\. Rode \.\/install\.sh/);
    expect(r.stdout).not.toContain("POSTGRES_PASSWORD");
  });

  it("status não avisa com o db saudável, mesmo com a linha velha no log, nem sem a linha", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    expect(e.echo(["status"], { STUB_DB_LOG: LOG, STUB_DB_SAUDE: "healthy" }).stdout).not.toContain("recusou os segredos");
    expect(e.echo(["status"], { STUB_DB_LOG: "", STUB_DB_SAUDE: "" }).stdout).not.toContain("recusou os segredos");
  });

  it("doctor dá ERRO banco com a mesma explicação (e não o genérico 'não está rodando')", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const r = e.echo(["doctor"], { STUB_DB_LOG: LOG, STUB_DB_SAUDE: "" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^ERRO banco: o banco recusou os segredos do \.env .*Rode \.\/install\.sh/m);
    expect(r.stdout).not.toMatch(/^ERRO banco: o serviço db não está rodando/m);
  });
});

describe("./echo doctor: segredos (mesmas regras da guarda D43, sem mostrar valor)", () => {
  function doctorCom(alteracoes) {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const caminho = join(e.arvore, ".env");
    let texto = readFileSync(caminho, "utf8");
    for (const [k, v] of Object.entries(alteracoes)) texto = texto.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`);
    writeFileSync(caminho, texto, { mode: 0o600 });
    return e.echo(["doctor"]);
  }

  it("segredo placeholder = ERRO, exit 1, e o valor não aparece", () => {
    const r = doctorCom({ POSTGRES_PASSWORD: "__GERE_COM_install.sh__" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^ERRO segredos: .*POSTGRES_PASSWORD\(placeholder\)/m);
  });

  it("segredo fora do formato = ERRO e o valor errado não é impresso", () => {
    const r = doctorCom({ JWT_SECRET: "SEGREDO-INVALIDO-XYZ" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("JWT_SECRET(formato)");
    expect(r.stdout).not.toContain("SEGREDO-INVALIDO-XYZ");
  });

  it("só zeros ou um caractere repetido = ERRO", () => {
    const r = doctorCom({ VAULT_ROOT_KEY: "0".repeat(64), ZAPO_DB_PASSWORD: "a".repeat(48) });
    expect(r.stdout).toContain("VAULT_ROOT_KEY(um caractere só)");
    expect(r.stdout).toContain("ZAPO_DB_PASSWORD(um caractere só)");
  });

  it("segredo vazio = ERRO, mas ECHO_SETUP_TOKEN vazio é permitido (/setup desligado)", () => {
    const r = doctorCom({ AI_KEY_SECRET: "", ECHO_SETUP_TOKEN: "" });
    expect(r.stdout).toContain("AI_KEY_SECRET(vazio)");
    expect(r.stdout).not.toContain("ECHO_SETUP_TOKEN(");
  });

  it("ECHO_SETUP_TOKEN com menos de 32 hex = ERRO", () => {
    const r = doctorCom({ ECHO_SETUP_TOKEN: "abcdef" });
    expect(r.stdout).toContain("ECHO_SETUP_TOKEN(formato)");
  });

  it("hex maiúsculo é aceito como na guarda do banco, salvo na VAULT_ROOT_KEY (par do preflight.sh)", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const caminho = join(e.arvore, ".env");
    const env = lerEnv(readFileSync(caminho, "utf8"));
    let texto = readFileSync(caminho, "utf8");
    for (const k of ["POSTGRES_PASSWORD", "JWT_SECRET", "ZAPO_DB_PASSWORD", "ECHO_SETUP_TOKEN", "REALTIME_DB_ENC_KEY"]) {
      texto = texto.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${env.get(k).toUpperCase()}`);
    }
    writeFileSync(caminho, texto, { mode: 0o600 });
    const ok = e.echo(["doctor"]);
    expect(ok.stdout).toMatch(/^OK segredos:/m);

    writeFileSync(caminho, texto.replace(/^VAULT_ROOT_KEY=.*$/m, `VAULT_ROOT_KEY=${env.get("VAULT_ROOT_KEY").toUpperCase()}`), { mode: 0o600 });
    const ruim = e.echo(["doctor"]);
    expect(ruim.status).toBe(1);
    expect(ruim.stdout).toContain("VAULT_ROOT_KEY(formato)");
  });

  it("um .env recém-gerado passa nos segredos", () => {
    const r = doctorCom({});
    expect(r.stdout).toMatch(/^OK segredos:/m);
  });

  it("IP público em http = AVISO", () => {
    const r = doctorCom({ ECHO_PUBLIC_URL: "http://203.0.113.10:8088" });
    expect(r.stdout).toMatch(/^AVISO endereço: http:\/\/203\.0\.113\.10:8088 é HTTP em IP público/m);
  });

  it("http:// de IP privado ou de nome que não é localhost = AVISO sobre a mídia; localhost = OK", () => {
    for (const url of ["http://10.0.0.5:8088", "http://echo.lan:8088"]) {
      const r = doctorCom({ ECHO_PUBLIC_URL: url });
      expect(r.stdout, url).toMatch(new RegExp(`^AVISO endereço: ${url.replace(/[.]/g, "\\.")} é HTTP de um host que não é localhost: a mídia só carrega`, "m"));
    }
    for (const url of ["http://localhost:8088", "http://127.0.0.1:8088"]) {
      const r = doctorCom({ ECHO_PUBLIC_URL: url });
      expect(r.stdout, url).toMatch(/^OK endereço: /m);
      expect(r.stdout, url).not.toMatch(/^AVISO endereço/m);
    }
  });

  describe("e-mail (a mesma regra do entrypoint do gateway e de _shared/email.ts)", () => {
    it("SMTP_HOST sem remetente (SMTP_ADMIN_EMAIL e EMAIL_FROM vazios) = ERRO e exit 1", () => {
      const r = doctorCom({ SMTP_HOST: "smtp.exemplo.com" });
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/^ERRO e-mail: SMTP_HOST está preenchido e não há remetente/m);
    });
    it("SMTP_HOST com SMTP_ADMIN_EMAIL = OK", () => {
      const r = doctorCom({ SMTP_HOST: "smtp.exemplo.com", SMTP_ADMIN_EMAIL: "echo@exemplo.com" });
      expect(r.stdout).toMatch(/^OK e-mail: SMTP configurado/m);
      expect(r.stdout).not.toMatch(/^ERRO e-mail/m);
    });
    it("SMTP_HOST com EMAIL_FROM e sem SMTP_ADMIN_EMAIL = AVISO (a recuperação de senha é do Auth)", () => {
      const r = doctorCom({ SMTP_HOST: "smtp.exemplo.com", EMAIL_FROM: "echo@exemplo.com" });
      expect(r.stdout).toMatch(/^AVISO e-mail: SMTP configurado com EMAIL_FROM, mas sem SMTP_ADMIN_EMAIL/m);
    });
    it("SMTP_SECURE fora de starttls|tls|none = ERRO; caixa livre", () => {
      const base = { SMTP_HOST: "smtp.exemplo.com", SMTP_ADMIN_EMAIL: "echo@exemplo.com" };
      const ruim = doctorCom({ ...base, SMTP_SECURE: "ssl" });
      expect(ruim.status).toBe(1);
      expect(ruim.stdout).toMatch(/^ERRO e-mail: SMTP_SECURE precisa ser starttls, tls ou none/m);
      expect(doctorCom({ ...base, SMTP_SECURE: "STARTTLS" }).stdout).toMatch(/^OK e-mail: SMTP configurado/m);
      expect(doctorCom({ ...base, SMTP_SECURE: "None" }).stdout).toMatch(/^OK e-mail: SMTP configurado/m);
    });
    it("SMTP_PORT fora de 1 a 65535 ou não numérica = ERRO", () => {
      const base = { SMTP_HOST: "smtp.exemplo.com", SMTP_ADMIN_EMAIL: "echo@exemplo.com" };
      for (const porta of ["0", "65536", "abc", "58 7"]) {
        const r = doctorCom({ ...base, SMTP_PORT: porta });
        expect(r.stdout, porta).toMatch(/^ERRO e-mail: SMTP_PORT precisa ser um número de 1 a 65535/m);
      }
      expect(doctorCom({ ...base, SMTP_PORT: "465" }).stdout).toMatch(/^OK e-mail: SMTP configurado/m);
    });
    it("RESEND_API_KEY sem EMAIL_FROM = AVISO; com EMAIL_FROM = OK; nada = OK sem SMTP", () => {
      expect(doctorCom({ RESEND_API_KEY: "re_teste" }).stdout).toMatch(/^AVISO e-mail: RESEND_API_KEY está preenchida e EMAIL_FROM não/m);
      expect(doctorCom({ RESEND_API_KEY: "re_teste", EMAIL_FROM: "echo@exemplo.com" }).stdout).toMatch(/^OK e-mail: Resend configurado/m);
      expect(doctorCom({}).stdout).toMatch(/^OK e-mail: sem SMTP/m);
    });
  });

  it("toda linha da saída começa com OK, AVISO ou ERRO (ou é o resumo final)", () => {
    const r = doctorCom({});
    for (const linha of r.stdout.split("\n").filter(Boolean)) {
      expect(linha, linha).toMatch(/^(OK|AVISO|ERRO) |^Sem erros\.$|^\d+ erro\(s\)\./);
    }
  });
});

describe("./echo upgrade (com git e docker de mentira: só o fluxo de controle)", () => {
  function comEnv() {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    writeFileSync(join(e.arvore, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [2.13.0] - 2026-12-01\n\n### Adicionado\n- coisa nova\n\n## [2.12.0] - 2026-11-01\n\n- antiga\n");
    return e;
  }
  const gitChamadas = (e) =>
    e
      .chamadas()
      .filter((c) => c[0] === "git")
      .map((c) => ["git", (c[1] ?? "").replace(/^-C \S+ /, "")]);

  it("árvore suja: recusa antes de qualquer fetch, backup ou build", () => {
    const e = comEnv();
    const r = e.echo(["upgrade", "--to", "v2.13.0", "--no-backup"], { STUB_GIT_SUJO: " M src/App.tsx\n", STUB_GIT_TAGS: "v2.13.0" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("alterações locais");
    expect(e.chamadas().filter((c) => c[1] === "compose" && c.includes("build"))).toEqual([]);
    expect(gitChamadas(e).some((c) => c[1]?.startsWith("fetch"))).toBe(false);
  });

  it("tag que não existe: recusa", () => {
    const e = comEnv();
    const r = e.echo(["upgrade", "--to", "v9.9.9", "--no-backup"], { STUB_GIT_TAGS: "v2.13.0" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("v9.9.9");
  });

  it("salto de versão maior sem --force: recusa e não mexe no código", () => {
    const e = comEnv();
    const r = e.echo(["upgrade", "--to", "v3.0.0", "--no-backup"], { STUB_GIT_TAGS: "v3.0.0", STUB_GIT_VERSAO_ALVO: "3.0.0" });
    expect(r.status).toBe(1);
    // A versão instalada é a do package.json real do repositório (copiado para a árvore do teste).
    const instalada = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")).version;
    expect(instalada.startsWith("2.")).toBe(true);
    expect(r.stderr).toContain(`${instalada} -> 3.0.0`);
    expect(r.stderr).toContain("--force");
    expect(gitChamadas(e).some((c) => c[1]?.startsWith("checkout"))).toBe(false);
    expect(JSON.parse(readFileSync(join(e.arvore, "package.json"), "utf8")).version).toBe(instalada);
  });

  it("sem --to e sem remota configurada: pede --to", () => {
    const e = comEnv();
    const r = e.echo(["upgrade", "--no-backup"], { STUB_GIT_UPSTREAM: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--to");
  });

  it("checkout solto (tag) sem --to: pede --to", () => {
    const e = comEnv();
    const r = e.echo(["upgrade", "--no-backup"], { STUB_GIT_DETACHED: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--to");
    expect(r.stderr).toContain("sem branch");
    expect(r.stderr).toContain("git checkout <branch>");
  });

  it("caminho feliz: fetch, checkout da tag, completa o .env, builda uma imagem por vez, sobe e mostra o CHANGELOG", () => {
    const e = comEnv();
    const r = e.echo(["upgrade", "--to", "v2.13.0", "--no-backup"], { STUB_GIT_TAGS: "v2.13.0", STUB_GIT_VERSAO_ALVO: "2.13.0" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("--no-backup");
    expect(r.stdout).toContain("coisa nova");
    expect(r.stdout).not.toContain("antiga");
    const git = gitChamadas(e).map((c) => c[1]);
    expect(git.findIndex((g) => g.startsWith("fetch --tags"))).toBeGreaterThanOrEqual(0);
    expect(git.findIndex((g) => g.includes("checkout --quiet v2.13.0"))).toBeGreaterThan(git.findIndex((g) => g.startsWith("fetch --tags")));
    const compose = e.chamadas().filter((c) => c[1] === "compose" && c[2] === "--project-directory");
    const verbos = compose.map((c) => c.slice(c.indexOf("-p") + 2).join(" "));
    const builds = verbos.filter((v) => v.startsWith("build"));
    expect(builds).toEqual(["build db", "build gateway", "build functions", "build qr"]);
    const iUp = verbos.findIndex((v) => v.startsWith("up -d --wait --wait-timeout 900"));
    expect(iUp).toBeGreaterThan(verbos.lastIndexOf("build qr"));
    expect(verbos.some((v) => v.startsWith("down"))).toBe(false);
  });

  it("sem Node no host e ECHO_ENV_FILE fora da árvore: o contêiner do gen-keys recebe a pasta do .env em /e", () => {
    const e = comEnv();
    const fora = join(e.raiz, "fora");
    mkdirSync(fora);
    const alvo = join(fora, ".env");
    copyFileSync(join(e.arvore, ".env"), alvo);
    const semNode = `${join(e.raiz, "stubs")}:/usr/bin:/bin`;
    const r = e.echo(["upgrade", "--to", "v2.13.0", "--no-backup"], {
      PATH: semNode,
      ECHO_ENV_FILE: alvo,
      STUB_GIT_TAGS: "v2.13.0",
      STUB_GIT_VERSAO_ALVO: "2.13.0",
    });
    const run = e.chamadas().find((c) => c[1] === "run");
    expect(run, r.stderr).toBeDefined();
    const texto = run.join(" ");
    expect(texto).toContain(`-v ${fora}:/e`);
    expect(texto).toContain("--completar /e/.env");
    expect(texto).not.toContain(`--completar ${alvo}`);
  });

  it("sem --no-backup o backup roda primeiro (para o stack e o sobe de novo) e, se ele falha, o código não é tocado", () => {
    const e = comEnv();
    // O docker falso não cria os .tar: o backup falha depois de subir o stack de volta.
    const r = e.echo(["upgrade", "--to", "v2.13.0"], { STUB_GIT_TAGS: "v2.13.0", STUB_GIT_VERSAO_ALVO: "2.13.0" });
    expect(r.status).not.toBe(0);
    const verbos = e.chamadas().filter((c) => c[1] === "compose" && c[2] === "--project-directory").map((c) => c.slice(c.indexOf("-p") + 2).join(" "));
    expect(verbos).toContain("stop");
    expect(verbos.indexOf("stop")).toBeLessThan(verbos.findIndex((v) => v.startsWith("up -d --wait")));
    expect(gitChamadas(e).some((c) => c[1]?.includes("checkout") || c[1]?.startsWith("pull"))).toBe(false);
    expect(verbos.some((v) => v.startsWith("build"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Achados da revisão final (INSTALADOR)
// ---------------------------------------------------------------------------------------------------------------

const verbosCompose = (e) =>
  e
    .chamadas()
    .filter((c) => c[1] === "compose" && c[2] === "--project-directory")
    .map((c) => c.slice(c.indexOf("-p") + 2).join(" "));

describe("install.sh: volumes de uma instalação anterior (sem .env)", () => {
  const VOLUMES = "echo_db-data\necho_qr-sessions\n";

  it("sem .env e com volumes do projeto: sai 1 antes de gerar segredo, lista os volumes e dá as três saídas", () => {
    const e = ambiente();
    const r = e.instalar(["--env-only", "--yes"], { STUB_VOLUMES: VOLUMES });
    expect(r.status).toBe(1);
    expect(existsSync(join(e.arvore, ".env"))).toBe(false);
    expect(r.stderr).toContain("echo_db-data");
    expect(r.stderr).toContain("echo_qr-sessions");
    expect(r.stderr).toContain("backups/*/.env ou .env.bak.*");
    expect(r.stderr).toContain("docker volume rm echo_db-data echo_qr-sessions");
    expect(r.stderr).toContain("COMPOSE_PROJECT_NAME=outro-nome ./install.sh");
    expect(e.chamadas().some((c) => c.slice(1).join(" ") === "volume ls -q --filter label=com.docker.compose.project=echo")).toBe(true);
  });

  it("usa o COMPOSE_PROJECT_NAME do ambiente no filtro e na mensagem", () => {
    const e = ambiente();
    const r = e.instalar(["--env-only", "--yes"], { STUB_VOLUMES: "meu_db-data\n", COMPOSE_PROJECT_NAME: "meu" });
    expect(r.status).toBe(1);
    expect(e.chamadas().some((c) => c.slice(1).join(" ").endsWith("label=com.docker.compose.project=meu"))).toBe(true);
    expect(r.stderr).toContain("docker compose -p meu down -v");
  });

  it("sem volumes: segue e cria o .env", () => {
    const e = ambiente();
    const r = e.instalar(["--env-only", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(e.arvore, ".env"))).toBe(true);
  });

  it("com .env existente os volumes são esperados: não aborta nem consulta o Docker por volumes", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const antes = e.chamadas().length;
    const r = e.instalar(["--env-only", "--yes"], { STUB_VOLUMES: VOLUMES });
    expect(r.status, r.stderr).toBe(0);
    expect(e.chamadas().slice(antes).some((c) => c[1] === "volume")).toBe(false);
  });

  it("db-init que não autentica: o falhou() aponta segredos novos sobre volume antigo", () => {
    const e = ambiente();
    const r = e.instalar(["--yes", "--port", "58231"], {
      STUB_INSTALL_OK: "1",
      STUB_COMPOSE_FAIL: "up",
      STUB_DB_LOG: 'psql: error: FATAL:  password authentication failed for user "supabase_admin"',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CAUSA PROVÁVEL");
    expect(r.stderr).toContain("segredos novos sobre um volume de instalação anterior");
    expect(r.stderr).toContain("Não mexa no Vault");
  });

  it("falha do up sem erro de senha no db-init: não acusa volume antigo", () => {
    const e = ambiente();
    const r = e.instalar(["--yes", "--port", "58232"], { STUB_INSTALL_OK: "1", STUB_COMPOSE_FAIL: "up", STUB_DB_LOG: "tudo certo" });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain("CAUSA PROVÁVEL");
  });

  it("as mensagens de 'reinstale' dizem como: backup, down -v e novo ./install.sh", () => {
    const e = ambiente();
    const r = e.instalar(["--yes", "--port", "58233"], { STUB_INSTALL_OK: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Modo avaliação:.*127\.0\.0\.1/);
    expect(r.stdout).toContain("docker compose -p echo down -v");
    expect(r.stdout).not.toMatch(/reinstale/);
    const r2 = e.instalar(["--yes", "--port", "58234"], { STUB_INSTALL_OK: "1" });
    expect(r2.stderr).toContain("down -v");
    expect(r2.stderr).not.toMatch(/reinstale/);
  });
});

describe("install.sh: conferência informativa do HTTPS no modo domínio", () => {
  const dominio = ["--domain", "echo.exemplo.com", "--yes"];
  const ambienteComCurlLog = (e) => join(e.raiz, "curl.log");

  it("certificado respondeu: sem aviso, e a conferência bateu em https://domínio/config.js", () => {
    const e = ambiente();
    const log = ambienteComCurlLog(e);
    const r = e.instalar(dominio, { STUB_INSTALL_OK: "1", ECHO_HTTPS_ESPERA: "0", STUB_CURL_LOG: log });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Pronto.");
    expect(r.stdout).not.toContain("AVISO: o certificado HTTPS");
    expect(readFileSync(log, "utf8")).toContain("https://echo.exemplo.com/config.js");
  });

  it("certificado não respondeu: AVISO com DNS, portas e logs, sai 0 e ainda imprime o link", () => {
    const e = ambiente();
    const r = e.instalar(dominio, { STUB_INSTALL_OK: "1", ECHO_HTTPS_ESPERA: "0", STUB_CURL_FAIL: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Pronto.");
    expect(r.stdout).toContain("AVISO: o certificado HTTPS de https://echo.exemplo.com ainda não respondeu");
    expect(r.stdout).toContain("dig +short");
    expect(r.stdout).toContain("80 e 443");
    expect(r.stdout).toContain("./echo logs gateway");
    expect(r.stdout).toContain("/setup?codigo=");
  });

  it("modo localhost e atrás de proxy: não confere", () => {
    for (const args of [["--yes", "--port", "58235"], ["--behind-proxy", "--url", "https://echo.exemplo.com", "--port", "58236", "--yes"]]) {
      const e = ambiente();
      const log = ambienteComCurlLog(e);
      const r = e.instalar(args, { STUB_INSTALL_OK: "1", ECHO_HTTPS_ESPERA: "0", STUB_CURL_FAIL: "1", STUB_CURL_LOG: log });
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
      expect(r.stdout).not.toContain("certificado HTTPS");
    }
  });

  it("reexecução (já há .env): não repete a conferência", () => {
    const e = ambiente();
    expect(e.instalar(dominio, { STUB_INSTALL_OK: "1", ECHO_HTTPS_ESPERA: "0" }).status).toBe(0);
    const log = ambienteComCurlLog(e);
    const r = e.instalar(dominio, { STUB_INSTALL_OK: "1", ECHO_HTTPS_ESPERA: "0", STUB_CURL_FAIL: "1", STUB_CURL_LOG: log });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
    expect(r.stdout).not.toContain("certificado HTTPS");
  });

  it("./echo doctor: domínio sem resposta HTTPS é AVISO (não ERRO); com resposta, OK", () => {
    const e = ambiente();
    expect(e.instalar(dominio.concat("--env-only")).status).toBe(0);
    const r = e.echo(["doctor"], { STUB_CURL_FAIL: "1" });
    expect(r.stdout).toMatch(/^AVISO endereço: https:\/\/echo\.exemplo\.com não respondeu por HTTPS/m);
    const ok = e.echo(["doctor"]);
    expect(ok.stdout).toMatch(/^OK endereço: https:\/\/echo\.exemplo\.com \(respondeu por HTTPS\)/m);
  });
});

describe("./echo doctor e restart: o .env só vale depois de ./echo up", () => {
  function doctorBanco(alteracoes, extra = {}) {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const caminho = join(e.arvore, ".env");
    let texto = readFileSync(caminho, "utf8");
    for (const [k, v] of Object.entries(alteracoes)) texto = texto.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`);
    writeFileSync(caminho, texto, { mode: 0o600 });
    return e.echo(["doctor"], { STUB_DB_ESTADO: "running", STUB_DB_SAUDE: "healthy", STUB_PSQL: "1", ...extra });
  }

  it("segredo da Meta vazio com linha business_api: ERRO manda ./echo up, não ./echo restart", () => {
    const r = doctorBanco({ WHATSAPP_APP_SECRET: "" });
    expect(r.stdout).toMatch(/^ERRO Cloud API: .*aplique com \.\/echo up functions/m);
    expect(r.stdout).not.toContain("echo restart");
  });

  it(".env preenchido e a função sem o valor (restart não relê): AVISO, nunca OK", () => {
    const r = doctorBanco({ WHATSAPP_APP_SECRET: "a".repeat(32) }, { STUB_ENV_WHATSAPP_APP_SECRET: "" });
    expect(r.stdout).toMatch(/^AVISO Cloud API: .*o \.env mudou e não foi aplicado.*\.\/echo up functions/m);
    expect(r.stdout).not.toMatch(/^OK Cloud API/m);
    expect(r.stdout).not.toContain("a".repeat(32));
  });

  it(".env preenchido e a função com o valor: OK", () => {
    const r = doctorBanco({ WHATSAPP_APP_SECRET: "a".repeat(32) }, { STUB_ENV_WHATSAPP_APP_SECRET: "a".repeat(32) });
    expect(r.stdout).toMatch(/^OK Cloud API: .*WHATSAPP_APP_SECRET preenchido/m);
  });

  it("função parada (não dá para ler): sem aviso falso", () => {
    const r = doctorBanco({ WHATSAPP_APP_SECRET: "a".repeat(32) });
    expect(r.stdout).toMatch(/^OK Cloud API/m);
  });

  it("SMTP no .env e a função sem o valor: AVISO manda ./echo up", () => {
    const r = doctorBanco({ SMTP_HOST: "smtp.exemplo.com", SMTP_ADMIN_EMAIL: "echo@exemplo.com" }, { STUB_ENV_SMTP_HOST: "" });
    expect(r.stdout).toMatch(/^AVISO e-mail: o \.env tem SMTP_HOST.*\.\/echo up auth functions gateway/m);
  });

  it("nenhuma correção do script manda ./echo restart (restart não relê o .env)", () => {
    const e = ambiente();
    const texto = readFileSync(join(e.arvore, "echo"), "utf8");
    const mensagens = texto.split("\n").filter((l) => /\.\/echo restart/.test(l) && !l.trim().startsWith("#") && !/restart \[serviço\]|up \| down \| restart/.test(l));
    expect(mensagens).toEqual([]);
  });
});

describe("./echo backup: estado do stack e caminhos relativos", () => {
  it("stack em pé: para, salva e sobe de novo", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const r = e.echo(["backup"]);
    expect(r.stdout).toContain("Subindo o stack de novo");
    const v = verbosCompose(e);
    expect(v.some((x) => x.startsWith("up -d --wait"))).toBe(true);
  });

  it("stack parado (./echo down antes): o backup não o liga e diz que continua parado", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const antes = verbosCompose(e).length;
    const r = e.echo(["backup"], { STUB_RODANDO: "" });
    const v = verbosCompose(e).slice(antes);
    expect(v).toContain("ps --status running -q");
    expect(v.some((x) => x.startsWith("up -d --wait"))).toBe(false);
    expect(r.stdout).toContain("O stack estava parado e continua parado.");
    expect(r.stdout).not.toContain("Subindo o stack de novo");
  });

  it("--dest relativo vale a partir de onde o comando foi chamado, não da pasta do repositório", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    e.echo(["backup", "--dest", "hoje"]);
    expect(existsSync(join(e.raiz, "hoje"))).toBe(true);
    expect(existsSync(join(e.arvore, "hoje"))).toBe(false);
  });

  it("restore com DIR relativo acha o backup a partir de onde o comando foi chamado", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    mkdirSync(join(e.raiz, "bkp-relativo"));
    writeFileSync(join(e.raiz, "bkp-relativo", "manifest.json"), "{}\n");
    const r = e.echo(["restore", "bkp-relativo"]);
    expect(r.stderr).not.toContain("não é um diretório");
    expect(r.stderr).toContain("manifest ilegível");
  });
});

describe("./echo restore: falha na extração", () => {
  it("tar que falha: avisa o estado (volumes incompletos), manda não subir e não repõe os segredos", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const dir = join(e.raiz, "bkp");
    mkdirSync(dir);
    const nomes = ["db-data.tar", "qr-sessions.tar", "storage-data.tar", "caddy-data.tar", ".env"];
    const sha = (arq) => createHash("sha256").update(readFileSync(arq)).digest("hex");
    for (const n of nomes) writeFileSync(join(dir, n), `conteudo de ${n}`);
    const linhas = nomes.map((n) => `    "${n}": {"bytes": ${readFileSync(join(dir, n)).length}, "sha256": "${sha(join(dir, n))}"}`);
    writeFileSync(join(dir, "manifest.json"), `{\n  "echo_version": "2.12.0",\n  "postgres_base": "x",\n  "arquivos": {\n${linhas.join(",\n")}\n  }\n}\n`);
    const r = e.echo(["restore", dir], { STUB_PG_BASE: "x", STUB_RUN_EXIT: "1" }, "echo\n");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("restore interrompido no volume db-data");
    expect(r.stderr).toContain("NÃO rode ./echo up");
    expect(r.stderr).toContain(`./echo restore ${dir}`);
    expect(verbosCompose(e).some((x) => x.startsWith("up -d"))).toBe(false);
    expect(readFileSync(join(e.arvore, ".env"), "utf8")).not.toContain("conteudo de .env");
  });
});

describe("./echo upgrade: build que falha no meio", () => {
  it("não manda ./echo up (mistura imagens e migra com funções antigas): diz o estado e o caminho de volta", () => {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    const r = e.echo(["upgrade", "--to", "v2.13.0", "--no-backup"], {
      STUB_GIT_TAGS: "v2.13.0",
      STUB_GIT_VERSAO_ALVO: "2.13.0",
      STUB_COMPOSE_FAIL: "build gateway",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("NÃO rode ./echo up");
    expect(r.stderr).toContain("já está na versão nova (2.13.0)");
    expect(r.stderr).toContain("git checkout abc1234 && ./install.sh");
    expect(r.stderr).not.toMatch(/rode \.\/echo up para voltar/);
    const v = verbosCompose(e);
    expect(v).toContain("build db");
    expect(v.some((x) => x.startsWith("up -d --wait"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Segunda rodada de revisão (INSTALADOR)
// ---------------------------------------------------------------------------------------------------------------

describe("install.sh: texto dos próximos passos usa os nomes reais da tela", () => {
  it("primeiro acesso e reexecução apontam para a aba QR Code e o botão Gerar QR", () => {
    const e = ambiente();
    const r = e.instalar(["--yes", "--port", "58237"], { STUB_INSTALL_OK: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Configurações > Números, aba QR Code: digite um nome de exibição e clique em Gerar QR.");
    expect(r.stdout).not.toContain("Adicionar número");
  });
});

describe("install.sh: volumes antigos com containers do projeto ainda existentes", () => {
  const VOLUMES = "echo_db-data\necho_qr-sessions\n";

  it("com containers: a saída 2 manda remover os containers antes dos volumes e avisa das portas", () => {
    const e = ambiente();
    const r = e.instalar(["--env-only", "--yes"], { STUB_VOLUMES: VOLUMES, STUB_PS_AQ: "abc123\n" });
    expect(r.status).toBe(1);
    expect(existsSync(join(e.arvore, ".env"))).toBe(false);
    const i = r.stderr.indexOf("xargs -r docker rm -f");
    const j = r.stderr.indexOf("docker volume rm echo_db-data echo_qr-sessions");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(r.stderr).toContain("label=com.docker.compose.project=echo | xargs");
    expect(r.stderr).toContain("ocupando as portas");
    expect(e.chamadas().some((c) => c.slice(1).join(" ") === "ps -aq --filter label=com.docker.compose.project=echo")).toBe(true);
  });

  it("sem containers: mantém a mensagem de antes (volume rm e down -v), sem docker rm", () => {
    const e = ambiente();
    const r = e.instalar(["--env-only", "--yes"], { STUB_VOLUMES: VOLUMES });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docker volume rm echo_db-data echo_qr-sessions");
    expect(r.stderr).toContain('"docker compose -p echo down -v" faz o mesmo');
    expect(r.stderr).not.toContain("docker rm -f");
    expect(r.stderr).not.toContain("ocupando as portas");
  });
});

describe("install.sh: conferência do HTTPS conta pelo relógio", () => {
  it("curl que pendura: termina perto de ECHO_HTTPS_ESPERA, não em 19 tentativas de 10 s", () => {
    const e = ambiente();
    // curl de mentira que honra --max-time: pendura até o limite (sleep de verdade; o sleep do PATH é um no-op).
    writeFileSync(
      join(e.raiz, "stubs", "curl"),
      `#!/bin/bash
mt=10
while [ $# -gt 0 ]; do if [ "$1" = "--max-time" ]; then mt="$2"; fi; shift; done
/bin/sleep "$mt"
exit 28
`,
    );
    chmodSync(join(e.raiz, "stubs", "curl"), 0o755);
    const ini = Date.now();
    const r = e.instalar(["--domain", "echo.exemplo.com", "--yes"], { STUB_INSTALL_OK: "1", ECHO_HTTPS_ESPERA: "6" });
    const seg = (Date.now() - ini) / 1000;
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("AVISO: o certificado HTTPS de https://echo.exemplo.com ainda não respondeu");
    expect(seg).toBeGreaterThanOrEqual(5);
    expect(seg).toBeLessThan(20);
    // O teste dura pelo menos os 6 s do ECHO_HTTPS_ESPERA: o teto padrão de 5 s do Vitest o reprovava no CI.
  }, 30000);
});

describe("./echo doctor: porta do gateway", () => {
  function doctorComPorta(saida) {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    return e.echo(["doctor"], { STUB_GATEWAY_PORT: saida });
  }

  it("porta publicada: mostra o endereço que o Compose devolve", () => {
    const r = doctorComPorta("127.0.0.1:8088");
    expect(r.stdout).toContain("OK portas: o gateway publica 127.0.0.1:8088");
  });

  it.each([":0", "invalid IP:0"])("gateway de pé sem porta publicada (%s): não imprime o valor cru", (saida) => {
    const r = doctorComPorta(saida);
    expect(r.stdout).toContain("OK portas: o gateway está de pé e não publica porta no host");
    expect(r.stdout).not.toContain("o gateway publica");
  });
});

describe("./echo upgrade: estado e volta nas falhas (segunda rodada)", () => {
  function comEnv() {
    const e = ambiente();
    expect(e.instalar().status).toBe(0);
    return e;
  }
  const VERSAO = { STUB_GIT_TAGS: "v2.13.0", STUB_GIT_VERSAO_ALVO: "2.13.0" };

  it("build falho com menos de 4 GB: diz que gateway, functions e qr estão PARADOS e como religar com start", () => {
    const e = comEnv();
    const r = e.echo(["upgrade", "--to", "v2.13.0", "--no-backup"], { ...VERSAO, ECHO_RAM_MB: "2048", STUB_COMPOSE_FAIL: "build gateway" });
    expect(r.status).toBe(1);
    expect(verbosCompose(e)).toContain("stop gateway functions qr");
    expect(r.stderr).toContain("PARADOS");
    expect(r.stderr).toContain("-p echo start gateway functions qr");
    expect(r.stderr).toContain("NÃO rode ./echo up");
  });

  it("build falho com RAM suficiente: não para nada e não fala em PARADOS", () => {
    const e = comEnv();
    const r = e.echo(["upgrade", "--to", "v2.13.0", "--no-backup"], { ...VERSAO, ECHO_RAM_MB: "8192", STUB_COMPOSE_FAIL: "build gateway" });
    expect(r.status).toBe(1);
    expect(verbosCompose(e)).not.toContain("stop gateway functions qr");
    expect(r.stderr).not.toContain("PARADOS");
  });

  it("sem Node e ECHO_ENV_FILE dentro da árvore: o contêiner recebe o caminho relativo a /w", () => {
    const e = comEnv();
    const alvo = join(e.arvore, ".env.segunda");
    copyFileSync(join(e.arvore, ".env"), alvo);
    const r = e.echo(["upgrade", "--to", "v2.13.0", "--no-backup"], {
      ...VERSAO,
      PATH: `${join(e.raiz, "stubs")}:/usr/bin:/bin`,
      ECHO_ENV_FILE: alvo,
    });
    const run = e.chamadas().find((c) => c[1] === "run");
    expect(run, r.stderr).toBeDefined();
    const texto = run.join(" ");
    expect(texto).toContain("--completar .env.segunda");
    expect(texto).not.toContain(`--completar ${alvo}`);
    expect(texto).not.toContain(":/e");
  });

  it("falha ao completar o .env depois do checkout: diz o estado e o caminho de volta, sem build", () => {
    const e = comEnv();
    const alvo = join(e.arvore, ".env.segunda");
    copyFileSync(join(e.arvore, ".env"), alvo);
    const r = e.echo(["upgrade", "--to", "v2.13.0", "--no-backup"], {
      ...VERSAO,
      PATH: `${join(e.raiz, "stubs")}:/usr/bin:/bin`,
      ECHO_ENV_FILE: alvo,
      STUB_RUN_EXIT: "1",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("não consegui completar o .env da versão nova");
    expect(r.stderr).toContain("já está na versão nova (2.13.0)");
    expect(r.stderr).toContain("git checkout abc1234 && ./install.sh");
    expect(verbosCompose(e).some((x) => x.startsWith("build"))).toBe(false);
  });

  it("upgrade de branch (sem --to) com build falho: a volta diz para retornar à branch", () => {
    const e = comEnv();
    const r = e.echo(["upgrade", "--no-backup"], { STUB_GIT_BRANCH: "minha-branch", STUB_COMPOSE_FAIL: "build gateway" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("git checkout abc1234 && ./install.sh");
    expect(r.stderr).toContain("git checkout minha-branch && ./echo upgrade");
  });

  it("upgrade por tag (--to) a partir de checkout solto: não inventa branch na volta", () => {
    const e = comEnv();
    const r = e.echo(["upgrade", "--to", "v2.13.0", "--no-backup"], { ...VERSAO, STUB_GIT_DETACHED: "1", STUB_COMPOSE_FAIL: "build gateway" });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain("&& ./echo upgrade");
  });
});
