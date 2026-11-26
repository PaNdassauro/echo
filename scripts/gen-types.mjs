#!/usr/bin/env node
/**
 * Gera src/integrations/supabase/types.ts.
 *
 * Dois caminhos:
 *   --local         `supabase gen types typescript --local`, a partir do banco do
 *                   `supabase start` (baseline aplicado). É o caminho padrão
 *                   para desenvolver.
 *   --ref <ref>     Management API (/types/typescript) de um projeto hospedado.
 *                   Também aceita a env SUPABASE_PROJECT_REF. Exige a env
 *                   SUPABASE_ACCESS_TOKEN (token pessoal sbp_...).
 *
 * Sem `--local` e sem ref o script falha: não existe projeto padrão.
 *
 * Por que a Management API em vez de `supabase gen types --linked`?
 * A CLI já descartou tabelas silenciosamente (ex.: conversation_assignees,
 * automation_executions) mesmo saindo com exit 0, o que gera um types.ts
 * incompleto e quebra o `tsc`. Por isso, depois de gerar, o script confere que
 * as tabelas abaixo existem e falha se faltar alguma.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "src/integrations/supabase/types.ts");

const TABELAS_OBRIGATORIAS = ["conversation_assignees", "automation_executions"];

function parseArgs(argv) {
  const args = { local: false, ref: process.env.SUPABASE_PROJECT_REF || null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--local") args.local = true;
    else if (argv[i] === "--ref") args.ref = argv[++i] ?? null;
  }
  return args;
}

function gerarLocal() {
  const r = spawnSync(
    "npx",
    ["supabase", "gen", "types", "typescript", "--local", "--schema", "public"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    console.error(`Falha ao gerar tipos locais (exit ${r.status}). O \`supabase start\` está rodando?`);
    console.error(r.stderr);
    process.exit(1);
  }
  return r.stdout;
}

async function gerarRemoto(ref) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.error("SUPABASE_ACCESS_TOKEN não definido. Exporte seu token (sbp_...) antes de rodar.");
    process.exit(1);
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/types/typescript`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`Falha ao gerar tipos (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const { types } = await res.json();
  if (!types || typeof types !== "string") {
    console.error("Resposta da API sem campo `types`.");
    process.exit(1);
  }
  return types;
}

const { local, ref } = parseArgs(process.argv.slice(2));
if (!local && !ref) {
  console.error("Informe a origem dos tipos: --local (banco do `supabase start`) ou --ref <project_ref> (ou SUPABASE_PROJECT_REF).");
  process.exit(2);
}

const types = local ? gerarLocal() : await gerarRemoto(ref);

const faltando = TABELAS_OBRIGATORIAS.filter((t) => !new RegExp(`^      ${t}: \\{`, "m").test(types));
if (faltando.length > 0) {
  console.error(`types.ts NÃO foi gravado: faltam tabelas conhecidas (${faltando.join(", ")}).`);
  process.exit(1);
}

writeFileSync(out, types);
const tables = (types.match(/^      [a-z_]+: \{/gm) || []).length;
console.log(`types.ts atualizado (${local ? "banco local" : `ref ${ref}`}, ${tables} definições).`);
