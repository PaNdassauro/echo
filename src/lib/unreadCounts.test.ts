import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buscarContagemDaLinha,
  criarVooUnico,
  MAX_REINICIOS_FRESCOS,
  mesclarContagens,
  parseLinhasDeContagem,
  PRAZO_CONTAGEM_MS,
  respostaTruncada,
  type RespostaDeContagem,
} from "./unreadCounts";

const LINHA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINHA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINHA_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ok = (linha: string | null, ...pares: Array<[string, number | string]>): RespostaDeContagem => ({
  linha,
  rows: pares.map(([conversation_id, count]) => ({ conversation_id, count })),
  falhou: false,
});
const falha = (linha: string | null): RespostaDeContagem => ({ linha, rows: null, falhou: true });

const semIgnorar: ReadonlySet<string> = new Set();

describe("mesclarContagens", () => {
  it("junta as respostas dos números e converte o count (bigint pode vir como texto)", () => {
    const mesclado = mesclarContagens({
      respostas: [ok(LINHA_A, ["c1", 2], ["c2", "5"]), ok(LINHA_B, ["c3", 1])],
      anterior: new Map(),
      linhaDaConversa: () => undefined,
      ignorar: semIgnorar,
    });
    expect(mesclado).toEqual(
      new Map([
        ["c1", 2],
        ["c2", 5],
        ["c3", 1],
      ]),
    );
  });

  it("o que o número respondeu substitui o que havia: conversa lida some do mapa", () => {
    const mesclado = mesclarContagens({
      respostas: [ok(LINHA_A, ["c1", 1])],
      anterior: new Map([
        ["c1", 4],
        ["c2", 3],
      ]),
      linhaDaConversa: () => LINHA_A,
      ignorar: semIgnorar,
    });
    expect(mesclado).toEqual(new Map([["c1", 1]]));
  });

  it("o número que falhou mantém as entradas dele; o que respondeu não herda nada do passado", () => {
    const linhas = new Map([
      ["c1", LINHA_A],
      ["c2", LINHA_A],
      ["c3", LINHA_B],
      ["c4", LINHA_B],
    ]);
    const mesclado = mesclarContagens({
      respostas: [falha(LINHA_A), ok(LINHA_B, ["c3", 7])],
      anterior: new Map([
        ["c1", 2],
        ["c2", 1],
        ["c3", 5],
        ["c4", 9], // de B, que respondeu sem ela: ficou lida
      ]),
      linhaDaConversa: (id) => linhas.get(id),
      ignorar: semIgnorar,
    });
    expect(mesclado).toEqual(
      new Map([
        ["c3", 7],
        ["c1", 2],
        ["c2", 1],
      ]),
    );
  });

  it("entrada de conversa que a lista não conhece não é mantida (não dá para saber de quem é)", () => {
    const mesclado = mesclarContagens({
      respostas: [falha(LINHA_A), ok(LINHA_B)],
      anterior: new Map([["solta", 3]]),
      linhaDaConversa: () => undefined,
      ignorar: semIgnorar,
    });
    expect(mesclado).toEqual(new Map());
  });

  it("todos os números falharam → undefined (o mapa fica como está)", () => {
    expect(
      mesclarContagens({
        respostas: [falha(LINHA_A), falha(LINHA_B)],
        anterior: new Map([["c1", 1]]),
        linhaDaConversa: () => LINHA_A,
        ignorar: semIgnorar,
      }),
    ).toBeUndefined();
  });

  it("sem nenhuma resposta → undefined", () => {
    expect(
      mesclarContagens({ respostas: [], anterior: new Map(), linhaDaConversa: () => undefined, ignorar: semIgnorar }),
    ).toBeUndefined();
  });

  it("a consulta sem escopo (linha null) funciona como um número só", () => {
    expect(
      mesclarContagens({
        respostas: [ok(null, ["c1", 3])],
        anterior: new Map(),
        linhaDaConversa: () => undefined,
        ignorar: semIgnorar,
      }),
    ).toEqual(new Map([["c1", 3]]));
    expect(
      mesclarContagens({
        respostas: [falha(null)],
        anterior: new Map([["c1", 3]]),
        linhaDaConversa: () => LINHA_A,
        ignorar: semIgnorar,
      }),
    ).toBeUndefined();
  });

  it("conversa com leitura em voo fica de fora, venha de onde vier", () => {
    const mesclado = mesclarContagens({
      respostas: [ok(LINHA_A, ["c1", 2], ["c2", 1]), falha(LINHA_B)],
      anterior: new Map([["c3", 4]]),
      linhaDaConversa: () => LINHA_B,
      ignorar: new Set(["c1", "c3"]),
    });
    expect(mesclado).toEqual(new Map([["c2", 1]]));
  });

  it("conversa que mudou de número e veio na resposta de quem respondeu fica com o valor novo", () => {
    const mesclado = mesclarContagens({
      respostas: [falha(LINHA_A), ok(LINHA_B, ["c1", 1])],
      anterior: new Map([["c1", 6]]),
      linhaDaConversa: () => LINHA_A, // a lista ainda a tem no número antigo
      ignorar: semIgnorar,
    });
    expect(mesclado?.get("c1")).toBe(1);
  });

  it("falhas de dois números mantêm as entradas dos dois", () => {
    const linhas = new Map([
      ["c1", LINHA_A],
      ["c2", LINHA_B],
      ["c3", LINHA_C],
    ]);
    const mesclado = mesclarContagens({
      respostas: [falha(LINHA_A), falha(LINHA_B), ok(LINHA_C, ["c3", 2])],
      anterior: new Map([
        ["c1", 1],
        ["c2", 2],
      ]),
      linhaDaConversa: (id) => linhas.get(id),
      ignorar: semIgnorar,
    });
    expect(mesclado).toEqual(
      new Map([
        ["c3", 2],
        ["c1", 1],
        ["c2", 2],
      ]),
    );
  });

  it("não muta o mapa anterior", () => {
    const anterior = new Map([["c1", 1]]);
    mesclarContagens({
      respostas: [ok(LINHA_A, ["c9", 1])],
      anterior,
      linhaDaConversa: () => LINHA_A,
      ignorar: semIgnorar,
    });
    expect(anterior).toEqual(new Map([["c1", 1]]));
  });
});

