import { spawnSync } from "node:child_process";
import { createECDH, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLACEHOLDER,
  SEGREDOS_GERADOS,
  chaveDePapel,
  chavesDoEnv,
  completarEnv,
  FORMATOS,
  gerarEnv,
  gerarExemplo,
  gerarSegredos,
  gerarVapid,
  lerEnv,
  validarOpcoes,
} from "../docker/tools/gen-keys.mjs";

const GEN_KEYS = resolve(import.meta.dirname, "../docker/tools/gen-keys.mjs");

const BASE = {
  publicUrl: "http://localhost:8088",
  siteAddress: ":80",
  bind: "127.0.0.1",
  httpPort: 8088,
  project: "echo",
  comOverride: true,
};

const pastas = [];
function pastaTemp() {
  const p = mkdtempSync(join(tmpdir(), "echo-genkeys-"));
  pastas.push(p);
  return p;
}
afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

function node(args, opcoes = {}) {
  return spawnSync(process.execPath, [GEN_KEYS, ...args], { encoding: "utf8", ...opcoes });
}

function decodificarJwt(jwt) {
  const [h, c, s] = jwt.split(".");
  return { cabecalho: JSON.parse(Buffer.from(h, "base64url").toString()), corpo: JSON.parse(Buffer.from(c, "base64url").toString()), assinatura: s, assinado: `${h}.${c}` };
}

describe("segredos (formatos da seção 3.2)", () => {
  const s = gerarSegredos();

  it.each(Object.entries(FORMATOS))("%s tem o formato da tabela", (chave, formato) => {
    expect(s[chave]).toMatch(formato);
  });

  it("os tamanhos hexadecimais são exatamente os da tabela", () => {
    expect(s.POSTGRES_PASSWORD).toHaveLength(48);
    expect(s.JWT_SECRET).toHaveLength(64);
    expect(s.VAULT_ROOT_KEY).toHaveLength(64);
    expect(s.AI_KEY_SECRET).toHaveLength(64);
    expect(s.REALTIME_SECRET_KEY_BASE).toHaveLength(96);
    expect(s.REALTIME_DB_ENC_KEY).toHaveLength(16);
    expect(s.REALTIME_RELEASE_COOKIE).toHaveLength(56);
    expect(s.QR_WEBHOOK_SECRET).toHaveLength(64);
    expect(s.WHATSAPP_VERIFY_TOKEN).toHaveLength(64);
    expect(s.INSTAGRAM_OAUTH_STATE_SECRET).toHaveLength(64);
    expect(s.ZAPO_DB_PASSWORD).toHaveLength(48);
    expect(s.ECHO_SETUP_TOKEN).toHaveLength(32);
  });

  it("duas gerações não repetem nenhum segredo", () => {
    const outro = gerarSegredos();
    for (const k of SEGREDOS_GERADOS) expect(outro[k]).not.toBe(s[k]);
  });

  it("ANON_KEY e SERVICE_ROLE_KEY são JWT HS256 verificáveis com o JWT_SECRET, com exp em 10 anos", () => {
    for (const [chave, papel] of [["ANON_KEY", "anon"], ["SERVICE_ROLE_KEY", "service_role"]]) {
      const j = decodificarJwt(s[chave]);
      expect(j.cabecalho).toEqual({ alg: "HS256", typ: "JWT" });
      expect(j.corpo.role).toBe(papel);
      expect(j.corpo.iss).toBe("supabase");
      expect(j.corpo.exp - j.corpo.iat).toBe(10 * 365 * 24 * 3600);
      const esperado = createHmac("sha256", s.JWT_SECRET).update(j.assinado).digest("base64url");
      expect(j.assinatura).toBe(esperado);
    }
  });

  it("chaveDePapel é determinística para o mesmo instante e muda com o segredo", () => {
    const a = chaveDePapel("anon", "x".repeat(32), 1000);
    expect(chaveDePapel("anon", "x".repeat(32), 1000)).toBe(a);
    expect(chaveDePapel("anon", "y".repeat(32), 1000)).not.toBe(a);
  });

  it("VAPID: pública = ponto não comprimido de 65 bytes, privada = 32 bytes, e a privada gera a pública", () => {
    const { publica, privada } = gerarVapid();
    const pub = Buffer.from(publica, "base64url");
    const priv = Buffer.from(privada, "base64url");
    expect(pub).toHaveLength(65);
    expect(pub[0]).toBe(0x04);
    expect(priv).toHaveLength(32);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    expect(ecdh.getPublicKey().equals(pub)).toBe(true);
    expect(publica).not.toMatch(/[+/=]/);
    expect(privada).not.toMatch(/[+/=]/);
  });
});

