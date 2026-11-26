import { z } from "zod";

/**
 * Configuração do front em tempo de execução.
 *
 * O mesmo build serve qualquer instalação: o gateway escreve `/config.js`
 * (`window.__ECHO_CONFIG__ = {...}`) na subida, e o `index.html` o carrega como
 * script clássico ANTES do módulo da aplicação, então o client do Supabase, que
 * é criado no import, já encontra a configuração.
 *
 * Precedência POR CAMPO, string vazia conta como ausente:
 *   1. `window.__ECHO_CONFIG__`
 *   2. `import.meta.env.VITE_*` (desenvolvimento e hospedagem estática)
 *   3. padrão de mesma origem (`supabaseUrl` e `siteUrl` = origem da página;
 *      `qrServiceUrl` = origem + "/qr"; `features` todas `true`).
 *
 * Sem cache de propósito: os testes usam `vi.stubEnv` depois do import, e
 * `mediaDerivative` lê a base a cada bolha.
 */

declare global {
  interface Window {
    __ECHO_CONFIG__?: unknown;
  }
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

export interface RuntimeFeatures {
  email: boolean;
  recuperacaoSenha: boolean;
  feedback: boolean;
  transformacaoImagem: boolean;
}

export interface RuntimeConfig {
  /** Absoluta, sem barra final. */
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** Absoluta, sem barra final (o WebSocket de áudio da ligação exige absoluta). */
  qrServiceUrl: string;
  /** Absoluta, sem barra final. */
  siteUrl: string;
  vapidPublicKey: string | null;
  feedbackWebhookUrl: string | null;
  features: RuntimeFeatures;
}

// Campo com tipo errado vira "ausente" (cai para a env ou o padrão) em vez de derrubar o app.
const campoTexto = z.string().optional().catch(undefined);
const campoBool = z.boolean().optional().catch(undefined);

const InjectedFeaturesSchema = z
  .object({
    email: campoBool,
    recuperacaoSenha: campoBool,
    feedback: campoBool,
    transformacaoImagem: campoBool,
  })
  .catch({});

const InjectedConfigSchema = z
  .object({
    supabaseUrl: campoTexto,
    supabaseAnonKey: campoTexto,
    qrServiceUrl: campoTexto,
    siteUrl: campoTexto,
    vapidPublicKey: campoTexto,
    feedbackWebhookUrl: campoTexto,
    features: InjectedFeaturesSchema.optional(),
  })
  .catch({});

type InjectedConfig = z.infer<typeof InjectedConfigSchema>;

const RuntimeConfigSchema = z.object({
  supabaseUrl: z.string().url(),
  supabaseAnonKey: z.string().min(1),
  qrServiceUrl: z.string().url(),
  siteUrl: z.string().url(),
  vapidPublicKey: z.string().min(1).nullable(),
  feedbackWebhookUrl: z.string().min(1).nullable(),
  features: z.object({
    email: z.boolean(),
    recuperacaoSenha: z.boolean(),
    feedback: z.boolean(),
    transformacaoImagem: z.boolean(),
  }),
});

function lerInjetada(): InjectedConfig {
  if (typeof window === "undefined") return {};
  return InjectedConfigSchema.parse(window.__ECHO_CONFIG__ ?? {});
}

/** String não vazia (depois do trim) ou undefined. */
function preenchido(valor: unknown): string | undefined {
  if (typeof valor !== "string") return undefined;
  const limpo = valor.trim();
  return limpo === "" ? undefined : limpo;
}

function origemDaPagina(): string {
  return typeof location === "undefined" ? "" : location.origin;
}

/** Resolve valor relativo contra a origem da página e tira a barra final. */
function paraUrlAbsoluta(valor: string, campo: string): string {
  const origem = origemDaPagina();
  try {
    const url = origem ? new URL(valor, origem) : new URL(valor);
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new RuntimeConfigError(`Echo sem configuração: ${campo} inválida ("${valor}") em /config.js`);
  }
}

function urlDoCampo(
  campo: "supabaseUrl" | "qrServiceUrl" | "siteUrl",
  injetada: InjectedConfig,
  daEnv: string | undefined,
  padrao: () => string,
): string {
  const valor = preenchido(injetada[campo]) ?? preenchido(daEnv);
  return valor === undefined ? padrao() : paraUrlAbsoluta(valor, campo);
}

/**
 * Valor OPCIONAL (feedback, push): mal formado não derruba o app, que não pode ficar em tela branca por
 * causa de um recurso acessório. Vira `null` (recurso desligado) e o motivo vai para o console.
 */
function opcionalValido(
  campo: string,
  valor: string | undefined,
  valido: (texto: string) => boolean,
  esperado: string,
): string | null {
  if (valor === undefined) return null;
  if (valido(valor)) return valor;
  console.warn(`[Echo] ${campo} ignorado: ${esperado}. O recurso fica desligado.`);
  return null;
}

function ehUrlHttp(texto: string): boolean {
  try {
    const { protocol } = new URL(texto);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Chave pública VAPID: base64 (padrão ou url-safe) sem espaço nem aspas.
const ehChaveVapid = (texto: string): boolean => /^[A-Za-z0-9_+/=-]+$/.test(texto);

function featuresDe(injetada: InjectedConfig): RuntimeFeatures {
  const f = injetada.features ?? {};
  return {
    email: f.email ?? true,
    recuperacaoSenha: f.recuperacaoSenha ?? true,
    feedback: f.feedback ?? true,
    transformacaoImagem: f.transformacaoImagem ?? true,
  };
}

function baseSupabase(injetada: InjectedConfig): string {
  return urlDoCampo("supabaseUrl", injetada, import.meta.env.VITE_SUPABASE_URL, origemDaPagina);
}

export function getRuntimeConfig(): RuntimeConfig {
  const injetada = lerInjetada();
  const supabaseAnonKey =
    preenchido(injetada.supabaseAnonKey) ?? preenchido(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
  if (!supabaseAnonKey) {
    throw new RuntimeConfigError("Echo sem configuração: falta supabaseAnonKey (/config.js)");
  }

  const bruta = {
    supabaseUrl: baseSupabase(injetada),
    supabaseAnonKey,
    qrServiceUrl: urlDoCampo("qrServiceUrl", injetada, import.meta.env.VITE_QR_SERVICE_URL, () => `${origemDaPagina()}/qr`),
    siteUrl: urlDoCampo("siteUrl", injetada, import.meta.env.VITE_SITE_URL, origemDaPagina),
    vapidPublicKey: opcionalValido(
      "vapidPublicKey",
      preenchido(injetada.vapidPublicKey) ?? preenchido(import.meta.env.VITE_VAPID_PUBLIC_KEY),
      ehChaveVapid,
      "esperava uma chave base64 sem espaços",
    ),
    feedbackWebhookUrl: opcionalValido(
      "feedbackWebhookUrl",
      preenchido(injetada.feedbackWebhookUrl) ?? preenchido(import.meta.env.VITE_FEEDBACK_WEBHOOK_URL),
      ehUrlHttp,
      "esperava uma URL começando com http:// ou https://",
    ),
    features: featuresDe(injetada),
  };

  const resultado = RuntimeConfigSchema.safeParse(bruta);
  if (!resultado.success) {
    const campo = resultado.error.issues[0]?.path.join(".") ?? "desconhecido";
    throw new RuntimeConfigError(`Echo sem configuração: valor inválido em ${campo} (/config.js)`);
  }
  // O tsconfig do app é `strict: false`: o Zod infere tudo opcional. A validação acima garante os campos.
  return resultado.data as RuntimeConfig;
}

/** Flags de recurso sem exigir a chave anon (serve a telas e testes que só decidem o que mostrar). */
export function getRuntimeFeatures(): RuntimeFeatures {
  return featuresDe(lerInjetada());
}

export function supabaseBaseUrl(): string {
  return baseSupabase(lerInjetada());
}

/** URL pública do front (links de convite, endereço de webhook mostrado ao admin). */
export function siteUrl(): string {
  return urlDoCampo("siteUrl", lerInjetada(), import.meta.env.VITE_SITE_URL, origemDaPagina);
}

/** Base do serviço de QR (absoluta, sem barra final). */
export function qrServiceUrl(): string {
  return urlDoCampo("qrServiceUrl", lerInjetada(), import.meta.env.VITE_QR_SERVICE_URL, () => `${origemDaPagina()}/qr`);
}

const semBarraInicial = (caminho: string): string => caminho.replace(/^\/+/, "");

export function functionUrl(nome: string): string {
  return `${supabaseBaseUrl()}/functions/v1/${semBarraInicial(nome)}`;
}

export function restUrl(caminho: string): string {
  return `${supabaseBaseUrl()}/rest/v1/${semBarraInicial(caminho)}`;
}

export function storageUrl(caminho: string): string {
  return `${supabaseBaseUrl()}/storage/v1/${semBarraInicial(caminho)}`;
}

/**
 * Endereço de uma função como o mundo de fora a enxerga (o que o admin cola na
 * Meta, o que a documentação da API mostra). É o endereço canônico do site, não
 * o IP ou o apelido por onde esta aba abriu, quando:
 *   - o `/config.js` definiu `siteUrl` (o docker sempre define); ou
 *   - a base do Supabase NÃO foi definida (padrão de mesma origem: front e API
 *     no mesmo host) e `VITE_SITE_URL` foi.
 * Com `supabaseUrl` explícito (`/config.js` ou `VITE_SUPABASE_URL`, o caminho
 * Cloud e a hospedagem estática, onde o front e a API ficam em hosts
 * diferentes), é sempre a base do Supabase: `VITE_SITE_URL` ali é só o endereço
 * do front (links de convite) e `<front>/functions/v1/…` não existe.
 */
export function publicFunctionUrl(nome: string): string {
  const injetada = lerInjetada();
  const doDocker = preenchido(injetada.siteUrl);
  const supabaseExplicita =
    preenchido(injetada.supabaseUrl) !== undefined || preenchido(import.meta.env.VITE_SUPABASE_URL) !== undefined;
  const daEnv = supabaseExplicita ? undefined : preenchido(import.meta.env.VITE_SITE_URL);
  const explicita = doDocker ?? daEnv;
  const base = explicita === undefined ? baseSupabase(injetada) : paraUrlAbsoluta(explicita, "siteUrl");
  return `${base}/functions/v1/${semBarraInicial(nome)}`;
}

/**
 * URL pública de um anexo do bucket `attachments`, no formato do `getPublicUrl`
 * do storage-js (`encodeURI`). Par de `urlPublicaDoAnexo` (edge) e do
 * `publicUrl.ts` do qr-service.
 *
 * É a URL que será GRAVADA (figurinha, mídia de fluxo, cabeçalho de template) e
 * lida depois pelo servidor, então leva a base canônica: o `siteUrl` do
 * `/config.js` (o `ECHO_PUBLIC_URL` do docker, o mesmo que a edge grava) e, sem
 * ele, a base do Supabase. Não a origem da aba: aberto por IP da rede local ou
 * por apelido, o servidor não reconheceria a URL como anexo nosso nem a alcançaria.
 */
export function publicAttachmentUrl(caminho: string): string {
  const injetada = lerInjetada();
  const canonica = preenchido(injetada.siteUrl);
  const base = canonica === undefined ? baseSupabase(injetada) : paraUrlAbsoluta(canonica, "siteUrl");
  return encodeURI(`${base}/storage/v1/object/public/attachments/${semBarraInicial(caminho)}`);
}

/**
 * A URL é do Storage desta instalação? Aceita a base atual (`supabaseUrl`) e a
 * canônica (`siteUrl`): mídia gravada pelo servidor leva a pública, e quem
 * acessa por outro endereço (IP da rede local, por exemplo) continua
 * reconhecendo. Devolve a base que casou, ou null.
 */
export function isOwnStorageBase(url: string): string | null {
  if (!url) return null;
  const injetada = lerInjetada();
  let candidatas: string[];
  try {
    candidatas = [
      baseSupabase(injetada),
      urlDoCampo("siteUrl", injetada, import.meta.env.VITE_SITE_URL, origemDaPagina),
    ];
  } catch {
    return null;
  }
  for (const base of candidatas) {
    if (base && url.startsWith(`${base}/storage/v1/`)) return base;
  }
  return null;
}
