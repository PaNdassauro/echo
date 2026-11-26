import { describe, expect, it } from "vitest";
import {
    buildConversationExport,
    DETAIL_COLUMNS,
    DETAIL_COL_WIDTHS,
    exportFileName,
    formatExportDate,
    MESSAGE_COLUMNS,
    MESSAGE_COL_WIDTHS,
    resolveMessageAuthor,
    type ExportConversation,
    type ExportMessage,
} from "./conversationExport";

const conv = (overrides: Partial<ExportConversation> = {}): ExportConversation => ({
    id: "conv-1",
    contact_name: "Márcia Souza",
    contact_phone: "5511999990001",
    is_group: false,
    group_jid: null,
    created_at: "2026-08-01T12:00:00Z",
    last_message_at: "2026-09-01T12:00:00Z",
    status: "active",
    phone_numbers: { display_name: "Comercial", phone_number: "5511999990004" },
    ...overrides,
});

const msg = (overrides: Partial<ExportMessage> = {}): ExportMessage => ({
    created_at: "2026-09-01T15:30:00Z",
    direction: "inbound",
    message_type: "text",
    content: "oi",
    sender_name: null,
    sender_phone: null,
    sender_jid: null,
    status: null,
    read_at: null,
    is_deleted: false,
    is_edited: false,
    is_imported: false,
    reaction: null,
    our_reaction: null,
    media_filename: null,
    media_mime_type: null,
    media_url: null,
    error_message: null,
    whatsapp_message_id: null,
    sent_by: null,
    profiles: null,
    ...overrides,
});

const NOW = new Date("2026-09-04T18:00:00Z");

describe("resolveMessageAuthor", () => {
    it("prefere pushName, depois telefone, depois jid", () => {
        const c = conv();
        expect(resolveMessageAuthor(msg({ sender_name: "Bruno", sender_phone: "351912345678" }), c))
            .toBe("Bruno");
        expect(resolveMessageAuthor(msg({ sender_phone: "351912345678" }), c))
            .toBe("351912345678");
        expect(resolveMessageAuthor(msg({ sender_jid: "12345@lid" }), c)).toBe("12345@lid");
    });

    it("em grupo sem remetente identificável NÃO usa o nome do grupo", () => {
        const grupo = conv({ contact_name: "Grupo Acme 01JAN30", is_group: true });
        const author = resolveMessageAuthor(msg(), grupo);
        expect(author).toBe("(participante não identificado)");
        expect(author).not.toBe(grupo.contact_name);
    });

    it("em 1:1 sem remetente cai no contato e, sem nome, no telefone", () => {
        expect(resolveMessageAuthor(msg(), conv())).toBe("Márcia Souza");
        expect(resolveMessageAuthor(msg(), conv({ contact_name: "" }))).toBe("5511999990001");
    });

    it("outbound usa o nome do perfil que enviou", () => {
        const author = resolveMessageAuthor(
            msg({ direction: "outbound", sent_by: "user-1", profiles: { full_name: "Carla" } }),
            conv(),
        );
        expect(author).toBe("Carla");
    });

    it("outbound com sent_by mas perfil ilegível (RLS) vira 'usuário'", () => {
        expect(resolveMessageAuthor(msg({ direction: "outbound", sent_by: "user-1" }), conv()))
            .toBe("usuário");
    });

    it("outbound sem sent_by é eco do aparelho/automação/import", () => {
        expect(resolveMessageAuthor(msg({ direction: "outbound" }), conv()))
            .toBe("aparelho/automação");
    });
});

describe("formatExportDate", () => {
    it("formata no fuso de São Paulo, não no da máquina", () => {
        // 15:30 UTC = 12:30 em -03. O assert pega qualquer remoção do timeZone.
        expect(formatExportDate("2026-09-01T15:30:00Z")).toBe("01/09/2026, 12:30:00");
    });

    it("devolve vazio para ausente ou inválido", () => {
        expect(formatExportDate(null)).toBe("");
        expect(formatExportDate(undefined)).toBe("");
        expect(formatExportDate("")).toBe("");
        expect(formatExportDate("nada disso")).toBe("");
    });
});

describe("exportFileName", () => {
    it("desacentua, troca pontuação por hífen e datia com o now injetado", () => {
        expect(exportFileName(conv(), NOW)).toBe("conversa-marcia-souza-2026-09-04.xlsx");
        expect(exportFileName(conv({ contact_name: "Grupo Acme / 01JAN30" }), NOW))
            .toBe("conversa-grupo-acme-01jan30-2026-09-04.xlsx");
    });

    it("nome sem nada aproveitável vira sem-nome", () => {
        expect(exportFileName(conv({ contact_name: "🎉🎉", contact_phone: "" }), NOW))
            .toBe("conversa-sem-nome-2026-09-04.xlsx");
    });

    it("trunca nome longo sem deixar hífen solto", () => {
        const name = exportFileName(conv({ contact_name: "a".repeat(200) }), NOW);
        expect(name).toBe(`conversa-${"a".repeat(60)}-2026-09-04.xlsx`);
        expect(name.endsWith(".xlsx")).toBe(true);
    });
});

