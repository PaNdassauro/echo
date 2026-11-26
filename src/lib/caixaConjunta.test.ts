import { describe, expect, it } from "vitest";
import {
  agruparPorNome,
  chaveDeNome,
  chaveEscopo,
  conjuntaDisponivel,
  corDoNumero,
  expandirSelecao,
  idsDaChave,
  listarNomes,
  numerosDaConjunta,
  numeroDeEnvio,
  opcoesAgrupadas,
} from "./caixaConjunta";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("chaveEscopo", () => {
  it("é a mesma para a mesma coleção de números, em qualquer ordem", () => {
    expect(chaveEscopo([B, A, C])).toBe(chaveEscopo([C, A, B]));
    expect(chaveEscopo([A, B])).toBe(`${A},${B}`);
  });

  it("não depende da identidade do array", () => {
    const um = [A, B];
    const outro = [...um];
    expect(chaveEscopo(um)).toBe(chaveEscopo(outro));
  });

  it("ignora repetição e id vazio", () => {
    expect(chaveEscopo([A, A, "", B])).toBe(`${A},${B}`);
  });

  it("escopo vazio tem chave vazia e um número só é o próprio id", () => {
    expect(chaveEscopo([])).toBe("");
    expect(chaveEscopo([A])).toBe(A);
  });

  it("não muta o array recebido", () => {
    const ids = [B, A];
    chaveEscopo(ids);
    expect(ids).toEqual([B, A]);
  });

  it("conjuntos diferentes têm chaves diferentes", () => {
    expect(chaveEscopo([A])).not.toBe(chaveEscopo([A, B]));
    expect(chaveEscopo([A, B])).not.toBe(chaveEscopo([A, C]));
  });
});

describe("idsDaChave", () => {
  it("volta da chave aos ids, em ordem", () => {
    expect(idsDaChave(chaveEscopo([B, A]))).toEqual([A, B]);
  });

  it("chave vazia é escopo vazio", () => {
    expect(idsDaChave("")).toEqual([]);
  });
});

describe("listarNomes", () => {
  it("monta a frase curta", () => {
    expect(listarNomes([])).toBe("");
    expect(listarNomes(["Comercial"])).toBe("Comercial");
    expect(listarNomes(["Comercial", "Suporte"])).toBe("Comercial e Suporte");
    expect(listarNomes(["A", "B", "C"])).toBe("A, B e C");
  });

  it("passando do máximo vira só a contagem", () => {
    expect(listarNomes(["A", "B", "C", "D"])).toBe("4 números");
    expect(listarNomes(["A", "B", "C", "D"], 5)).toBe("A, B, C e D");
  });
});

describe("agruparPorNome", () => {
  it("normaliza a chave: sem espaço nas pontas e sem diferença de caixa (pt-BR)", () => {
    expect(chaveDeNome("  VIP ")).toBe("vip");
    expect(chaveDeNome("Ação")).toBe(chaveDeNome("AÇÃO"));
    expect(chaveDeNome("Ação")).not.toBe(chaveDeNome("Acao"));
  });

  it("junta os de mesmo nome, na ordem em que apareceram, e o primeiro dá o nome", () => {
    const itens = [
      { id: "1", name: "Vip" },
      { id: "2", name: "Pagou" },
      { id: "3", name: " vip " },
    ];
    const grupos = agruparPorNome(itens, (item) => item.name);
    expect(grupos.map((g) => g.chave)).toEqual(["vip", "pagou"]);
    expect(grupos[0].nome).toBe("Vip");
    expect(grupos[0].itens.map((i) => i.id)).toEqual(["1", "3"]);
  });
});

