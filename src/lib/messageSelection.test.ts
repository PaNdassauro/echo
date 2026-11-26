import { describe, expect, it } from "vitest";
import {
    isForwardable,
    selectedInOrder,
    toggleSelection,
    MAX_SELECTED_MESSAGES,
} from "./messageSelection";
import type { Message } from "@/hooks/chat/useMessages";

const msg = (over: Partial<Message> = {}): Message => ({
    id: "m1",
    content: "oi",
    direction: "inbound",
    created_at: "2026-08-17T12:00:00.000Z",
    sent_by: null,
    ...over,
});

describe("isForwardable", () => {
    it("aceita texto simples", () => {
        expect(isForwardable(msg())).toBe(true);
        expect(isForwardable(msg({ message_type: "text" }))).toBe(true);
    });

    it("aceita mídia com URL e recusa mídia sem URL", () => {
        expect(isForwardable(msg({ message_type: "image", media_url: "https://cdn/x.jpg" }))).toBe(true);
        expect(isForwardable(msg({ message_type: "image", media_url: null }))).toBe(false);
        expect(isForwardable(msg({ message_type: "sticker" }))).toBe(false);
    });

    it("recusa apagada, em envio e com falha", () => {
        expect(isForwardable(msg({ is_deleted: true }))).toBe(false);
        expect(isForwardable(msg({ status: "sending" }))).toBe(false);
        expect(isForwardable(msg({ status: "error" }))).toBe(false);
        expect(isForwardable(msg({ status: "failed" }))).toBe(false);
    });

    it("recusa tipos não reproduzíveis em outro chat", () => {
        for (const type of ["contact", "list", "flow", "template", "group_action", "deleted"]) {
            expect(isForwardable(msg({ message_type: type }))).toBe(false);
        }
    });
});

describe("toggleSelection", () => {
    it("marca e desmarca", () => {
        const um = toggleSelection(new Set<string>(), "a");
        expect([...um]).toEqual(["a"]);
        expect([...toggleSelection(um, "a")]).toEqual([]);
    });

    it("não passa do teto", () => {
        let selected = new Set<string>();
        for (let i = 0; i < MAX_SELECTED_MESSAGES + 3; i++) {
            selected = toggleSelection(selected, `m${i}`);
        }
        expect(selected.size).toBe(MAX_SELECTED_MESSAGES);
    });

    it("devolve o MESMO Set quando o clique é ignorado pelo teto", () => {
        const cheio = new Set(Array.from({ length: MAX_SELECTED_MESSAGES }, (_, i) => `m${i}`));
        expect(toggleSelection(cheio, "novo")).toBe(cheio);
    });

    it("desmarcar continua funcionando no limite", () => {
        const cheio = new Set(Array.from({ length: MAX_SELECTED_MESSAGES }, (_, i) => `m${i}`));
        const next = toggleSelection(cheio, "m0");
        expect(next.has("m0")).toBe(false);
        expect(next.size).toBe(MAX_SELECTED_MESSAGES - 1);
    });

    it("não muta o Set de entrada", () => {
        const original = new Set(["a"]);
        toggleSelection(original, "b");
        expect([...original]).toEqual(["a"]);
    });
});

describe("selectedInOrder", () => {
    it("devolve na ordem da conversa, não na ordem do clique", () => {
        const messages = [msg({ id: "a" }), msg({ id: "b" }), msg({ id: "c" })];
        const selected = new Set(["c", "a"]);
        expect(selectedInOrder(messages, selected).map((m) => m.id)).toEqual(["a", "c"]);
    });

    it("ignora id selecionado que saiu da lista", () => {
        expect(selectedInOrder([msg({ id: "a" })], new Set(["a", "sumiu"])).map((m) => m.id)).toEqual(["a"]);
    });
});
