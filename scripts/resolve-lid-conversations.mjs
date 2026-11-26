#!/usr/bin/env node
/**
 * Saneia conversas 1:1 que nasceram com o LID cru como contact_phone (dígitos
 * de 13+ que não são telefone), traduzindo LID → telefone pelo store do Baileys
 * via rota POST /session/lid-map/:phoneNumberId do qr-service (imagem >= 2.2.14).
 *
 * Para cada conversa LID cujo LID o store resolve:
 *   - sem conversa "real" na mesma linha → PATCH direto (contact_phone/contact_name);
 *   - com conversa real (índice único impede o update) → o merge é multi-tabela e
 *     precisa ser atômico, então o script GERA o SQL (merge atômico num
 *     bloco DO) e você roda: node scripts/run-sql.mjs <arquivo gerado>.
 *
 * LIDs que o store não conhece passam pelo caminho INVERSO (qr-service >= 2.5.0):
 * mandamos como `candidates` os telefones das conversas 1:1 reais da mesma linha
 * (até 500, as mais recentes) e o serviço pergunta ao WhatsApp o LID de cada um,
 * casando com os pendentes. Sob demanda e em lotes de 50 — não rodar em loop.
 * O que ainda sobrar fica como está.
 *
 * Uso:
 *   node scripts/resolve-lid-conversations.mjs [--dry-run] [--phone <phoneNumberId>]
 *
 * Credenciais: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e VITE_QR_SERVICE_URL do .env.
 */
import { readFileSync, writeFileSync } from "node:fs";

