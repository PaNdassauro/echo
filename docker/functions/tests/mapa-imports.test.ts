// Trava do runtime Docker das funções: nenhum import `https://` fica fora do mapa de imports e o lock não tem módulo remoto.
//
// Por quê: os fontes das funções importam do esm.sh (é o que o caminho Supabase Cloud/CLI usa), e o esm.sh já serviu bytes
// diferentes para a mesma URL versionada (erro de integridade no `deno cache --frozen` do build, no CI, doze minutos depois
// de um build que passou). No stack Docker o `docker/functions/deno.json` redireciona cada especificador para `npm:`, cujo
// tarball é imutável, e o lock congela a integridade. Especificador novo fora do mapa voltaria a baixar do host remoto:
// o build passaria hoje e quebraria quando esse host oscilasse. Este teste reprova os dois casos.
//
// deno test --config docker/functions/deno.json --allow-net=127.0.0.1 --allow-env --allow-read docker/functions/tests

const RAIZ = new URL("../../../", import.meta.url);
const CAMINHO_MAPA = "docker/functions/deno.json";
const CAMINHO_LOCK = "docker/functions/deno.lock";
// O que o Dockerfile apaga da imagem (testes e apoio de teste) não roda no runtime, então não entra na varredura.
const PASTAS = ["supabase/functions", "docker/functions"];
const IGNORADOS = /\.test\.ts$|\.test-helper\.ts$/;

type Achado = { arquivo: string; linha: number; especificador: string; forma: "import" | "export-from" | "import()" };

