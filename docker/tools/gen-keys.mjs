#!/usr/bin/env node
// Gerador do .env único da instalação auto-hospedada do Echo. Sem dependências: só node:crypto, node:fs e node:path
// (roda no Node do host ou, sem Node, num container node:alpine; por isso não usa Zod: a entrada é a linha de comando
// e cada valor é validado à mão em `validarOpcoes`, com exit 2).
//
//   node docker/tools/gen-keys.mjs --out .env --public-url URL --site-address ADDR --bind IP --http-port N \
//        [--https-port N] [--behind-proxy] [--proxy-network NOME] [--project echo] [--com-override] [--force]
//   node docker/tools/gen-keys.mjs --completar .env      # acrescenta só chaves ausentes; nunca reescreve; cópia .env.bak.<ts>
//   node docker/tools/gen-keys.mjs --print-jwt anon|service_role    # do JWT_SECRET do ambiente
//   node docker/tools/gen-keys.mjs --exemplo             # escreve o .env.example (placeholders que a guarda recusa)
//
// Contrato: seção 3.2 da especificação. Variáveis, ordem e formatos são os dessa tabela; `.env.example` é a saída de
// `--exemplo` e `scripts/env-paridade.test.mjs` garante que os dois emitem as mesmas chaves.
//
// Perder o .env = perder a chave-raiz do Vault e o segredo das chaves de IA: por isso o gerador recusa sobrescrever
// sem --force e o `--completar` nunca reescreve uma chave existente.
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Marcador do `.env.example`: a guarda de segredos do banco (preflight.sh) recusa qualquer valor que o contenha. */
export const PLACEHOLDER = "__GERE_COM_install.sh__";

const DEZ_ANOS = 10 * 365 * 24 * 3600;
const EMAIL_VAPID_PADRAO = "mailto:echo@example.com";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** JWT HS256 sem dependências. */
export function assinarJwt(payload, segredo) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const corpo = b64url(JSON.stringify(payload));
  const assinatura = b64url(createHmac("sha256", segredo).update(`${header}.${corpo}`).digest());
  return `${header}.${corpo}.${assinatura}`;
}

/** Chave de papel do Supabase: `{role, iss:"supabase", iat, exp:+10 anos}`. */
export function chaveDePapel(role, segredo, agora = Math.floor(Date.now() / 1000)) {
  return assinarJwt({ role, iss: "supabase", iat: agora, exp: agora + DEZ_ANOS }, segredo);
}

function hex(bytes) {
  return randomBytes(bytes).toString("hex");
}

/**
 * Par VAPID P-256: pública = base64url do ponto não comprimido (0x04 || x || y, 65 bytes); privada = base64url do
 * escalar `d` (32 bytes). É o formato que a biblioteca web-push espera.
 */
export function gerarVapid() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string" || typeof jwk.d !== "string") {
    throw new Error("o Node não exportou o par P-256 em JWK (x, y, d)");
  }
  const ponto = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { publica: b64url(ponto), privada: b64url(Buffer.from(jwk.d, "base64url")) };
}

/**
 * Catálogo na ordem da seção 3.2. `grupo` abre a seção com comentário; `chave`/`valor` descrevem cada linha.
 * `valor` recebe o contexto ({ opcoes, segredos }) e devolve o texto da linha (sem aspas).
 * `completar`: o que `--completar` faz com a chave ausente: "gerar" (usa `valor`), "vazio", ou "endereco"
 * (não há como adivinhar: erro de uso).
 */
export const SEGREDOS_GERADOS = [
  "POSTGRES_PASSWORD",
  "JWT_SECRET",
  "ANON_KEY",
  "SERVICE_ROLE_KEY",
  "VAULT_ROOT_KEY",
  "AI_KEY_SECRET",
  "REALTIME_SECRET_KEY_BASE",
  "REALTIME_DB_ENC_KEY",
  "REALTIME_RELEASE_COOKIE",
  "QR_WEBHOOK_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "INSTAGRAM_OAUTH_STATE_SECRET",
  "ZAPO_DB_PASSWORD",
  "ECHO_SETUP_TOKEN",
];

