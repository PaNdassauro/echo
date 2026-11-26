import {
  BYTES_POR_SEGUNDO_AUDIO,
  CONFIG_RETRY,
  OpenAIErro,
  PRECOS,
  base64DeBytes,
  custoTokens,
  estimarCusto,
  responder,
  transcrever,
  type ResponderOpcoes,
  type Uso,
} from "../../supabase/functions/_shared/openai.ts";

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function perto(a: number, b: number) {
  if (Math.abs(a - b) > 1e-9) throw new Error(`expected ~${b}, got ${a}`);
}

CONFIG_RETRY.esperaMs = 5;

type Chamada = { url: string; init: RequestInit };
const originalFetch = globalThis.fetch;
function falso(respostas: Array<Response | Error>): { chamadas: Chamada[]; restaurar: () => void } {
  const chamadas: Chamada[] = [];
  let i = 0;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    const r = respostas[Math.min(i++, respostas.length - 1)];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r.clone());
  }) as typeof fetch;
  return { chamadas, restaurar: () => (globalThis.fetch = originalFetch) };
}
const json = (corpo: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json", ...headers } });

const base: ResponderOpcoes = {
  chave: "sk-proj-SEGREDO123",
  modelo: "gpt-6-luna",
  esforco: "none",
  instrucoes: "instr",
  entrada: [{ role: "user", content: "oi" }],
};
const ok = (extra: Record<string, unknown> = {}) => ({
  id: "resp_1",
  status: "completed",
  output_text: '{"a":1}',
  usage: { input_tokens: 10000, output_tokens: 2000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 1000 } },
  ...extra,
});

