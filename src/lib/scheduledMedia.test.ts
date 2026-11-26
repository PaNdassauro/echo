import { describe, expect, it } from "vitest";
import {
  MAX_SCHEDULED_FILE_BYTES,
  parseScheduledMedia,
  scheduledFilesProblem,
  sanitizeFilename,
  scheduledMediaPath,
  scheduledMediaSummary,
  unsentScheduledPaths,
} from "./scheduledMedia";

const item = (filename: string, extra: Record<string, unknown> = {}) => ({
  storage_path: `outbound/u/1_${filename}`,
  filename,
  mime_type: "application/pdf",
  size_bytes: 10,
  ...extra,
});

describe("scheduledMedia", () => {
  it("caminho na pasta do usuário, com índice e nome saneado", () => {
    expect(scheduledMediaPath("u-1", "Proposta São Paulo (1).pdf", 2, 1700)).toBe("outbound/u-1/1700_2_Proposta_Sao_Paulo_1_.pdf");
    expect(sanitizeFilename("ação  final.pdf")).toBe("acao_final.pdf");
  });

  it("resumo: nome, legenda e contagem", () => {
    expect(scheduledMediaSummary([item("a.pdf")])).toBe("a.pdf");
    expect(scheduledMediaSummary([item("a.pdf", { caption: " Proposta " })])).toBe("Proposta");
    expect(scheduledMediaSummary([item("a.pdf"), item("b.pdf")])).toBe("a.pdf + 1 arquivo");
    expect(scheduledMediaSummary([item("a.pdf"), item("b.pdf"), item("c.pdf")])).toBe("a.pdf + 2 arquivos");
    expect(scheduledMediaSummary([])).toBe("Arquivo");
  });

  it("parse tolera lixo e devolve lista vazia", () => {
    expect(parseScheduledMedia(null)).toEqual([]);
    expect(parseScheduledMedia([{ filename: "x" }])).toEqual([]);
    expect(parseScheduledMedia([item("a.pdf")])).toHaveLength(1);
  });

  it("cancelar apaga só o que não saiu", () => {
    expect(unsentScheduledPaths([item("a.pdf", { whatsapp_message_id: "W1" }), item("b.pdf")])).toEqual(["outbound/u/1_b.pdf"]);
  });

  it("tetos conferidos na hora de agendar", () => {
    expect(scheduledFilesProblem([{ name: "a.pdf", size: 10 }])).toBeNull();
    expect(scheduledFilesProblem([])).toBe("Escolha pelo menos um arquivo.");
    expect(scheduledFilesProblem([{ name: "v.mp4", size: MAX_SCHEDULED_FILE_BYTES + 1 }])).toBe("v.mp4 passa de 50 MB. Agende um arquivo menor.");
    expect(scheduledFilesProblem([{ name: "a.pdf", size: 1, caption: "x".repeat(4097) }])).toBe("A legenda de a.pdf passa de 4096 caracteres. Encurte a legenda.");
  });
});
