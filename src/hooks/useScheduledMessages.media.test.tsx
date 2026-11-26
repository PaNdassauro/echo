import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

/**
 * Agendar com arquivo: os arquivos sobem antes do INSERT e, se qualquer passo
 * falhar, o que subiu é apagado (nada fica órfão nem meio agendado). Cancelar
 * apaga só o que ainda não saiu: o que saiu numa tentativa anterior é a mídia
 * da bolha na conversa.
 */

afterEach(cleanup);

const h = vi.hoisted(() => ({
  uploads: [] as Array<{ path: string; contentType?: string }>,
  removidos: [] as string[][],
  inserts: [] as Array<Record<string, unknown>>,
  falharUploadNo: 0, // 1-based; 0 = nunca
  falharInsert: false,
  // Erro de rede no INSERT (sem code do Postgres) e se a linha entrou mesmo assim.
  insertSemCodigo: false,
  linhaExiste: false,
  cancelada: null as Record<string, unknown> | null,
  toasts: [] as Array<{ title: string; variant?: string }>,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (t: { title: string; variant?: string }) => h.toasts.push(t) }),
}));

vi.mock("@/integrations/supabase/client", () => {
  const consulta = () => {
    const c: Record<string, unknown> = {};
    let acao: "select" | "insert" | "update" = "select";
    let unica = false;
    c.select = () => c;
    c.maybeSingle = () => {
      unica = true;
      return c;
    };
    c.eq = () => c;
    c.order = () => c;
    c.insert = (row: Record<string, unknown>) => {
      acao = "insert";
      h.inserts.push(row);
      return c;
    };
    c.update = () => {
      acao = "update";
      return c;
    };
    c.then = (resolve: (v: unknown) => void) => {
      if (acao === "insert") {
        if (h.insertSemCodigo) return resolve({ data: null, error: { message: "TypeError: Failed to fetch", code: "" } });
        return resolve(h.falharInsert ? { data: null, error: { message: "boom", code: "23514" } } : { data: null, error: null });
      }
      if (unica) return resolve({ data: h.linhaExiste ? { id: "x" } : null, error: null });
      if (acao === "update") return resolve({ data: h.cancelada ? [h.cancelada] : [], error: null });
      return resolve({ data: [], error: null });
    };
    return c;
  };
  return {
    supabase: {
      from: consulta,
      auth: {
        getSession: () => Promise.resolve({ data: { session: { user: { id: "u-1" } } } }),
        getUser: () => Promise.resolve({ data: { user: { id: "u-1" } } }),
      },
      storage: {
        from: () => ({
          upload: (path: string, _file: File, opts?: { contentType?: string }) => {
            h.uploads.push({ path, contentType: opts?.contentType });
            const falha = h.uploads.length === h.falharUploadNo;
            return Promise.resolve(falha ? { data: null, error: { message: "Payload too large" } } : { data: { path }, error: null });
          },
          remove: (paths: string[]) => {
            h.removidos.push(paths);
            return Promise.resolve({ data: [], error: null });
          },
        }),
      },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel: () => Promise.resolve(),
    },
  };
});

import { useScheduledMessages } from "./useScheduledMessages";

const pdf = (nome: string) => new File(["%PDF"], nome, { type: "application/pdf" });

const entrada = (files: File[]) => ({
  conversationId: "conv-1",
  phoneNumberId: "phone-1",
  organizationId: "org-1",
  scheduledAt: new Date("2026-11-12T11:00:00.000Z"),
  contactPhone: "5511999990000",
  quotedMessageId: "q-1",
  files: files.map((file, i) => ({ file, caption: i === 0 ? "  Proposta enviada  " : undefined })),
});

beforeEach(() => {
  h.uploads = [];
  h.removidos = [];
  h.inserts = [];
  h.falharUploadNo = 0;
  h.falharInsert = false;
  h.insertSemCodigo = false;
  h.linhaExiste = false;
  h.cancelada = null;
  h.toasts = [];
});

