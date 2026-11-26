import { criarVerificador } from "../common.ts";
import { carregarFuncoes, criarDespachante, drenar, type Handler } from "../router.ts";
import { agora, assinarJwt, FIXTURES, igual, SEGREDO } from "./helpers.ts";

const INFO = { remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 1 } } as Deno.ServeHandlerInfo;
const verificar = criarVerificador(SEGREDO);

function despachante(
  handlers: Record<string, Handler>,
  mapa: Record<string, boolean>,
  opcoes: { falhas?: Record<string, string>; timeoutMs?: number } = {},
) {
  return criarDespachante({
    handlers: new Map(Object.entries(handlers)),
    falhas: opcoes.falhas ?? {},
    mapa,
    verificar,
    timeoutMs: opcoes.timeoutMs ?? 5000,
  });
}

const OK: Handler = () => Response.json({ ok: true });
const chamar = (d: Handler, caminho: string, init: RequestInit = {}) =>
  Promise.resolve(d(new Request(`http://x${caminho}`, init), INFO));

Deno.test("verify_jwt: sem header -> 401 com o código da prova", async () => {
  const d = despachante({ f: OK }, { f: true });
  const r = await chamar(d, "/f");
  igual(r.status, 401, "status");
  const corpo = await r.json();
  igual(corpo.code, "UNAUTHORIZED_NO_AUTH_HEADER", "código");
  igual(r.headers.get("sb-error-code"), "UNAUTHORIZED_NO_AUTH_HEADER", "cabeçalho sb-error-code");
});

Deno.test("verify_jwt: JWT forjado -> 401; vencido -> 401; ok -> 200", async () => {
  const d = despachante({ f: OK }, { f: true });
  const forjado = await assinarJwt({ role: "service_role" }, { segredo: "outro-segredo-qualquer-com-mais-de-32-chars" });
  const r1 = await chamar(d, "/f", { headers: { authorization: `Bearer ${forjado}` } });
  igual([r1.status, (await r1.json()).code], [401, "UNAUTHORIZED_LEGACY_JWT"], "forjado");
  const vencido = await assinarJwt({ role: "anon", exp: agora() - 5 });
  const r2 = await chamar(d, "/f", { headers: { authorization: `Bearer ${vencido}` } });
  igual([r2.status, (await r2.json()).code], [401, "UNAUTHORIZED_LEGACY_JWT_EXPIRED"], "vencido");
  const bom = await assinarJwt({ role: "anon", exp: agora() + 60 });
  const r3 = await chamar(d, "/f", { headers: { authorization: `Bearer ${bom}` } });
  igual([r3.status, await r3.json()], [200, { ok: true }], "válido");
});

Deno.test("verify_jwt: OPTIONS passa sem header; verify_jwt=false passa sem header", async () => {
  const d = despachante({ f: OK, aberta: OK }, { f: true, aberta: false });
  igual((await chamar(d, "/f", { method: "OPTIONS" })).status, 200, "preflight");
  igual((await chamar(d, "/aberta")).status, 200, "verify_jwt=false");
});

Deno.test("função fora do mapa exige JWT (a linha 130 da prova abria)", async () => {
  const d = despachante({ fora: OK }, {});
  const r = await chamar(d, "/fora");
  igual([r.status, (await r.json()).code], [401, "UNAUTHORIZED_NO_AUTH_HEADER"], "fora do mapa sem JWT");
  const bom = await assinarJwt({ role: "anon" });
  igual((await chamar(d, "/fora", { headers: { authorization: `Bearer ${bom}` } })).status, 200, "fora do mapa com JWT");
});

Deno.test("função desconhecida ou nome inválido -> 404", async () => {
  const d = despachante({ f: OK }, { f: false });
  igual((await chamar(d, "/nao-existe")).status, 404, "desconhecida");
  igual((await chamar(d, "/")).status, 404, "raiz");
  igual((await chamar(d, "/.env")).status, 404, "nome inválido");
});

