// Testes de scripts/smoke/realtime-lib.mjs, sem stack, sem rede e sem supabase-js: canais e relógio de mentira.
//   node --test scripts/smoke/realtime-lib.test.mjs      (o testes-infra.sh roda este comando)
// Usa node:test (e não o Vitest) para rodar em qualquer Node >= 20 sem instalar nada.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agoraMonotonico, assinar, assinarComTentativas, sondarAte, tentarMensagem } from "./realtime-lib.mjs";

/** Relógio de mentira: `dorme` só avança o tempo, e registra quanto esperou. */
function relogio() {
  let t = 1_000_000;
  const esperas = [];
  return {
    agora: () => t,
    dorme: async (ms) => {
      esperas.push(ms);
      t += ms;
    },
    esperas,
  };
}

/** Canal de mentira: o roteiro diz o que cada `subscribe` devolve; "cdc" também dispara o evento system. */
function canalFalso(roteiro, vivos) {
  const handlers = [];
  const canal = {
    on(tipo, _filtro, fn) {
      if (tipo === "system") handlers.push(fn);
      return canal;
    },
    subscribe(cb) {
      queueMicrotask(() => {
        if (roteiro === "ok") {
          cb("SUBSCRIBED");
          for (const h of handlers) h({ extension: "postgres_changes", status: "ok" });
        } else if (roteiro === "sem-cdc") {
          cb("SUBSCRIBED");
        } else if (roteiro !== "mudo") {
          cb(roteiro, new Error("erro de mentira"));
        }
      });
      return canal;
    },
  };
  vivos?.add(canal);
  return canal;
}

describe("assinar", () => {
  it("resolve com SUBSCRIBED e o 'Subscribed to PostgreSQL'", async () => {
    await assinar(canalFalso("ok"), "A/global", { timeoutMs: 500 });
  });

  for (const status of ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) {
    it(`rejeita com o status ${status} no texto`, async () => {
      await assert.rejects(assinar(canalFalso(status), "A/global", { timeoutMs: 500 }), (e) => e.message.startsWith(`A/global: ${status}`));
    });
  }

  it("rejeita quando o SUBSCRIBED não vem no prazo", async () => {
    await assert.rejects(assinar(canalFalso("mudo"), "A/global", { timeoutMs: 30 }), /A\/global: subscribe não respondeu/);
  });

  it("rejeita quando o 'Subscribed to PostgreSQL' não vem no prazo", async () => {
    await assert.rejects(assinar(canalFalso("sem-cdc"), "A/global", { timeoutMs: 30 }), /sem "Subscribed to PostgreSQL"/);
  });
});

