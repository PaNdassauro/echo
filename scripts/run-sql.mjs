#!/usr/bin/env node
/**
 * Executa um arquivo .sql no Postgres do Supabase via Management API.
 *
 * A REST (PostgREST) com sb_secret_ não executa SQL arbitrário; a Management
 * API é o caminho suportado e usa o access token pessoal (sbp_) gravado pelo
 * `supabase login` em ~/.supabase/access-token.
 *
 * A API devolve apenas o resultado do ÚLTIMO statement do batch. Para ver
 * várias consultas, separe-as no .sql com uma linha `-- @@ Título`: cada bloco
 * vira uma request e tem o resultado impresso sob esse título.
 *
 * Uso:
 *   node scripts/run-sql.mjs <arquivo.sql> --ref <project_ref> [--dry-run] [--raw]
 *
 * O ref do projeto é obrigatório: `--ref <project_ref>` ou a env
 * SUPABASE_PROJECT_REF. Não existe projeto padrão, para um SQL nunca cair no
 * banco errado por esquecimento. Para o Postgres local (`supabase start`) use
 * `psql` ou o Studio; este script só fala com a Management API.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parseArgs(argv) {
  const args = { file: null, ref: process.env.SUPABASE_PROJECT_REF || null, dryRun: false, raw: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ref") {
      args.ref = argv[++i];
    } else if (argv[i] === "--dry-run") {
      args.dryRun = true;
    } else if (argv[i] === "--raw") {
      // Sem prelúdio: o bloco vai sozinho. Obrigatório para CREATE/DROP INDEX
      // CONCURRENTLY — com dois statements a API envolve tudo numa transação
      // e o Postgres recusa com 25001.
      args.raw = true;
    } else if (!args.file) {
      args.file = argv[i];
    }
  }
  return args;
}

function readToken() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    return readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
  } catch {
    throw new Error(
      "Access token não encontrado. Defina SUPABASE_ACCESS_TOKEN ou rode `supabase login`."
    );
  }
}

/** Renderiza array de objetos como tabela de largura fixa. */
function printTable(rows) {
  if (rows.length === 0) {
    console.log("(0 linhas)");
    return;
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => (v === null ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const width = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))])
  );
  const line = (parts) => parts.join("  ");
  console.log(line(cols.map((c) => c.padEnd(width[c]))));
  console.log(line(cols.map((c) => "─".repeat(width[c]))));
  for (const row of rows) {
    console.log(line(cols.map((c) => cell(row[c]).padEnd(width[c]))));
  }
  console.log(`\n(${rows.length} linha${rows.length === 1 ? "" : "s"})`);
}

/** Divide o arquivo nos marcadores `-- @@ Título`. Sem marcador, um bloco só. */
function splitBlocks(sql) {
  const blocks = [];
  let title = null;
  let buffer = [];
  for (const line of sql.split("\n")) {
    const marker = line.match(/^--\s*@@\s*(.*)$/);
    if (marker) {
      if (buffer.join("").trim()) blocks.push({ title, sql: buffer.join("\n") });
      title = marker[1].trim() || null;
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  if (buffer.join("").trim()) blocks.push({ title, sql: buffer.join("\n") });
  return blocks;
}

async function runBlock({ ref, token, sql }) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const err = JSON.parse(text);
      message = err.message || err.error || text;
    } catch {
      /* corpo não-JSON: usa cru */
    }
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const { file, ref, dryRun, raw } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error("Uso: node scripts/run-sql.mjs <arquivo.sql> --ref <project_ref> [--dry-run] [--raw]");
    process.exit(2);
  }
  if (!ref) {
    console.error("Informe o projeto: --ref <project_ref> ou a env SUPABASE_PROJECT_REF.");
    process.exit(2);
  }

  const sql = readFileSync(file, "utf8");
  const token = readToken();
  const blocks = splitBlocks(sql);

  // O GUC controla o dry-run dos scripts de migração. No modo normal ele é
  // explicitamente resetado: a Management API reusa conexões do pool, e um
  // dry-run anterior deixaria o valor ligado na sessão herdada.
  const prelude = raw
    ? ""
    : dryRun
      ? "SET echo.migrate_dry_run = 'on';\n"
      : "RESET echo.migrate_dry_run;\n";

  console.error(
    `→ ${file}  (projeto ${ref}, ${sql.length} bytes, ${blocks.length} bloco(s))` +
      (dryRun ? "  [DRY RUN — nada será gravado]" : "")
  );
  const started = Date.now();

  for (const [i, block] of blocks.entries()) {
    if (blocks.length > 1) {
      console.log(`\n── ${block.title || `bloco ${i + 1}`} ──\n`);
    }
    let payload;
    try {
      payload = await runBlock({ ref, token, sql: prelude + block.sql });
    } catch (err) {
      // O dry-run termina com um RAISE EXCEPTION deliberado que carrega o
      // placar da execução — é sucesso, não falha.
      if (/DRY RUN OK/.test(err.message)) {
        console.log(err.message.replace(/^.*?DRY RUN OK/, "DRY RUN OK").replace(/ \| /g, "\n  "));
        console.error(`\n✓ dry run concluído e revertido em ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return;
      }
      console.error(`\n✗ HTTP ${err.status ?? "?"} no bloco ${i + 1}${block.title ? ` (${block.title})` : ""}\n`);
      console.error(err.message);
      process.exit(1);
    }
    if (Array.isArray(payload)) {
      printTable(payload);
    } else {
      console.log(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
    }
  }

  console.error(`\n✓ ok em ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