Deno.test("504 IDLE_TIMEOUT quando a função não responde no tempo", async () => {
  const lento: Handler = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return Response.json({ lento: true });
  };
  const d = despachante({ lento }, { lento: false }, { timeoutMs: 40 });
  const r = await chamar(d, "/lento");
  igual([r.status, (await r.json()).code], [504, "IDLE_TIMEOUT"], "504");
  await new Promise((resolve) => setTimeout(resolve, 350)); // deixa o timer da função terminar
});

Deno.test("drena o corpo que a função não leu", async () => {
  const semLer: Handler = () => Response.json({ leu: false }, { status: 500 });
  const d = despachante({ semLer }, { semLer: false });
  const req = new Request("http://x/semLer", { method: "POST", body: "payload que ninguém lê" });
  const r = await d(req, INFO);
  igual(r.status, 500, "status da função preservado");
  igual(req.bodyUsed, true, "corpo drenado");
});

Deno.test("drena o corpo também nos retornos antecipados do roteador (401, 404, 503) e no catch do 500", async () => {
  const lanca: Handler = () => {
    throw new Error("de propósito");
  };
  const d = despachante(
    { lanca, f: OK, quebrada: OK },
    { lanca: false, f: true, quebrada: false },
    { falhas: { quebrada: "Error: x" } },
  );
  const casos: Array<[string, number]> = [["/f", 401], ["/nao-existe", 404], ["/quebrada", 503], ["/lanca", 500]];
  for (const [caminho, status] of casos) {
    const req = new Request(`http://x${caminho}`, { method: "POST", body: "payload que ninguém lê" });
    const r = await d(req, INFO);
    igual(r.status, status, `${caminho}: status`);
    igual(req.bodyUsed, true, `${caminho}: corpo drenado`);
  }
});

Deno.test("drenar consome em streaming e cancela o stream ao passar do teto", async () => {
  let cancelado = false;
  let enviados = 0;
  const corpo = new ReadableStream<Uint8Array>({
    pull(controller) {
      enviados++;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelado = true;
    },
  });
  const req = new Request("http://x/f", { method: "POST", body: corpo, duplex: "half" } as RequestInit);
  await drenar(req, 4096);
  igual(cancelado, true, "stream cancelado no teto");
  igual(enviados < 20, true, `leu só até o teto (${enviados} blocos)`);
});

/** Lê uma resposta HTTP/1.1 (cabeçalho + Content-Length) de uma conexão crua; null = conexão fechada antes. */
async function lerResposta(conn: Deno.Conn): Promise<string | null> {
  const dec = new TextDecoder();
  let acumulado = "";
  const buf = new Uint8Array(4096);
  for (;;) {
    const fim = acumulado.indexOf("\r\n\r\n");
    if (fim >= 0) {
      const tamanho = Number(/content-length: (\d+)/i.exec(acumulado.slice(0, fim))?.[1] ?? 0);
      if (acumulado.length >= fim + 4 + tamanho) return acumulado;
    }
    const n = await conn.read(buf);
    if (n === null) return null;
    acumulado += dec.decode(buf.subarray(0, n));
  }
}

Deno.test("401 de verify_jwt com corpo: a mesma conexão keep-alive atende o 2º POST", async () => {
  const d = despachante({ f: OK }, { f: true });
  const servidor = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req, info) => d(req, info));
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: servidor.addr.port });
  try {
    const enc = new TextEncoder();
    const corpo = "x".repeat(512 * 1024);
    const pedido = `POST /f HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: ${corpo.length}\r\n\r\n${corpo}`;
    for (const rodada of [1, 2]) {
      const bytes = enc.encode(pedido);
      for (let off = 0; off < bytes.length;) off += await conn.write(bytes.subarray(off)); // write pode ser parcial
      const resposta = await lerResposta(conn);
      igual(resposta?.startsWith("HTTP/1.1 401") ?? false, true, `rodada ${rodada}: 401 na mesma conexão`);
    }
  } finally {
    conn.close();
    await servidor.shutdown();
  }
});