// import/export ... from "https://…" (inclui várias linhas e `import type`) e `import "https://…"` (efeito colateral).
// Ancorados no início da linha: comentário (// ou *) não casa.
const RE_ESTATICO = /^[ \t]*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])(https?:\/\/[^'"]+)\1/gm;
const RE_EFEITO = /^[ \t]*import\s*(['"])(https?:\/\/[^'"]+)\1/gm;
// import("https://…") literal; vale em qualquer ponto da linha, menos dentro de comentário de linha ou de bloco.
const RE_DINAMICO = /\bimport\(\s*(['"])(https?:\/\/[^'"]+)\1\s*\)/g;

function numeroDaLinha(texto: string, indice: number): number {
  let n = 1;
  for (let i = 0; i < indice; i++) if (texto.charCodeAt(i) === 10) n++;
  return n;
}

function emComentario(texto: string, indice: number): boolean {
  const inicioLinha = texto.lastIndexOf("\n", indice - 1) + 1;
  const antes = texto.slice(inicioLinha, indice);
  if (/^\s*(\/\/|\*|\/\*)/.test(antes) || /\/\/[^'"`]*$/.test(antes)) return true;
  // Bloco /* … */ que abre no início de uma linha (um "/*" dentro de string, como um glob, não conta).
  for (const bloco of texto.matchAll(/^[ \t]*\/\*[\s\S]*?\*\//gm)) {
    const ini = bloco.index ?? 0;
    if (indice >= ini && indice < ini + bloco[0].length) return true;
  }
  return false;
}

export function acharEspecificadoresRemotos(arquivo: string, texto: string): Achado[] {
  const achados: Achado[] = [];
  const coleta = (re: RegExp, forma: Achado["forma"], ignorarComentario: boolean) => {
    for (const m of texto.matchAll(re)) {
      const indice = m.index ?? 0;
      if (ignorarComentario && emComentario(texto, indice)) continue;
      const exporta = /^\s*export\b/.test(m[0]);
      achados.push({
        arquivo,
        linha: numeroDaLinha(texto, indice),
        especificador: m[2],
        forma: forma === "import" && exporta ? "export-from" : forma,
      });
    }
  };
  coleta(RE_ESTATICO, "import", false);
  coleta(RE_EFEITO, "import", false);
  coleta(RE_DINAMICO, "import()", true);
  return achados;
}

/** Cobertura como o import map: chave idêntica ao especificador, ou chave terminada em "/" que é prefixo dele. */
export function coberto(especificador: string, mapa: Record<string, string>): boolean {
  return Object.keys(mapa).some((chave) =>
    chave === especificador || (chave.endsWith("/") && especificador.startsWith(chave))
  );
}

function pacoteDoEsm(especificador: string): string | null {
  const m = especificador.match(/^https:\/\/esm\.sh\/((?:@[^/@]+\/)?[^/@]+@[^/?#]+)$/);
  return m ? m[1] : null;
}

/** O que acrescentar ao `imports` de docker/functions/deno.json para cobrir o especificador. */
export function sugestao(especificador: string): string {
  const pacote = pacoteDoEsm(especificador);
  return pacote
    ? `"${especificador}": "npm:${pacote}"`
    : `"${especificador}": "npm:<pacote>@<versão>"  (ou um shim local em ./shim/, como o do deno.land/std)`;
}

const VERSAO_EXATA = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** "npm:@escopo/nome@1.2.3" -> { nome: "@escopo/nome", versao: "1.2.3" }; null se não for npm: com @versão. */
function pacoteNpm(alvo: string): { nome: string; versao: string } | null {
  const m = alvo.match(/^npm:((?:@[^/@]+\/)?[^/@]+)@(.+)$/);
  return m ? { nome: m[1], versao: m[2] } : null;
}

/**
 * Cada `npm:` do mapa tem de estar no lock e ter a MESMA versão exata da URL do esm.sh que ele substitui (é o que o Supabase
 * Cloud roda a partir do fonte). Intervalo (^, ~, *) deixaria cada regeneração do lock escolher a versão do dia. O alias sem URL
 * (ex.: "@supabase/supabase-js") tem de bater com a entrada do esm.sh do mesmo pacote.
 */
export function conferirVersoes(mapa: Record<string, string>, especificadores: Record<string, string>): string[] {
  const problemas: string[] = [];
  const doEsm = new Map<string, string>(); // nome do pacote -> alvo npm: da chave esm.sh
  for (const [chave, alvo] of Object.entries(mapa)) {
    const pacoteEsm = pacoteDoEsm(chave);
    if (pacoteEsm !== null) doEsm.set(pacoteEsm.slice(0, pacoteEsm.lastIndexOf("@")), alvo);
  }
  for (const [chave, alvo] of Object.entries(mapa)) {
    if (!alvo.startsWith("npm:")) continue;
    const npm = pacoteNpm(alvo);
    if (!npm || !VERSAO_EXATA.test(npm.versao)) {
      problemas.push(`"${chave}" -> ${alvo}: o alvo npm: precisa de versão exata (nada de ^, ~, * nem intervalo)`);
    } else {
      const pacoteEsm = pacoteDoEsm(chave);
      if (pacoteEsm !== null && alvo !== `npm:${pacoteEsm}`) {
        problemas.push(`"${chave}" -> ${alvo}: a versão tem de ser a da URL (esperado "npm:${pacoteEsm}")`);
      }
      const irmao = doEsm.get(npm.nome);
      if (pacoteEsm === null && irmao !== undefined && irmao !== alvo) {
        problemas.push(`"${chave}" -> ${alvo}: o alias tem de apontar para o mesmo que a URL do esm.sh (${irmao})`);
      }
    }
    const resolvido = especificadores[alvo];
    if (resolvido === undefined) {
      problemas.push(`"${chave}" -> ${alvo} não está em "specifiers" do lock (lock desatualizado)`);
    } else if (npm && VERSAO_EXATA.test(npm.versao) && !resolvido.startsWith(npm.versao)) {
      problemas.push(`"${chave}" -> ${alvo} resolveu no lock para ${resolvido}, não para ${npm.versao}`);
    }
  }
  return problemas;
}

async function listarTs(pasta: URL, relativo: string, saida: string[]): Promise<void> {
  for await (const e of Deno.readDir(pasta)) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const rel = `${relativo}/${e.name}`;
    if (e.isDirectory) await listarTs(new URL(`${e.name}/`, pasta), rel, saida);
    else if (e.isFile && /\.(ts|tsx|mts)$/.test(e.name) && !IGNORADOS.test(e.name)) saida.push(rel);
  }
}

async function lerJson(caminho: string): Promise<Record<string, unknown>> {
  const bruto = await Deno.readTextFile(new URL(caminho, RAIZ));
  return JSON.parse(bruto) as Record<string, unknown>;
}

async function mapaDeImports(): Promise<Record<string, string>> {
  const cfg = await lerJson(CAMINHO_MAPA);
  const imports = cfg.imports;
  if (!imports || typeof imports !== "object") throw new Error(`${CAMINHO_MAPA} sem "imports"`);
  return imports as Record<string, string>;
}

Deno.test("todo import https:// das funções e do runtime está no mapa de imports do Docker", async () => {
  const mapa = await mapaDeImports();
  const arquivos: string[] = [];
  for (const p of PASTAS) await listarTs(new URL(`${p}/`, RAIZ), p, arquivos);
  if (arquivos.length < 50) throw new Error(`varredura achou só ${arquivos.length} arquivos .ts: caminho errado?`);

  const faltando: Achado[] = [];
  let total = 0;
  for (const arquivo of arquivos) {
    const texto = await Deno.readTextFile(new URL(arquivo, RAIZ));
    for (const a of acharEspecificadoresRemotos(arquivo, texto)) {
      total++;
      if (!coberto(a.especificador, mapa)) faltando.push(a);
    }
  }
  if (total < 20) throw new Error(`varredura achou só ${total} imports https://: o detector quebrou?`);
  if (faltando.length > 0) {
    const unicos = [...new Set(faltando.map((f) => f.especificador))];
    throw new Error(
      `${unicos.length} especificador(es) https:// fora do mapa de imports de ${CAMINHO_MAPA} ` +
        `(no Docker o build baixaria do host remoto, que pode servir outros bytes para a mesma URL):\n` +
        faltando.map((f) => `  ${f.arquivo}:${f.linha} ${f.forma} ${f.especificador}`).join("\n") +
        `\nAcrescente em "imports" de ${CAMINHO_MAPA}:\n` +
        unicos.map((u) => `  ${sugestao(u)}`).join("\n") +
        `\ne regenere o lock: deno cache --frozen=false --config ${CAMINHO_MAPA} docker/functions/main.ts ` +
        `supabase/functions/*/index.ts docker/functions/echo-admin.ts (detalhes em docs/development.md).`,
    );
  }
});

Deno.test("o lock não tem módulo remoto, e cada npm: do mapa está nele com integridade", async () => {
  const lock = await lerJson(CAMINHO_LOCK);
  const problemas: string[] = [];

  const remote = (lock.remote ?? {}) as Record<string, string>;
  for (const url of Object.keys(remote)) problemas.push(`módulo remoto no lock: ${url}`);
  const redirects = (lock.redirects ?? {}) as Record<string, string>;
  for (const [de, para] of Object.entries(redirects)) problemas.push(`redirect no lock: ${de} -> ${para}`);

  const especificadores = (lock.specifiers ?? {}) as Record<string, string>;
  const pacotes = (lock.npm ?? {}) as Record<string, { integrity?: string }>;
  for (const [nome, p] of Object.entries(pacotes)) {
    if (!p.integrity) problemas.push(`pacote npm sem integridade no lock: ${nome}`);
  }

  problemas.push(...conferirVersoes(await mapaDeImports(), especificadores));

  if (problemas.length > 0) {
    throw new Error(
      `${CAMINHO_LOCK} fora do combinado (só npm:, com integridade, cobrindo o mapa):\n  ${problemas.join("\n  ")}\n` +
        `Cada especificador https:// precisa de uma entrada npm: em "imports" de ${CAMINHO_MAPA}; depois regenere o lock: ` +
        `deno cache --frozen=false --config ${CAMINHO_MAPA} docker/functions/main.ts supabase/functions/*/index.ts ` +
        `docker/functions/echo-admin.ts`,
    );
  }
});

// ---- o próprio detector ----

Deno.test("detector: acha import estático, multilinha, export-from, efeito colateral e import() literal", () => {
  const texto = [
    `import { a } from 'https://esm.sh/a@1.0.0';`,
    `import type {`,
    `  B,`,
    `  C,`,
    `} from "https://esm.sh/b@2.0.0";`,
    `export * from 'https://esm.sh/c@3.0.0';`,
    `import 'https://esm.sh/d@4.0.0';`,
    `const m = await import('https://esm.sh/e@5.0.0');`,
    `import { local } from './local.ts';`,
    `import x from "npm:nodemailer@10.3.1";`,
  ].join("\n");
  const achados = acharEspecificadoresRemotos("x.ts", texto);
  const esperado = ["a@1.0.0", "b@2.0.0", "c@3.0.0", "d@4.0.0", "e@5.0.0"].map((s) => `https://esm.sh/${s}`);
  const obtido = achados.map((a) => a.especificador).sort();
  if (JSON.stringify(obtido) !== JSON.stringify(esperado)) {
    throw new Error(`esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);
  }
  const formas = Object.fromEntries(achados.map((a) => [a.especificador.slice(-5), a.forma]));
  if (formas["1.0.0"] !== "import" || formas["3.0.0"] !== "export-from" || formas["5.0.0"] !== "import()") {
    throw new Error(`formas erradas: ${JSON.stringify(formas)}`);
  }
  const linhaDe = (s: string) => achados.find((a) => a.especificador.endsWith(s))?.linha;
  if (linhaDe("b@2.0.0") !== 2 || linhaDe("e@5.0.0") !== 8) throw new Error("número de linha errado");
});

Deno.test("detector: ignora comentários, strings que não são import e URLs comuns", () => {
  const texto = [
    `// import { a } from 'https://esm.sh/a@1.0.0';`,
    `/**`,
    ` * import('https://esm.sh/b@2.0.0')`,
    ` * import { z } from "https://esm.sh/zod@3.23.8";`,
    ` */`,
    `const url = 'https://esm.sh/c@3.0.0';`,
    `const g = \`https://graph.instagram.com/\${v}\`;`,
    `await fetch("https://api.openai.com/v1/x");`,
    `// await import('https://esm.sh/d@4.0.0')`,
  ].join("\n");
  const achados = acharEspecificadoresRemotos("x.ts", texto);
  if (achados.length !== 0) throw new Error(`falso positivo: ${JSON.stringify(achados)}`);
});

Deno.test("cobertura: chave exata ou prefixo com barra final; sugestão de entrada npm:", () => {
  const mapa = { "https://esm.sh/zod@3.23.8": "npm:zod@3.23.8", "https://deno.land/std@0.168.0/": "./shim/" };
  if (!coberto("https://esm.sh/zod@3.23.8", mapa)) throw new Error("chave exata");
  if (!coberto("https://deno.land/std@0.168.0/http/server.ts", mapa)) throw new Error("prefixo com barra");
  if (coberto("https://esm.sh/zod@3.23.9", mapa)) throw new Error("versão diferente não é coberta");
  if (coberto("https://esm.sh/zod@3.23.8/lib/x.js", mapa)) throw new Error("subcaminho não é coberto por chave exata");
  const s = sugestao("https://esm.sh/@supabase/storage-js@2.87.1");
  if (s !== `"https://esm.sh/@supabase/storage-js@2.87.1": "npm:@supabase/storage-js@2.87.1"`) throw new Error(s);
});

Deno.test("versões: o npm: do mapa tem de ser a versão exata da URL do esm.sh e estar resolvido no lock", () => {
  const lock = { "npm:date-fns@3.6.0": "3.6.0", "npm:zod@3.23.8": "3.23.8" };
  const ok = {
    "https://esm.sh/date-fns@3.6.0": "npm:date-fns@3.6.0",
    "zod": "npm:zod@3.23.8",
    "https://esm.sh/zod@3.23.8": "npm:zod@3.23.8",
    "https://deno.land/std@0.168.0/http/server.ts": "./shim/std_server.ts",
  };
  const base = conferirVersoes(ok, lock);
  if (base.length !== 0) throw new Error(`falso positivo: ${base.join(" | ")}`);

  const casos: Array<[string, Record<string, string>, Record<string, string>, RegExp]> = [
    ["intervalo ^", { "https://esm.sh/date-fns@3.6.0": "npm:date-fns@^3" }, { "npm:date-fns@^3": "3.6.1" }, /versão exata/],
    ["versão diferente da URL", { "https://esm.sh/date-fns@3.6.0": "npm:date-fns@3.6.1" }, { "npm:date-fns@3.6.1": "3.6.1" }, /versão tem de ser a da URL/],
    ["pacote diferente da URL", { "https://esm.sh/date-fns@3.6.0": "npm:dayjs@3.6.0" }, { "npm:dayjs@3.6.0": "3.6.0" }, /versão tem de ser a da URL/],
    ["sem versão", { "https://esm.sh/date-fns@3.6.0": "npm:date-fns" }, { "npm:date-fns": "3.6.0" }, /versão exata/],
    ["lock resolveu outra versão", { "https://esm.sh/date-fns@3.6.0": "npm:date-fns@3.6.0" }, { "npm:date-fns@3.6.0": "3.7.0" }, /resolveu no lock para 3\.7\.0/],
    ["fora do lock", { "https://esm.sh/date-fns@3.6.0": "npm:date-fns@3.6.0" }, {}, /não está em "specifiers"/],
    [
      "alias diverge da URL",
      { "https://esm.sh/zod@3.23.8": "npm:zod@3.23.8", "zod": "npm:zod@3.24.0" },
      { "npm:zod@3.23.8": "3.23.8", "npm:zod@3.24.0": "3.24.0" },
      /alias tem de apontar/,
    ],
  ];
  for (const [nome, mapa, especificadores, esperado] of casos) {
    const problemas = conferirVersoes(mapa, especificadores);
    if (!problemas.some((p) => esperado.test(p))) {
      throw new Error(`"${nome}" não foi pego (esperado ${esperado}); obtido: ${JSON.stringify(problemas)}`);
    }
  }
});