describe("opcoesAgrupadas e expandirSelecao", () => {
  const tags = [
    { id: "t-a-vip", name: "Vip", color: "red", phone_number_id: A },
    { id: "t-a-pago", name: "Pago", color: "blue", phone_number_id: A },
    { id: "t-b-vip", name: "vip", color: "green", phone_number_id: B },
  ];
  const leitor = { nome: (t: (typeof tags)[number]) => t.name, cor: (t: (typeof tags)[number]) => t.color };

  it("um número só: uma opção por item, com o id dele (como sempre foi)", () => {
    const opcoes = opcoesAgrupadas(tags.filter((t) => t.phone_number_id === A), leitor, false);
    expect(opcoes.map((o) => o.id)).toEqual(["t-a-vip", "t-a-pago"]);
    expect(expandirSelecao(["t-a-pago"], opcoes)).toEqual(["t-a-pago"]);
  });

  it("vários números: uma opção por nome, com a cor do primeiro, e marcar uma casa todos os ids do grupo", () => {
    const opcoes = opcoesAgrupadas(tags, leitor, true);
    expect(opcoes.map((o) => [o.id, o.label, o.color])).toEqual([
      ["vip", "Vip", "red"],
      ["pago", "Pago", "blue"],
    ]);
    expect(expandirSelecao(["vip"], opcoes).sort()).toEqual(["t-a-vip", "t-b-vip"]);
    expect(expandirSelecao(["vip", "pago"], opcoes).sort()).toEqual(["t-a-pago", "t-a-vip", "t-b-vip"]);
  });

  it("o mesmo item repetido (setor legado de vários números) entra uma vez", () => {
    const setor = { id: "s1", name: "Vendas", color: "x" };
    const opcoes = opcoesAgrupadas([setor, setor], { nome: (s) => s.name }, true);
    expect(opcoes).toHaveLength(1);
    expect(opcoes[0].ids).toEqual(["s1"]);
  });

  it("id marcado que não é de nenhuma opção passa como veio (a sentinela de 'sem setor')", () => {
    expect(expandirSelecao(["__no_sector__"], [])).toEqual(["__no_sector__"]);
    expect(expandirSelecao([], opcoesAgrupadas(tags, leitor, true))).toEqual([]);
  });
});

describe("numerosDaConjunta e conjuntaDisponivel", () => {
  it("são os acessíveis menos os excluídos, na ordem dos acessíveis", () => {
    expect(numerosDaConjunta([C, A, B], [A])).toEqual([C, B]);
  });

  it("sem exclusões entram todos; exclusão de número que não é acessível não faz nada", () => {
    expect(numerosDaConjunta([A, B], [])).toEqual([A, B]);
    expect(numerosDaConjunta([A, B], [C])).toEqual([A, B]);
  });

  it("não repete número nem aceita id vazio", () => {
    expect(numerosDaConjunta([A, A, "", B], [])).toEqual([A, B]);
  });

  it("número novo liberado entra sozinho (guardamos exclusões, não marcados)", () => {
    const fora = [B];
    expect(numerosDaConjunta([A, B], fora)).toEqual([A]);
    expect(numerosDaConjunta([A, B, C], fora)).toEqual([A, C]);
  });

  it("só está disponível com 2 ou mais números DEPOIS das exclusões", () => {
    expect(conjuntaDisponivel([A], [])).toBe(false);
    expect(conjuntaDisponivel([A, B], [])).toBe(true);
    expect(conjuntaDisponivel([A, B], [B])).toBe(false);
    expect(conjuntaDisponivel([A, B, C], [B])).toBe(true);
    expect(conjuntaDisponivel([], [])).toBe(false);
  });
});

describe("numeroDeEnvio", () => {
  const opcoes = [{ id: A }, { id: B }, { id: C }];

  it("a escolha do usuário vence", () => {
    expect(numeroDeEnvio(opcoes, C, B)?.id).toBe(C);
  });

  it("sem escolha vale o preferido (o número da conversa aberta)", () => {
    expect(numeroDeEnvio(opcoes, null, B)?.id).toBe(B);
  });

  it("preferido ou escolha fora das opções cai no primeiro", () => {
    expect(numeroDeEnvio(opcoes, "x", "y")?.id).toBe(A);
    expect(numeroDeEnvio(opcoes, null, undefined)?.id).toBe(A);
  });

  it("sem opções não há número", () => {
    expect(numeroDeEnvio([], A, B)).toBeNull();
  });
});

describe("cores dos números", () => {
  it("o ponto do selo usa L 55%, e número sem matiz pinta o teal da marca", () => {
    expect(corDoNumero(200)).toBe("hsl(200, 65%, 55%)");
    expect(corDoNumero(null)).toBe("hsl(176, 65%, 55%)");
  });
});
