// Chamadas das edges de template (listar, criar, editar) com o payload da Meta validado.
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { checkEdgeFunctionResponseAsync } from "@/lib/utils";
import { extractErrorMessage, toUserMessage } from "@/lib/userFacingError";
import { headerMediaFor, toTemplateRequest, type TemplateDraft } from "@/lib/templateBuilder";
import type { TemplateHeaderMedia } from "@/lib/templateMedia";

const ButtonSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    url: z.string().optional(),
    phone_number: z.string().optional(),
    example: z.array(z.string()).optional(),
    flow_id: z.union([z.string(), z.number()]).transform(String).optional(),
    flow_action: z.string().optional(),
    navigate_screen: z.string().optional(),
  })
  .passthrough();

const ComponentSchema = z
  .object({
    type: z.string(),
    format: z.string().optional(),
    text: z.string().optional(),
    example: z
      .object({
        body_text: z.array(z.array(z.string())).optional(),
        header_text: z.array(z.string()).optional(),
        header_handle: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    buttons: z.array(ButtonSchema).optional(),
  })
  .passthrough();

export const MetaTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    language: z.string(),
    status: z.string(),
    category: z.string().default(""),
    components: z.array(ComponentSchema).default([]),
    rejected_reason: z.string().optional(),
  })
  .passthrough();

// Interface explícita: com strict: false o z.infer deixa todo campo opcional.
export interface MetaTemplateButton {
  type: string;
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string[];
  flow_id?: string;
  flow_action?: string;
  navigate_screen?: string;
}

export interface MetaTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  example?: { body_text?: string[][]; header_text?: string[]; header_handle?: string[] };
  buttons?: MetaTemplateButton[];
}

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: MetaTemplateComponent[];
  rejected_reason?: string;
}

const ListSchema = z.object({ data: z.array(z.unknown()).default([]) });

/** `name` filtra na Meta (contém): quem precisa do nome exato confere depois. */
export async function fetchOrgTemplates(organizationId: string, name?: string): Promise<MetaTemplate[]> {
  const result = await supabase.functions.invoke("whatsapp-templates", { body: { organizationId, name } });
  const raw = ListSchema.parse(await checkEdgeFunctionResponseAsync(result));
  // Um template fora do formato não derruba a lista inteira.
  return raw.data.flatMap((item) => {
    const parsed = MetaTemplateSchema.safeParse(item);
    if (!parsed.success) console.warn("[templates] item fora do formato", parsed.error.issues);
    return parsed.success ? [parsed.data as MetaTemplate] : [];
  });
}

const SaveResponseSchema = z
  .object({ template: z.object({ id: z.string().optional(), status: z.string().optional() }).passthrough().optional() })
  .passthrough();

export interface SavedTemplate {
  id?: string;
  name: string;
  language: string;
  /** Mídia de exemplo do cabeçalho (já no Storage): o disparo reaproveita no envio. */
  headerMedia: TemplateHeaderMedia | null;
  /** Status devolvido na hora pela Meta (APPROVED às vezes vem direto). */
  status?: string;
}

export async function saveTemplate(opts: {
  organizationId: string;
  draft: TemplateDraft;
  editing?: { id: string; category: string } | null;
}): Promise<SavedTemplate> {
  const req = toTemplateRequest(opts.draft);
  const result = opts.editing
    ? await supabase.functions.invoke("whatsapp-edit-template", {
        body: {
          ...req,
          // Nome e idioma não mudam; categoria só vai quando muda (recusa por categoria errada).
          name: undefined,
          language: undefined,
          category: req.category !== opts.editing.category ? req.category : undefined,
          organizationId: opts.organizationId,
          templateId: opts.editing.id,
        },
      })
    : await supabase.functions.invoke("whatsapp-create-template", {
        body: { ...req, organizationId: opts.organizationId },
      });
  const data = SaveResponseSchema.parse(await checkEdgeFunctionResponseAsync(result));
  return {
    id: data.template?.id ?? opts.editing?.id ?? undefined,
    name: opts.draft.name,
    language: opts.draft.language,
    headerMedia: headerMediaFor(opts.draft),
    status: data.template?.status ?? "PENDING",
  };
}