/** Formatos da seção 3.2 (a guarda `preflight.sh` do banco aplica as mesmas regras). */
export const FORMATOS = {
  POSTGRES_PASSWORD: /^[0-9a-f]{48}$/,
  JWT_SECRET: /^[0-9a-f]{64}$/,
  ANON_KEY: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  SERVICE_ROLE_KEY: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  VAULT_ROOT_KEY: /^[0-9a-f]{64}$/,
  AI_KEY_SECRET: /^[0-9a-f]{64}$/,
  REALTIME_SECRET_KEY_BASE: /^[0-9a-f]{96}$/,
  REALTIME_DB_ENC_KEY: /^[0-9a-f]{16}$/,
  REALTIME_RELEASE_COOKIE: /^[0-9a-f]{56}$/,
  QR_WEBHOOK_SECRET: /^[0-9a-f]{64}$/,
  WHATSAPP_VERIFY_TOKEN: /^[0-9a-f]{64}$/,
  INSTAGRAM_OAUTH_STATE_SECRET: /^[0-9a-f]{64}$/,
  ZAPO_DB_PASSWORD: /^[0-9a-f]{48}$/,
  ECHO_SETUP_TOKEN: /^[0-9a-f]{32,}$/,
};

/** Gera os segredos ⚙ de uma instalação nova (tudo que o `.env` precisa de aleatório). */
export function gerarSegredos(agora = Math.floor(Date.now() / 1000)) {
  const jwtSecret = hex(32);
  const vapid = gerarVapid();
  return {
    POSTGRES_PASSWORD: hex(24),
    JWT_SECRET: jwtSecret,
    ANON_KEY: chaveDePapel("anon", jwtSecret, agora),
    SERVICE_ROLE_KEY: chaveDePapel("service_role", jwtSecret, agora),
    VAULT_ROOT_KEY: hex(32),
    AI_KEY_SECRET: hex(32),
    REALTIME_SECRET_KEY_BASE: hex(48),
    REALTIME_DB_ENC_KEY: hex(8),
    REALTIME_RELEASE_COOKIE: hex(28),
    QR_WEBHOOK_SECRET: hex(32),
    WHATSAPP_VERIFY_TOKEN: hex(32),
    INSTAGRAM_OAUTH_STATE_SECRET: hex(32),
    ZAPO_DB_PASSWORD: hex(24),
    ECHO_SETUP_TOKEN: hex(16),
    VAPID_PUBLIC_KEY: vapid.publica,
    VAPID_PRIVATE_KEY: vapid.privada,
  };
}

function composeFile(o) {
  const arquivos = ["docker-compose.yml"];
  if (o.modoDominio) arquivos.push("docker/compose/dominio.yml");
  if (o.proxyNetwork) arquivos.push("docker/compose/proxy-rede.yml");
  if (o.comOverride) arquivos.push("docker-compose.override.yml");
  return arquivos.join(":");
}

function vapidSubject(publicUrl) {
  return publicUrl.startsWith("https://") ? publicUrl : EMAIL_VAPID_PADRAO;
}

/**
 * Seções do `.env`, na ordem da 3.2. Cada item: [chave, valor (string ou função de contexto), completar].
 * Item de texto = comentário. O contexto é `{ o: opcoes, s: segredos }`.
 */
