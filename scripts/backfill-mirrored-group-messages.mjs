#!/usr/bin/env node
/**
 * Preenche as mensagens de grupo que faltam nas conversas irmãs.
 *
 * Contexto: cada linha conectada tem a SUA conversa do grupo e as SUAS mensagens
 * (o webhook resolve a conversa por phone_number_id + group_jid). Linha que cai
 * perde tudo o que passa no grupo naquele período, e não volta: o
 * fetchMessageHistory só puxa para trás de uma âncora, e conversa sem mensagem
 * nova depois do buraco não tem âncora. Acontece, por exemplo, com uma linha que
 * ficou dias desconectada.
 *
 * O trabalho todo mora em public.mirror_group_messages_to_siblings (definida no
 * baseline). Aqui só existe o laço, o ensaio e a conferência — assim o
 * mesmo código serve para um conserto pontual depois de outra queda.
 *
 * Idempotente: a cópia é gravada com ON CONFLICT (whatsapp_message_id,
 * conversation_id) DO NOTHING e some do NOT EXISTS na rodada seguinte. Rodar duas
 * vezes não duplica; a segunda vez copia zero.
 *
 * As cópias nascem LIDAS. Sem isso o GlobalNotificationListener dispararia som,
 * notificação e badge uma vez por linha, aos milhares — a mesma lição do
 * import-history.
 *
 * Uso (o ref do projeto é obrigatório: --ref ou a env SUPABASE_PROJECT_REF):
 *   node scripts/backfill-mirrored-group-messages.mjs --ref <ref> --dry-run
 *   node scripts/backfill-mirrored-group-messages.mjs --ref <ref>
 *   node scripts/backfill-mirrored-group-messages.mjs --ref <ref> --days 7
 *   node scripts/backfill-mirrored-group-messages.mjs --ref <ref> --unread   # cópia notifica
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Teto por rodada. Casa com o que a função aceita sem estourar o tempo do statement. */
const CHUNK = 2000;
/** Trava de segurança do laço: 2000 x 50 = 100k cópias, muito além do previsto. */
const MAX_ROUNDS = 50;

function parseArgs(argv) {
  const args = { dryRun: false, days: 30, unread: false, ref: process.env.SUPABASE_PROJECT_REF || null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--unread") args.unread = true;
    else if (argv[i] === "--days") args.days = Number(argv[++i]);
    else if (argv[i] === "--ref") args.ref = argv[++i];
  }
  if (!Number.isInteger(args.days) || args.days < 1) {
    throw new Error("--days precisa ser um inteiro positivo");
  }
  if (!args.ref) {
    throw new Error("Informe o projeto: --ref <project_ref> ou a env SUPABASE_PROJECT_REF.");
  }
  return args;
}

/**
 * A REST com sb_secret_ não executa SQL arbitrário; a Management API é o caminho
 * suportado e usa o token pessoal sbp_ gravado pelo `supabase login`.
 */
function readToken() {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    return readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
  } catch {
    throw new Error("Sem token: rode `supabase login` ou exporte SUPABASE_ACCESS_TOKEN");
  }
}

const TOKEN = readToken();

async function sql(ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text}`);
  return JSON.parse(text);
}

/**
 * O que falta, sem gravar nada. Repete a seleção da função de propósito: o
 * relatório tem de bater com o que será copiado, e um SELECT não pode depender de
 * ter escrito antes.
 */
const PREVIEW_SQL = (days) => `
with src_conv as (
  select c.id, c.group_jid, c.phone_number_id, pn.organization_id
    from conversations c join phone_numbers pn on pn.id = c.phone_number_id
   where c.is_group and c.group_jid is not null
     and c.last_message_at >= now() - interval '${days} days'
), pair as (
  select s.id src_id, t.id tgt_id, t.created_at tgt_created
    from src_conv s
    join conversations t on t.group_jid = s.group_jid and t.is_group
     and t.phone_number_id <> s.phone_number_id
    join phone_numbers tpn on tpn.id = t.phone_number_id
   where tpn.organization_id = s.organization_id
), todo as (
  select distinct on (p.tgt_id, m.whatsapp_message_id) p.tgt_id, m.created_at
    from pair p join messages m on m.conversation_id = p.src_id
   where m.created_at >= now() - interval '${days} days'
     and m.created_at <  now() - interval '2 minutes'
     and m.created_at >= p.tgt_created
     and m.whatsapp_message_id is not null
     and m.is_imported = false
     and not exists (select 1 from messages x
                      where x.conversation_id = p.tgt_id
                        and x.whatsapp_message_id = m.whatsapp_message_id)
   order by p.tgt_id, m.whatsapp_message_id, (m.direction = 'inbound') desc, m.created_at
)
select pn.display_name linha, count(*)::int copias,
       count(distinct t.tgt_id)::int conversas,
       min(t.created_at)::date de, max(t.created_at)::date ate
  from todo t
  join conversations c on c.id = t.tgt_id
  join phone_numbers pn on pn.id = c.phone_number_id
 group by 1 order by 2 desc`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const markRead = !args.unread;

  console.log(
    `Janela: ${args.days} dias | cópias nascem ${markRead ? "LIDAS" : "NÃO LIDAS (notificam)"} | projeto ${args.ref}\n`
  );

  const preview = await sql(args.ref, PREVIEW_SQL(args.days));
  if (preview.length === 0) {
    console.log("Nada a copiar. Todas as conversas irmãs já têm as mesmas mensagens.");
    return;
  }
  const total = preview.reduce((acc, r) => acc + r.copias, 0);
  for (const r of preview) {
    console.log(
      `  ${String(r.copias).padStart(6)}  ${r.linha.padEnd(24)} ${r.conversas} conversa(s)  ${r.de} → ${r.ate}`
    );
  }
  console.log(`\n  ${String(total).padStart(6)}  TOTAL`);

  if (args.dryRun) {
    console.log("\n--dry-run: nada foi gravado.");
    return;
  }

  console.log("\nCopiando…");
  let copied = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const rows = await sql(
      args.ref,
      `select public.mirror_group_messages_to_siblings(
         interval '${args.days} days', interval '2 minutes', ${markRead}, ${CHUNK}
       )::int as n`
    );
    const n = rows[0]?.n ?? 0;
    copied += n;
    console.log(`  rodada ${round}: ${n}`);
    if (n === 0) break;
    if (round === MAX_ROUNDS) {
      console.log("  ATENÇÃO: teto de rodadas atingido, rode de novo para terminar.");
    }
  }

  // A conferência é a mesma consulta do preview: tem de sobrar zero. Se sobrar, é
  // mensagem que entrou DEPOIS que o laço começou (a janela é móvel), não falha.
  const left = await sql(args.ref, PREVIEW_SQL(args.days));
  const remaining = left.reduce((acc, r) => acc + r.copias, 0);
  console.log(`\nCopiadas: ${copied} | ainda faltando: ${remaining}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