Deno.test("responder: corpo com store:false, sem previous_response_id, json_schema strict e prompt_cache_key", async () => {
  const f = falso([json(ok())]);
  try {
    const r = await responder({
      ...base,
      schema: { nome: "saida", schema: { type: "object" } },
      cacheKey: "chave-fixa",
      maxSaida: 900,
    });
    equal(f.chamadas[0].url, "https://api.openai.com/v1/responses");
    const corpo = JSON.parse(String(f.chamadas[0].init.body));
    equal(corpo.store, false);
    equal("previous_response_id" in corpo, false);
    equal(corpo.model, "gpt-6-luna");
    equal(corpo.reasoning, { effort: "none" });
    equal(corpo.max_output_tokens, 900);
    equal(corpo.prompt_cache_key, "chave-fixa");
    equal(corpo.instructions, "instr");
    equal(corpo.text, { format: { type: "json_schema", name: "saida", schema: { type: "object" }, strict: true } });
    equal(r.json, { a: 1 });
    equal(r.respostaId, "resp_1");
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: aoUsar recebe o custo certo (conta à mão)", async () => {
  const f = falso([json(ok())]);
  try {
    let uso: Uso | null = null;
    await responder({ ...base, aoUsar: (u) => { uso = u; } });
    // entrada 10000, cache leitura 4000, escrita 1000 → sem cache 5000
    const esperado = (5000 * 0.1 + 4000 * 0.01 + 1000 * 0.125 + 2000 * 0.5) / 1e6;
    perto((uso as unknown as Uso).custo_usd, esperado);
    perto(custoTokens("gpt-6-luna", { entrada: 10000, cacheLeitura: 4000, cacheEscrita: 1000, saida: 2000 }), esperado);
    equal((uso as unknown as Uso).tokens_cache_escrita, 1000);
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: aoUsar é chamado antes do parse (json inválido ainda cobra)", async () => {
  const f = falso([json(ok({ output_text: "não é json" }))]);
  try {
    let chamado = false;
    let erro: unknown = null;
    try {
      await responder({ ...base, schema: { nome: "s", schema: {} }, aoUsar: () => { chamado = true; } });
    } catch (e) {
      erro = e;
    }
    equal(chamado, true);
    equal((erro as OpenAIErro).codigo, "json_invalido");
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: 503 repete 1 vez e depois funciona", async () => {
  const f = falso([json({ error: { code: "x" } }, 503), json(ok())]);
  try {
    const r = await responder(base);
    equal(f.chamadas.length, 2);
    equal(r.texto, '{"a":1}');
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: 503 duas vezes → erro transitório http", async () => {
  const f = falso([json({}, 503), json({}, 503)]);
  try {
    let erro: unknown = null;
    try { await responder(base); } catch (e) { erro = e; }
    equal(f.chamadas.length, 2);
    equal((erro as OpenAIErro).codigo, "http");
    equal((erro as OpenAIErro).transitorio, true);
    equal((erro as OpenAIErro).message, "AI provider error: http (HTTP 503)");
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: timeout não repete", async () => {
  const f = falso([new DOMException("timeout", "TimeoutError"), json(ok())]);
  try {
    let erro: unknown = null;
    try { await responder(base); } catch (e) { erro = e; }
    equal(f.chamadas.length, 1);
    equal((erro as OpenAIErro).codigo, "timeout");
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: erro de rede repete", async () => {
  const f = falso([new TypeError("fetch failed"), json(ok())]);
  try {
    await responder(base);
    equal(f.chamadas.length, 2);
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: 400 não repete", async () => {
  const f = falso([json({ error: { code: "bad" } }, 400), json(ok())]);
  try {
    let erro: unknown = null;
    try { await responder(base); } catch (e) { erro = e; }
    equal(f.chamadas.length, 1);
    equal((erro as OpenAIErro).codigo, "http");
    equal((erro as OpenAIErro).transitorio, false);
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: 429 insufficient_quota → sem_saldo, sem retry", async () => {
  const f = falso([json({ error: { code: "insufficient_quota" } }, 429), json(ok())]);
  try {
    let erro: unknown = null;
    try { await responder(base); } catch (e) { erro = e; }
    equal(f.chamadas.length, 1);
    equal((erro as OpenAIErro).codigo, "sem_saldo");
  } finally {
    f.restaurar();
  }
});

for (const [nome, corpo] of [
  ["billing_not_active em type (corpo do canário)", { error: { type: "billing_not_active", code: "billing_not_active" } }],
  ["billing_not_active só em type", { error: { type: "billing_not_active", code: null } }],
  ["account_deactivated", { error: { code: "account_deactivated" } }],
  ["insufficient_quota em type com code genérico", { error: { code: "rate_limit_exceeded", type: "insufficient_quota" } }],
] as const) {
  Deno.test(`responder: 429 ${nome} → sem_saldo não transitório, sem retry`, async () => {
    const f = falso([json(corpo, 429), json(ok())]);
    try {
      let erro: unknown = null;
      try { await responder(base); } catch (e) { erro = e; }
      equal(f.chamadas.length, 1);
      equal((erro as OpenAIErro).codigo, "sem_saldo");
      equal((erro as OpenAIErro).transitorio, false);
    } finally {
      f.restaurar();
    }
  });
}

Deno.test("transcrever: 429 billing_not_active → sem_saldo", async () => {
  const f = falso([json({ error: { type: "billing_not_active", code: "billing_not_active" } }, 429)]);
  try {
    let erro: unknown = null;
    try { await transcrever({ chave: "k", bytes: new Uint8Array(4), mime: "audio/ogg", nomeArquivo: "a.ogg" }); } catch (e) { erro = e; }
    equal((erro as OpenAIErro).codigo, "sem_saldo");
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: relógio do sistema andando para trás não gera ms negativo (relógio monotônico)", async () => {
  const f = falso([json({ error: { code: "rate_limit_exceeded" } }, 500), json(ok())]);
  const dateNow = Date.now;
  let t = 1_700_000_000_000;
  Date.now = () => (t -= 1000); // cada leitura volta 1 s, como um ajuste de NTP
  const logs: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    await responder(base);
    await transcrever({ chave: "k", bytes: new Uint8Array(4), mime: "audio/ogg", nomeArquivo: "a.ogg" }).catch(() => {});
    equal(logs.length > 0, true);
    equal(logs.some((l) => /ms=-/.test(l)), false);
  } finally {
    Date.now = dateNow;
    console.error = err;
    f.restaurar();
  }
});

Deno.test("responder: 429 comum repete", async () => {
  const f = falso([json({ error: { code: "rate_limit_exceeded" } }, 429, { "retry-after": "0" }), json(ok())]);
  try {
    await responder(base);
    equal(f.chamadas.length, 2);
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: 401 com chave no corpo → message sem 'sk-'", async () => {
  const f = falso([json({ error: { code: "invalid_api_key", message: "Incorrect API key provided: sk-proj-abc123. You can find..." } }, 401)]);
  try {
    let erro: unknown = null;
    try { await responder(base); } catch (e) { erro = e; }
    equal((erro as OpenAIErro).codigo, "chave_invalida");
    equal((erro as Error).message.includes("sk-"), false);
    equal((erro as Error).message, "AI provider error: chave_invalida (HTTP 401)");
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: status incomplete → erro incompleta (e cobra)", async () => {
  const f = falso([json(ok({ status: "incomplete" }))]);
  try {
    let chamado = false;
    let erro: unknown = null;
    try { await responder({ ...base, aoUsar: () => { chamado = true; } }); } catch (e) { erro = e; }
    equal((erro as OpenAIErro).codigo, "incompleta");
    equal(chamado, true);
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: recusa e texto vindo de output[].content[]", async () => {
  let f = falso([json({ id: "r", status: "completed", output: [{ content: [{ type: "refusal", refusal: "não" }] }], usage: {} })]);
  try {
    let erro: unknown = null;
    try { await responder(base); } catch (e) { erro = e; }
    equal((erro as OpenAIErro).codigo, "recusa");
  } finally {
    f.restaurar();
  }
  f = falso([json({ id: "r", status: "completed", output: [{ content: [{ type: "output_text", text: "a" }, { type: "output_text", text: "b" }] }], usage: {} })]);
  try {
    equal((await responder(base)).texto, "ab");
  } finally {
    f.restaurar();
  }
});

Deno.test("responder: console.error não vaza chave nem corpo", async () => {
  const f = falso([json({ error: { code: "x", message: "sk-proj-SEGREDO123" } }, 400)]);
  const original = console.error;
  const logs: string[] = [];
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    try { await responder(base); } catch { /* esperado */ }
    equal(logs.some((l) => l.includes("SEGREDO") || l.includes("sk-")), false);
  } finally {
    console.error = original;
    f.restaurar();
  }
});

Deno.test("transcrever: manda model, language=pt, nome .ogg e mime limpo", async () => {
  const f = falso([json({ text: "olá", usage: { seconds: 30 } })]);
  try {
    let uso: Uso | null = null;
    const r = await transcrever({
      chave: "sk-x", bytes: new Uint8Array([1, 2, 3]), mime: "audio/ogg; codecs=opus", nomeArquivo: "audio.ogg",
      aoUsar: (u) => { uso = u; },
    });
    equal(f.chamadas[0].url, "https://api.openai.com/v1/audio/transcriptions");
    const form = f.chamadas[0].init.body as FormData;
    equal(form.get("model"), "gpt-transcribe");
    equal(form.get("language"), "pt");
    equal(form.get("response_format"), "json");
    const arq = form.get("file") as File;
    equal(arq.name, "audio.ogg");
    equal(arq.type, "audio/ogg");
    equal(r.texto, "olá");
    perto((uso as unknown as Uso).custo_usd, (30 / 60) * 0.0045);
    equal((uso as unknown as Uso).segundos_audio, 30);
  } finally {
    f.restaurar();
  }
});

Deno.test("transcrever: sem duração usa a estimativa por bytes", async () => {
  const f = falso([json({ text: "x" })]);
  try {
    const bytes = new Uint8Array(BYTES_POR_SEGUNDO_AUDIO * 60);
    const r = await transcrever({ chave: "k", bytes, mime: "audio/ogg", nomeArquivo: "audio.ogg" });
    perto(r.uso.custo_usd, 0.0045);
  } finally {
    f.restaurar();
  }
});

Deno.test("transcrever: timeout e 503 não repetem", async () => {
  let f = falso([new DOMException("t", "TimeoutError"), json({ text: "x" })]);
  try {
    let erro: unknown = null;
    try { await transcrever({ chave: "k", bytes: new Uint8Array(1), mime: "audio/ogg", nomeArquivo: "audio.ogg" }); } catch (e) { erro = e; }
    equal(f.chamadas.length, 1);
    equal((erro as OpenAIErro).codigo, "timeout");
  } finally {
    f.restaurar();
  }
  f = falso([json({}, 503), json({ text: "x" })]);
  try {
    let erro: unknown = null;
    try { await transcrever({ chave: "k", bytes: new Uint8Array(1), mime: "audio/ogg", nomeArquivo: "audio.ogg" }); } catch (e) { erro = e; }
    equal(f.chamadas.length, 1);
    equal((erro as OpenAIErro).codigo, "http");
  } finally {
    f.restaurar();
  }
});

Deno.test("estimarCusto", () => {
  const p = PRECOS["gpt-6-luna"];
  perto(
    estimarCusto({ tipo: "texto", modelo: "gpt-6-luna", charsEntrada: 3500, maxSaida: 1000 }),
    (1000 * p.entrada + 1000 * p.saida) / 1e6,
  );
  perto(
    estimarCusto({ tipo: "imagem", modelo: "gpt-6-luna", maxSaida: 900 }),
    (1600 * p.entrada + 900 * p.saida) / 1e6,
  );
  perto(
    estimarCusto({ tipo: "pdf", modelo: "gpt-6-luna", bytes: 204_800, maxSaida: 900 }),
    (3000 * p.entrada + 900 * p.saida) / 1e6,
  );
  perto(estimarCusto({ tipo: "transcricao", bytes: 3 * 1024 * 1024 }), (3 * 1024 * 1024 / 2000 / 60) * 0.0045);
});

Deno.test("custoTokens: modelo sem preço → 0", () => {
  const w = console.warn;
  console.warn = () => {};
  try {
    equal(custoTokens("modelo-x", { entrada: 100, cacheLeitura: 0, cacheEscrita: 0, saida: 100 }), 0);
  } finally {
    console.warn = w;
  }
});

Deno.test("base64DeBytes bate com btoa em arquivo maior que um bloco", () => {
  const bytes = new Uint8Array(100_003).map((_, i) => (i * 7) % 256);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  equal(base64DeBytes(bytes) === btoa(bin), true);
  equal(base64DeBytes(new Uint8Array(0)), "");
});