function secoes() {
  return [
    {
      titulo: "Instalação",
      comentarios: ["Nome do projeto Docker Compose (prefixo de contêineres, volumes e imagens)."],
      itens: [
        ["COMPOSE_PROJECT_NAME", ({ o }) => o.project, "endereco"],
        [
          "COMPOSE_FILE",
          ({ o }) => composeFile(o),
          "endereco",
          "Arquivos do compose, separados por ':'. O `docker compose` e o ./echo leem esta linha.",
        ],
      ],
    },
    {
      titulo: "Endereço",
      comentarios: [
        "Uma única URL pública, sem barra final. Fica gravada no banco (mídias, links): para trocar de endereço, reinstale.",
      ],
      itens: [
        ["ECHO_PUBLIC_URL", ({ o }) => o.publicUrl, "endereco"],
        ["ECHO_SITE_ADDRESS", ({ o }) => o.siteAddress, "endereco", "':80' = HTTP puro; um domínio = HTTPS automático."],
        ["ECHO_BIND", ({ o }) => o.bind, "endereco"],
        ["ECHO_HTTP_PORT", ({ o }) => String(o.httpPort), "endereco"],
        ["ECHO_HTTPS_PORT", ({ o }) => (o.httpsPort ? String(o.httpsPort) : ""), "vazio", "Só no modo domínio."],
        ["ECHO_BEHIND_PROXY", ({ o }) => String(o.behindProxy), "endereco"],
        [
          "ECHO_PROXY_NETWORK",
          ({ o }) => o.proxyNetwork,
          "vazio",
          "Rede Docker externa do proxy reverso (só com --proxy-network).",
        ],
      ],
    },
    {
      titulo: "Segredos (gerados; não versionar e guardar no backup)",
      comentarios: [
        "Perder VAULT_ROOT_KEY, AI_KEY_SECRET ou JWT_SECRET torna ilegíveis o Vault e as chaves de IA; sem este arquivo",
        "um backup não restaura. Não troque estes valores numa instalação com dados.",
      ],
      itens: [
        ["POSTGRES_PASSWORD", ({ s }) => s.POSTGRES_PASSWORD, "gerar"],
        ["JWT_SECRET", ({ s }) => s.JWT_SECRET, "gerar"],
        ["ANON_KEY", ({ s }) => s.ANON_KEY, "gerar"],
        ["SERVICE_ROLE_KEY", ({ s }) => s.SERVICE_ROLE_KEY, "gerar"],
        ["VAULT_ROOT_KEY", ({ s }) => s.VAULT_ROOT_KEY, "gerar"],
        ["AI_KEY_SECRET", ({ s }) => s.AI_KEY_SECRET, "gerar"],
        ["REALTIME_SECRET_KEY_BASE", ({ s }) => s.REALTIME_SECRET_KEY_BASE, "gerar"],
        ["REALTIME_DB_ENC_KEY", ({ s }) => s.REALTIME_DB_ENC_KEY, "gerar"],
        ["REALTIME_RELEASE_COOKIE", ({ s }) => s.REALTIME_RELEASE_COOKIE, "gerar"],
        ["QR_WEBHOOK_SECRET", ({ s }) => s.QR_WEBHOOK_SECRET, "gerar"],
        ["WHATSAPP_VERIFY_TOKEN", ({ s }) => s.WHATSAPP_VERIFY_TOKEN, "gerar"],
        ["INSTAGRAM_OAUTH_STATE_SECRET", ({ s }) => s.INSTAGRAM_OAUTH_STATE_SECRET, "gerar"],
        ["ZAPO_DB_PASSWORD", ({ s }) => s.ZAPO_DB_PASSWORD, "gerar"],
        [
          "ECHO_SETUP_TOKEN",
          ({ s }) => s.ECHO_SETUP_TOKEN,
          "gerar",
          "Código do primeiro acesso (/setup). Vazio desliga a tela de setup.",
        ],
        ["VAPID_PUBLIC_KEY", ({ s }) => s.VAPID_PUBLIC_KEY, "gerar", "Web Push (chaves VAPID). Vazio = sem push."],
        ["VAPID_PRIVATE_KEY", ({ s }) => s.VAPID_PRIVATE_KEY, "gerar"],
        ["VAPID_SUBJECT", ({ o }) => vapidSubject(o.publicUrl), "gerar"],
      ],
    },
    {
      titulo: "E-mail (opcional)",
      comentarios: [
        "Sem SMTP_HOST e sem RESEND_API_KEY o Echo funciona sem e-mail: convite vira link para copiar e a senha se",
        "redefine por `./echo reset-password`. SMTP_ADMIN_EMAIL é obrigatório quando SMTP_HOST está preenchido.",
      ],
      itens: [
        ["SMTP_HOST", () => "", "vazio"],
        ["SMTP_PORT", () => "587", "gerar"],
        ["SMTP_USER", () => "", "vazio"],
        ["SMTP_PASS", () => "", "vazio"],
        ["SMTP_SECURE", () => "", "vazio", "starttls | tls | none (vazio = tls na porta 465, senão starttls)."],
        ["SMTP_ADMIN_EMAIL", () => "", "vazio"],
        ["SMTP_SENDER_NAME", () => "Echo", "gerar"],
        ["RESEND_API_KEY", () => "", "vazio", "Alternativa ao SMTP (só as funções; o GoTrue usa apenas SMTP)."],
        ["EMAIL_FROM", () => "", "vazio"],
        ["FAILURE_ALERT_EMAILS", () => "", "vazio", "Listas separadas por vírgula."],
        ["FEEDBACK_EMAILS", () => "", "vazio"],
        ["FEEDBACK_WEBHOOK_URL", () => "", "vazio", "URL que recebe o formulário de feedback (JSON)."],
      ],
    },
    {
      titulo: "Cloud API da Meta (opcional)",
      comentarios: ["Só para linhas business_api: sem o segredo do app o POST do webhook não pode ser verificado."],
      itens: [
        ["WHATSAPP_APP_SECRET", () => "", "vazio"],
        ["WHATSAPP_APP_SECRET_ENFORCE", () => "true", "gerar"],
      ],
    },
    {
      titulo: "Instagram (opcional)",
      comentarios: [],
      itens: [
        ["INSTAGRAM_APP_ID", () => "", "vazio"],
        ["INSTAGRAM_APP_SECRET", () => "", "vazio"],
        ["INSTAGRAM_VERIFY_TOKEN", () => "", "vazio"],
        ["INSTAGRAM_PAGINA_RETORNO", () => "", "vazio"],
        ["INSTAGRAM_GRAPH_VERSION", () => "", "vazio"],
        ["INSTAGRAM_WEBHOOK_REGISTRAR_INVALIDOS", () => "", "vazio"],
      ],
    },
    {
      titulo: "Limites (opcional)",
      comentarios: ["Vazio = padrão do código (MAX_MEDIA_BYTES 52428800; FN_REQUEST_TIMEOUT_MS 150000)."],
      itens: [
        ["MAX_MEDIA_BYTES", () => "", "vazio"],
        ["FN_REQUEST_TIMEOUT_MS", () => "", "vazio"],
      ],
    },
    {
      titulo: "Avançado (opcional)",
      comentarios: ["Variáveis de proteção do qr e outros ajustes finos vão em docker-compose.override.yml."],
      itens: [
        ["EDGE_INTERNAL_AUTH_ENFORCE", () => "", "vazio"],
        ["EDGE_INTERNAL_SECRET_KEYS", () => "", "vazio"],
        [
          "ECHO_OUTBOUND_ALLOW_HOSTS",
          () => "",
          "vazio",
          "Hosts exatos (vírgula) que as URLs de webhook podem alcançar na rede local.",
        ],
      ],
    },
  ];
}

