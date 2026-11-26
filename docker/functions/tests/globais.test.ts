// Globais do processo (console com nome da função, EdgeRuntime.waitUntil, promessa solta). Fica em arquivo próprio:
// cada arquivo de teste roda no seu isolate, então o patch não vaza para os outros.
import { carregarFuncoes, criarDespachante, instalarGlobais, pendentesDeWaitUntil } from "../router.ts";
import { criarVerificador } from "../common.ts";
import { FIXTURES, igual, SEGREDO } from "./helpers.ts";

const INFO = { remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 1 } } as Deno.ServeHandlerInfo;

Deno.test("EdgeRuntime.waitUntil: a promessa segue depois da resposta e o /_health a conta", async () => {
  instalarGlobais();
  const { handlers, falhas } = await carregarFuncoes({ dir: FIXTURES, nomes: ["wait-until"] });
  const d = criarDespachante({
    handlers,
    falhas,
    mapa: { "wait-until": false },
    verificar: criarVerificador(SEGREDO),
    timeoutMs: 5000,
    pendentesWaitUntil: pendentesDeWaitUntil,
  });
  const r = await d(new Request("http://x/wait-until"), INFO);
  igual([r.status, await r.json()], [200, { agendado: true }], "resposta");
  igual(pendentesDeWaitUntil(), 1, "1 promessa pendente logo depois da resposta");
  const h = await (await d(new Request("http://x/_health"), INFO)).json();
  igual(h.waitUntil, 1, "/_health conta a pendente");
  await new Promise((resolve) => setTimeout(resolve, 350));
  igual(pendentesDeWaitUntil(), 0, "a promessa terminou sozinha");
});

Deno.test("console de uma função leva o nome dela no prefixo", async () => {
  const linhas: unknown[][] = [];
  const original = console.log;
  const { contexto } = await import("../router.ts");
  // instalarGlobais já embrulhou console.log; captura o que o embrulho entrega ao console original.
  console.log = (...args: unknown[]) => void linhas.push(args);
  try {
    // Reembrulha sobre o capturador para observar o prefixo.
    instalarGlobais();
    contexto.run("minha-funcao", () => console.log("olá"));
    contexto.exit(() => console.log("sem contexto"));
  } finally {
    console.log = original;
  }
  igual(linhas[0], ["[minha-funcao]", "olá"], "com contexto");
  igual(linhas[1], ["sem contexto"], "sem contexto");
});
