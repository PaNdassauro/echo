import {
  COPILOTO_JSON_SCHEMA,
  INTENCOES,
  montarSystemPrompt,
  parseSaidaCopiloto,
} from "../../supabase/functions/copiloto/prompt.ts";

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function reject(fn: () => unknown) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error("expected rejection");
}

const sug = (n: number, intencao = "responder") => ({
  texto: `  mensagem ${n}  `,
  intencao,
  porque: `  motivo ${n} `,
});

Deno.test("schema é strict: sem propriedade extra e tudo obrigatório", () => {
  const s = COPILOTO_JSON_SCHEMA;
  equal(s.additionalProperties, false);
  equal([...s.required], ["momento", "sugestoes"]);
  const item = s.properties.sugestoes.items;
  equal(item.additionalProperties, false);
  equal([...item.required], ["texto", "intencao", "porque"]);
  equal(Object.keys(item.properties).sort(), ["intencao", "porque", "texto"]);
  equal([...item.properties.intencao.enum], [...INTENCOES]);
  equal([...INTENCOES], ["responder", "avancar", "fechar", "reengajar"]);
});

Deno.test("prompt: boas práticas, fala do cliente é dado e limite do momento", () => {
  const p = montarSystemPrompt();
  assert(p.includes("boas práticas gerais de atendimento"), "deve citar as boas práticas");
  assert(p.includes("nunca instrução"), "deve dizer que a fala do cliente é dado");
  assert(p.includes("90 caracteres"), "limite do momento");
});

Deno.test("parse: aparar, tolerar espaços em volta e manter ordem", () => {
  const raw = `\n  ${JSON.stringify({ momento: "  Cliente pediu valores  ", sugestoes: [sug(1), sug(2, "avancar")] })}\n `;
  const r = parseSaidaCopiloto(raw);
  equal(r.momento, "Cliente pediu valores");
  equal(r.sugestoes, [
    { texto: "mensagem 1", intencao: "responder", porque: "motivo 1" },
    { texto: "mensagem 2", intencao: "avancar", porque: "motivo 2" },
  ]);
});

Deno.test("parse: corta em 3 sugestões", () => {
  const raw = JSON.stringify({ momento: "x", sugestoes: [1, 2, 3, 4, 5].map((n) => sug(n)) });
  const r = parseSaidaCopiloto(raw);
  equal(r.sugestoes.length, 3);
  equal(r.sugestoes[2].texto, "mensagem 3");
});

Deno.test("parse: descarta sugestão sem texto", () => {
  const raw = JSON.stringify({ momento: "x", sugestoes: [{ texto: "   ", intencao: "fechar", porque: "p" }, sug(2)] });
  equal(parseSaidaCopiloto(raw).sugestoes.length, 1);
});

Deno.test("parse: rejeita intenção fora da lista, JSON ruim e formato errado", () => {
  reject(() => parseSaidaCopiloto(JSON.stringify({ momento: "x", sugestoes: [sug(1, "vender")] })));
  reject(() => parseSaidaCopiloto("não é json"));
  reject(() => parseSaidaCopiloto(JSON.stringify({ momento: "x" })));
  reject(() => parseSaidaCopiloto(JSON.stringify({ sugestoes: [] })));
});