/** Todas as chaves do `.env`, na ordem. */
export function chavesDoEnv() {
  return secoes().flatMap((s) => s.itens.map((i) => i[0]));
}

function renderizar(ctx, cabecalho) {
  const linhas = [...cabecalho, ""];
  for (const sec of secoes()) {
    linhas.push(`# --- ${sec.titulo} ---`);
    for (const c of sec.comentarios) linhas.push(`# ${c}`);
    for (const [chave, valor, , nota] of sec.itens) {
      if (nota) linhas.push(`# ${nota}`);
      linhas.push(`${chave}=${valor(ctx)}`);
    }
    linhas.push("");
  }
  return linhas.join("\n");
}

const HOST_RE = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function porta(valor, nome) {
  if (!/^\d{1,5}$/.test(String(valor))) throw new ErroDeUso(`${nome} precisa ser um número de 1 a 65535`);
  const n = Number(valor);
  if (n < 1 || n > 65535) throw new ErroDeUso(`${nome} precisa ser um número de 1 a 65535`);
  return n;
}

export class ErroDeUso extends Error {}

/**
 * Valida e completa as opções de geração (entrada externa: linha de comando). Devolve o objeto que o catálogo usa.
 * Modo domínio = `--site-address` é um nome de host (não ":porta") e não há `--behind-proxy`.
 */
