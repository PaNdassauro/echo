// Regras do builder de template da Cloud API (criar e editar), sem React.
// Espelha as recusas mais comuns da Meta para o erro aparecer no campo antes do envio,
// em vez de voltar como "Invalid parameter" depois de esperar a aprovação.
// Par no servidor: whatsapp-create-template / whatsapp-edit-template (montam os components).
import type { TemplateHeaderMedia } from "@/lib/templateMedia";

export type TemplateCategory = "MARKETING" | "UTILITY";
export type HeaderKind = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
export type ButtonKind = "QUICK_REPLY" | "URL" | "PHONE_NUMBER";

export interface DraftButton {
  /** Chave estável da linha na lista (não vai para a Meta). */
  key: string;
  type: ButtonKind;
  text: string;
  url: string;
  /** Valor de exemplo do {{1}} no fim da URL dinâmica. */
  urlExample: string;
  /** Dígitos E.164 sem "+" (saída do PhoneNumberInput). */
  phone: string;
}

export interface TemplateDraft {
  name: string;
  category: TemplateCategory;
  language: string;
  headerType: HeaderKind;
  headerText: string;
  headerMedia: TemplateHeaderMedia | null;
  body: string;
  /** Exemplo por número da variável ("1" → "Maria"). */
  examples: Record<string, string>;
  footer: string;
  buttons: DraftButton[];
  /**
   * Com mais de 3 botões o WhatsApp mostra só os 2 primeiros e "Ver todas as opções".
   * A Meta exige cada grupo junto; aqui se escolhe qual grupo vem antes.
   */
  quickRepliesFirst: boolean;
}

export const LIMITS = {
  name: 512,
  headerText: 60,
  body: 1024,
  footer: 60,
  buttonText: 25,
  url: 2000,
  buttonsTotal: 10,
  perType: { QUICK_REPLY: 10, URL: 2, PHONE_NUMBER: 1 } as Record<ButtonKind, number>,
} as const;

export const TEMPLATE_LANGUAGES = [
  { value: "pt_BR", label: "Português (Brasil)" },
  { value: "en_US", label: "Inglês (EUA)" },
  { value: "es", label: "Espanhol" },
] as const;

export const emptyDraft = (): TemplateDraft => ({
  name: "",
  category: "UTILITY",
  language: "pt_BR",
  headerType: "NONE",
  headerText: "",
  headerMedia: null,
  body: "",
  examples: {},
  footer: "",
  buttons: [],
  quickRepliesFirst: false,
});

let buttonSeq = 0;
export const newButton = (type: ButtonKind): DraftButton => ({
  key: `b${++buttonSeq}`,
  type,
  text: "",
  url: "",
  urlExample: "",
  phone: "",
});

/** "Confirmação de reserva!" → "confirmacao_de_reserva". */
export function slugifyTemplateName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, LIMITS.name);
}

// Só {{n}} exato: as edges e a Meta não aceitam {{ 1 }} nem {{nome}}.
const VAR_RE = /\{\{(\d+)\}\}/g;

/** Trecho com chaves que não é variável válida ({{ 1 }}, {{nome}}, {{1}). */
export function hasMalformedVariable(text: string): boolean {
  return /\{\{|\}\}/.test(text.replace(VAR_RE, ""));
}

