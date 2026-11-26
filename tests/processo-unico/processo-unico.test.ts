// deno test --no-config --allow-env --allow-read --allow-sys tests/processo-unico
//
// Mitigação do processo único (SPEC 3.7, D28): o roteador de docker/functions roda todas as funções no mesmo
// processo, então o código de produção em supabase/functions não pode ter estado de módulo mutável, configuração
// global de biblioteca, escrita em globalThis/ambiente nem import(variável). As fixtures abaixo cobrem cada regra;
// o último teste varre o código real.
import { escanear, escanearPasta, type Regra } from "./scanner.ts";

function igual<T>(a: T, b: T, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
  }
}

function regrasDe(fonte: string): Regra[] {
  return escanear("fixture.ts", fonte)
    .filter((o) => !o.escapada)
    .map((o) => o.regra);
}

Deno.test("let e var de topo são recusados; dentro de função, não", () => {
  igual(regrasDe("let contador = 0;\n"), ["let-var-de-topo"], "let");
  igual(regrasDe("var x = 1;\n"), ["let-var-de-topo"], "var");
  igual(regrasDe("let a = 1, b = 2;\n"), ["let-var-de-topo"], "let com dois nomes");
  igual(regrasDe("function f() { let local = 0; var v = 1; return local + v; }\n"), [], "dentro de função");
  igual(regrasDe("const f = () => { let local = 0; return local; };\n"), [], "dentro de arrow");
  igual(regrasDe("if (true) {\n  let preso = 1;\n  console.log(preso);\n}\n"), ["let-var-de-topo"], "bloco de topo");
});

Deno.test("const Map/Set/[]/{} de topo mutado é recusado", () => {
  igual(
    regrasDe("const cache = new Map<string, number>();\nexport function g(k: string) { cache.set(k, 1); }\n"),
    ["estado-mutavel-de-topo"],
    "Map.set",
  );
  igual(
    regrasDe("const vistos = new Set<string>();\nexport function g(k: string) { vistos.add(k); }\n"),
    ["estado-mutavel-de-topo"],
    "Set.add",
  );
  igual(
    regrasDe("const fila: string[] = [];\nexport function g(k: string) { fila.push(k); }\n"),
    ["estado-mutavel-de-topo"],
    "[].push",
  );
  igual(
    regrasDe("const estado = {} as Record<string, number>;\nexport function g(k: string) { estado[k] = 1; }\n"),
    ["estado-mutavel-de-topo"],
    "{}[k] =",
  );
  igual(
    regrasDe("const estado = { n: 0 };\nexport function g() { estado.n = 1; }\n"),
    ["estado-mutavel-de-topo"],
    "{}.campo =",
  );
  igual(
    regrasDe("const estado = { n: 0 };\nexport function g() { estado.n++; }\n"),
    ["estado-mutavel-de-topo"],
    "{}.campo++",
  );
  igual(
    regrasDe("const mapa = new Map<string, number>();\nexport function g(k: string) { mapa.delete(k); mapa.clear(); }\n"),
    ["estado-mutavel-de-topo"],
    "delete e clear viram uma ocorrência só",
  );
  igual(
    regrasDe("const base = { a: 1 };\nexport function g() { Object.assign(base, { b: 2 }); }\n"),
    ["estado-mutavel-de-topo"],
    "Object.assign",
  );
  igual(
    regrasDe("const base: Record<string, number> = { a: 1 };\nexport function g() { delete base.a; }\n"),
    ["estado-mutavel-de-topo"],
    "delete base.a",
  );
});

Deno.test("const de topo só lido, e variável local homônima, passam", () => {
  igual(
    regrasDe("const PERMITIDOS = new Set(['a', 'b']);\nexport const ok = (x: string) => PERMITIDOS.has(x);\n"),
    [],
    "Set só de leitura",
  );
  igual(regrasDe("const TABELA = { a: 1 };\nexport const ler = () => TABELA.a;\n"), [], "objeto só lido");
  igual(
    regrasDe("const itens: string[] = [];\nexport function g() { const itens: string[] = []; itens.push('x'); return itens; }\n"),
    [],
    "variável local com o mesmo nome",
  );
  igual(
    regrasDe("const itens: string[] = [];\nexport function g(itens: string[]) { itens.push('x'); }\n"),
    [],
    "parâmetro com o mesmo nome",
  );
  igual(regrasDe("const f = () => new Map<string, number>();\nexport const m = f();\n"), [], "fábrica não é estado de topo");
});

