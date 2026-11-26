import { describe, expect, it } from "vitest";
import {
  draftFromTemplate,
  editBlockedReason,
  fillVariables,
  hasGluedFormatting,
  separateGluedFormatting,
  variableContext,
  emptyDraft,
  extractVariables,
  fillExamples,
  newButton,
  nextVariableNumber,
  renumberVariables,
  slugifyTemplateName,
  toTemplateRequest,
  validateDraft,
  type TemplateDraft,
} from "./templateBuilder";

const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  ...emptyDraft(),
  name: "boas_vindas",
  body: "Olá {{1}}, sua reserva {{2}} está confirmada.",
  examples: { "1": "Maria", "2": "R123" },
  ...over,
});

describe("slugifyTemplateName", () => {
  it("tira acento, espaço e pontuação", () => {
    expect(slugifyTemplateName("Confirmação de Reserva!")).toBe("confirmacao_de_reserva");
    expect(slugifyTemplateName("  2ª via -- boleto ")).toBe("2a_via_boleto");
  });
});

describe("variáveis", () => {
  it("extrai únicas e em ordem", () => {
    expect(extractVariables("{{2}} a {{1}} b {{2}}")).toEqual([1, 2]);
    expect(nextVariableNumber("a {{1}} b {{3}}")).toBe(4);
    expect(nextVariableNumber("sem")).toBe(1);
  });

  it("renumera pela ordem de aparição levando os exemplos", () => {
    const r = renumberVariables("Oi {{3}}, pedido {{1}} e {{3}}", { "3": "Ana", "1": "P9" });
    expect(r.text).toBe("Oi {{1}}, pedido {{2}} e {{1}}");
    expect(r.examples).toEqual({ "1": "Ana", "2": "P9" });
  });

  it("preenche a prévia com os exemplos", () => {
    expect(fillExamples("Oi {{1}} e {{2}}", { "1": "Ana" })).toBe("Oi Ana e {{2}}");
  });
});

describe("validateDraft", () => {
  it("rascunho bom passa", () => {
    expect(validateDraft(draft())).toEqual({});
  });

  it("nome obrigatório só na criação", () => {
    expect(validateDraft(draft({ name: "" })).name).toBeTruthy();
    expect(validateDraft(draft({ name: "" }), "edit").name).toBeUndefined();
  });

  it("recusa variável no começo ou no fim", () => {
    expect(validateDraft(draft({ body: "{{1}}, sua reserva está ok", examples: { "1": "x" } })).body).toMatch(/começar/);
    expect(validateDraft(draft({ body: "Sua reserva é {{1}}", examples: { "1": "x" } })).body).toMatch(/terminar/);
  });

  it("recusa variável fora de sequência", () => {
    expect(validateDraft(draft({ body: "Olá {{2}}, tudo bem com você?", examples: { "2": "x" } })).body).toMatch(/ordem/);
  });

  it("recusa muita variável para pouco texto", () => {
    expect(validateDraft(draft({ body: "Oi {{1}} {{2}} {{3}} ok", examples: { "1": "a", "2": "b", "3": "c" } })).body).toMatch(/Muitas/);
  });

  it("exige exemplo por variável", () => {
    expect(validateDraft(draft({ examples: { "1": "Maria" } }))["examples.2"]).toBeTruthy();
  });

  it("cabeçalho de texto sem variável e mídia exige arquivo", () => {
    expect(validateDraft(draft({ headerType: "TEXT", headerText: "Oi {{1}}" })).header).toMatch(/variável/);
    expect(validateDraft(draft({ headerType: "IMAGE" })).header).toBeTruthy();
  });

  it("botões: texto repetido, link e telefone", () => {
    const a = { ...newButton("QUICK_REPLY"), text: "Sim" };
    const b = { ...newButton("QUICK_REPLY"), text: "sim" };
    const u = { ...newButton("URL"), text: "Ver", url: "https://x.com/{{1}}" };
    const bad = { ...newButton("URL"), text: "Ir", url: "https://x.com/{{1}}/fim" };
    const p = { ...newButton("PHONE_NUMBER"), text: "Ligar", phone: "11" };
    const e = validateDraft(draft({ buttons: [a, b, u, bad, p] }));
    expect(e[`buttons.${b.key}.text`]).toMatch(/Já existe/);
    expect(e[`buttons.${u.key}.urlExample`]).toBeTruthy();
    expect(e[`buttons.${bad.key}.url`]).toMatch(/no fim/);
    expect(e[`buttons.${p.key}.phone`]).toBeTruthy();
  });
});

describe("toTemplateRequest", () => {
  it("agrupa respostas rápidas antes das ações e monta o exemplo da URL", () => {
    const u = { ...newButton("URL"), text: "Ver", url: "https://x.com/r/{{1}}", urlExample: "R123" };
    const q = { ...newButton("QUICK_REPLY"), text: "Sim" };
    const p = { ...newButton("PHONE_NUMBER"), text: "Ligar", phone: "5511999998888" };
    const req = toTemplateRequest(draft({ buttons: [u, q, p], quickRepliesFirst: true }));
    expect(req.buttons?.map((b) => b.type)).toEqual(["QUICK_REPLY", "URL", "PHONE_NUMBER"]);
    expect(req.buttons?.[1]).toMatchObject({ url: "https://x.com/r/{{1}}", example: "https://x.com/r/R123" });
    expect(req.buttons?.[2].phone_number).toBe("+5511999998888");
    expect(req.examples).toEqual(["Maria", "R123"]);
    expect(req.headerFormat).toBeUndefined();
  });
});