export function validarOpcoes(bruto) {
  const publicUrl = bruto.publicUrl;
  if (typeof publicUrl !== "string" || !/^https?:\/\/[^/\s"'\\]+$/.test(publicUrl)) {
    throw new ErroDeUso("--public-url precisa ser http(s)://host[:porta], sem barra no fim, sem aspas nem espaço");
  }
  const siteAddress = bruto.siteAddress ?? ":80";
  const ehPorta = /^:\d{1,5}$/.test(siteAddress);
  if (!ehPorta && !HOST_RE.test(siteAddress)) {
    throw new ErroDeUso("--site-address precisa ser ':porta' (HTTP puro, ex.: :80) ou um nome de host (HTTPS automático)");
  }
  const bind = bruto.bind ?? "127.0.0.1";
  const m = IPV4_RE.exec(bind);
  if (!m || m.slice(1).some((p) => Number(p) > 255)) throw new ErroDeUso("--bind precisa ser um IPv4 (127.0.0.1 ou 0.0.0.0)");
  const httpPort = porta(bruto.httpPort ?? 8088, "--http-port");
  const behindProxy = Boolean(bruto.behindProxy);
  const modoDominio = !behindProxy && !ehPorta;
  let httpsPort = "";
  if (bruto.httpsPort !== undefined && bruto.httpsPort !== null && bruto.httpsPort !== "") {
    if (!modoDominio) throw new ErroDeUso("--https-port só vale no modo domínio (--site-address com nome de host, sem --behind-proxy)");
    httpsPort = porta(bruto.httpsPort, "--https-port");
  } else if (modoDominio) {
    httpsPort = 443;
  }
  const proxyNetwork = bruto.proxyNetwork ?? "";
  if (proxyNetwork) {
    if (!behindProxy) throw new ErroDeUso("--proxy-network exige --behind-proxy");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(proxyNetwork)) throw new ErroDeUso("--proxy-network: nome de rede Docker inválido");
  }
  const project = bruto.project ?? "echo";
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) {
    throw new ErroDeUso("--project: só letras minúsculas, dígitos, '-' e '_' (nome de projeto do Docker Compose)");
  }
  return {
    publicUrl,
    siteAddress,
    bind,
    httpPort,
    httpsPort,
    behindProxy,
    proxyNetwork,
    project,
    modoDominio,
    comOverride: Boolean(bruto.comOverride),
  };
}

/** Texto de um `.env` novo. `segredos` é injetável para teste. */
export function gerarEnv(bruto, segredos = gerarSegredos(), agora = new Date()) {
  const o = validarOpcoes(bruto);
  return renderizar({ o, s: segredos }, [
    "# Gerado por docker/tools/gen-keys.mjs (./install.sh). SEGREDO: não versionar; guarde junto dos backups.",
    `# Gerado em ${agora.toISOString()}`,
  ]);
}

/** Texto do `.env.example`: os mesmos campos, com `PLACEHOLDER` onde há segredo gerado. */
export function gerarExemplo() {
  const o = validarOpcoes({
    publicUrl: "http://localhost:8088",
    siteAddress: ":80",
    bind: "127.0.0.1",
    httpPort: 8088,
    behindProxy: false,
    project: "echo",
    comOverride: false,
  });
  const s = Object.fromEntries(SEGREDOS_GERADOS.map((k) => [k, PLACEHOLDER]));
  // Web Push é opcional (vazio = sem push): vazio em vez de placeholder, para a guarda não recusar um campo opcional.
  s.VAPID_PUBLIC_KEY = "";
  s.VAPID_PRIVATE_KEY = "";
  const texto = renderizar({ o, s }, [
    "# Variáveis do Echo auto-hospedado (docker compose). Este arquivo é o MODELO: os segredos abaixo são",
    "# placeholders que a guarda do banco recusa de propósito. Quem gera o .env de verdade é o ./install.sh",
    "# (docker/tools/gen-keys.mjs): não copie este arquivo para .env.",
    "# Variáveis do front em desenvolvimento (VITE_*): .env.development.example.",
  ]);
  // No modelo o VAPID_SUBJECT fica vazio junto das chaves VAPID.
  return texto.replace(/^VAPID_SUBJECT=.*$/m, "VAPID_SUBJECT=");
}

