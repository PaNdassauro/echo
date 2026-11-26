#!/usr/bin/env node
/**
 * Aplica o template do e-mail de nova senha (supabase/templates/recovery.html)
 * na configuração de Auth do projeto, pela Management API.
 *
 * Simulação por padrão: mostra o que está no ar e o que mudaria. Só grava com
 * `--aplicar`. O `--ref` é obrigatório. No ambiente local (`supabase start`) o
 * template já vem do config.toml (`[auth.email.template.recovery]`) e este
 * script não é necessário.
 *
 *   node scripts/aplicar-template-recuperacao.mjs --ref <ref> [--aplicar]
 *
 * Token: SUPABASE_ACCESS_TOKEN ou o do `supabase login` (~/.supabase/access-token).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSUNTO = "Criar uma nova senha no Echo";
const argv = process.argv.slice(2);
const ref = argv.includes("--ref") ? argv[argv.indexOf("--ref") + 1] : undefined;
const aplicar = argv.includes("--aplicar");

if (!ref || !/^[a-z]{20}$/.test(ref)) {
  console.error("Uso: node scripts/aplicar-template-recuperacao.mjs --ref <project_ref> [--aplicar]");
  process.exit(1);
}

function lerToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  try {
    return readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
  } catch {
    console.error("Access token não encontrado. Defina SUPABASE_ACCESS_TOKEN ou rode `supabase login`.");
    process.exit(1);
  }
}

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
// O comentário do topo é só para quem lê o repo: não vai no e-mail.
const html = readFileSync(join(raiz, "supabase", "templates", "recovery.html"), "utf8").replace(/<!--[\s\S]*?-->\n?/, "");

for (const exigido of ["{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery", "{{ .SiteURL }}"]) {
  if (!html.includes(exigido)) {
    console.error(`Template sem "${exigido}": não aplico.`);
    process.exit(1);
  }
}

const url = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const headers = { Authorization: `Bearer ${lerToken()}`, "Content-Type": "application/json" };

const atualResp = await fetch(url, { headers });
if (!atualResp.ok) {
  console.error(`Não consegui ler a config de Auth (${atualResp.status}): ${(await atualResp.text()).slice(0, 300)}`);
  process.exit(1);
}
const atual = await atualResp.json();
const conteudoAtual = atual.mailer_templates_recovery_content ?? "";

console.log(`Projeto: ${ref}`);
console.log(`Assunto no ar:   ${JSON.stringify(atual.mailer_subjects_recovery ?? null)}`);
console.log(`Assunto novo:    ${JSON.stringify(ASSUNTO)}`);
console.log(`Template no ar:  ${conteudoAtual.length} caracteres, usa token_hash: ${conteudoAtual.includes(".TokenHash")}`);
console.log(`Template novo:   ${html.length} caracteres`);
console.log(`Prazo do link (mailer_otp_exp): ${atual.mailer_otp_exp} s`);
console.log(`Redirecionamentos permitidos:   ${atual.uri_allow_list}`);

if (conteudoAtual === html && atual.mailer_subjects_recovery === ASSUNTO) {
  console.log("Já está igual. Nada a fazer.");
  process.exit(0);
}

if (!aplicar) {
  console.log("Simulação: nada gravado. Para gravar, repita com --aplicar.");
  process.exit(0);
}

const resp = await fetch(url, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ mailer_subjects_recovery: ASSUNTO, mailer_templates_recovery_content: html }),
});
if (!resp.ok) {
  console.error(`Falhou (${resp.status}): ${(await resp.text()).slice(0, 500)}`);
  process.exit(1);
}
const depois = await resp.json();
if (depois.mailer_templates_recovery_content !== html || depois.mailer_subjects_recovery !== ASSUNTO) {
  console.error("A API respondeu ok, mas a config devolvida não bate com o template. Conferir à mão.");
  process.exit(1);
}
console.log("Template aplicado e conferido.");