describe("respostaTruncada", () => {
  it("o total antes do corte maior que o que veio denuncia a truncagem", () => {
    expect(
      respostaTruncada([
        { conversation_id: "c1", count: 1, total_conversations: 1500 },
        { conversation_id: "c2", count: 1, total_conversations: 1500 },
      ]),
    ).toEqual({ recebidas: 2, total: 1500 });
  });

  it("total igual ao que veio, ou resposta vazia, não é truncagem", () => {
    expect(respostaTruncada([{ conversation_id: "c1", count: 1, total_conversations: 1 }])).toBeNull();
    expect(respostaTruncada([])).toBeNull();
    expect(respostaTruncada(null)).toBeNull();
  });

  it("total que vem como texto (bigint) também conta", () => {
    expect(respostaTruncada([{ conversation_id: "c1", count: 1, total_conversations: "3" }])).toEqual({
      recebidas: 1,
      total: 3,
    });
  });
});

/** Promessa que o teste resolve quando quiser. */
function adiada<T>() {
  let resolver!: (valor: T) => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<T>((resolve, reject) => {
    resolver = resolve;
    rejeitar = reject;
  });
  return { promessa, resolver, rejeitar };
}

const assentar = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("criarVooUnico", () => {
  it("chamadas durante o voo dividem a mesma busca e o mesmo resultado", async () => {
    const porta = adiada<number>();
    const buscar = vi.fn(() => porta.promessa);
    const aplicar = vi.fn((n: number) => n * 2);
    const voo = criarVooUnico(buscar, aplicar);

    const primeira = voo();
    const segunda = voo();
    const terceira = voo();
    expect(segunda).toBe(primeira);
    expect(terceira).toBe(primeira);

    porta.resolver(21);
    await expect(primeira).resolves.toBe(42);

    expect(buscar).toHaveBeenCalledTimes(1);
    expect(aplicar).toHaveBeenCalledTimes(1);
  });

  it("terminado o voo, a chamada seguinte busca de novo", async () => {
    let n = 0;
    const voo = criarVooUnico(
      async () => ++n,
      (valor) => valor,
    );
    await expect(voo()).resolves.toBe(1);
    await expect(voo()).resolves.toBe(2);
  });

  it("invalidar no meio do voo: descarta o resultado velho e roda mais uma vez, para todos", async () => {
    const portas = [adiada<string>(), adiada<string>()];
    let chamada = 0;
    const buscar = vi.fn(() => portas[chamada++].promessa);
    const aplicar = vi.fn((valor: string) => valor);
    const voo = criarVooUnico(buscar, aplicar);

    const primeira = voo();
    voo.invalidar();
    const segunda = voo(); // o escopo mudou e alguém pede de novo: entra na mesma promessa
    expect(segunda).toBe(primeira);

    portas[0].resolver("escopo velho");
    await assentar();
    // A resposta velha não chega ao estado, e a segunda busca já saiu.
    expect(aplicar).not.toHaveBeenCalled();
    expect(buscar).toHaveBeenCalledTimes(2);

    portas[1].resolver("escopo novo");
    await expect(primeira).resolves.toBe("escopo novo");
    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(aplicar).toHaveBeenCalledWith("escopo novo");
  });

  it("várias invalidações no mesmo voo valem uma busca a mais só", async () => {
    const portas = [adiada<string>(), adiada<string>()];
    let chamada = 0;
    const buscar = vi.fn(() => portas[chamada++].promessa);
    const voo = criarVooUnico(buscar, (valor: string) => valor);

    const resultado = voo();
    voo.invalidar();
    voo.invalidar();
    voo.invalidar();
    portas[0].resolver("velho");
    await assentar();
    portas[1].resolver("novo");

    await expect(resultado).resolves.toBe("novo");
    expect(buscar).toHaveBeenCalledTimes(2);
  });

  it("invalidar de novo durante a segunda busca pede uma terceira", async () => {
    const portas = [adiada<string>(), adiada<string>(), adiada<string>()];
    let chamada = 0;
    const buscar = vi.fn(() => portas[chamada++].promessa);
    const voo = criarVooUnico(buscar, (valor: string) => valor);

    const resultado = voo();
    voo.invalidar();
    portas[0].resolver("1");
    await assentar();
    voo.invalidar();
    portas[1].resolver("2");
    await assentar();
    portas[2].resolver("3");

    await expect(resultado).resolves.toBe("3");
    expect(buscar).toHaveBeenCalledTimes(3);
  });

  it("invalidar sem busca em voo não faz nada", async () => {
    const buscar = vi.fn(async () => "x");
    const voo = criarVooUnico(buscar, (valor: string) => valor);
    voo.invalidar();
    expect(buscar).not.toHaveBeenCalled();
    await expect(voo()).resolves.toBe("x");
    expect(buscar).toHaveBeenCalledTimes(1);
  });

  it("busca que rejeita rejeita para todos e libera o voo seguinte", async () => {
    const porta = adiada<number>();
    let primeiraVez = true;
    const buscar = vi.fn(() => {
      if (primeiraVez) {
        primeiraVez = false;
        return porta.promessa;
      }
      return Promise.resolve(7);
    });
    const voo = criarVooUnico(buscar, (valor: number) => valor);

    const a = voo();
    const b = voo();
    porta.rejeitar(new Error("rede"));
    await expect(a).rejects.toThrow("rede");
    await expect(b).rejects.toThrow("rede");

    await expect(voo()).resolves.toBe(7);
  });

  describe("chamada fresca", () => {
    it("no meio do voo, a busca em voo é descartada e uma nova (posterior à chamada) vale para todos", async () => {
      const portas = [adiada<string>(), adiada<string>()];
      let chamada = 0;
      const buscar = vi.fn(() => portas[chamada++].promessa);
      const aplicar = vi.fn((valor: string) => valor);
      const voo = criarVooUnico(buscar, aplicar);

      const antiga = voo();
      const fresca = voo({ fresca: true });
      expect(fresca).toBe(antiga);

      portas[0].resolver("foto anterior à chamada");
      await assentar();
      // A foto velha não chega ao estado, e a segunda busca já saiu.
      expect(aplicar).not.toHaveBeenCalled();
      expect(buscar).toHaveBeenCalledTimes(2);

      portas[1].resolver("foto posterior");
      await expect(antiga).resolves.toBe("foto posterior");
      await expect(fresca).resolves.toBe("foto posterior");
      expect(aplicar).toHaveBeenCalledTimes(1);
      expect(aplicar).toHaveBeenCalledWith("foto posterior");
    });

    it("sem voo em andamento é uma busca só", async () => {
      const buscar = vi.fn(async () => "x");
      const voo = criarVooUnico(buscar, (valor: string) => valor);

      await expect(voo({ fresca: true })).resolves.toBe("x");
      expect(buscar).toHaveBeenCalledTimes(1);
    });

    it("junto com invalidar vale uma busca a mais só", async () => {
      const portas = [adiada<string>(), adiada<string>()];
      let chamada = 0;
      const buscar = vi.fn(() => portas[chamada++].promessa);
      const voo = criarVooUnico(buscar, (valor: string) => valor);

      const resultado = voo();
      voo.invalidar();
      voo({ fresca: true });
      voo({ fresca: true });
      portas[0].resolver("velho");
      await assentar();
      portas[1].resolver("novo");

      await expect(resultado).resolves.toBe("novo");
      expect(buscar).toHaveBeenCalledTimes(2);
    });

    it("durante a segunda busca, uma nova chamada fresca pede uma terceira", async () => {
      const portas = [adiada<string>(), adiada<string>(), adiada<string>()];
      let chamada = 0;
      const buscar = vi.fn(() => portas[chamada++].promessa);
      const voo = criarVooUnico(buscar, (valor: string) => valor);

      const resultado = voo();
      voo({ fresca: true });
      portas[0].resolver("1");
      await assentar();
      voo({ fresca: true });
      portas[1].resolver("2");
      await assentar();
      portas[2].resolver("3");

      await expect(resultado).resolves.toBe("3");
      expect(buscar).toHaveBeenCalledTimes(3);
    });

    it("várias chamadas frescas durante a MESMA busca gastam um reinício só", async () => {
      const portas = [adiada<string>(), adiada<string>(), adiada<string>(), adiada<string>()];
      let chamada = 0;
      const buscar = vi.fn(() => portas[chamada++].promessa);
      const voo = criarVooUnico(buscar, (valor: string) => valor);

      const resultado = voo();
      voo({ fresca: true });
      voo({ fresca: true });
      voo({ fresca: true });
      portas[0].resolver("1");
      await assentar();
      expect(buscar).toHaveBeenCalledTimes(2);

      // Ainda sobra reinício: uma fresca durante a segunda busca pede a terceira.
      voo({ fresca: true });
      portas[1].resolver("2");
      await assentar();
      expect(buscar).toHaveBeenCalledTimes(3);

      portas[2].resolver("3");
      await expect(resultado).resolves.toBe("3");
    });

    it("canal que oscila mais depressa que a busca não a reinicia sem fim: passado o limite, divide o voo", async () => {
      const portas = Array.from({ length: MAX_REINICIOS_FRESCOS + 3 }, () => adiada<number>());
      let chamada = 0;
      const buscar = vi.fn(() => portas[chamada++].promessa);
      const aplicar = vi.fn((valor: number) => valor);
      const voo = criarVooUnico(buscar, aplicar);

      const resultado = voo();
      // Cada busca é interrompida por uma nova queda do canal antes de terminar.
      for (let i = 0; i < MAX_REINICIOS_FRESCOS + 1; i += 1) {
        voo({ fresca: true });
        portas[i].resolver(i);
        await assentar();
      }

      // O limite foi gasto: a última busca chega ao estado em vez de ser descartada de novo.
      await expect(resultado).resolves.toBe(MAX_REINICIOS_FRESCOS);
      expect(buscar).toHaveBeenCalledTimes(MAX_REINICIOS_FRESCOS + 1);
      expect(aplicar).toHaveBeenCalledTimes(1);
    });

    it("o limite é por voo: depois que ele termina, a queda seguinte volta a pedir busca fresca", async () => {
      const portas: Array<ReturnType<typeof adiada<number>>> = [];
      const buscar = vi.fn(() => {
        const porta = adiada<number>();
        portas.push(porta);
        return porta.promessa;
      });
      const voo = criarVooUnico(buscar, (valor: number) => valor);

      // Primeiro voo: gasta o limite inteiro.
      const primeiro = voo();
      for (let i = 0; i <= MAX_REINICIOS_FRESCOS; i += 1) {
        voo({ fresca: true });
        portas[i].resolver(i);
        await assentar();
      }
      await primeiro;
      expect(buscar).toHaveBeenCalledTimes(MAX_REINICIOS_FRESCOS + 1);

      // Segundo voo: uma fresca volta a reiniciar.
      const segundo = voo();
      const primeiraDoSegundo = portas.length - 1;
      voo({ fresca: true });
      portas[primeiraDoSegundo].resolver(0);
      await assentar();
      expect(buscar).toHaveBeenCalledTimes(MAX_REINICIOS_FRESCOS + 3);
      portas[primeiraDoSegundo + 1].resolver(0);
      await segundo;
    });

    it("`invalidar` não gasta o limite das frescas", async () => {
      const portas = Array.from({ length: MAX_REINICIOS_FRESCOS + 3 }, () => adiada<number>());
      let chamada = 0;
      const buscar = vi.fn(() => portas[chamada++].promessa);
      const voo = criarVooUnico(buscar, (valor: number) => valor);

      const resultado = voo();
      voo.invalidar();
      portas[0].resolver(0);
      await assentar();
      // O limite está inteiro: as frescas seguintes ainda reiniciam.
      for (let i = 1; i <= MAX_REINICIOS_FRESCOS; i += 1) {
        voo({ fresca: true });
        portas[i].resolver(i);
        await assentar();
      }
      portas[MAX_REINICIOS_FRESCOS + 1].resolver(99);

      await expect(resultado).resolves.toBe(99);
      expect(buscar).toHaveBeenCalledTimes(MAX_REINICIOS_FRESCOS + 2);
    });

    it("chamada sem `fresca` continua dividindo o voo, e `fresca: false` também", async () => {
      const porta = adiada<number>();
      const buscar = vi.fn(() => porta.promessa);
      const voo = criarVooUnico(buscar, (valor: number) => valor);

      const primeira = voo();
      voo({});
      voo({ fresca: false });
      porta.resolver(5);

      await expect(primeira).resolves.toBe(5);
      expect(buscar).toHaveBeenCalledTimes(1);
    });
  });

  it("busca que lança de forma síncrona também não prende o voo", async () => {
    let quebrar = true;
    const voo = criarVooUnico(
      (): Promise<number> => {
        if (quebrar) throw new Error("síncrono");
        return Promise.resolve(1);
      },
      (valor: number) => valor,
    );

    await expect(voo()).rejects.toThrow("síncrono");
    quebrar = false;
    await expect(voo()).resolves.toBe(1);
  });
});

