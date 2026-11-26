#!/usr/bin/env node
/**
 * Reprocessa falhas de escrita de mensagem evidenciadas em qr_message_log
 * (success=false, com payload replayável em baileys_result — gravadas pelo
 * logWriteFailure das edges e pelo outbox do qr-service).
 *
 * Dois modos de replay, decididos pela rota da evidência:
 *  - rota '/qr-*'  → re-POST do payload à própria rota do whatsapp-webhook
 *    (idempotente: o upsert composto wamid+conversation_id dedupa);
 *  - rota de writer de saída (whatsapp-send, scheduled-message-execute,
 *    automation-*, auto-reply-*) → upsert direto em messages via REST, já que a
 *    mensagem JÁ foi entregue ao contato — só falta a linha em `messages`.
 *  - 'cloud-messages' fica de fora: reconstruir o envelope da Meta não é
 *    seguro em lote; a linha fica listada para tratamento manual.
 *
 * Uso:
 *   node scripts/replay-write-failures.mjs --dry-run
 *   node scripts/replay-write-failures.mjs
 *   node scripts/replay-write-failures.mjs --purge   # apaga a evidência após sucesso
 */
import { readFileSync } from "node:fs";

const ENV = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "").replace(/\r$/, "")];
    })
);

const SUPABASE_URL = ENV.VITE_SUPABASE_URL || ENV.SUPABASE_URL;
const SERVICE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY || ENV.SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Faltam VITE_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY no .env");

const dryRun = process.argv.includes("--dry-run");
const purge = process.argv.includes("--purge");

const REST_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...REST_HEADERS, ...init.headers } });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const failures = await rest(
  "qr_message_log?success=eq.false&action=in.(msg_write_failed,msg_payload_invalid)" +
    "&select=id,action,error,message_id,baileys_result,created_at&order=created_at.asc&limit=500"
);

if (failures.length === 0) {
  console.log("Nenhuma falha de escrita pendente. ✓");
  process.exit(0);
}
console.log(`${failures.length} falha(s) evidenciada(s):\n`);

let ok = 0, skipped = 0, failed = 0;
for (const row of failures) {
  const route = row.baileys_result?.route;
  const payload = row.baileys_result?.payload;
  const label = `${row.created_at}  ${route ?? "?"}  wamid=${row.message_id ?? "-"}`;

  if (!route || !payload || Object.keys(payload).length === 0) {
    console.log(`  ⊘ ${label} — sem payload replayável (${row.error?.slice(0, 60) ?? ""})`);
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(`  → ${label} — replayável via ${route.startsWith("/qr-") ? "re-POST" : "upsert direto"}`);
    continue;
  }

  try {
    if (route.startsWith("/qr-")) {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-webhook${route}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          // As rotas /qr-* exigem o segredo compartilhado quando configurado
          // (mesmo valor do qr-service; QR_WEBHOOK_SECRET no .env local).
          ...(ENV.QR_WEBHOOK_SECRET ? { "x-qr-secret": ENV.QR_WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`webhook ${res.status}: ${(await res.text()).slice(0, 120)}`);
    } else if (payload.conversation_id && (payload.content !== undefined || payload.whatsapp_message_id)) {
      // Writer de saída: a mensagem já chegou ao contato — repõe só a linha.
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/messages?on_conflict=whatsapp_message_id,conversation_id`,
        {
          method: "POST",
          headers: { ...REST_HEADERS, Prefer: "resolution=ignore-duplicates" },
          body: JSON.stringify({
            conversation_id: payload.conversation_id,
            content: payload.content ?? "",
            direction: payload.direction ?? "outbound",
            sent_by: payload.sent_by ?? null,
            whatsapp_message_id: payload.whatsapp_message_id ?? row.message_id,
            message_type: payload.message_type ?? "text",
          }),
        }
      );
      if (!res.ok) throw new Error(`REST ${res.status}: ${(await res.text()).slice(0, 120)}`);
    } else {
      console.log(`  ⊘ ${label} — rota '${route}' exige tratamento manual`);
      skipped++;
      continue;
    }

    console.log(`  ✓ ${label}`);
    ok++;
    if (purge) await rest(`qr_message_log?id=eq.${row.id}`, { method: "DELETE" });
  } catch (err) {
    console.log(`  ✗ ${label} — ${err.message}`);
    failed++;
  }
}

console.log(`\nReplay: ${ok} ok, ${skipped} manual/sem payload, ${failed} falha(s).${dryRun ? " (dry-run: nada disparado)" : ""}`);
console.log("Idempotente: o upsert composto dedupa — rodar de novo não duplica.");