/** Lê um `.env` (KEY=valor por linha; comentários e linhas vazias ignorados). Último valor vence, como no Compose. */
export function lerEnv(texto) {
  const mapa = new Map();
  for (const linha of texto.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(linha);
    if (!m) continue;
    let valor = m[2].trim();
    if (/^(".*"|'.*')$/.test(valor)) valor = valor.slice(1, -1);
    mapa.set(m[1], valor);
  }
  return mapa;
}

/**
 * Segredos que, depois de usados, não mudam sem perda ou quebra: a senha do banco (o diretório de dados guarda a
 * antiga), o JWT_SECRET e as chaves assinadas com ele, as chaves do Vault e da cifra das chaves de IA (o que já foi
 * cifrado fica ilegível) e os segredos do Realtime. O `--completar` nunca os inventa: linha apagada num .env de uma
 * instalação existente é erro, e a saída é restaurar a linha (backups/*\/.env ou .env.bak.*).
 * Lista irmã: CHAVES_IMUTAVEIS do ./echo (as que o restore repõe), que também inclui as geráveis.
 */
export const SEGREDOS_QUE_NAO_SE_INVENTAM = [
  "POSTGRES_PASSWORD",
  "ZAPO_DB_PASSWORD",
  "JWT_SECRET",
  "ANON_KEY",
  "SERVICE_ROLE_KEY",
  "VAULT_ROOT_KEY",
  "AI_KEY_SECRET",
  "REALTIME_SECRET_KEY_BASE",
  "REALTIME_DB_ENC_KEY",
  "REALTIME_RELEASE_COOKIE",
];

/**
 * Acrescenta ao texto de um `.env` existente só as chaves ausentes. Nunca altera nem remove linha existente.
 * Devolve `{ texto, acrescentadas }`. Chave de endereço ausente (não há como adivinhar) e segredo que não se
 * inventa (SEGREDOS_QUE_NAO_SE_INVENTAM) são erro de uso, e nada é escrito.
 */
export function completarEnv(texto, segredos = gerarSegredos(), agora = new Date()) {
  const atual = lerEnv(texto);
  const faltam = chavesDoEnv().filter((k) => !atual.has(k));
  if (faltam.length === 0) return { texto, acrescentadas: [] };

  const imutaveisAusentes = SEGREDOS_QUE_NAO_SE_INVENTAM.filter((k) => !atual.has(k));
  if (imutaveisAusentes.length > 0) {
    throw new ErroDeUso(
      `${imutaveisAusentes.join(", ")} falta(m) no .env de uma instalação existente: restaure a linha de backups/*/.env ou .env.bak.*; não gere outra (o banco, o Vault ou o JWT da instalação não abririam). Instalação nova: ./install.sh.`,
    );
  }

  const naoDaParaGerar = [];
  const novas = [];
  const publicUrl = atual.get("ECHO_PUBLIC_URL") ?? "";
  const par = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"];
  const umDoParAusente = par.filter((k) => atual.has(k)).length === 1;
  for (const sec of secoes()) {
    for (const [chave, valor, modo] of sec.itens) {
      if (atual.has(chave)) continue;
      if (modo === "endereco") {
        naoDaParaGerar.push(chave);
        continue;
      }
      if (par.includes(chave) && umDoParAusente) {
        naoDaParaGerar.push(chave);
        continue;
      }
      if (chave === "VAPID_SUBJECT") {
        novas.push(`${chave}=${vapidSubject(publicUrl)}`);
        continue;
      }
      const v = modo === "vazio" ? "" : valor({ o: { publicUrl }, s: segredos });
      novas.push(`${chave}=${v}`);
    }
  }
  if (naoDaParaGerar.length > 0) {
    throw new ErroDeUso(
      `chave(s) que o gerador não consegue inventar e que faltam no .env: ${naoDaParaGerar.join(", ")} (endereço da instalação, ou metade do par VAPID)`,
    );
  }
  const sep = texto.endsWith("\n") || texto === "" ? "" : "\n";
  const bloco = ["", `# Acrescentado por gen-keys --completar em ${agora.toISOString()}`, ...novas, ""].join("\n");
  return { texto: `${texto}${sep}${bloco}`, acrescentadas: faltam };
}