describe("parseLinhasDeContagem", () => {
  afterEach(() => vi.restoreAllMocks());

  it("aceita count e total como número ou texto (bigint) e preserva a linha", () => {
    expect(
      parseLinhasDeContagem([
        { conversation_id: "c1", count: 2, total_conversations: 3 },
        { conversation_id: "c2", count: "5", total_conversations: "9" },
        { conversation_id: "c3", count: 1 },
      ]),
    ).toEqual([
      { conversation_id: "c1", count: 2, total_conversations: 3 },
      { conversation_id: "c2", count: "5", total_conversations: "9" },
      { conversation_id: "c3", count: 1 },
    ]);
  });

  it("null (sem não-lidas) vira lista vazia", () => {
    expect(parseLinhasDeContagem(null)).toEqual([]);
  });

  it("linha fora do contrato é descartada com aviso e não derruba as outras", () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      parseLinhasDeContagem([
        { conversation_id: "ok", count: 1 },
        { conversation_id: 7, count: 1 },
        { conversation_id: "sem-count" },
        { conversation_id: "texto", count: "abc" },
        { conversation_id: "vazio", count: "" },
        { conversation_id: "total-ruim", count: 1, total_conversations: "x" },
        null,
      ]),
    ).toEqual([{ conversation_id: "ok", count: 1 }]);
    expect(aviso).toHaveBeenCalledTimes(6);
  });

  it("o que não é lista (e não é null) conta como falha da chamada", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseLinhasDeContagem({ erro: true })).toBeNull();
    expect(parseLinhasDeContagem("x")).toBeNull();
  });
});