const ENV = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const SUPABASE_URL = ENV.VITE_SUPABASE_URL;
const SERVICE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
const QR_URL = (ENV.VITE_QR_SERVICE_URL || "").replace(/\/$/, "");
if (!SUPABASE_URL || !SERVICE_KEY || !QR_URL) {
  throw new Error("Faltam VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou VITE_QR_SERVICE_URL no .env");
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyPhoneId = args.includes("--phone") ? args[args.indexOf("--phone") + 1] : null;

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ------------------------------------------------ 1. conversas com LID cru
// 13+ dígitos que não são BR completo (55 + 11). Falso positivo (número gringo
// longo, ex. Argentina 549…) é inofensivo: o store não resolve o que não é LID
// e a conversa fica intocada.
const lidConvs = (
  await rest(
    "conversations?is_group=eq.false&phone_number_id=not.is.null" +
      "&contact_phone=match.%5E%5B0-9%5D%7B13%7D%5B0-9%5D*%24" + // ^[0-9]{13}[0-9]*$
      "&contact_phone=not.match.%5E55%5B0-9%5D%7B11%7D%24" + // ^55[0-9]{11}$
      "&select=id,phone_number_id,contact_phone,contact_name,status&limit=1000"
  )
).filter((c) => !onlyPhoneId || c.phone_number_id === onlyPhoneId);
if (lidConvs.length === 1000) console.warn("⚠ 1000 linhas — teto do PostgREST; rode de novo depois.");
console.log(`Conversas com LID cru: ${lidConvs.length}`);
if (lidConvs.length === 0) process.exit(0);

// ------------------------------------------------ 2. resolve por linha
const byLine = new Map();
for (const c of lidConvs) {
  (byLine.get(c.phone_number_id) ?? byLine.set(c.phone_number_id, []).get(c.phone_number_id)).push(c);
}

const updates = []; // sem conflito → PATCH
const merges = []; // com conflito → SQL gerado
let unresolved = 0;

for (const [phoneNumberId, convs] of byLine) {
  const lids = [...new Set(convs.map((c) => c.contact_phone))];
  // Candidatos ao caminho inverso: telefones reais (BR completo) das conversas 1:1 desta linha.
  const candidates = (
    await rest(
      `conversations?phone_number_id=eq.${phoneNumberId}&is_group=eq.false` +
        "&contact_phone=match.%5E55%5B0-9%5D%7B10%2C11%7D%24" + // ^55[0-9]{10,11}$
        "&select=contact_phone&order=last_message_at.desc.nullslast&limit=500"
    )
  ).map((c) => c.contact_phone);
  let mappings = new Map();
  let reverse = null;
  for (let i = 0; i < lids.length; i += 500) {
    const res = await fetch(`${QR_URL}/session/lid-map/${phoneNumberId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ lids: lids.slice(i, i + 500), candidates }),
    });
    if (res.status === 409) {
      console.log(`— linha ${phoneNumberId}: sessão desconectada, pulando`);
      mappings = null;
      break;
    }
    if (!res.ok) throw new Error(`lid-map ${phoneNumberId} → ${res.status} ${await res.text()}`);
    const body = await res.json();
    for (const { lid, phone } of body.mappings) mappings.set(lid, phone);
    if (body.reverse) reverse = body.reverse;
  }
  if (!mappings) continue;
  console.log(
    `— linha ${phoneNumberId}: ${lids.length} LID(s), ${mappings.size} resolvido(s)` +
      (reverse ? ` (inverso: ${reverse.matched} de ${reverse.candidates} candidatos)` : "")
  );

  for (const c of convs) {
    const phone = mappings.get(c.contact_phone);
    if (!phone) {
      unresolved++;
      continue;
    }
    const conflict = await rest(
      `conversations?phone_number_id=eq.${c.phone_number_id}&contact_phone=eq.${phone}&is_group=eq.false&select=id`
    );
    if (conflict.length > 0) merges.push({ src: c.id, dst: conflict[0].id, phone, lid: c.contact_phone });
    else updates.push({ ...c, phone });
  }
}

// ------------------------------------------------ 3. aplica
console.log(`\nResolvidas: ${updates.length} update(s) direto(s), ${merges.length} merge(s); ${unresolved} sem par no store.`);

for (const u of updates) {
  const body = { contact_phone: u.phone };
  if (u.contact_name === u.contact_phone) body.contact_name = u.phone;
  console.log(`update ${u.contact_phone} → ${u.phone} (conv ${u.id})`);
  if (!dryRun) await rest(`conversations?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify(body) });
}

if (merges.length > 0) {
  // Mesmo playbook do merge anterior (lid-merge.sql): dedup por wamid,
  // reads com GREATEST, reabre o destino se o lado LID estiver ativo.
  const pairs = merges.map((m) => `    ('${m.src}', '${m.dst}', '${m.phone}')`).join(",\n");
  const sql = `-- @@ Merge de ${merges.length} conversas LID nas conversas reais (gerado por resolve-lid-conversations.mjs)
DO $$
DECLARE
  n int; v_src_msgs int; v_dupes int; v_moved int;
BEGIN
  CREATE TEMP TABLE _lid_pairs (src uuid, dst uuid, phone text) ON COMMIT DROP;
  INSERT INTO _lid_pairs VALUES
${pairs};

  SELECT count(*) INTO n
    FROM _lid_pairs p
    JOIN conversations s ON s.id = p.src AND s.is_group = false
    JOIN conversations d ON d.id = p.dst AND d.is_group = false
   WHERE d.phone_number_id = s.phone_number_id AND d.contact_phone = p.phone;
  IF n <> ${merges.length} THEN RAISE EXCEPTION 'invariantes: esperava ${merges.length} pares válidos, achei %', n; END IF;

  SELECT count(*) INTO v_src_msgs FROM messages m JOIN _lid_pairs p ON p.src = m.conversation_id;

  UPDATE conversation_notes x SET conversation_id = p.dst FROM _lid_pairs p WHERE x.conversation_id = p.src;
  UPDATE automation_executions x SET conversation_id = p.dst FROM _lid_pairs p WHERE x.conversation_id = p.src;

  INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
  SELECT r.user_id, p.dst, max(r.last_read_at)
    FROM conversation_reads r JOIN _lid_pairs p ON p.src = r.conversation_id
   GROUP BY r.user_id, p.dst
      ON CONFLICT (user_id, conversation_id)
      DO UPDATE SET last_read_at = GREATEST(EXCLUDED.last_read_at, conversation_reads.last_read_at);

  DELETE FROM messages m
   USING _lid_pairs p
   WHERE m.conversation_id = p.src
     AND m.whatsapp_message_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM messages m2
                  WHERE m2.conversation_id = p.dst
                    AND m2.whatsapp_message_id = m.whatsapp_message_id);
  GET DIAGNOSTICS v_dupes = ROW_COUNT;

  UPDATE messages m SET conversation_id = p.dst FROM _lid_pairs p WHERE m.conversation_id = p.src;
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved + v_dupes <> v_src_msgs THEN
    RAISE EXCEPTION 'conservação de mensagens falhou: % + % <> %', v_moved, v_dupes, v_src_msgs;
  END IF;

  UPDATE conversations d
     SET last_message_at = GREATEST(coalesce(d.last_message_at, s.last_message_at),
                                    coalesce(s.last_message_at, d.last_message_at)),
         status       = CASE WHEN d.status = 'closed' AND s.status <> 'closed' THEN s.status ELSE d.status END,
         closed_at    = CASE WHEN d.status = 'closed' AND s.status <> 'closed' THEN NULL ELSE d.closed_at END,
         close_reason = CASE WHEN d.status = 'closed' AND s.status <> 'closed' THEN NULL ELSE d.close_reason END,
         closed_by    = CASE WHEN d.status = 'closed' AND s.status <> 'closed' THEN NULL ELSE d.closed_by END,
         contact_name = CASE
                          WHEN d.contact_name ~ '^\\d+$' AND coalesce(s.contact_name, '') <> ''
                           AND s.contact_name !~ '^\\d+$' THEN s.contact_name
                          ELSE d.contact_name
                        END,
         assigned_to               = coalesce(d.assigned_to, s.assigned_to),
         contact_avatar_url        = coalesce(d.contact_avatar_url, s.contact_avatar_url),
         contact_avatar_updated_at = coalesce(d.contact_avatar_updated_at, s.contact_avatar_updated_at),
         contact_picture_url       = coalesce(d.contact_picture_url, s.contact_picture_url),
         picture_fetched_at        = coalesce(d.picture_fetched_at, s.picture_fetched_at)
    FROM _lid_pairs p
    JOIN conversations s ON s.id = p.src
   WHERE d.id = p.dst;

  DELETE FROM conversations c USING _lid_pairs p WHERE c.id = p.src;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> ${merges.length} THEN RAISE EXCEPTION 'esperava apagar ${merges.length} conversas LID, apaguei %', n; END IF;
END $$;
`;
  const out = new URL(`../backups/lid-merge-${new Date().toISOString().slice(0, 10)}.sql`, import.meta.url).pathname;
  writeFileSync(out, sql);
  console.log(`\nMerges gerados em ${out}`);
  console.log(`Confira e rode: node scripts/run-sql.mjs ${out}`);
}

if (dryRun) console.log("\n(dry-run: nada foi escrito)");