describe("scheduleMediaMessage", () => {
  it("sobe os arquivos na pasta do usuário e grava um agendamento media, na ordem", async () => {
    const { result } = renderHook(() => useScheduledMessages({}));
    let r: { success: boolean } = { success: false };
    await act(async () => {
      r = await result.current.scheduleMediaMessage(entrada([pdf("Proposta.pdf"), pdf("Anexo.pdf")]));
    });
    expect(r.success).toBe(true);
    expect(h.uploads.map((u) => u.path)).toEqual([
      expect.stringMatching(/^outbound\/u-1\/\d+_0_Proposta\.pdf$/),
      expect.stringMatching(/^outbound\/u-1\/\d+_1_Anexo\.pdf$/),
    ]);
    expect(h.inserts).toHaveLength(1);
    const row = h.inserts[0];
    expect(row.message_type).toBe("media");
    expect(row.created_by).toBe("u-1");
    expect(row.quoted_message_id).toBe("q-1");
    expect(row.content).toBeUndefined();
    expect(row.media).toEqual([
      { storage_path: h.uploads[0].path, filename: "Proposta.pdf", mime_type: "application/pdf", size_bytes: 4, caption: "Proposta enviada" },
      { storage_path: h.uploads[1].path, filename: "Anexo.pdf", mime_type: "application/pdf", size_bytes: 4 },
    ]);
    expect(h.removidos).toEqual([]);
    expect(h.toasts.at(-1)?.title).toBe("2 arquivos agendados");
  });

  it("upload que falha no meio apaga o que já subiu e não agenda nada", async () => {
    h.falharUploadNo = 2;
    const { result } = renderHook(() => useScheduledMessages({}));
    let r: { success: boolean } = { success: true };
    await act(async () => {
      r = await result.current.scheduleMediaMessage(entrada([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]));
    });
    expect(r.success).toBe(false);
    expect(h.uploads).toHaveLength(2);
    expect(h.inserts).toHaveLength(0);
    expect(h.removidos).toEqual([[h.uploads[0].path]]);
    expect(h.toasts.at(-1)).toMatchObject({ title: "Não foi possível agendar os arquivos", variant: "destructive" });
  });

  it("INSERT recusado apaga todos os arquivos que subiram", async () => {
    h.falharInsert = true;
    const { result } = renderHook(() => useScheduledMessages({}));
    await act(async () => {
      await result.current.scheduleMediaMessage(entrada([pdf("a.pdf"), pdf("b.pdf")]));
    });
    expect(h.removidos).toEqual([h.uploads.map((u) => u.path)]);
  });
});

describe("scheduleMediaMessage: casos de borda", () => {
  it("erro de rede no INSERT com a linha criada: dá sucesso e NÃO apaga os arquivos", async () => {
    h.insertSemCodigo = true;
    h.linhaExiste = true;
    const { result } = renderHook(() => useScheduledMessages({}));
    let r: { success: boolean } = { success: false };
    await act(async () => {
      r = await result.current.scheduleMediaMessage(entrada([pdf("a.pdf")]));
    });
    expect(r.success).toBe(true);
    expect(h.removidos).toEqual([]);
    expect(typeof h.inserts[0].id).toBe("string");
  });

  it("erro de rede no INSERT sem a linha: apaga os arquivos", async () => {
    h.insertSemCodigo = true;
    const { result } = renderHook(() => useScheduledMessages({}));
    await act(async () => {
      await result.current.scheduleMediaMessage(entrada([pdf("a.pdf")]));
    });
    expect(h.removidos).toEqual([[h.uploads[0].path]]);
  });

  it("arquivo acima de 50 MB é recusado antes de subir", async () => {
    const grande = pdf("video.pdf");
    Object.defineProperty(grande, "size", { value: 60 * 1024 * 1024 });
    const { result } = renderHook(() => useScheduledMessages({}));
    let r: { success: boolean } = { success: true };
    await act(async () => {
      r = await result.current.scheduleMediaMessage(entrada([grande]));
    });
    expect(r.success).toBe(false);
    expect(h.uploads).toHaveLength(0);
    expect(h.toasts.at(-1)?.title).toBe("Não foi possível agendar os arquivos");
  });
});

describe("cancelScheduledMessage com arquivo", () => {
  it("apaga só os arquivos que ainda não saíram", async () => {
    h.cancelada = {
      id: "s-1",
      message_type: "media",
      media: [
        { storage_path: "outbound/u-1/1_0_a.pdf", filename: "a.pdf", mime_type: "application/pdf", size_bytes: 4, whatsapp_message_id: "W1" },
        { storage_path: "outbound/u-1/1_1_b.pdf", filename: "b.pdf", mime_type: "application/pdf", size_bytes: 4 },
      ],
    };
    const { result } = renderHook(() => useScheduledMessages({}));
    await act(async () => {
      await result.current.cancelScheduledMessage("s-1");
    });
    expect(h.removidos).toEqual([["outbound/u-1/1_1_b.pdf"]]);
  });

  it("agendamento de texto não mexe no Storage", async () => {
    h.cancelada = { id: "s-2", message_type: "text", media: null };
    const { result } = renderHook(() => useScheduledMessages({}));
    await act(async () => {
      await result.current.cancelScheduledMessage("s-2");
    });
    expect(h.removidos).toEqual([]);
  });
});