Deno.test("função que lança vira 500 EDGE_FUNCTION_ERROR sem derrubar o roteador", async () => {
  const lanca: Handler = () => {
    throw new Error("de propósito");
  };
  const d = despachante({ lanca, ok: OK }, { lanca: false, ok: false });
  const r = await chamar(d, "/lanca");
  igual([r.status, (await r.json()).code], [500, "EDGE_FUNCTION_ERROR"], "500");
  igual((await chamar(d, "/ok")).status, 200, "outra função segue");
});

Deno.test("falha de carga: 503 BOOT_ERROR na função e /_health 503 com o nome dela", async () => {
  const d = despachante({ ok: OK }, { ok: false, quebrada: true }, { falhas: { quebrada: "Error: x | at y" } });
  const r = await chamar(d, "/quebrada");
  igual([r.status, (await r.json()).code], [503, "BOOT_ERROR"], "função quebrada");
  const h = await chamar(d, "/_health");
  const corpo = await h.json();
  igual(h.status, 503, "health 503");
  igual(corpo.ok, false, "ok=false");
  igual(Object.keys(corpo.falhas), ["quebrada"], "nome da função em falhas");
  igual((await chamar(d, "/ok")).status, 200, "a que carregou segue");
});

Deno.test("/_health só responde ao próprio container: de outro IP (o gateway) é 404, sem vazar as falhas", async () => {
  const d = despachante({ ok: OK }, { ok: false, quebrada: true }, { falhas: { quebrada: "Error: x | at /app/functions/quebrada/index.ts:2" } });
  for (const hostname of ["172.18.0.5", "10.0.0.7", "fd00::5", "8.8.8.8"]) {
    const info = { remoteAddr: { transport: "tcp", hostname, port: 1 } } as Deno.ServeHandlerInfo;
    const r = await d(new Request("http://x/_health"), info);
    igual(r.status, 404, `de ${hostname}`);
    igual(JSON.stringify(await r.json()).includes("/app/functions"), false, `de ${hostname}: sem caminho de arquivo no corpo`);
  }
  for (const hostname of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const info = { remoteAddr: { transport: "tcp", hostname, port: 1 } } as Deno.ServeHandlerInfo;
    igual((await d(new Request("http://x/_health"), info)).status, 503, `loopback ${hostname}`);
  }
});

Deno.test("/_health 200 sem falhas, com a contagem de carregadas e em voo", async () => {
  const d = despachante({ a: OK, b: OK }, { a: false, b: false });
  const h = await chamar(d, "/_health");
  igual(h.status, 200, "health 200");
  igual(await h.json(), { ok: true, carregadas: 2, falhas: {}, emVoo: 0, waitUntil: 0 }, "corpo");
});

Deno.test("carregarFuncoes: carrega, recusa sem Deno.serve e com Deno.serve duas vezes, restaura o Deno.serve", async () => {
  const antes = Deno.serve;
  const nomes = ["ok", "std-serve", "sem-serve", "duas-vezes", "quebrada", "inexistente"];
  const r = await carregarFuncoes({ dir: FIXTURES, nomes });
  igual([...r.handlers.keys()].sort(), ["ok", "std-serve"], "handlers registrados");
  igual(Object.keys(r.falhas).sort(), ["duas-vezes", "inexistente", "quebrada", "sem-serve"], "falhas");
  igual(r.falhas["sem-serve"], "importou, mas não chamou Deno.serve", "mensagem sem serve");
  igual(r.falhas["quebrada"].includes("falha de carga de propósito"), true, "mensagem da falha de carga");
  igual(Deno.serve === antes, true, "Deno.serve restaurado");
  const std = r.handlers.get("std-serve");
  if (!std) throw new Error("std-serve não carregou");
  const resp = await std(new Request("http://x/std-serve"), INFO);
  igual(await resp.json(), { via: "std" }, "serve do std remapeado para o registrador");
});

Deno.test("carregarFuncoes: a 2ª chamada de Deno.serve da mesma função vira falha (duas-vezes)", async () => {
  const r = await carregarFuncoes({ dir: FIXTURES, nomes: ["duas-vezes"] });
  igual(Object.keys(r.falhas), ["duas-vezes"], "falha");
  igual(r.falhas["duas-vezes"].includes("chamado duas vezes"), true, "mensagem");
});
