import { describe, expect, it } from "vitest";
import { alvoDeContato, conversaDoId } from "./conversaCarregada";

const contato = { id: "A", contact_phone: "5511999990000" };
const grupo = { id: "G", contact_phone: "120363@g.us", is_group: true, group_jid: "120363@g.us" };
const direct = { id: "D", contact_phone: "ig:123", channel: "instagram" as const };

describe("conversaDoId", () => {
  it("devolve a conversa só se for a do id aberto", () => {
    expect(conversaDoId(contato, "A")).toBe(contato);
    expect(conversaDoId(contato, "B")).toBeNull();
    expect(conversaDoId(contato, null)).toBeNull();
    expect(conversaDoId(null, "A")).toBeNull();
  });
});

describe("alvoDeContato", () => {
  it("1:1 aberta: o telefone do contato", () => {
    expect(alvoDeContato(contato, "A")).toEqual({ contactPhone: "5511999990000", isGroup: false, groupJid: undefined });
  });

  it("grupo aberto: o JID, para presença e participantes", () => {
    expect(alvoDeContato(grupo, "G")).toEqual({ contactPhone: "120363@g.us", isGroup: true, groupJid: "120363@g.us" });
  });

  it("troca A -> B: com a conversa A ainda carregada, o alvo é vazio (nada de presença da A no número da B)", () => {
    const alvo = alvoDeContato(contato, "B");
    expect(alvo.contactPhone).toBeUndefined();
    expect(alvo.groupJid).toBeUndefined();
    expect(alvo.isGroup).toBe(false);
  });

  it("troca de um grupo para outra conversa não vaza o grupo anterior", () => {
    expect(alvoDeContato(grupo, "A")).toEqual({ contactPhone: undefined, isGroup: false, groupJid: undefined });
  });

  it("Direct do Instagram nunca vira alvo: ig:<id> não é telefone", () => {
    expect(alvoDeContato(direct, "D").contactPhone).toBeUndefined();
  });

  it("sem conversa carregada, sem alvo", () => {
    expect(alvoDeContato(null, "A").contactPhone).toBeUndefined();
  });
});
