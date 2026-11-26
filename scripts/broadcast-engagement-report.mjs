#!/usr/bin/env node
/**
 * Relatório de entrega + engajamento de um broadcast.
 *
 * Cruza broadcast_recipients com messages (via whatsapp_message_id) para obter
 * o status de entrega (sent/delivered/read/failed) e mede engajamento como:
 *   - reação na própria mensagem do broadcast (messages.reaction)
 *   - qualquer mensagem inbound na conversa a partir do sent_at do destinatário
 *     (resposta de texto/mídia, clique de botão = message_type 'button_reply')
 *
 * Uso:
 *   node scripts/broadcast-engagement-report.mjs <broadcast_id> --ref <project_ref> [--prefix nome]
 *
 * O ref do projeto é obrigatório: `--ref` ou a env SUPABASE_PROJECT_REF.
 *
 * Gera na raiz do projeto:
 *   <prefix>-relatorio.csv   — todos os destinatários com status + engajamento
 *   <prefix>-engajaram.csv   — quem respondeu/reagiu/clicou (excluir do follow-up)
 *   <prefix>-followup.csv    — quem NÃO engajou e não falhou (lista pro follow-up)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parseArgs(argv) {
  const args = { broadcastId: null, prefix: "broadcast", ref: process.env.SUPABASE_PROJECT_REF || null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prefix") args.prefix = argv[++i];
    else if (argv[i] === "--ref") args.ref = argv[++i];
    else if (!args.broadcastId) args.broadcastId = argv[i];
  }
  return args;
}

function readToken() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN;
  if (fromEnv) return fromEnv.trim();
  return readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
}

async function runQuery(ref, token, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

function toCsv(rows, cols) {
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v).replace(/\r?\n/g, " ");
    return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => escape(r[c])).join(","))].join("\n") + "\n";
}

async function main() {
  const { broadcastId, prefix, ref } = parseArgs(process.argv.slice(2));
  if (!broadcastId) {
    console.error("Uso: node scripts/broadcast-engagement-report.mjs <broadcast_id> --ref <project_ref> [--prefix nome]");
    process.exit(2);
  }
  if (!ref) {
    console.error("Informe o projeto: --ref <project_ref> ou a env SUPABASE_PROJECT_REF.");
    process.exit(2);
  }
  if (!/^[0-9a-f-]{36}$/i.test(broadcastId)) throw new Error("broadcast_id inválido");
  const token = readToken();

  const sql = `
WITH r AS (
  SELECT id, phone_number, contact_name, status AS send_status,
         whatsapp_message_id, sent_at, error_message
  FROM broadcast_recipients
  WHERE broadcast_id = '${broadcastId}'
),
bm AS (
  -- mensagem do broadcast no chat (uma por destinatário)
  SELECT DISTINCT ON (r.id)
         r.id AS rid, r.sent_at, m.conversation_id,
         m.status AS msg_status, m.reaction
  FROM r
  JOIN messages m ON m.whatsapp_message_id = r.whatsapp_message_id
  ORDER BY r.id, m.created_at
),
eng AS (
  SELECT bm.rid,
         count(*)                                                    AS n_inbound,
         min(i.created_at)                                           AS first_reply_at,
         bool_or(i.message_type IN ('button_reply','list_reply'))    AS clicked_button,
         left(string_agg(left(coalesce(i.content,''), 60), ' | ' ORDER BY i.created_at)
              FILTER (WHERE i.message_type = 'text'), 200)           AS amostra_resposta
  FROM bm
  JOIN messages i
    ON i.conversation_id = bm.conversation_id
   AND i.direction = 'inbound'
   AND i.created_at >= bm.sent_at
  GROUP BY bm.rid
)
SELECT r.phone_number                                   AS telefone,
       r.contact_name                                   AS nome,
       r.send_status                                    AS status_envio,
       COALESCE(bm.msg_status,
                CASE WHEN r.send_status = 'failed' THEN 'failed' ELSE 'sem_status' END)
                                                        AS status_entrega,
       (bm.reaction IS NOT NULL)                        AS reagiu,
       bm.reaction                                      AS reacao,
       COALESCE(eng.clicked_button, false)              AS clicou_botao,
       COALESCE(eng.n_inbound, 0)                       AS msgs_recebidas,
       eng.first_reply_at                               AS primeira_resposta,
       eng.amostra_resposta,
       (bm.reaction IS NOT NULL OR eng.rid IS NOT NULL) AS engajou,
       r.error_message                                  AS erro
FROM r
LEFT JOIN bm  ON bm.rid  = r.id
LEFT JOIN eng ON eng.rid = r.id
ORDER BY engajou DESC, status_entrega, nome NULLS LAST;`;

  console.error(`→ consultando broadcast ${broadcastId} em ${ref}…`);
  const rows = await runQuery(ref, token, sql);
  console.error(`← ${rows.length} destinatários`);

  const cols = [
    "telefone", "nome", "status_envio", "status_entrega", "engajou",
    "reagiu", "reacao", "clicou_botao", "msgs_recebidas",
    "primeira_resposta", "amostra_resposta", "erro",
  ];
  writeFileSync(`${prefix}-relatorio.csv`, toCsv(rows, cols));

  const engaged = rows.filter((r) => r.engajou);
  writeFileSync(`${prefix}-engajaram.csv`, toCsv(engaged, cols));

  const followup = rows.filter(
    (r) => !r.engajou && r.status_envio !== "failed" && r.status_entrega !== "failed"
  );
  writeFileSync(
    `${prefix}-followup.csv`,
    toCsv(followup, ["telefone", "nome", "status_entrega"])
  );

  const by = (k, v) => rows.filter((r) => r[k] === v).length;
  console.log(`Total:            ${rows.length}`);
  console.log(`  lidas (read):   ${by("status_entrega", "read")}`);
  console.log(`  entregues:      ${by("status_entrega", "delivered")}`);
  console.log(`  só enviadas:    ${by("status_entrega", "sent")}`);
  console.log(`  sem status:     ${by("status_entrega", "sem_status")}`);
  console.log(`  falharam:       ${rows.filter((r) => r.status_entrega === "failed").length}`);
  console.log(`Engajaram:        ${engaged.length}`);
  console.log(`Follow-up (sem engajados/falhas): ${followup.length}`);
  console.log(`\nArquivos: ${prefix}-relatorio.csv, ${prefix}-engajaram.csv, ${prefix}-followup.csv`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
