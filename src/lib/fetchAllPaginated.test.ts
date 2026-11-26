import { describe, expect, it } from "vitest";
import { criarLimitador, mapComLimite } from "./fetchAllPaginated";

/** Promessa que o teste resolve ou rejeita quando quiser. */
function adiada<T>() {
  let resolver!: (valor: T) => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<T>((resolve, reject) => {
    resolver = resolve;
    rejeitar = reject;
  });
  return { promessa, resolver, rejeitar };
}

/** Deixa as continuações pendentes (then/finally) rodarem. */
const esvaziarMicrotarefas = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("criarLimitador", () => {
  it("nunca passa do teto de tarefas em voo e atende a fila em ordem de chegada", async () => {
    const limitar = criarLimitador(2);
    const portas = [adiada<string>(), adiada<string>(), adiada<string>(), adiada<string>()];
    const iniciadas: number[] = [];
    let emVoo = 0;
    let picoEmVoo = 0;

    const resultados = portas.map((porta, i) =>
      limitar(async () => {
        iniciadas.push(i);
        emVoo += 1;
        picoEmVoo = Math.max(picoEmVoo, emVoo);
        try {
          return await porta.promessa;
        } finally {
          emVoo -= 1;
        }
      }),
    );

    // Só as duas primeiras começaram.
    expect(iniciadas).toEqual([0, 1]);

    portas[1].resolver("b");
    await esvaziarMicrotarefas();
    // A vaga da segunda vai para a terceira da fila, não para a quarta.
    expect(iniciadas).toEqual([0, 1, 2]);

    portas[0].resolver("a");
    portas[2].resolver("c");
    await esvaziarMicrotarefas();
    expect(iniciadas).toEqual([0, 1, 2, 3]);

    portas[3].resolver("d");
    await expect(Promise.all(resultados)).resolves.toEqual(["a", "b", "c", "d"]);
    expect(picoEmVoo).toBeLessThanOrEqual(2);
  });

  it("uma tarefa que rejeita libera a vaga e só o dono dela recebe o erro", async () => {
    const limitar = criarLimitador(1);
    const falha = adiada<string>();
    const seguinte = adiada<string>();

    const primeira = limitar(() => falha.promessa);
    const segunda = limitar(() => seguinte.promessa);

    falha.rejeitar(new Error("boom"));
    await expect(primeira).rejects.toThrow("boom");

    seguinte.resolver("ok");
    await expect(segunda).resolves.toBe("ok");
  });

  it("uma tarefa que lança de forma síncrona também libera a vaga", async () => {
    const limitar = criarLimitador(1);
    const quebrada = limitar((): Promise<string> => {
      throw new Error("síncrono");
    });
    const seguinte = limitar(async () => "depois");

    await expect(quebrada).rejects.toThrow("síncrono");
    await expect(seguinte).resolves.toBe("depois");
  });

  it("tarefa enfileirada que lança na hora de rodar não trava as seguintes", async () => {
    const limitar = criarLimitador(1);
    const porta = adiada<string>();
    const primeira = limitar(() => porta.promessa);
    const quebrada = limitar((): Promise<string> => {
      throw new Error("na fila");
    });
    const ultima = limitar(async () => "fim");

    porta.resolver("início");
    await expect(primeira).resolves.toBe("início");
    await expect(quebrada).rejects.toThrow("na fila");
    await expect(ultima).resolves.toBe("fim");
  });

  it("teto menor que 1 vale 1", async () => {
    const limitar = criarLimitador(0);
    const ordem: number[] = [];
    await Promise.all([1, 2, 3].map((n) => limitar(async () => ordem.push(n))));
    expect(ordem).toEqual([1, 2, 3]);
  });
});

describe("mapComLimite", () => {
  it("devolve os resultados na ordem dos itens, mesmo terminando fora de ordem", async () => {
    const portas = [adiada<number>(), adiada<number>(), adiada<number>()];
    const resultado = mapComLimite([0, 1, 2], (i) => portas[i].promessa, { concurrency: 3 });

    portas[2].resolver(30);
    portas[0].resolver(10);
    portas[1].resolver(20);

    await expect(resultado).resolves.toEqual([10, 20, 30]);
  });

  it("respeita a concorrência pedida", async () => {
    const portas = Array.from({ length: 6 }, () => adiada<void>());
    let emVoo = 0;
    let pico = 0;

    const resultado = mapComLimite(
      portas,
      async (porta) => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await porta.promessa;
        emVoo -= 1;
      },
      { concurrency: 4 },
    );

    await esvaziarMicrotarefas();
    expect(emVoo).toBe(4);

    for (const porta of portas) {
      porta.resolver();
      await esvaziarMicrotarefas();
    }
    await resultado;
    expect(pico).toBe(4);
  });

  it("lista vazia resolve com lista vazia e a concorrência padrão é 4", async () => {
    await expect(mapComLimite([], async () => 1)).resolves.toEqual([]);

    const portas = Array.from({ length: 5 }, () => adiada<void>());
    let emVoo = 0;
    const resultado = mapComLimite(portas, async (porta) => {
      emVoo += 1;
      await porta.promessa;
    });
    await esvaziarMicrotarefas();
    expect(emVoo).toBe(4);
    for (const porta of portas) porta.resolver();
    await resultado;
  });

  it("repassa o índice do item", async () => {
    await expect(mapComLimite(["a", "b"], async (item, i) => `${i}:${item}`)).resolves.toEqual(["0:a", "1:b"]);
  });
});
