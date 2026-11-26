import { describe, expect, it } from "vitest";
import { groupMediaRows, type MediaRow } from "./useConversationMediaLibrary";

const row = (over: Partial<MediaRow> & Pick<MediaRow, "id" | "message_type">): MediaRow => ({
    media_url: `https://bucket/${over.id}`,
    media_mime_type: null,
    media_filename: null,
    media_size_bytes: null,
    content: null,
    created_at: "2026-08-01T10:00:00Z",
    direction: "inbound",
    ...over,
});

describe("groupMediaRows", () => {
    it("joga audio E ptt no mesmo balde", () => {
        // O whatsapp-webhook grava 'audio' no recebido e o echo-api grava 'ptt'
        // no enviado: separar os dois esconderia metade dos áudios.
        const library = groupMediaRows([
            row({ id: "a", message_type: "audio" }),
            row({ id: "b", message_type: "ptt" }),
        ]);

        expect(library.audio.map((i) => i.id)).toEqual(["a", "b"]);
        expect(library.visual).toHaveLength(0);
        expect(library.docs).toHaveLength(0);
    });

    it("separa imagem/vídeo de documento", () => {
        const library = groupMediaRows([
            row({ id: "img", message_type: "image" }),
            row({ id: "vid", message_type: "video" }),
            row({ id: "doc", message_type: "document" }),
        ]);

        expect(library.visual.map((i) => i.id)).toEqual(["img", "vid"]);
        expect(library.docs.map((i) => i.id)).toEqual(["doc"]);
    });

    it("ignora sticker e tipos sem arquivo", () => {
        const library = groupMediaRows([
            row({ id: "s", message_type: "sticker" }),
            row({ id: "t", message_type: "text" }),
            row({ id: "r", message_type: "reaction" }),
        ]);

        expect(library.visual).toHaveLength(0);
        expect(library.docs).toHaveLength(0);
        expect(library.audio).toHaveLength(0);
    });

    it("descarta linha sem media_url em vez de vazar url nula pro lightbox", () => {
        const library = groupMediaRows([
            row({ id: "sem", message_type: "image", media_url: null }),
            row({ id: "com", message_type: "image" }),
        ]);

        expect(library.visual.map((i) => i.id)).toEqual(["com"]);
    });

    it("legenda placeholder vira null, legenda real é preservada", () => {
        const library = groupMediaRows([
            row({ id: "p", message_type: "image", content: "[Imagem]" }),
            row({ id: "r", message_type: "image", content: "olha isso" }),
        ]);

        expect(library.visual[0].caption).toBeNull();
        expect(library.visual[1].caption).toBe("olha isso");
    });

    it("preserva a ordem cronológica que a query entregou", () => {
        // O lightbox navega o array de visual como carrossel: reordenar aqui
        // trocaria o sentido das setas.
        const library = groupMediaRows([
            row({ id: "1", message_type: "image", created_at: "2026-01-01T00:00:00Z" }),
            row({ id: "2", message_type: "image", created_at: "2026-06-01T00:00:00Z" }),
            row({ id: "3", message_type: "image", created_at: "2026-12-01T00:00:00Z" }),
        ]);

        expect(library.visual.map((i) => i.id)).toEqual(["1", "2", "3"]);
    });

    it("normaliza direction desconhecida para inbound", () => {
        const library = groupMediaRows([
            row({ id: "o", message_type: "image", direction: "outbound" }),
            row({ id: "n", message_type: "image", direction: null }),
        ]);

        expect(library.visual[0].direction).toBe("outbound");
        expect(library.visual[1].direction).toBe("inbound");
    });

    it("carrega os metadados do documento que a linha de docs mostra", () => {
        const library = groupMediaRows([
            row({
                id: "d",
                message_type: "document",
                media_filename: "contrato.pdf",
                media_mime_type: "application/pdf",
                media_size_bytes: 2048,
            }),
        ]);

        expect(library.docs[0]).toMatchObject({
            filename: "contrato.pdf",
            mimeType: "application/pdf",
            sizeBytes: 2048,
        });
    });
});
