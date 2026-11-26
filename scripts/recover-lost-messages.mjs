#!/usr/bin/env node
/**
 * Recupera mensagens que o qr-service recebeu e descartou antes do insert.
 *
 * Origem: `qr_message_log` com action='msg_handler_throw' cujo `message_id` nunca
 * chegou em `messages` — o handler de messages.upsert estourou (ECACHEFULL do
 * NodeCache) e abortou a mensagem.
 *
 * Caminho de recuperação: POST /session/sync/:phoneNumberId do qr-service, que chama
 * fetchMessageHistory (HISTORY_SYNC_ON_DEMAND). O protocolo puxa mensagens ANTERIORES
 * a uma âncora, então cada conversa precisa de uma mensagem gravada DEPOIS do gap —
 * conversa sem âncora não tem por onde entrar e é reportada como tal.
 *
 * Idempotente: o ingest faz upsert com onConflict (whatsapp_message_id, conversation_id),
 * então rodar de novo não duplica.
 *
 * Uso:
 *   node scripts/recover-lost-messages.mjs --dry-run
 *   node scripts/recover-lost-messages.mjs
 *   node scripts/recover-lost-messages.mjs --jid <jid-do-grupo>@g.us
 */
import { readFileSync } from "node:fs";

const ENV = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const SUPABASE_URL = ENV.VITE_SUPABASE_URL || ENV.SUPABASE_URL;
const SERVICE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY || ENV.SERVICE_ROLE_KEY;
const QR_URL = ENV.VITE_QR_SERVICE_URL;

if (!SUPABASE_URL || !SERVICE_KEY || !QR_URL) {
  throw new Error("Faltam VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou VITE_QR_SERVICE_URL no .env");
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyJid = args[args.indexOf("--jid") + 1] && args.includes("--jid") ? args[args.indexOf("--jid") + 1] : null;
// A resposta do on-demand depende do aparelho principal estar acessível: um celular
// lento (ou que só acorda ao ser aberto) não responde em 20s. Teto do serviço: 60s.
const waitMs = args.includes("--wait") ? Number(args[args.indexOf("--wait") + 1]) : 20_000;

/** PostgREST com a service key. */
async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * As perdas e suas âncoras saem de uma RPC-free query em duas etapas: a lista de
 * wamids que estouraram, e o que já existe em `messages`. Cruzar no cliente evita
 * depender de SQL arbitrário (a REST não executa) e mantém o script rodável por
 * quem só tem a service key.
 */
async function collectTargets() {
  const throws = await rest(
    "qr_message_log?action=eq.msg_handler_throw&select=to_jid,message_id,created_at&order=created_at.asc&limit=1000"
  );
  if (throws.length === 0) return [];

  const ids = [...new Set(throws.map((t) => t.message_id))];
  // Uma conversa por vez no filtro seria N requests; o .in() com todos os wamids é
  // curto aqui (ids de 20-32 chars), longe do teto de URL do gateway.
  const existing = new Set(
    (
      await rest(
        `messages?whatsapp_message_id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=whatsapp_message_id`
      )
    ).map((m) => m.whatsapp_message_id)
  );

  const lost = throws.filter((t) => !existing.has(t.message_id));
  const byJid = new Map();
  for (const l of lost) {
    const cur = byJid.get(l.to_jid) ?? { jid: l.to_jid, wamids: new Set(), first: l.created_at, last: l.created_at };
    cur.wamids.add(l.message_id);
    if (l.created_at < cur.first) cur.first = l.created_at;
    if (l.created_at > cur.last) cur.last = l.created_at;
    byJid.set(l.to_jid, cur);
  }

  const targets = [];
  for (const g of byJid.values()) {
    if (onlyJid && g.jid !== onlyJid) continue;

    const convs = await rest(
      `conversations?or=(group_jid.eq.${g.jid},whatsapp_id.eq.${g.jid})&select=id,contact_name,phone_number_id&order=created_at.asc`
    );
    if (convs.length === 0) {
      targets.push({ ...g, skip: "conversa não encontrada" });
      continue;
    }
    // Linhas espelhadas gravam o mesmo JID em conversas distintas. O refetch é por
    // sessão: pedir pela primeira basta, o webhook replica para as duas como sempre.
    const conv = convs[0];

    const anchor = await rest(
      `messages?conversation_id=eq.${conv.id}&created_at=gt.${encodeURIComponent(g.last)}` +
        `&whatsapp_message_id=not.is.null&select=whatsapp_message_id,created_at,direction&order=created_at.asc&limit=1`
    );
    if (anchor.length === 0) {
      targets.push({ ...g, name: conv.contact_name, skip: "sem âncora (nenhuma mensagem depois do gap)" });
      continue;
    }

    targets.push({
      ...g,
      name: conv.contact_name,
      phoneNumberId: conv.phone_number_id,
      anchor: anchor[0],
    });
  }
  return targets;
}

const targets = await collectTargets();
const actionable = targets.filter((t) => !t.skip);

console.log(`\n${targets.length} conversa(s) com perda; ${actionable.length} recuperável(is).\n`);
for (const t of targets) {
  const n = t.wamids.size;
  if (t.skip) {
    console.log(`  ⊘ ${t.name ?? t.jid} — ${n} msg(s) — ${t.skip}`);
  } else {
    console.log(`  → ${t.name} — ${n} msg(s) — âncora ${t.anchor.whatsapp_message_id} de ${t.anchor.created_at}`);
  }
}

if (dryRun) {
  console.log("\n--dry-run: nada foi disparado.\n");
  process.exit(0);
}

// Sequencial de propósito: syncMessageHistory tem guarda por sessão
// (SYNC_ALREADY_RUNNING), então duas conversas da mesma linha em paralelo se atropelam.
let recovered = 0;
for (const t of actionable) {
  const body = {
    chatJid: t.jid,
    anchorMessageId: t.anchor.whatsapp_message_id,
    anchorTimestampMs: new Date(t.anchor.created_at).getTime(),
    anchorFromMe: t.anchor.direction === "outbound",
    // Descarta o que for anterior ao início do gap — não queremos reimportar o histórico todo.
    sinceMs: new Date(t.first).getTime() - 60_000,
    count: 50,
    waitMs,
  };

  process.stdout.write(`\n${t.name} … `);
  const res = await fetch(`${QR_URL}/session/sync/${t.phoneNumberId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(`falhou (HTTP ${res.status}): ${json.error ?? ""}`);
    continue;
  }
  console.log(`recebidas ${json.received}/${json.requested}`);
  recovered += json.received ?? 0;
}

console.log(`\nTotal encaminhado pelo aparelho: ${recovered} mensagem(ns).`);
console.log("Confira no Echo — o ingest faz upsert, então rodar de novo não duplica.\n");
