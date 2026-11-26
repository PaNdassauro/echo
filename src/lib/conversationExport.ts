/**
 * Montagem da planilha de exportação de uma conversa.
 *
 * Camada pura de propósito: nada de rede e — importante — nada de `xlsx`. O
 * SheetJS tem ~900 KB e hoje só entra no chunk lazy de Broadcasts; importá-lo
 * aqui o arrastaria para o chunk do Dashboard, que é o caminho crítico do
 * inbox. Quem escreve o arquivo é `conversationExportClient.ts`, com
 * `await import("xlsx")`.
 */
import type { Database } from "@/integrations/supabase/types";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
type ConversationRow = Database["public"]["Tables"]["conversations"]["Row"];

/** Linha de `messages` + o autor embutido pela FK `messages_sent_by_fkey`. */
export type ExportMessage = Pick<
    MessageRow,
    | "created_at"
    | "direction"
    | "message_type"
    | "content"
    | "sender_name"
    | "sender_phone"
    | "sender_jid"
    | "status"
    | "read_at"
    | "is_deleted"
    | "is_edited"
    | "is_imported"
    | "reaction"
    | "our_reaction"
    | "media_filename"
    | "media_mime_type"
    | "media_url"
    | "error_message"
    | "whatsapp_message_id"
    | "sent_by"
> & {
    /** to-one; null quando `sent_by` é null OU quando a RLS de profiles nega. */
    profiles: { full_name: string | null } | null;
};

/** Cabeçalho da conversa + a linha (número) de onde ela veio. */
export type ExportConversation = Pick<
    ConversationRow,
    | "id"
    | "contact_name"
    | "contact_phone"
    | "is_group"
    | "group_jid"
    | "created_at"
    | "last_message_at"
    | "status"
> & { phone_numbers: { display_name: string; phone_number: string } | null };

/** Célula: string ou número. Nunca `undefined` — ver buildRow. */
type Cell = string | number;

export interface ConversationExportSheets {
    /** aoa da aba Resumo, já com o header ["Campo", "Valor"]. */
    summary: Cell[][];
    /** Aba Mensagens — chaves na ordem de MESSAGE_COLUMNS. */
    messages: Record<string, Cell>[];
    /** Aba Detalhes — mesma ordem de linhas, casada pela coluna "#". */
    details: Record<string, Cell>[];
    fileName: string;
}

/** Aba de leitura: o que se olha para reconstituir a conversa. */
export const MESSAGE_COLUMNS = [
    "#",
    "Data/hora",
    "Autor",
    "Sentido",
    "Mensagem",
    "Tipo",
    "Status",
    "Arquivo",
] as const;

export const MESSAGE_COL_WIDTHS = [5, 19, 26, 10, 90, 14, 12, 44] as const;

/** Aba técnica: recibos, flags e ids, para auditoria. */
export const DETAIL_COLUMNS = [
    "#",
    "Telefone do autor",
    "Lida em",
    "Reação",
    "Nossa reação",
    "Editada",
    "Apagada",
    "Importada",
    "Arquivo",
    "Tipo do arquivo",
    "URL do arquivo",
    "Erro",
    "ID WhatsApp",
] as const;

export const DETAIL_COL_WIDTHS = [5, 18, 19, 8, 13, 9, 9, 10, 24, 22, 44, 30, 34] as const;

const SUMMARY_HEADER: Cell[] = ["Campo", "Valor"];

/** Larguras da aba Resumo (rótulo curto, valor largo). */
export const SUMMARY_COL_WIDTHS = [22, 60] as const;

/**
 * O fuso é fixo de propósito: sem `timeZone` o `toLocaleString` seguiria o
 * relógio da máquina e a mesma conversa sairia com horários diferentes para
 * cada pessoa que exportasse.
 */
const EXPORT_TIME_ZONE = "America/Sao_Paulo";

export function formatExportDate(value: string | null | undefined): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("pt-BR", { timeZone: EXPORT_TIME_ZONE, hour12: false });
}

/** `direction` é `string` no schema, não enum — daí o fallback no valor cru. */
const DIRECTION_LABELS: Record<string, string> = {
    inbound: "Recebida",
    outbound: "Enviada",
};