describe("buscarContagemDaLinha", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resposta boa vira linhas validadas", async () => {
    const resposta = await buscarContagemDaLinha("A", async () => ({
      data: [{ conversation_id: "c1", count: "2" }],
      error: null,
    }));
    expect(resposta).toEqual({ linha: "A", rows: [{ conversation_id: "c1", count: "2" }], falhou: false });
  });

  it("erro devolvido, exceção e resposta que não é lista contam como falha", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(buscarContagemDaLinha("A", async () => ({ data: null, error: { message: "x" } }))).resolves.toEqual({
      linha: "A",
      rows: null,
      falhou: true,
    });
    await expect(
      buscarContagemDaLinha("A", async () => {
        throw new Error("rede");
      }),
    ).resolves.toMatchObject({ falhou: true });
    await expect(buscarContagemDaLinha("A", async () => ({ data: { x: 1 }, error: null }))).resolves.toMatchObject({
      falhou: true,
    });
  });

  it("chamada pendurada estoura o prazo, aborta a requisição e conta como falha", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let sinal: AbortSignal | undefined;
    const resposta = buscarContagemDaLinha("A", (_linha, s) => {
      sinal = s;
      return new Promise<never>(() => undefined);
    });

    await vi.advanceTimersByTimeAsync(PRAZO_CONTAGEM_MS - 1);
    expect(sinal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resposta).resolves.toEqual({ linha: "A", rows: null, falhou: true });
    expect(sinal?.aborted).toBe(true);
  });

  it("uma chamada pendurada não prende o voo único: o próximo refresh roda", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let penduradas = true;
    const chamar = vi.fn((): Promise<{ data: unknown; error: unknown }> =>
      penduradas
        ? new Promise<never>(() => undefined)
        : Promise.resolve({ data: [{ conversation_id: "c1", count: 1 }], error: null }),
    );
    const voo = criarVooUnico(
      () => buscarContagemDaLinha("A", chamar),
      (resposta: RespostaDeContagem) => resposta,
    );

    const primeira = voo();
    await vi.advanceTimersByTimeAsync(PRAZO_CONTAGEM_MS);
    await expect(primeira).resolves.toMatchObject({ falhou: true });

    penduradas = false;
    await expect(voo()).resolves.toMatchObject({ falhou: false, rows: [{ conversation_id: "c1", count: 1 }] });
    expect(chamar).toHaveBeenCalledTimes(2);
  });

  it("o prazo não vaza: resposta rápida limpa o relógio", async () => {
    vi.useFakeTimers();
    await buscarContagemDaLinha("A", async () => ({ data: [], error: null }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