/** Números das variáveis do texto, únicos e em ordem crescente. */
export function extractVariables(text: string): number[] {
  const found = new Set<number>();
  for (const m of text.matchAll(VAR_RE)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

export function nextVariableNumber(text: string): number {
  const vars = extractVariables(text);
  return vars.length ? vars[vars.length - 1] + 1 : 1;
}

/**
 * Renumera as variáveis na ordem em que aparecem ({{3}} … {{1}} → {{1}} … {{2}}),
 * levando os exemplos junto. A Meta recusa lacuna ou ordem fora de sequência.
 */
export function renumberVariables(
  text: string,
  examples: Record<string, string>,
): { text: string; examples: Record<string, string> } {
  const order: number[] = [];
  for (const m of text.matchAll(VAR_RE)) {
    const n = Number(m[1]);
    if (!order.includes(n)) order.push(n);
  }
  const map = new Map(order.map((n, i) => [n, i + 1]));
  const nextExamples: Record<string, string> = {};
  for (const [oldN, newN] of map) {
    const ex = examples[String(oldN)];
    if (ex) nextExamples[String(newN)] = ex;
  }
  return {
    text: text.replace(VAR_RE, (_, n: string) => `{{${map.get(Number(n))}}}`),
    examples: nextExamples,
  };
}

/** Variáveis fora de sequência (lacuna, não começa em 1 ou fora de ordem no texto). */
export function variablesOutOfOrder(text: string): boolean {
  const seen: number[] = [];
  for (const m of text.matchAll(VAR_RE)) {
    const n = Number(m[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen.some((n, i) => n !== i + 1);
}

const hasVariable = (s: string) => /\{\{/.test(s);

const URL_DYNAMIC_RE = /\{\{1\}\}$/;

export function isDynamicUrl(url: string): boolean {
  return URL_DYNAMIC_RE.test(url.trim());
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.replace(URL_DYNAMIC_RE, "x"));
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export type DraftErrors = Partial<Record<string, string>>;

/**
 * Erros por campo. Chaves: name, header, body, examples.<n>, footer, buttons,
 * buttons.<key>.text, buttons.<key>.url, buttons.<key>.urlExample, buttons.<key>.phone.
 * `mode = "edit"` não valida o nome (a Meta não deixa trocar).
 */
export function validateDraft(draft: TemplateDraft, mode: "create" | "edit" = "create"): DraftErrors {
  const e: DraftErrors = {};

  if (mode === "create") {
    if (!draft.name) e.name = "Dê um nome ao template.";
    else if (!/^[a-z0-9_]+$/.test(draft.name)) e.name = "Use só letras minúsculas, números e _.";
  }

  if (draft.headerType === "TEXT") {
    const t = draft.headerText.trim();
    if (!t) e.header = "Escreva o texto do cabeçalho ou escolha \"Nenhum\".";
    else if (hasVariable(t)) e.header = "O cabeçalho não aceita variável. Deixe a variável no texto da mensagem.";
    else if (/\p{Extended_Pictographic}|[*_~\n]/u.test(t)) e.header = "O cabeçalho não aceita emoji nem formatação (*, _, ~).";
    else if (t.length > LIMITS.headerText) e.header = `Máximo de ${LIMITS.headerText} caracteres.`;
  } else if (draft.headerType !== "NONE" && headerMediaFor(draft) === null) {
    e.header = "Envie um arquivo de exemplo. A Meta usa só para aprovar.";
  }

  const body = draft.body.trim();
  if (!body) {
    e.body = "Escreva a mensagem.";
  } else if (body.length > LIMITS.body) {
    e.body = `Máximo de ${LIMITS.body} caracteres.`;
  } else if (hasMalformedVariable(body)) {
    e.body = "Variável só no formato {{1}}, {{2}}… Use o botão Variável.";
  } else if (/^\{\{\d+\}\}/.test(body) || /\{\{\d+\}\}$/.test(body)) {
    e.body = "A mensagem não pode começar nem terminar com variável. Ex.: \"Olá {{1}}, tudo bem?\"";
  } else if (variablesOutOfOrder(body)) {
    e.body = "As variáveis precisam seguir a ordem {{1}}, {{2}}, {{3}}…";
  } else if (mode === "create") {
    // Só na criação: em edição, um texto que a Meta já aprovou não pode ficar travado aqui.
    const vars = extractVariables(body);
    const words = body.replace(VAR_RE, " ").split(/\s+/).filter(Boolean).length;
    // A Meta recusa "too many variables for its length": na prática, menos de ~2 palavras por variável.
    if (vars.length > 0 && words < vars.length * 2 + 1) {
      e.body = "Muitas variáveis para um texto tão curto. Escreva mais texto em volta delas.";
    }
  }

  for (const n of extractVariables(draft.body)) {
    const ex = (draft.examples[String(n)] ?? "").trim();
    if (!ex) e[`examples.${n}`] = "Preencha um exemplo.";
    else if (/[\n\t]| {5,}/.test(ex)) e[`examples.${n}`] = "Sem quebra de linha, tab ou muitos espaços.";
  }

  if (draft.footer.trim()) {
    if (hasVariable(draft.footer)) e.footer = "O rodapé não aceita variável.";
    else if (draft.footer.trim().length > LIMITS.footer) e.footer = `Máximo de ${LIMITS.footer} caracteres.`;
  }

  const counts: Record<ButtonKind, number> = { QUICK_REPLY: 0, URL: 0, PHONE_NUMBER: 0 };
  const seenTexts = new Set<string>();
  let dynamicUrls = 0;
  for (const b of draft.buttons) {
    counts[b.type]++;
    const k = `buttons.${b.key}`;
    const text = b.text.trim();
    if (!text) e[`${k}.text`] = "Escreva o texto do botão.";
    else if (text.length > LIMITS.buttonText) e[`${k}.text`] = `Máximo de ${LIMITS.buttonText} caracteres.`;
    else if (hasVariable(text)) e[`${k}.text`] = "O texto do botão não aceita variável.";
    else if (seenTexts.has(text.toLowerCase())) e[`${k}.text`] = "Já existe um botão com esse texto.";
    seenTexts.add(text.toLowerCase());

    if (b.type === "URL") {
      const url = b.url.trim();
      if (!url) e[`${k}.url`] = "Cole o link.";
      else if (!isHttpUrl(url)) e[`${k}.url`] = "Link inválido. Comece com https://";
      else if (url.length > LIMITS.url) e[`${k}.url`] = `Máximo de ${LIMITS.url} caracteres.`;
      else if (hasVariable(url) && !isDynamicUrl(url)) e[`${k}.url`] = "A parte variável só pode ser {{1}}, no fim do link.";
      else if (isDynamicUrl(url) && !b.urlExample.trim()) e[`${k}.urlExample`] = "Preencha um exemplo do final do link.";
      else if (isDynamicUrl(url) && ++dynamicUrls > 1) {
        // Os envios (nova conversa, chat, disparo) preenchem um final de link só.
        e[`${k}.url`] = "Só um link pode ter parte variável.";
      }
    }
    if (b.type === "PHONE_NUMBER" && b.phone.replace(/\D/g, "").length < 8) {
      e[`${k}.phone`] = "Informe o telefone com DDD.";
    }
  }
  if (draft.buttons.length > LIMITS.buttonsTotal) e.buttons = `No máximo ${LIMITS.buttonsTotal} botões.`;
  else if (counts.URL > LIMITS.perType.URL) e.buttons = "No máximo 2 botões de link.";
  else if (counts.PHONE_NUMBER > LIMITS.perType.PHONE_NUMBER) e.buttons = "No máximo 1 botão de ligar.";

  return e;
}

/** Mídia do cabeçalho só vale se for do tipo escolhido (trocar Imagem → Vídeo não reaproveita o JPEG). */
export function headerMediaFor(draft: TemplateDraft): TemplateHeaderMedia | null {
  const m = draft.headerMedia;
  return m?.link && m.format === draft.headerType ? m : null;
}

/** Botões na ordem em que vão para a Meta (e aparecem na prévia e no formulário). */
export function orderedButtons(draft: Pick<TemplateDraft, "buttons" | "quickRepliesFirst">): DraftButton[] {
  const quick = draft.buttons.filter((b) => b.type === "QUICK_REPLY");
  const actions = draft.buttons.filter((b) => b.type !== "QUICK_REPLY");
  return draft.quickRepliesFirst ? [...quick, ...actions] : [...actions, ...quick];
}

export function canAddButton(buttons: DraftButton[], type: ButtonKind): boolean {
  if (buttons.length >= LIMITS.buttonsTotal) return false;
  return buttons.filter((b) => b.type === type).length < LIMITS.perType[type];
}

export function guessHeaderMime(media: TemplateHeaderMedia | null): string | undefined {
  if (!media?.link) return undefined;
  const lower = media.link.toLowerCase().split("?")[0];
  if (media.format === "IMAGE") return lower.endsWith(".png") ? "image/png" : "image/jpeg";
  if (media.format === "VIDEO") return /\.3gpp?$/.test(lower) ? "video/3gpp" : "video/mp4";
  return "application/pdf";
}

export interface TemplateRequestButton {
  type: ButtonKind;
  text: string;
  url?: string;
  /** URL completa de exemplo, só para link dinâmico. */
  example?: string;
  phone_number?: string;
}

/** Corpo comum de whatsapp-create-template / whatsapp-edit-template. */
export function toTemplateRequest(draft: TemplateDraft) {
  const media = draft.headerType !== "NONE" && draft.headerType !== "TEXT" ? headerMediaFor(draft) : null;
  const vars = extractVariables(draft.body);
  // A Meta exige respostas rápidas juntas, antes ou depois dos botões de ação.
  const buttons: TemplateRequestButton[] = orderedButtons(draft).map((b) => {
    const text = b.text.trim();
    if (b.type === "URL") {
      const url = b.url.trim();
      return isDynamicUrl(url)
        ? { type: "URL", text, url, example: url.replace(URL_DYNAMIC_RE, b.urlExample.trim()) }
        : { type: "URL", text, url };
    }
    if (b.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text, phone_number: `+${b.phone.replace(/\D/g, "")}` };
    return { type: "QUICK_REPLY", text };
  });
  return {
    name: draft.name,
    category: draft.category,
    language: draft.language,
    headerFormat: draft.headerType === "NONE" ? undefined : draft.headerType,
    headerText: draft.headerType === "TEXT" ? draft.headerText.trim() : undefined,
    headerSampleUrl: media?.link,
    headerSampleMimeType: guessHeaderMime(media),
    bodyText: draft.body.trim(),
    examples: vars.length ? vars.map((n) => (draft.examples[String(n)] ?? "").trim()) : undefined,
    footerText: draft.footer.trim() || undefined,
    buttons: buttons.length ? buttons : undefined,
  };
}

interface MetaComponent {
  type?: string;
  format?: string;
  text?: string;
  example?: { body_text?: string[][]; header_handle?: string[] };
  buttons?: Array<{ type?: string; text?: string; url?: string; phone_number?: string; example?: string[] }>;
}

const EDITABLE_BUTTONS = new Set(["QUICK_REPLY", "URL", "PHONE_NUMBER"]);
const BUTTON_LABEL: Record<string, string> = {
  COPY_CODE: "copiar código",
  FLOW: "formulário (Flow)",
  OTP: "código de verificação",
  CATALOG: "catálogo",
  MPM: "produtos",
  VOICE_CALL: "ligação pelo WhatsApp",
};

/**
 * Motivo para não editar no Echo, ou null. Salvar reenvia todos os components,
 * então um botão que o builder não conhece seria apagado do template.
 */
export function editBlockedReason(t: { category?: string; components?: MetaComponent[] }): string | null {
  if (t.category === "AUTHENTICATION") return "Template de autenticação só se edita no Gerenciador do WhatsApp da Meta.";
  const header = t.components?.find((c) => c.type === "HEADER");
  if (header?.format?.toUpperCase() === "LOCATION") {
    return "Este template tem cabeçalho de localização, que o Echo não edita. Edite no Gerenciador do WhatsApp da Meta.";
  }
  if (header?.format?.toUpperCase() === "TEXT" && hasVariable(header.text ?? "")) {
    return "Este template tem variável no cabeçalho, que o Echo não edita. Edite no Gerenciador do WhatsApp da Meta.";
  }
  if (hasMalformedVariable(t.components?.find((c) => c.type === "BODY")?.text ?? "")) {
    return "Este template usa variável com nome ({{nome}}), que o Echo não edita. Edite no Gerenciador do WhatsApp da Meta.";
  }
  const btns = t.components?.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  if (btns.filter((b) => b.type === "URL" && isDynamicUrl(b.url ?? "")).length > 1) {
    return "Este template tem dois links com parte variável, que o Echo não edita. Edite no Gerenciador do WhatsApp da Meta.";
  }
  const other = btns.find((b) => !EDITABLE_BUTTONS.has(b.type ?? ""));
  if (other) {
    const label = BUTTON_LABEL[other.type ?? ""] ?? (other.type ?? "").toLowerCase();
    return `Este template tem botão de ${label}, que o Echo não edita. Edite no Gerenciador do WhatsApp da Meta.`;
  }
  return null;
}

/** Rascunho a partir de um template da Meta (para editar). */
export function draftFromTemplate(t: {
  name: string;
  category?: string;
  language: string;
  components?: MetaComponent[];
}): TemplateDraft {
  const comps = t.components ?? [];
  const header = comps.find((c) => c.type === "HEADER");
  const body = comps.find((c) => c.type === "BODY");
  const footer = comps.find((c) => c.type === "FOOTER");
  const btns = comps.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  const fmt = header?.format?.toUpperCase();
  const headerType: HeaderKind =
    fmt === "TEXT" || fmt === "IMAGE" || fmt === "VIDEO" || fmt === "DOCUMENT" ? fmt : "NONE";
  const sample = body?.example?.body_text?.[0] ?? [];
  const examples: Record<string, string> = {};
  extractVariables(body?.text ?? "").forEach((n, i) => {
    if (sample[i]) examples[String(n)] = sample[i];
  });
  return {
    name: t.name,
    category: t.category === "MARKETING" ? "MARKETING" : "UTILITY",
    language: t.language,
    headerType,
    headerText: headerType === "TEXT" ? header?.text ?? "" : "",
    // A Meta devolve a URL do exemplo em header_handle: a edge baixa e reenvia,
    // sem obrigar a subir o arquivo de novo para trocar uma palavra.
    headerMedia:
      (headerType === "IMAGE" || headerType === "VIDEO" || headerType === "DOCUMENT") && header?.example?.header_handle?.[0]
        ? { format: headerType, link: header.example.header_handle[0] }
        : null,
    body: body?.text ?? "",
    examples,
    footer: footer?.text ?? "",
    quickRepliesFirst: btns[0]?.type === "QUICK_REPLY",
    buttons: btns
      .filter((b) => b.type === "QUICK_REPLY" || b.type === "URL" || b.type === "PHONE_NUMBER")
      .map((b) => {
        const nb = newButton(b.type as ButtonKind);
        const url = b.url ?? "";
        const ex = b.example?.[0] ?? "";
        const prefix = url.replace(URL_DYNAMIC_RE, "");
        return {
          ...nb,
          text: b.text ?? "",
          url,
          urlExample: isDynamicUrl(url) && ex.startsWith(prefix) ? ex.slice(prefix.length) : "",
          phone: (b.phone_number ?? "").replace(/\D/g, ""),
        };
      }),
  };
}

/** Troca TODAS as ocorrências de cada {{n}} pelo parâmetro n (variável repetida aparece duas vezes). */
export function fillVariables(text: string, params: string[], fallback: (n: number) => string = (n) => `{{${n}}}`): string {
  return text.replace(VAR_RE, (_, n: string) => params[Number(n) - 1] || fallback(Number(n)));
}

/** Trecho em volta da variável, para o atendente saber o que vai ali: "Olá ___, sua reserva". */
export function variableContext(text: string, n: number, words = 3): string | null {
  const token = `{{${n}}}`;
  const idx = text.indexOf(token);
  if (idx < 0) return null;
  const strip = (s: string) => s.replace(VAR_RE, "…").replace(/\s+/g, " ");
  const before = strip(text.slice(0, idx)).trim().split(" ").slice(-words).join(" ");
  const after = strip(text.slice(idx + token.length)).trim().split(" ").slice(0, words).join(" ");
  return `${before} ___ ${after}`.trim();
}

/**
 * O que um envio já pronto depende do template: número de variáveis, link dinâmico
 * e formato do cabeçalho. Mudar isso num template aprovado quebra agendamentos,
 * disparos e integrações que guardaram os parâmetros.
 */
export function templateSignature(draft: TemplateDraft): string {
  const dyn = orderedButtons(draft).map((b, i) => (b.type === "URL" && isDynamicUrl(b.url) ? i : -1)).filter((i) => i >= 0);
  return JSON.stringify({ vars: extractVariables(draft.body).length, dyn, header: draft.headerType });
}

// *x* ou ~x~ colado no fim de uma palavra ("teste*negrito*"): o WhatsApp não formata.
// O _ fica de fora porque aparece colado em link (minha_reserva) sem ser formatação.
const GLUED_FORMAT_RE = /([\p{L}\p{N}])([*~])(?=[^\s*~](?:[^\n]*?[^\s*~])?\2(?![\p{L}\p{N}]))/gu;

/** Marcador de formatação colado na palavra anterior, que o WhatsApp mostra como texto puro. */
export function hasGluedFormatting(text: string): boolean {
  GLUED_FORMAT_RE.lastIndex = 0;
  return GLUED_FORMAT_RE.test(text);
}

/** Separa o marcador da palavra anterior com um espaço ("teste*a*" → "teste *a*"). */
export function separateGluedFormatting(text: string): string {
  return text.replace(GLUED_FORMAT_RE, "$1 $2");
}

/** Texto da mensagem com os exemplos no lugar das variáveis (para a prévia). */
export function fillExamples(text: string, examples: Record<string, string>): string {
  return text.replace(VAR_RE, (whole, n: string) => examples[n]?.trim() || whole);
}
