import { describe, expect, it } from "vitest";
import { camposDoApelido, nomeNoWhatsAppSeApelido, rotuloEditarNome, ultimaTrocaDeNome } from "./nomeDoGrupo";

describe("nomeNoWhatsAppSeApelido", () => {
  it("grupo com apelido: devolve o nome do WhatsApp", () => {
    expect(nomeNoWhatsAppSeApelido({ is_group: true, contact_name: "Atendimento X", group_subject: "Equipe Projeto X" })).toBe(
      "Equipe Projeto X"
    );
  });

  it("grupo sem apelido, grupo antigo sem a coluna ou conversa individual: null", () => {
    expect(nomeNoWhatsAppSeApelido({ is_group: true, contact_name: "Equipe Projeto X", group_subject: "Equipe Projeto X" })).toBeNull();
    expect(nomeNoWhatsAppSeApelido({ is_group: true, contact_name: "Equipe Projeto X", group_subject: null })).toBeNull();
    expect(nomeNoWhatsAppSeApelido({ is_group: false, contact_name: "Ana", group_subject: "x" })).toBeNull();
    expect(nomeNoWhatsAppSeApelido({ is_group: true, contact_name: "Equipe Projeto Y ", group_subject: "Equipe Projeto Y" })).toBeNull();
  });
});

describe("camposDoApelido", () => {
  it("grupo sem group_subject: guarda o nome atual como nome no WhatsApp", () => {
    expect(camposDoApelido({ is_group: true, group_jid: "1@g.us", contact_name: "Equipe Projeto X", group_subject: null }, " Apelido X ")).toEqual({
      contact_name: "Apelido X",
      group_subject: "Equipe Projeto X",
    });
  });

  it("grupo sem group_jid (importado) ou com o JID como nome: não inventa nome no WhatsApp", () => {
    expect(camposDoApelido({ is_group: true, group_jid: null, contact_name: "Grupo importado", group_subject: null }, "Apelido X")).toEqual({
      contact_name: "Apelido X",
    });
    expect(camposDoApelido({ is_group: true, group_jid: "120363@g.us", contact_name: "120363", group_subject: null }, "Apelido X")).toEqual({
      contact_name: "Apelido X",
    });
  });

  it("grupo com group_subject ou conversa individual: só o nome exibido", () => {
    expect(camposDoApelido({ is_group: true, contact_name: "X", group_subject: "Ana" }, "Apelido X")).toEqual({ contact_name: "Apelido X" });
    expect(camposDoApelido({ is_group: false, contact_name: "Ana", group_subject: null }, "Ana Paula")).toEqual({
      contact_name: "Ana Paula",
    });
  });
});

describe("rotuloEditarNome", () => {
  it("apelido no grupo, nome no 1:1", () => {
    expect(rotuloEditarNome({ is_group: true })).toBe("Editar apelido");
    expect(rotuloEditarNome({ is_group: false })).toBe("Editar nome");
  });
});

describe("ultimaTrocaDeNome", () => {
  const texto = (id: string) => ({ id, message_type: "text", metadata: null });
  const troca = (id: string) => ({ id, message_type: "group_action", metadata: { groupAction: { action: "subject" } } });

  it("devolve a troca de nome mais recente", () => {
    expect(ultimaTrocaDeNome([texto("a"), troca("b"), texto("c"), troca("d"), texto("e")])).toBe("d");
  });

  it("outros eventos de grupo e lista sem troca: null", () => {
    const entrou = { id: "x", message_type: "group_action", metadata: { groupAction: { action: "join" } } };
    expect(ultimaTrocaDeNome([texto("a"), entrou])).toBeNull();
    expect(ultimaTrocaDeNome([])).toBeNull();
  });

  it("só olha o fim da lista", () => {
    expect(ultimaTrocaDeNome([troca("velha"), texto("a"), texto("b")], 2)).toBeNull();
  });
});