Deno.test("configuração global de biblioteca no topo é recusada; dentro de função, não", () => {
  igual(
    regrasDe("import webpush from 'npm:web-push';\nwebpush.setVapidDetails('mailto:a@b.c', 'x', 'y');\n"),
    ["configuracao-global-de-biblioteca"],
    "setVapidDetails no topo",
  );
  igual(regrasDe("lib.configure({ a: 1 });\n"), ["configuracao-global-de-biblioteca"], "configure no topo");
  igual(regrasDe("lib.init();\n"), ["configuracao-global-de-biblioteca"], "init no topo");
  igual(
    regrasDe("export function handler() { webpush.setVapidDetails('mailto:a@b.c', 'x', 'y'); }\n"),
    [],
    "dentro de função",
  );
  igual(regrasDe("console.log('subiu');\n"), [], "console no topo é inofensivo");
});

Deno.test("escrita em globalThis é recusada", () => {
  igual(regrasDe("globalThis.cache = new Map();\n"), ["escrita-em-globalthis"], "atribuição");
  igual(regrasDe("(globalThis as Record<string, unknown>).x = 1;\n"), ["escrita-em-globalthis"], "atribuição com cast");
  igual(regrasDe("export function f() { globalThis['x'] = 1; }\n"), ["escrita-em-globalthis"], "dentro de função");
  igual(regrasDe("Reflect.set(globalThis, 'x', 1);\n"), ["escrita-em-globalthis"], "Reflect.set");
  igual(regrasDe("Object.defineProperty(globalThis, 'x', { value: 1 });\n"), ["escrita-em-globalthis"], "defineProperty");
  igual(regrasDe("export const f = () => globalThis.fetch;\n"), [], "ler globalThis é permitido");
  igual(
    regrasDe("export function f(globalThis: Record<string, number>) { globalThis.x = 1; }\n"),
    [],
    "parâmetro que esconde o global",
  );
});

Deno.test("Deno.env.set e Deno.env.delete são recusados; Deno.env.get, não", () => {
  igual(regrasDe("Deno.env.set('A', '1');\n"), ["env-mutado"], "set");
  igual(regrasDe("export function f() { Deno.env.delete('A'); }\n"), ["env-mutado"], "delete");
  igual(regrasDe("export const a = Deno.env.get('A');\n"), [], "get");
});

Deno.test("import() com argumento não literal é recusado; literal, não", () => {
  igual(regrasDe("export async function f(u: string) { return await import(u); }\n"), ["import-dinamico-nao-literal"], "variável");
  igual(
    regrasDe("const URL_X = 'https://esm.sh/x';\nexport const f = () => import(URL_X);\n"),
    ["import-dinamico-nao-literal"],
    "constante",
  );
  igual(
    regrasDe("export const f = (n: string) => import(`./${n}.ts`);\n"),
    ["import-dinamico-nao-literal"],
    "template com expressão",
  );
  igual(regrasDe("export const f = () => import('npm:nodemailer@10.3.1');\n"), [], "literal");
  igual(regrasDe("export const f = () => import(`npm:nodemailer@10.3.1`);\n"), [], "template sem expressão");
});

Deno.test("o escape '// processo-unico: <motivo>' na linha anterior marca a ocorrência como escapada", () => {
  const fonte = [
    "// processo-unico: cache de metadados públicos, igual para toda organização",
    "const cache = new Map<string, string>();",
    "export function g(k: string) { cache.set(k, 'v'); }",
    "",
    "let solto = 0;",
  ].join("\n");
  const o = escanear("fixture.ts", fonte);
  igual(o.length, 2, "duas ocorrências");
  igual(o[0].escapada, true, "a do Map está escapada");
  igual(o[0].motivo, "cache de metadados públicos, igual para toda organização", "motivo guardado");
  igual(o[1].escapada, false, "a do let não");
  const semMotivo = escanear("fixture.ts", "// processo-unico:\nlet x = 0;\n");
  igual(semMotivo[0].escapada, false, "escape sem motivo não vale");
});

Deno.test("regex, template e comentário com chaves e aspas não confundem a análise", () => {
  const fonte = [
    "const RE = /[{}'\"`]+/g;",
    "const texto = `abre { ${'}'} fecha`;",
    "// let x = 1; globalThis.y = 2; Deno.env.set('A', '1');",
    "export const f = () => RE.test(texto);",
  ].join("\n");
  igual(regrasDe(fonte), [], "nada a reportar");
});

Deno.test("o código real de supabase/functions não tem ocorrência sem escape", async () => {
  const todas = await escanearPasta(new URL("../../supabase/functions", import.meta.url).pathname);
  const abertas = todas.filter((o) => !o.escapada);
  if (abertas.length > 0) {
    const linhas = abertas.map((o) => `${o.arquivo}:${o.linha} [${o.regra}] ${o.detalhe}`);
    throw new Error(`estado compartilhado entre funções (processo único):\n${linhas.join("\n")}`);
  }
  for (const o of todas) {
    // Cada escape novo aparece no relatório: o teste imprime o motivo.
    console.log(`escape: ${o.arquivo}:${o.linha} [${o.regra}] ${o.motivo}`);
  }
});
