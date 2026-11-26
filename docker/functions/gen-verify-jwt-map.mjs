#!/usr/bin/env node
// Gera o mapa { "<função>": verify_jwt } que o roteador de docker/functions aplica por função.
//
//   node docker/functions/gen-verify-jwt-map.mjs <pasta supabase/functions> <supabase/config.toml> [--out arquivo.json]
//
// Regras (as mesmas do `supabase functions deploy`):
//   - Toda pasta com index.ts que não começa com "_" é uma função.
//   - verify_jwt vem de [functions.<nome>] no config.toml. Função sem entrada = true (fecha por padrão).
//   - Entrada no config.toml sem pasta = erro (config apontando para função que não existe).
//   - Função cujo index.ts declara `jwtVerifiedByGateway: true` com verify_jwt = false = erro: essa combinação
//     aceitaria um JWT `service_role` forjado (_shared/authz.ts, isInternalCaller, item 3).
// Sem dependências: o config.toml do Echo só usa `[functions.x]` + `verify_jwt = true|false` nessas seções.
// Roda em Node (CI, `npm run check:verify-jwt`) e em Deno (build da imagem); as funções exportadas são testadas em
// docker/functions/tests/gen-verify-jwt-map.test.ts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Pastas de `dir` que são funções (têm index.ts e o nome não começa com "_"), em ordem alfabética. */
export function listarFuncoes(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(dir, d.name, "index.ts")))
    .map((d) => d.name)
    .sort();
}

/**
 * `verify_jwt` declarado em cada `[functions.<nome>]` do config.toml (texto).
 * @param {string} texto
 * @returns {Record<string, boolean>}
 */
export function lerDeclarado(texto) {
  /** @type {Record<string, boolean>} */
  const declarado = {};
  let secao = null;
  for (const bruta of texto.split("\n")) {
    const linha = bruta.replace(/#.*$/, "").trim();
    if (!linha) continue;
    const s = linha.match(/^\[([^\]]+)\]$/);
    if (s) {
      const m = s[1].match(/^functions\.("?)([A-Za-z0-9_-]+)\1$/);
      secao = m ? m[2] : null;
      continue;
    }
    if (secao) {
      const v = linha.match(/^verify_jwt\s*=\s*(true|false)$/);
      if (v) declarado[secao] = v[1] === "true";
    }
  }
  return declarado;
}

/**
 * Monta o mapa e as violações. `lerIndex(nome)` devolve o texto do index.ts da função.
 * @param {string[]} funcoes
 * @param {Record<string, boolean>} declarado
 * @param {(nome: string) => string} lerIndex
 */
export function montarMapa(funcoes, declarado, lerIndex) {
  /** @type {Record<string, boolean>} */
  const mapa = {};
  for (const f of funcoes) mapa[f] = declarado[f] ?? true;
  return {
    mapa,
    orfas: Object.keys(declarado).filter((n) => !funcoes.includes(n)),
    confiaNoGateway: funcoes.filter(
      (f) => mapa[f] === false && /jwtVerifiedByGateway\s*:\s*true/.test(lerIndex(f)),
    ),
    semEntrada: funcoes.filter((f) => !(f in declarado)),
  };
}

function main() {
  const [dir, toml, ...resto] = process.argv.slice(2);
  if (!dir || !toml) {
    process.stderr.write("uso: gen-verify-jwt-map.mjs <functions> <config.toml> [--out arquivo]\n");
    process.exit(2);
  }
  const out = resto[0] === "--out" ? resto[1] : null;

  const funcoes = listarFuncoes(dir);
  const declarado = lerDeclarado(readFileSync(toml, "utf8"));
  const { mapa, orfas, confiaNoGateway, semEntrada } = montarMapa(funcoes, declarado, (f) =>
    readFileSync(join(dir, f, "index.ts"), "utf8"),
  );

  if (orfas.length) {
    process.stderr.write(`config.toml declara funções sem pasta: ${orfas.join(", ")}\n`);
    process.exit(1);
  }
  if (confiaNoGateway.length) {
    process.stderr.write(
      `verify_jwt = false em função que confia no gateway (jwtVerifiedByGateway: true): ${confiaNoGateway.join(", ")}\n`,
    );
    process.exit(1);
  }

  const texto = JSON.stringify(mapa, null, 2) + "\n";
  if (out) writeFileSync(out, texto);
  else process.stdout.write(texto);
  process.stderr.write(
    `funções: ${funcoes.length}; verify_jwt=false: ${funcoes.filter((f) => !mapa[f]).length}; ` +
      `sem entrada no config.toml (=true): ${semEntrada.length}${semEntrada.length ? " (" + semEntrada.join(", ") + ")" : ""}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