describe("assinarComTentativas", () => {
  it("tenta de novo em CHANNEL_ERROR, remove o canal que falhou antes de criar outro e espera 1, 2 s", async () => {
    const r = relogio();
    const vivos = new Set();
    const removidos = [];
    let n = 0;
    const roteiro = ["CHANNEL_ERROR", "TIMED_OUT", "ok"];
    const res = await assinarComTentativas({
      nome: "A/global",
      criar: () => {
        // O canal anterior TEM de já ter saído quando o próximo nasce (supabase-js devolve o existente do mesmo tópico).
        assert.equal(vivos.size, 0, "canal anterior ainda vivo quando o novo foi criado");
        return canalFalso(roteiro[n++], vivos);
      },
      remover: async (c) => {
        removidos.push(c);
        vivos.delete(c);
      },
      assinarFn: (canal, nome) => assinar(canal, nome, { timeoutMs: 200 }),
      dorme: r.dorme,
      agora: r.agora,
    });
    assert.equal(res.tentativas, 3);
    assert.equal(removidos.length, 2);
    assert.deepEqual(r.esperas, [1000, 2000]);
  });

  it("passa à assinarFn um prazo por tentativa de no máximo 20 s e no mínimo 5 s", async () => {
    const r = relogio();
    const prazos = [];
    await assert.rejects(
      assinarComTentativas({
        nome: "A/global",
        criar: () => ({}),
        remover: async () => {},
        assinarFn: async (_c, _n, { timeoutMs }) => {
          prazos.push(timeoutMs);
          await r.dorme(timeoutMs); // gasta o prazo todo, como um subscribe mudo
          throw new Error("A/global: subscribe não respondeu");
        },
        dorme: r.dorme,
        agora: r.agora,
      }),
    );
    assert.ok(prazos.length >= 2, `esperava mais de uma tentativa, teve ${prazos.length}`);
    assert.equal(prazos[0], 20000);
    for (const p of prazos) assert.ok(p >= 5000 && p <= 20000, `prazo fora de 5-20 s: ${p}`);
  });

  it("desiste perto de 45 s e a mensagem diz a causa, quantas tentativas e quantos segundos", async () => {
    const r = relogio();
    let tentativasVistas = 0;
    await assert.rejects(
      assinarComTentativas({
        nome: "B/global",
        criar: () => canalFalso("CHANNEL_ERROR"),
        remover: async () => {},
        assinarFn: (canal, nome) => {
          tentativasVistas += 1;
          return assinar(canal, nome, { timeoutMs: 200 });
        },
        dorme: r.dorme,
        agora: r.agora,
      }),
      (e) => {
        assert.match(e.message, /^B\/global: CHANNEL_ERROR /);
        assert.match(e.message, new RegExp(`\\(${tentativasVistas} tentativa\\(s\\) em \\d+ s\\)$`));
        return true;
      },
    );
    // 1+2+4+8+8+8+8 = 39 s de espera; a próxima passaria dos 45 s.
    assert.equal(tentativasVistas, 8);
    const total = r.esperas.reduce((a, b) => a + b, 0);
    assert.ok(total <= 45000, `esperou ${total} ms no total`);
    assert.deepEqual(r.esperas, [1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  });

  it("não mascara erro do remover: segue para a próxima tentativa", async () => {
    const r = relogio();
    let n = 0;
    const res = await assinarComTentativas({
      nome: "A/global",
      criar: () => canalFalso(n++ === 0 ? "CHANNEL_ERROR" : "ok"),
      remover: async () => {
        throw new Error("já saiu");
      },
      assinarFn: (canal, nome) => assinar(canal, nome, { timeoutMs: 200 }),
      dorme: r.dorme,
      agora: r.agora,
    });
    assert.equal(res.tentativas, 2);
  });

  it("à primeira, sem espera nenhuma", async () => {
    const r = relogio();
    const res = await assinarComTentativas({
      nome: "A/global",
      criar: () => canalFalso("ok"),
      remover: async () => {},
      assinarFn: (canal, nome) => assinar(canal, nome, { timeoutMs: 200 }),
      dorme: r.dorme,
      agora: r.agora,
    });
    assert.equal(res.tentativas, 1);
    assert.deepEqual(r.esperas, []);
  });
});

describe("sondarAte", () => {
  it("manda uma sonda nova a cada 3 s até uma chegar e devolve todas as enviadas", async () => {
    const r = relogio();
    const inicio = r.agora();
    const enviados = [];
    const quando = [];
    const res = await sondarAte({
      enviar: (i) => {
        quando.push(r.agora() - inicio);
        const id = `W${i}`;
        enviados.push(id);
        return id;
      },
      // só a 3ª sonda chega (como um canal que aplica o filtro tarde)
      recebeu: (ids) => ids.includes("W3"),
      dorme: r.dorme,
      agora: r.agora,
    });
    assert.equal(res.recebeu, true);
    assert.deepEqual(res.enviados, ["W1", "W2", "W3"]);
    assert.deepEqual(quando, [0, 3000, 6000]);
    assert.equal(new Set(res.enviados).size, 3, "wamid novo a cada tentativa");
  });

  it("chegando na primeira, manda uma só", async () => {
    const r = relogio();
    const res = await sondarAte({ enviar: (i) => `W${i}`, recebeu: (ids) => ids.length >= 1, dorme: r.dorme, agora: r.agora });
    assert.deepEqual(res, { recebeu: true, enviados: ["W1"] });
  });

  it("sem chegar em 30 s devolve recebeu:false com 10 sondas", async () => {
    const r = relogio();
    const res = await sondarAte({ enviar: (i) => `W${i}`, recebeu: () => false, dorme: r.dorme, agora: r.agora });
    assert.equal(res.recebeu, false);
    assert.equal(res.enviados.length, 10);
  });

  it("uma chegada no fim do último intervalo ainda conta", async () => {
    const r = relogio();
    const res = await sondarAte({
      enviar: (i) => `W${i}`,
      recebeu: (ids) => ids.length === 10 && r.agora() >= 1_000_000 + 29_900,
      dorme: r.dorme,
      agora: r.agora,
    });
    assert.equal(res.recebeu, true);
  });
});

describe("tentarMensagem", () => {
  it("chegando na primeira, manda uma só e devolve o id dela", async () => {
    const r = relogio();
    const res = await tentarMensagem({ enviar: (n) => `M${n}`, recebeu: (id) => id === "M1", dorme: r.dorme, agora: r.agora });
    assert.deepEqual(res, { recebeu: true, tentativa: 1, id: "M1", enviados: ["M1"] });
  });

  it("perdida a primeira, manda outra com id novo depois de 10 s, e o id devolvido é o da que chegou", async () => {
    const r = relogio();
    const inicio = r.agora();
    const quando = [];
    const res = await tentarMensagem({
      enviar: (n) => {
        quando.push(r.agora() - inicio);
        return `M${n}`;
      },
      // só a 2ª chega: a 1ª se perdeu dentro do Realtime
      recebeu: (id) => id === "M2",
      dorme: r.dorme,
      agora: r.agora,
    });
    assert.equal(res.recebeu, true);
    assert.equal(res.tentativa, 2);
    assert.equal(res.id, "M2");
    assert.deepEqual(res.enviados, ["M1", "M2"], "a lista inclui a que se perdeu (a checagem de RLS cobre as duas)");
    assert.deepEqual(quando, [0, 10000]);
  });

  it("chegando só na 3ª, ainda passa", async () => {
    const r = relogio();
    const res = await tentarMensagem({ enviar: (n) => `M${n}`, recebeu: (id) => id === "M3", dorme: r.dorme, agora: r.agora });
    assert.equal(res.recebeu, true);
    assert.equal(res.tentativa, 3);
    assert.deepEqual(res.enviados, ["M1", "M2", "M3"]);
    assert.equal(new Set(res.enviados).size, 3, "wamid novo a cada tentativa");
  });

  it("nenhuma chega: recebeu:false depois de 3 tentativas de 10 s, sem id", async () => {
    const r = relogio();
    const inicio = r.agora();
    const res = await tentarMensagem({ enviar: (n) => `M${n}`, recebeu: () => false, dorme: r.dorme, agora: r.agora });
    assert.deepEqual(res, { recebeu: false, tentativa: 3, id: null, enviados: ["M1", "M2", "M3"] });
    assert.ok(r.agora() - inicio >= 30000 && r.agora() - inicio < 30500, `esperou ${r.agora() - inicio} ms`);
  });

  it("uma chegada no fim da espera de 10 s ainda conta para aquela tentativa", async () => {
    const r = relogio();
    const res = await tentarMensagem({
      enviar: (n) => `M${n}`,
      recebeu: (id) => id === "M1" && r.agora() >= 1_000_000 + 9_900,
      dorme: r.dorme,
      agora: r.agora,
    });
    assert.equal(res.tentativa, 1);
  });
});

describe("relógio dos prazos", () => {
  it("agoraMonotonico não é o relógio de parede (que salta no WSL2): conta desde o início do processo", () => {
    assert.ok(agoraMonotonico() < Date.now() / 1000, "o valor parece uma data, e não um contador monotônico");
  });

  it("agoraMonotonico nunca anda para trás", () => {
    let ultimo = agoraMonotonico();
    for (let i = 0; i < 1000; i += 1) {
      const t = agoraMonotonico();
      assert.ok(t >= ultimo);
      ultimo = t;
    }
  });
});