describe("buildConversationExport", () => {
    const messages = [
        msg({ sender_name: "Bruno", status: "read", read_at: "2026-09-01T15:31:00Z" }),
        msg({
            direction: "outbound",
            created_at: "2026-09-01T16:00:00Z",
            content: "",
            message_type: "image",
            media_filename: "foto.jpg",
            media_mime_type: "image/jpeg",
            media_url: "https://storage/foto.jpg",
            is_edited: true,
        }),
        msg({ direction: "seila", created_at: "2026-09-01T17:00:00Z", is_deleted: true }),
    ];

    it("mantém as colunas e a ordem declaradas", () => {
        const sheets = buildConversationExport(conv(), messages, NOW);
        expect(Object.keys(sheets.messages[0])).toEqual([...MESSAGE_COLUMNS]);
        expect(Object.keys(sheets.details[0])).toEqual([...DETAIL_COLUMNS]);
        expect(MESSAGE_COL_WIDTHS).toHaveLength(MESSAGE_COLUMNS.length);
        expect(DETAIL_COL_WIDTHS).toHaveLength(DETAIL_COLUMNS.length);
    });

    it("numera as linhas em 1-based e casa as duas abas pelo #", () => {
        const sheets = buildConversationExport(conv(), messages, NOW);
        expect(sheets.messages.map((r) => r["#"])).toEqual([1, 2, 3]);
        expect(sheets.details.map((r) => r["#"])).toEqual([1, 2, 3]);
    });

    it("rotula o sentido e devolve o valor cru no que não conhece", () => {
        const sheets = buildConversationExport(conv(), messages, NOW);
        expect(sheets.messages.map((r) => r["Sentido"])).toEqual(["Recebida", "Enviada", "seila"]);
    });

    it("flags só marcam o que é verdadeiro (autofilter isola o 'sim')", () => {
        const sheets = buildConversationExport(conv(), messages, NOW);
        expect(sheets.details.map((r) => r["Editada"])).toEqual(["", "sim", ""]);
        expect(sheets.details.map((r) => r["Apagada"])).toEqual(["", "", "sim"]);
        expect(sheets.details.map((r) => r["Importada"])).toEqual(["", "", ""]);
    });

    it("nenhuma célula é undefined — senão a coluna desalinha no json_to_sheet", () => {
        const sheets = buildConversationExport(conv(), messages, NOW);
        for (const row of [...sheets.messages, ...sheets.details]) {
            expect(Object.values(row).every((v) => v !== undefined && v !== null)).toBe(true);
        }
    });

    it("mostra o arquivo pelo nome e, sem nome, pela URL", () => {
        const sheets = buildConversationExport(
            conv(),
            [messages[1], msg({ media_url: "https://storage/x.ogg" })],
            NOW,
        );
        expect(sheets.messages[0]["Arquivo"]).toBe("foto.jpg");
        expect(sheets.messages[1]["Arquivo"]).toBe("https://storage/x.ogg");
    });

    it("monta o resumo com o total como número e a linha formatada", () => {
        const sheets = buildConversationExport(conv(), messages, NOW);
        expect(sheets.summary[0]).toEqual(["Campo", "Valor"]);
        expect(sheets.summary).toContainEqual(["Total de mensagens", 3]);
        expect(sheets.summary).toContainEqual(["Linha", "Comercial (5511999990004)"]);
        expect(sheets.summary).toContainEqual(["Grupo", "não"]);
        expect(sheets.summary).toContainEqual(["Exportado em", "04/09/2026, 15:00:00"]);
    });

    it("em grupo, o JID substitui o telefone e a linha ausente sai vazia", () => {
        const sheets = buildConversationExport(
            conv({ is_group: true, group_jid: "1203@g.us", phone_numbers: null }),
            messages,
            NOW,
        );
        expect(sheets.summary).toContainEqual(["Telefone / JID", "1203@g.us"]);
        expect(sheets.summary).toContainEqual(["Linha", ""]);
        expect(sheets.summary).toContainEqual(["Grupo", "sim"]);
    });

    it("conversa sem mensagem ainda produz um resumo coerente", () => {
        const sheets = buildConversationExport(conv(), [], NOW);
        expect(sheets.messages).toEqual([]);
        expect(sheets.summary).toContainEqual(["Total de mensagens", 0]);
    });
});