describe("draftFromTemplate", () => {
  it("reconstrói o rascunho, inclusive exemplos e final da URL", () => {
    const d = draftFromTemplate({
      name: "t",
      category: "MARKETING",
      language: "pt_BR",
      components: [
        { type: "HEADER", format: "TEXT", text: "Oi" },
        { type: "BODY", text: "Olá {{1}}, tudo bem?", example: { body_text: [["Ana"]] } },
        { type: "BUTTONS", buttons: [{ type: "URL", text: "Ver", url: "https://x.com/{{1}}", example: ["https://x.com/abc"] }] },
      ],
    });
    expect(d.category).toBe("MARKETING");
    expect(d.headerText).toBe("Oi");
    expect(d.examples).toEqual({ "1": "Ana" });
    expect(d.buttons[0].urlExample).toBe("abc");
  });
});

describe("ajustes das personas", () => {
  it("variável fora do formato, emoji no cabeçalho e mídia de outro tipo", () => {
    expect(validateDraft(draft({ body: "Olá {{nome}}, tudo bem com você?" })).body).toMatch(/formato/);
    expect(validateDraft(draft({ headerType: "TEXT", headerText: "Oi 🎉" })).header).toMatch(/emoji/);
    const img = { format: "IMAGE" as const, link: "https://x/a.jpg" };
    expect(validateDraft(draft({ headerType: "VIDEO", headerMedia: img })).header).toBeTruthy();
    expect(toTemplateRequest(draft({ headerType: "VIDEO", headerMedia: img })).headerSampleUrl).toBeUndefined();
  });

  it("só um link dinâmico", () => {
    const a = { ...newButton("URL"), text: "A", url: "https://x.com/{{1}}", urlExample: "1" };
    const b = { ...newButton("URL"), text: "B", url: "https://y.com/{{1}}", urlExample: "2" };
    expect(validateDraft(draft({ buttons: [a, b] }))[`buttons.${b.key}.url`]).toMatch(/Só um link/);
  });

  it("ordem dos botões segue a escolha e a densidade não trava edição", () => {
    const q = { ...newButton("QUICK_REPLY"), text: "Sim" };
    const u = { ...newButton("URL"), text: "Ver", url: "https://x.com" };
    expect(toTemplateRequest(draft({ buttons: [q, u] })).buttons?.map((b) => b.type)).toEqual(["URL", "QUICK_REPLY"]);
    expect(toTemplateRequest(draft({ buttons: [q, u], quickRepliesFirst: true })).buttons?.[0].type).toBe("QUICK_REPLY");
    const dense = draft({ body: "Oi {{1}} {{2}} {{3}} ok", examples: { "1": "a", "2": "b", "3": "c" } });
    expect(validateDraft(dense, "edit").body).toBeUndefined();
  });

  it("fillVariables troca todas as ocorrências e variableContext dá o trecho", () => {
    expect(fillVariables("{{1}} e {{1}} e {{2}}", ["A"], () => "?")).toBe("A e A e ?");
    expect(variableContext("Olá {{1}}, sua reserva {{2}} está ok", 1)).toBe("Olá ___ , sua reserva");
  });

  it("bloqueia edição com botão que o builder não conhece", () => {
    expect(editBlockedReason({ components: [{ type: "BUTTONS", buttons: [{ type: "FLOW", text: "x" }] }] })).toMatch(/formulário/);
    expect(editBlockedReason({ category: "UTILITY", components: [] })).toBeNull();
    expect(editBlockedReason({ components: [{ type: "HEADER", format: "TEXT", text: "Oi {{1}}" }] })).toMatch(/cabeçalho/);
    expect(editBlockedReason({ components: [{ type: "BODY", text: "Oi {{nome}}, tudo bem?" }] })).toMatch(/com nome/);
    const two = [{ type: "URL", text: "A", url: "https://a.com/{{1}}" }, { type: "URL", text: "B", url: "https://b.com/{{1}}" }];
    expect(editBlockedReason({ components: [{ type: "BUTTONS", buttons: two }] })).toMatch(/dois links/);
  });
});

describe("formatação colada", () => {
  it("detecta e separa * e ~ colados na palavra", () => {
    expect(hasGluedFormatting("teste2000*dsadas*")).toBe(true);
    expect(separateGluedFormatting("teste2000*dsadas* e oi~x~")).toBe("teste2000 *dsadas* e oi ~x~");
    expect(hasGluedFormatting("teste *ok* e 2 * 3 * 4")).toBe(false);
    expect(hasGluedFormatting("site.com/minha_reserva_vip")).toBe(false);
  });
});