function carimbo(agora = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${agora.getFullYear()}${p(agora.getMonth() + 1)}${p(agora.getDate())}${p(agora.getHours())}${p(agora.getMinutes())}${p(agora.getSeconds())}`;
}

const OPCOES_COM_VALOR = {
  "--out": "out",
  "--public-url": "publicUrl",
  "--site-address": "siteAddress",
  "--bind": "bind",
  "--http-port": "httpPort",
  "--https-port": "httpsPort",
  "--proxy-network": "proxyNetwork",
  "--project": "project",
  "--completar": "completar",
  "--print-jwt": "printJwt",
};
const OPCOES_BOOLEANAS = {
  "--behind-proxy": "behindProxy",
  "--com-override": "comOverride",
  "--force": "force",
  "--exemplo": "exemplo",
};

/** Lê a linha de comando. Erro de uso lança ErroDeUso. */
export function lerArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t in OPCOES_COM_VALOR) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new ErroDeUso(`${t} precisa de um valor`);
      a[OPCOES_COM_VALOR[t]] = v;
    } else if (t in OPCOES_BOOLEANAS) {
      a[OPCOES_BOOLEANAS[t]] = true;
    } else {
      throw new ErroDeUso(`opção desconhecida: ${t}`);
    }
  }
  return a;
}

function gravar600(caminho, texto) {
  writeFileSync(caminho, texto, { mode: 0o600 });
  chmodSync(caminho, 0o600);
}

/** Executa um comando e devolve o texto para o stdout (quando houver) e o código de saída. Testável. */
export function executar(argv, env = process.env, io = { escreverOut: (t) => process.stdout.write(t), escreverErr: (t) => process.stderr.write(t) }) {
  const a = lerArgs(argv);

  if (a.printJwt) {
    const segredo = env.JWT_SECRET;
    if (!segredo || segredo.length < 32) throw new ErroDeUso("JWT_SECRET ausente ou com menos de 32 caracteres no ambiente");
    if (!["anon", "service_role"].includes(a.printJwt)) throw new ErroDeUso("--print-jwt aceita anon ou service_role");
    io.escreverOut(`${chaveDePapel(a.printJwt, segredo)}\n`);
    return 0;
  }

  if (a.exemplo) {
    const destino = resolve(".env.example");
    writeFileSync(destino, gerarExemplo());
    io.escreverErr(`Escrito ${destino}.\n`);
    return 0;
  }

  if (a.completar) {
    const alvo = resolve(a.completar);
    if (!existsSync(alvo)) throw new ErroDeUso(`${a.completar} não existe`);
    const texto = readFileSync(alvo, "utf8");
    const { texto: novo, acrescentadas } = completarEnv(texto);
    if (acrescentadas.length === 0) {
      io.escreverErr(`${a.completar}: nada a acrescentar.\n`);
      return 0;
    }
    const copia = `${alvo}.bak.${carimbo()}`;
    copyFileSync(alvo, copia);
    chmodSync(copia, 0o600);
    gravar600(alvo, novo);
    io.escreverErr(`${a.completar}: acrescentadas ${acrescentadas.length} chave(s): ${acrescentadas.join(", ")} (cópia em ${relative(process.cwd(), copia) || copia}).\n`);
    return 0;
  }

  const texto = gerarEnv({
    publicUrl: a.publicUrl,
    siteAddress: a.siteAddress,
    bind: a.bind,
    httpPort: a.httpPort,
    httpsPort: a.httpsPort,
    behindProxy: a.behindProxy,
    proxyNetwork: a.proxyNetwork,
    project: a.project,
    comOverride: a.comOverride,
  });
  if (!a.out) {
    io.escreverOut(texto);
    return 0;
  }
  const alvo = resolve(a.out);
  if (existsSync(alvo) && !a.force) {
    throw new ErroDeUso(
      `${a.out} já existe. Trocar os segredos de uma instalação com dados torna o Vault ilegível; use --force só numa instalação nova (ou --completar para acrescentar chaves).`,
    );
  }
  gravar600(alvo, texto);
  io.escreverErr(`Escrito ${a.out} (modo 600).\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = executar(process.argv.slice(2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`gen-keys: ${msg}\n`);
    process.exitCode = e instanceof ErroDeUso ? 2 : 1;
  }
}