const META_ERRORS: Array<[RegExp, string]> = [
  [/already exists|already .*content|já existe/i, "Já existe um template com esse nome neste idioma. Troque o nome."],
  [/being deleted|deleted.*(4|four) weeks/i, "Esse nome foi apagado há pouco e a Meta bloqueia o reuso por 4 semanas. Use outro nome."],
  [/too many (variables|parameters)|parameters.*ratio/i, "Muitas variáveis para o tamanho do texto. Escreva mais texto em volta delas."],
  [/leading or trailing|start or end/i, "A mensagem não pode começar nem terminar com variável."],
  [/Meta App ID/i, "Cabeçalho com mídia precisa do App ID da Meta em Configurações > Integrações (peça a um admin). Ou use cabeçalho de texto."],
  [/no WhatsApp credentials|WhatsApp não configurado/i, "O WhatsApp oficial não está configurado nesta organização."],
  [/header sample|header_handle|resumable upload/i, "A Meta não aceitou o arquivo de exemplo do cabeçalho. Envie outro arquivo."],
  [/edit.*(limit|times)|can't be edited|cannot be edited/i, "A Meta limita edições: até 10 por mês e 1 por dia em template aprovado."],
];

/** A organização não conectou a Cloud API: não é falha, é o estado normal de uma instalação nova. */
export function isWhatsAppNotConfigured(error: unknown): boolean {
  return /no WhatsApp credentials|WhatsApp não configurado|credentials not configured/i.test(extractErrorMessage(error) ?? "");
}

/** Erro da Meta (inglês, técnico) em frase com próximo passo. */
export function templateErrorMessage(error: unknown, fallback: string): string {
  const raw = extractErrorMessage(error) ?? "";
  for (const [re, msg] of META_ERRORS) if (re.test(raw)) return msg;
  return toUserMessage(error, fallback);
}

const REJECTED_REASONS: Record<string, string> = {
  INVALID_FORMAT: "formato inválido (variável, botão ou exemplo fora da regra)",
  PROMOTIONAL: "conteúdo promocional numa categoria que não é Marketing",
  INCORRECT_CATEGORY: "categoria errada para o conteúdo",
  TAG_CONTENT_MISMATCH: "o conteúdo não bate com a categoria",
  ABUSIVE_CONTENT: "conteúdo considerado abusivo",
  SCAM: "conteúdo considerado golpe",
  CATEGORY_NOT_AVAILABLE: "categoria indisponível para esta conta",
};

/** Recusas que se resolvem trocando a categoria, não o texto. */
export const CATEGORY_REJECTIONS = new Set(["PROMOTIONAL", "INCORRECT_CATEGORY", "TAG_CONTENT_MISMATCH", "CATEGORY_NOT_AVAILABLE"]);

/** Exclui um idioma (hsm_id) ou, com `allLanguages`, todos os idiomas do nome. */
export async function deleteTemplate(opts: {
  organizationId: string;
  template: Pick<MetaTemplate, "id" | "name">;
  allLanguages?: boolean;
}): Promise<void> {
  const result = await supabase.functions.invoke("whatsapp-delete-template", {
    body: {
      organizationId: opts.organizationId,
      name: opts.template.name,
      templateId: opts.allLanguages ? undefined : opts.template.id,
    },
  });
  await checkEdgeFunctionResponseAsync(result);
}

/** Motivo da recusa da Meta em português, ou null quando não veio motivo. */
export function rejectedReasonLabel(reason: string | null | undefined): string | null {
  if (!reason || reason === "NONE") return null;
  return REJECTED_REASONS[reason] ?? reason.toLowerCase().replace(/_/g, " ");
}
