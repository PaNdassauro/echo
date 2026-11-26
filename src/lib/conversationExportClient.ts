import { supabase } from "@/integrations/supabase/client";
import { fetchAllPaginated } from "@/lib/fetchAllPaginated";
import {
    buildConversationExport,
    DETAIL_COLUMNS,
    DETAIL_COL_WIDTHS,
    MESSAGE_COLUMNS,
    MESSAGE_COL_WIDTHS,
    SUMMARY_COL_WIDTHS,
    type ExportConversation,
    type ExportMessage,
} from "@/lib/conversationExport";

/**
 * Exportação de uma conversa para .xlsx — o lado com rede.
 *
 * O `xlsx` é carregado por `await import` dentro da função, nunca no topo: são
 * ~900 KB que hoje só existem no chunk lazy de Broadcasts, e este módulo é
 * alcançado pela ConversationsList, que está no caminho crítico do inbox.
 */

/** Válvula de segurança contra query mal-especificada (não é um corte de UX). */
const MAX_EXPORT_ROWS = 100_000;

// Template literal em uma peça, sem concatenação: o supabase-js infere o tipo
// do retorno a partir do literal do select, e uma string montada com `+` faz a
// inferência degradar para GenericStringError.
const CONVERSATION_SELECT = `
    id, contact_name, contact_phone, is_group, group_jid, created_at, last_message_at, status,
    phone_numbers ( display_name, phone_number )
`;

/**
 * Colunas explícitas em vez de `*`: `metadata` e `flow_response_json` não
 * entram na planilha e num histórico longo custam banda de graça.
 */
const MESSAGE_SELECT = `
    created_at, direction, message_type, content, sender_name, sender_phone, sender_jid,
    status, read_at, is_deleted, is_edited, is_imported, reaction, our_reaction,
    media_filename, media_mime_type, media_url, error_message, whatsapp_message_id,
    sent_by, profiles:sent_by ( full_name )
`;

export interface ExportResult {
    messageCount: number;
    fileName: string;
}

/**
 * Falha esperada (conversa inexistente ou sem mensagem) — o caller usa isso
 * para escolher entre "nada para exportar" e um erro técnico genérico.
 */
export class ConversationExportError extends Error {
    constructor(
        message: string,
        readonly kind: "empty" | "not_found",
    ) {
        super(message);
        this.name = "ConversationExportError";
    }
}

async function fetchConversation(conversationId: string): Promise<ExportConversation> {
    const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .eq("id", conversationId)
        .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new ConversationExportError("Conversa não encontrada.", "not_found");
    return data;
}

/**
 * O PostgREST corta em 1000 linhas silenciosamente, então o histórico é
 * drenado por `.range()`. Tiebreaker por `id` é obrigatório: mensagens
 * importadas em lote compartilham o mesmo `created_at` e sem ele as páginas se
 * sobrepõem ou pulam registros.
 */
function fetchMessages(conversationId: string): Promise<ExportMessage[]> {
    return fetchAllPaginated<ExportMessage>(
        (from, to) =>
            supabase
                .from("messages")
                .select(MESSAGE_SELECT)
                .eq("conversation_id", conversationId)
                .order("created_at", { ascending: true })
                .order("id", { ascending: true })
                .range(from, to),
        { maxRows: MAX_EXPORT_ROWS },
    );
}

export async function exportConversationToXlsx(conversationId: string): Promise<ExportResult> {
    const [conversation, messages] = await Promise.all([
        fetchConversation(conversationId),
        fetchMessages(conversationId),
    ]);

    // Falha antes de gerar o arquivo: um .xlsx de zero linhas com autofilter
    // ainda faz o Excel reclamar, e não há nada para o usuário fazer com ele.
    if (messages.length === 0) {
        throw new ConversationExportError("Esta conversa não tem mensagens.", "empty");
    }

    const sheets = buildConversationExport(conversation, messages);
    const XLSX = await import("xlsx");

    const wb = XLSX.utils.book_new();

    const wsSummary = XLSX.utils.aoa_to_sheet(sheets.summary);
    wsSummary["!cols"] = SUMMARY_COL_WIDTHS.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, wsSummary, "Resumo");

    const wsMessages = XLSX.utils.json_to_sheet(sheets.messages, {
        header: [...MESSAGE_COLUMNS],
    });
    wsMessages["!cols"] = MESSAGE_COL_WIDTHS.map((wch) => ({ wch }));
    wsMessages["!autofilter"] = { ref: wsMessages["!ref"] as string };
    XLSX.utils.book_append_sheet(wb, wsMessages, "Mensagens");

    const wsDetails = XLSX.utils.json_to_sheet(sheets.details, {
        header: [...DETAIL_COLUMNS],
    });
    wsDetails["!cols"] = DETAIL_COL_WIDTHS.map((wch) => ({ wch }));
    wsDetails["!autofilter"] = { ref: wsDetails["!ref"] as string };
    XLSX.utils.book_append_sheet(wb, wsDetails, "Detalhes");

    // writeFile já dispara o download no browser (mesmo caminho do modelo de
    // disparo em BroadcastBuilder) — não precisa de Blob nem de <a download>.
    XLSX.writeFile(wb, sheets.fileName);

    return { messageCount: messages.length, fileName: sheets.fileName };
}