describe("gerarEnv", () => {
  it("escreve todas as variáveis da seção 3.2, na ordem", () => {
    const env = lerEnv(gerarEnv(BASE));
    expect([...env.keys()]).toEqual(chavesDoEnv());
    const ordem = chavesDoEnv();
    expect(ordem.indexOf("COMPOSE_PROJECT_NAME")).toBeLessThan(ordem.indexOf("ECHO_PUBLIC_URL"));
    expect(ordem.indexOf("ECHO_PROXY_NETWORK")).toBeLessThan(ordem.indexOf("POSTGRES_PASSWORD"));
    expect(ordem.indexOf("VAPID_SUBJECT")).toBeLessThan(ordem.indexOf("SMTP_HOST"));
    expect(ordem.at(-1)).toBe("ECHO_OUTBOUND_ALLOW_HOSTS");
  });

  it("o conteúdo gerado tem os segredos no formato e o endereço pedido", () => {
    const env = lerEnv(gerarEnv({ ...BASE, project: "echo-sh-inst", httpPort: 58230 }));
    for (const [k, formato] of Object.entries(FORMATOS)) expect(env.get(k), k).toMatch(formato);
    expect(env.get("COMPOSE_PROJECT_NAME")).toBe("echo-sh-inst");
    expect(env.get("ECHO_PUBLIC_URL")).toBe("http://localhost:8088");
    expect(env.get("ECHO_HTTP_PORT")).toBe("58230");
    expect(env.get("ECHO_BIND")).toBe("127.0.0.1");
    expect(env.get("ECHO_BEHIND_PROXY")).toBe("false");
    expect(env.get("ECHO_HTTPS_PORT")).toBe("");
    expect(env.get("WHATSAPP_APP_SECRET_ENFORCE")).toBe("true");
    expect(env.get("SMTP_PORT")).toBe("587");
    expect(env.get("SMTP_SENDER_NAME")).toBe("Echo");
    expect(env.get("SMTP_HOST")).toBe("");
  });

  it("VAPID_SUBJECT: a própria URL com https, senão mailto", () => {
    const http = lerEnv(gerarEnv(BASE));
    expect(http.get("VAPID_SUBJECT")).toBe("mailto:echo@example.com");
    const https = lerEnv(gerarEnv({ ...BASE, publicUrl: "https://echo.exemplo.com", siteAddress: "echo.exemplo.com", bind: "0.0.0.0", httpPort: 80 }));
    expect(https.get("VAPID_SUBJECT")).toBe("https://echo.exemplo.com");
  });

  it("nenhuma linha de valor tem aspas, espaço à direita ou valor do exemplo", () => {
    const texto = gerarEnv(BASE);
    for (const linha of texto.split("\n")) {
      if (linha.startsWith("#") || linha === "") continue;
      expect(linha).not.toMatch(/=["']/);
      expect(linha).not.toMatch(/\s$/);
      expect(linha).not.toContain("__GERE");
    }
  });

  describe("COMPOSE_FILE por modo", () => {
    const composeFile = (opcoes) => lerEnv(gerarEnv({ ...BASE, ...opcoes })).get("COMPOSE_FILE");

    it("localhost com override (o que o install.sh sempre passa)", () => {
      expect(composeFile({})).toBe("docker-compose.yml:docker-compose.override.yml");
    });
    it("sem override", () => {
      expect(composeFile({ comOverride: false })).toBe("docker-compose.yml");
    });
    it("domínio: dominio.yml + HTTPS 443 por padrão", () => {
      const env = lerEnv(gerarEnv({ ...BASE, publicUrl: "https://echo.exemplo.com", siteAddress: "echo.exemplo.com", bind: "0.0.0.0", httpPort: 80 }));
      expect(env.get("COMPOSE_FILE")).toBe("docker-compose.yml:docker/compose/dominio.yml:docker-compose.override.yml");
      expect(env.get("ECHO_HTTPS_PORT")).toBe("443");
      expect(env.get("ECHO_SITE_ADDRESS")).toBe("echo.exemplo.com");
    });
    it("atrás de proxy no host: sem arquivo extra e com trusted_proxies", () => {
      const env = lerEnv(gerarEnv({ ...BASE, publicUrl: "https://echo.exemplo.com", behindProxy: true }));
      expect(env.get("COMPOSE_FILE")).toBe("docker-compose.yml:docker-compose.override.yml");
      expect(env.get("ECHO_BEHIND_PROXY")).toBe("true");
      expect(env.get("ECHO_PROXY_NETWORK")).toBe("");
    });
    it("atrás de proxy em container: proxy-rede.yml e o nome da rede", () => {
      const env = lerEnv(gerarEnv({ ...BASE, publicUrl: "https://echo.exemplo.com", behindProxy: true, proxyNetwork: "traefik" }));
      expect(env.get("COMPOSE_FILE")).toBe("docker-compose.yml:docker/compose/proxy-rede.yml:docker-compose.override.yml");
      expect(env.get("ECHO_PROXY_NETWORK")).toBe("traefik");
    });
  });

  describe("validação de entrada (exit 2 na linha de comando)", () => {
    it.each([
      ["URL com barra no fim", { publicUrl: "http://localhost:8088/" }],
      ["URL sem esquema", { publicUrl: "localhost:8088" }],
      ["URL com aspas", { publicUrl: 'http://x"y' }],
      ["URL com espaço", { publicUrl: "http://x y" }],
      ["bind que não é IPv4", { bind: "localhost" }],
      ["bind fora de faixa", { bind: "300.1.1.1" }],
      ["porta zero", { httpPort: 0 }],
      ["porta enorme", { httpPort: 70000 }],
      ["porta com letra", { httpPort: "80a" }],
      ["https-port fora do modo domínio", { httpsPort: 443 }],
      ["proxy-network sem behind-proxy", { proxyNetwork: "traefik" }],
      ["nome de rede inválido", { behindProxy: true, proxyNetwork: "rede ruim" }],
      ["projeto com maiúscula", { project: "Echo" }],
      ["site-address inválido", { siteAddress: "echo exemplo" }],
    ])("recusa %s", (_nome, extra) => {
      expect(() => validarOpcoes({ ...BASE, ...extra })).toThrow();
    });

    it("pela linha de comando sai com 2 e não escreve arquivo", () => {
      const dir = pastaTemp();
      const r = node(["--out", join(dir, ".env"), "--public-url", "http://x/", "--http-port", "8088"]);
      expect(r.status).toBe(2);
      expect(existsSync(join(dir, ".env"))).toBe(false);
      expect(node(["--opcao-que-nao-existe"]).status).toBe(2);
      expect(node(["--out"]).status).toBe(2);
    });
  });
});

describe("linha de comando: --out", () => {
  it("escreve o .env com modo 600 e recusa sobrescrever sem --force", () => {
    const dir = pastaTemp();
    const alvo = join(dir, ".env");
    const args = ["--out", alvo, "--public-url", "http://localhost:8088", "--site-address", ":80", "--bind", "127.0.0.1", "--http-port", "8088", "--com-override"];
    const r1 = node(args);
    expect(r1.status).toBe(0);
    expect(statSync(alvo).mode & 0o777).toBe(0o600);
    const primeiro = readFileSync(alvo, "utf8");

    const r2 = node(args);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/já existe/);
    expect(readFileSync(alvo, "utf8")).toBe(primeiro);

    const r3 = node([...args, "--force"]);
    expect(r3.status).toBe(0);
    expect(readFileSync(alvo, "utf8")).not.toBe(primeiro);
    expect(statSync(alvo).mode & 0o777).toBe(0o600);
  });

  it("--force mantém o modo 600 mesmo sobre um arquivo que estava aberto demais", () => {
    const dir = pastaTemp();
    const alvo = join(dir, ".env");
    writeFileSync(alvo, "X=1\n", { mode: 0o644 });
    const r = node(["--out", alvo, "--public-url", "http://localhost:8088", "--force"]);
    expect(r.status).toBe(0);
    expect(statSync(alvo).mode & 0o777).toBe(0o600);
  });

  it("sem --out escreve no stdout (e nada em disco)", () => {
    const dir = pastaTemp();
    const r = node(["--public-url", "http://localhost:8088"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("POSTGRES_PASSWORD=");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("--completar", () => {
  function envSemChave(chaves) {
    const completo = gerarEnv(BASE);
    return completo
      .split("\n")
      .filter((l) => !chaves.some((k) => l.startsWith(`${k}=`)))
      .join("\n");
  }

  it("acrescenta só a chave ausente e não muda nenhuma existente", () => {
    const dir = pastaTemp();
    const alvo = join(dir, ".env");
    const antes = envSemChave(["QR_WEBHOOK_SECRET", "MAX_MEDIA_BYTES"]);
    writeFileSync(alvo, antes, { mode: 0o600 });
    const r = node(["--completar", alvo]);
    expect(r.status).toBe(0);
    const depois = readFileSync(alvo, "utf8");
    expect(depois.startsWith(antes)).toBe(true);
    const a = lerEnv(antes);
    const d = lerEnv(depois);
    for (const [k, v] of a) expect(d.get(k), k).toBe(v);
    expect(d.get("QR_WEBHOOK_SECRET")).toMatch(FORMATOS.QR_WEBHOOK_SECRET);
    expect(d.get("MAX_MEDIA_BYTES")).toBe("");
    expect([...d.keys()].sort()).toEqual([...chavesDoEnv()].sort());
    expect(statSync(alvo).mode & 0o777).toBe(0o600);
  });

  it("faz cópia .env.bak.<ts> com o conteúdo anterior, modo 600, e só quando muda algo", () => {
    const dir = pastaTemp();
    const alvo = join(dir, ".env");
    const antes = envSemChave(["WHATSAPP_VERIFY_TOKEN"]);
    writeFileSync(alvo, antes, { mode: 0o600 });
    expect(node(["--completar", alvo]).status).toBe(0);
    const copias = readdirSync(dir).filter((n) => n.startsWith(".env.bak."));
    expect(copias).toHaveLength(1);
    expect(readFileSync(join(dir, copias[0]), "utf8")).toBe(antes);
    expect(statSync(join(dir, copias[0])).mode & 0o777).toBe(0o600);

    const estavel = readFileSync(alvo, "utf8");
    const r = node(["--completar", alvo]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/nada a acrescentar/);
    expect(readFileSync(alvo, "utf8")).toBe(estavel);
    expect(readdirSync(dir).filter((n) => n.startsWith(".env.bak."))).toHaveLength(1);
  });

  it("chave existente e vazia continua vazia (ECHO_SETUP_TOKEN vazio = /setup desligado)", () => {
    const base = gerarEnv(BASE).replace(/^ECHO_SETUP_TOKEN=.*$/m, "ECHO_SETUP_TOKEN=");
    const { texto, acrescentadas } = completarEnv(base);
    expect(acrescentadas).toEqual([]);
    expect(texto).toBe(base);
  });

  it("não inventa endereço: sem ECHO_PUBLIC_URL sai com 2", () => {
    const dir = pastaTemp();
    const alvo = join(dir, ".env");
    writeFileSync(alvo, envSemChave(["ECHO_PUBLIC_URL"]), { mode: 0o600 });
    const r = node(["--completar", alvo]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ECHO_PUBLIC_URL");
  });

  it("não gera metade do par VAPID", () => {
    expect(() => completarEnv(envSemChave(["VAPID_PRIVATE_KEY"]))).toThrow(/VAPID_PRIVATE_KEY/);
  });

  it.each(["POSTGRES_PASSWORD", "VAULT_ROOT_KEY", "AI_KEY_SECRET", "ANON_KEY", "ZAPO_DB_PASSWORD", "JWT_SECRET", "REALTIME_DB_ENC_KEY"])(
    "segredo imutável %s ausente: erro de uso (exit 2), nada é escrito e não cria .env.bak",
    (chave) => {
      const dir = pastaTemp();
      const alvo = join(dir, ".env");
      const antes = envSemChave([chave]);
      writeFileSync(alvo, antes, { mode: 0o600 });
      expect(() => completarEnv(antes)).toThrow(new RegExp(`${chave}.*restaure a linha`));
      const r = node(["--completar", alvo]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(chave);
      expect(r.stderr).toMatch(/backups\/\*\/\.env ou \.env\.bak/);
      expect(readFileSync(alvo, "utf8")).toBe(antes);
      expect(readdirSync(dir).filter((n) => n.startsWith(".env.bak."))).toEqual([]);
    },
  );

  it("com um segredo imutável ausente e outro gerável também, nada é acrescentado (nem o gerável)", () => {
    const antes = envSemChave(["VAULT_ROOT_KEY", "QR_WEBHOOK_SECRET"]);
    expect(() => completarEnv(antes)).toThrow(/VAULT_ROOT_KEY/);
  });

  it("QR_WEBHOOK_SECRET, WHATSAPP_VERIFY_TOKEN, INSTAGRAM_OAUTH_STATE_SECRET e ECHO_SETUP_TOKEN ausentes continuam sendo gerados", () => {
    const antes = envSemChave(["QR_WEBHOOK_SECRET", "WHATSAPP_VERIFY_TOKEN", "INSTAGRAM_OAUTH_STATE_SECRET", "ECHO_SETUP_TOKEN"]);
    const { texto, acrescentadas } = completarEnv(antes);
    expect(acrescentadas.sort()).toEqual(["ECHO_SETUP_TOKEN", "INSTAGRAM_OAUTH_STATE_SECRET", "QR_WEBHOOK_SECRET", "WHATSAPP_VERIFY_TOKEN"]);
    const d = lerEnv(texto);
    expect(d.get("QR_WEBHOOK_SECRET")).toMatch(FORMATOS.QR_WEBHOOK_SECRET);
    expect(d.get("ECHO_SETUP_TOKEN")).toMatch(FORMATOS.ECHO_SETUP_TOKEN);
  });

  it("VAPID_SUBJECT ausente deriva do ECHO_PUBLIC_URL do arquivo", () => {
    const https = gerarEnv({ ...BASE, publicUrl: "https://echo.exemplo.com", siteAddress: "echo.exemplo.com", bind: "0.0.0.0", httpPort: 80 });
    const sem = https.replace(/^VAPID_SUBJECT=.*$/m, "");
    const { texto } = completarEnv(sem);
    expect(lerEnv(texto).get("VAPID_SUBJECT")).toBe("https://echo.exemplo.com");
  });

  it("arquivo inexistente: exit 2", () => {
    expect(node(["--completar", join(pastaTemp(), "nao-existe")]).status).toBe(2);
  });
});

describe("--exemplo e .env.example", () => {
  it("todo segredo gerado e o código de setup levam o placeholder; nada parece segredo real", () => {
    const env = lerEnv(gerarExemplo());
    for (const k of SEGREDOS_GERADOS) expect(env.get(k), k).toBe(PLACEHOLDER);
    expect(PLACEHOLDER).toBe("__GERE_COM_install.sh__");
    for (const [k, v] of env) {
      expect(v, k).not.toMatch(/^[0-9a-f]{32,}$/);
      expect(v, k).not.toMatch(/^eyJ/);
    }
    expect(env.get("COMPOSE_FILE")).toBe("docker-compose.yml");
    expect(env.get("COMPOSE_PROJECT_NAME")).toBe("echo");
    expect(env.get("ECHO_HTTPS_PORT")).toBe("");
  });

  it("VAPID (opcional) fica vazio no modelo, para a guarda não recusar um campo opcional", () => {
    const env = lerEnv(gerarExemplo());
    expect(env.get("VAPID_PUBLIC_KEY")).toBe("");
    expect(env.get("VAPID_PRIVATE_KEY")).toBe("");
    expect(env.get("VAPID_SUBJECT")).toBe("");
  });

  it("a opção --exemplo grava o .env.example na pasta atual e o arquivo do repositório está em dia", () => {
    const dir = pastaTemp();
    const r = node(["--exemplo"], { cwd: dir });
    expect(r.status).toBe(0);
    const gerado = readFileSync(join(dir, ".env.example"), "utf8");
    expect(gerado).toBe(gerarExemplo());
    const versionado = readFileSync(resolve(import.meta.dirname, "../.env.example"), "utf8");
    expect(versionado).toBe(gerado);
  });
});

describe("--print-jwt", () => {
  it("reemite anon e service_role a partir do JWT_SECRET do ambiente", () => {
    const segredo = "a".repeat(64);
    for (const papel of ["anon", "service_role"]) {
      const r = node(["--print-jwt", papel], { env: { ...process.env, JWT_SECRET: segredo } });
      expect(r.status).toBe(0);
      const j = decodificarJwt(r.stdout.trim());
      expect(j.corpo.role).toBe(papel);
      expect(j.assinatura).toBe(createHmac("sha256", segredo).update(j.assinado).digest("base64url"));
    }
  });

  it("recusa segredo curto, ausente ou papel desconhecido (exit 2)", () => {
    expect(node(["--print-jwt", "anon"], { env: { ...process.env, JWT_SECRET: "curto" } }).status).toBe(2);
    const semSegredo = { ...process.env };
    delete semSegredo.JWT_SECRET;
    expect(node(["--print-jwt", "anon"], { env: semSegredo }).status).toBe(2);
    expect(node(["--print-jwt", "admin"], { env: { ...process.env, JWT_SECRET: "a".repeat(64) } }).status).toBe(2);
  });
});

describe("lerEnv", () => {
  it("ignora comentário e linha vazia, tira aspas e deixa o último valor vencer", () => {
    const m = lerEnv('# x\n\nA=1\nB="dois"\nC=\'tres\'\nA=4\nD=\n');
    expect(m.get("A")).toBe("4");
    expect(m.get("B")).toBe("dois");
    expect(m.get("C")).toBe("tres");
    expect(m.get("D")).toBe("");
  });
});

describe("o gerador roda sem nenhuma dependência instalada", () => {
  it("só importa módulos node:", () => {
    const fonte = readFileSync(GEN_KEYS, "utf8");
    const imports = [...fonte.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i.startsWith("node:"), i).toBe(true);
  });
});
