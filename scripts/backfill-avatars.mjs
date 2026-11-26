#!/usr/bin/env node
/**
 * Dirige a varredura de fotos de perfil do qr-service (rota
 * POST /session/avatar-backfill/:phoneNumberId, imagem >= 2.3.0).
 *
 * O trabalho roda NO SERVIÇO, não aqui: só ele tem o socket do Baileys, e a fila
 * de lá é a mesma do tráfego vivo — o que dá de graça o espaçamento entre
 * consultas, o disjuntor de 429 e a preempção (mensagem que chega passa na frente
 * do backfill). Este script só abre o trabalho e acompanha.
 *
 * Cuidado deliberado: tráfego em rajada pode derrubar a sessão (401/loggedOut).
 * Portanto — uma linha por vez, grupos primeiro (JID sem ambiguidade e sem
 * restrição de privacidade), e PARA no primeiro disparo do disjuntor.
 *
 * Uso:
 *   node scripts/backfill-avatars.mjs --list
 *   node scripts/backfill-avatars.mjs --phone <id> [--scope groups|individual|all]
 *                                     [--days 90] [--limit 500] [--watch-only]
 *   node scripts/backfill-avatars.mjs --phone <id> --cancel
 *
 * Credenciais: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e VITE_QR_SERVICE_URL do .env.
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

const SUPABASE_URL = ENV.VITE_SUPABASE_URL;
const SERVICE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
const QR_URL = (ENV.VITE_QR_SERVICE_URL || "").replace(/\/$/, "");
if (!SUPABASE_URL || !SERVICE_KEY || !QR_URL) {
  throw new Error("Faltam VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou VITE_QR_SERVICE_URL no .env");
}

const args = process.argv.slice(2);
const flag = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const phoneNumberId = flag("--phone");
const scope = flag("--scope", "groups");
const activeDays = Number(flag("--days", "90"));
const limit = Number(flag("--limit", "500"));
const doList = args.includes("--list");
const doCancel = args.includes("--cancel");
const watchOnly = args.includes("--watch-only");

const authHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: authHeaders });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function qr(path, init = {}) {
  const res = await fetch(`${QR_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- --list
// A coluna phone_numbers.qr_session_status não é confiável (ela pode ficar
// 'disconnected' com a sessão viva). Quem sabe o
// estado real é o serviço.
if (doList || !phoneNumberId) {
  const { status, body } = await qr("/session/health");
  if (status !== 200) {
    console.error(`/session/health → ${status}`, body);
    process.exit(1);
  }
  const live = body.sessions ?? {};
  const lines = await rest("phone_numbers?connection_type=eq.qr&select=id,display_name&order=display_name.asc");

  // Contagem por HEAD + count=exact: o PostgREST corta em 1000 linhas
  // (db-max-rows), então baixar as conversas para contar aqui mentiria em silêncio.
  const countPending = async (lineId, isGroup) => {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?select=id` +
        `&phone_number_id=eq.${lineId}&is_group=eq.${isGroup}&contact_avatar_url=is.null`,
      { method: "HEAD", headers: { ...authHeaders, Prefer: "count=exact", Range: "0-0" } }
    );
    return Number((res.headers.get("content-range") ?? "/0").split("/")[1]) || 0;
  };
  const tally = new Map();
  for (const l of lines) {
    tally.set(l.id, {
      grupos: await countPending(l.id, true),
      individuais: await countPending(l.id, false),
    });
  }

  console.log("estado      grupos  indiv  linha");
  for (const l of lines) {
    const t = tally.get(l.id) ?? { grupos: 0, individuais: 0 };
    const state = (live[l.id] ?? "—").padEnd(11);
    console.log(`${state} ${String(t.grupos).padStart(6)} ${String(t.individuais).padStart(6)}  ${l.display_name}  ${l.id}`);
  }
  console.log("\nSem foto = conversas com contact_avatar_url NULL (qualquer idade).");
  if (!phoneNumberId) {
    console.log("\nRode com --phone <id> para varrer UMA linha. Grupos primeiro.");
    process.exit(0);
  }
}

// ---------------------------------------------------------------- --cancel
if (doCancel) {
  const { status, body } = await qr(`/session/avatar-backfill/${phoneNumberId}`, { method: "DELETE" });
  console.log(status === 200 ? "Cancelado." : `Falhou (${status})`, JSON.stringify(body.backfill ?? body));
  process.exit(status === 200 ? 0 : 1);
}

// ---------------------------------------------------------------- start
if (!watchOnly) {
  if (!["all", "groups", "individual"].includes(scope)) {
    console.error("--scope deve ser all, groups ou individual");
    process.exit(1);
  }
  const { status, body } = await qr(`/session/avatar-backfill/${phoneNumberId}`, {
    method: "POST",
    body: JSON.stringify({ activeDays, limit, scope }),
  });
  if (status === 409) {
    console.log("Já havia varredura em andamento — acompanhando essa.");
  } else if (status !== 202) {
    console.error(`Não deu para abrir a varredura (${status}):`, body.error ?? body);
    process.exit(1);
  } else {
    console.log(`Varredura aberta: ${body.backfill.jobId} (scope=${scope}, days=${activeDays}, limit=${limit})`);
  }
}

// ---------------------------------------------------------------- acompanha
let lastLine = "";
for (;;) {
  const { status, body } = await qr(`/session/avatar-backfill/${phoneNumberId}`);
  if (status !== 200) {
    console.error(`status → ${status}`, body.error ?? body);
    process.exit(1);
  }
  const b = body.backfill;
  const q = body.queue ?? {};
  const line =
    `${b.state}  varridas=${b.scanned} enfileiradas=${b.enqueued} ` +
    `ok=${b.ok} sem_foto=${b.noPhoto} privado=${b.forbidden} ` +
    `sem_conversa=${b.noConversation} falhou=${b.transient} ` +
    `| fila=${q.queued ?? "?"} voo=${q.inFlight ?? "?"}` +
    (q.pausedUntil ? `  ⏸ PAUSADO até ${q.pausedUntil}` : "");
  if (line !== lastLine) {
    console.log(line);
    lastLine = line;
  }

  // Regra de operação: disjuntor disparou = para por hoje. Não insistir.
  if (b.breakerTrips > 0) {
    console.error(
      `\n⚠ O disjuntor de 429 disparou ${b.breakerTrips}x — o WhatsApp está reclamando. ` +
        `Cancelando a varredura; retome amanhã com --limit menor.`
    );
    await qr(`/session/avatar-backfill/${phoneNumberId}`, { method: "DELETE" });
    process.exit(2);
  }

  if (b.state !== "running") {
    console.log(`\nFim: ${b.state} (aberta ${b.startedAt}, encerrada ${b.finishedAt}).`);
    break;
  }
  await sleep(15000);
}