/**
 * Quem escreveu a mensagem.
 *
 * Em grupo, mensagem importada sem pushName não tem autor identificável: cair
 * no `contact_name` renderia o nome do GRUPO como se fosse a pessoa. Em
 * outbound, `sent_by` nulo cobre eco do aparelho, automação e import — e
 * `profiles` nulo com `sent_by` preenchido é a RLS negando ler o colega.
 */
export function resolveMessageAuthor(
    message: ExportMessage,
    conversation: ExportConversation,
): string {
    if (message.direction === "inbound") {
        return (
            message.sender_name ||
            message.sender_phone ||
            message.sender_jid ||
            (conversation.is_group
                ? "(participante não identificado)"
                : conversation.contact_name || conversation.contact_phone)
        );
    }
    return message.profiles?.full_name || (message.sent_by ? "usuário" : "aparelho/automação");
}

/**
 * Slug para nome de arquivo. Sem `.` na allowlist: um contato chamado
 * "Maria..." não deve produzir uma extensão falsa.
 */
const slugify = (name: string): string =>
    name
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/, "")
        .toLowerCase();

export function exportFileName(conversation: ExportConversation, now: Date = new Date()): string {
    const slug = slugify(conversation.contact_name || conversation.contact_phone) || "sem-nome";
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `conversa-${slug}-${yyyy}-${mm}-${dd}.xlsx`;
}

/** Flag → "sim" ou vazio. Nunca "não": assim o autofilter isola só os marcados. */
const flag = (value: boolean | null | undefined): string => (value ? "sim" : "");

/**
 * Casa valores com cabeçalhos. Toda célula tem de existir e não ser
 * `undefined`: o `json_to_sheet` omitiria a chave e a coluna sairia
 * desalinhada em relação ao `!cols`.
 */
const buildRow = (columns: readonly string[], values: Cell[]): Record<string, Cell> =>
    Object.fromEntries(columns.map((column, i) => [column, values[i] ?? ""]));

export function buildConversationExport(
    conversation: ExportConversation,
    messages: ExportMessage[],
    now: Date = new Date(),
): ConversationExportSheets {
    const line = conversation.phone_numbers
        ? `${conversation.phone_numbers.display_name} (${conversation.phone_numbers.phone_number})`
        : "";

    const summary: Cell[][] = [
        SUMMARY_HEADER,
        ["Conversa", conversation.contact_name || ""],
        ["Telefone / JID", conversation.group_jid || conversation.contact_phone || ""],
        ["Grupo", conversation.is_group ? "sim" : "não"],
        ["Linha", line],
        ["Status", conversation.status || ""],
        ["Criada em", formatExportDate(conversation.created_at)],
        ["Última mensagem", formatExportDate(conversation.last_message_at)],
        ["Total de mensagens", messages.length],
        ["ID da conversa", conversation.id],
        ["Exportado em", formatExportDate(now.toISOString())],
    ];

    // O "#" é a chave que casa as duas abas de dados.
    const rows = messages.map((message, index) => {
        const number = index + 1;
        return {
            message: buildRow(MESSAGE_COLUMNS, [
                number,
                formatExportDate(message.created_at),
                resolveMessageAuthor(message, conversation),
                DIRECTION_LABELS[message.direction] ?? message.direction,
                // O xlsx grava como texto, então conteúdo começando com "="
                // não vira fórmula. Um dia trocar por CSV reabriria isso.
                message.content || "",
                message.message_type || "text",
                message.status || "",
                message.media_filename || message.media_url || "",
            ]),
            detail: buildRow(DETAIL_COLUMNS, [
                number,
                message.sender_phone || "",
                formatExportDate(message.read_at),
                message.reaction || "",
                message.our_reaction || "",
                flag(message.is_edited),
                flag(message.is_deleted),
                flag(message.is_imported),
                message.media_filename || "",
                message.media_mime_type || "",
                message.media_url || "",
                message.error_message || "",
                message.whatsapp_message_id || "",
            ]),
        };
    });

    return {
        summary,
        messages: rows.map((row) => row.message),
        details: rows.map((row) => row.detail),
        fileName: exportFileName(conversation, now),
    };
}
