#!/usr/bin/env node
// Fumaça, passo 6/18/19: entrada de mensagem + Realtime com RLS, com o supabase-js do repo (transport ws).
//
//   ECHO_URL=http://localhost:58290 ANON_KEY=… SMOKE_A_EMAIL=… SMOKE_A_PASSWORD=… SMOKE_B_EMAIL=… SMOKE_B_PASSWORD=…
//   SMOKE_LINHA_A=<uuid da linha A> SMOKE_EXEC_QR="docker compose … exec -T qr" node scripts/smoke/realtime.mjs [--so-assinar]
//
// Modo completo: A e B (organizações diferentes) entram, assinam `global-notifications` (INSERT em messages com
// direction=eq.inbound), esperam a mensagem `system` "Subscribed to PostgreSQL" (sem ela um INSERT feito logo depois
// do SUBSCRIBED se perde: lição da prova B) e o script imprime PRONTO. Então posta, DE DENTRO do container qr, a
// mensagem recebida em /qr-message com x-qr-secret:
//   - sondas no canal global (wamid novo a cada ~3 s, até 30 s) até A receber uma: o filtro de um canal novo é aplicado
//     com atraso, e num stack recém-criado o primeiro INSERT se perdia;
//   - mensagem principal: até 3 tentativas de 10 s, wamid novo em cada uma. Chegar em qualquer uma = OK (e, se precisou de
//     mais de uma, imprime `AVISO realtime: a mensagem principal só chegou na tentativa N`, sem falhar); nenhuma = FALHOU.
//     B não recebe em 5 s NENHUMA das mensagens enviadas (principais nem sondas globais). Os passos seguintes usam o
//     wamid da tentativa que chegou;
//   - mensagens de sonda do mesmo contato (wamid novo a cada ~3 s, até 30 s) chegam ao canal filtrado da conversa de A
//     (assinado pelo próprio A depois da 1ª); B assina o mesmo canal e não recebe NENHUMA das sondas (o filtro não fura
//     a RLS). Sondar em vez de dormir um tempo fixo: o Realtime aplica o filtro de um canal novo com atraso, maior
//     com a máquina carregada;
//   - as assinaturas tentam de novo com espera crescente (até ~45 s) em CHANNEL_ERROR/TIMED_OUT/CLOSED, removendo o
//     canal antes de recriá-lo, como o `subscribeWithBackoff` do front; a falha diz quantas tentativas fez;
//   - o reenvio do mesmo wamid responde "duplicate message skipped";
//   - GET /rest/v1/messages do wamid: A vê 1 linha inbound, B vê 0.
// Modo --so-assinar (passo 19, wss com a CA interna): só entra, assina e confirma "Subscribed to PostgreSQL".
// Imprime `OK <nome>` por checagem e sai 1 na primeira falha.
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { agoraMonotonico, assinarComTentativas, dormeReal as dorme, sondarAte, tentarMensagem } from "./realtime-lib.mjs";

const Ambiente = z.object({
  ECHO_URL: z.string().url(),
  ANON_KEY: z.string().min(20),
  SMOKE_A_EMAIL: z.string().email(),
  SMOKE_A_PASSWORD: z.string().min(8),
  SMOKE_B_EMAIL: z.string().email().optional(),
  SMOKE_B_PASSWORD: z.string().min(8).optional(),
  SMOKE_LINHA_A: z.string().uuid().optional(),
  SMOKE_EXEC_QR: z.string().min(1).optional(),
});
const env = Ambiente.parse(process.env);
const soAssinar = process.argv.includes("--so-assinar");
if (!soAssinar && !(env.SMOKE_B_EMAIL && env.SMOKE_B_PASSWORD && env.SMOKE_LINHA_A && env.SMOKE_EXEC_QR)) {
  console.error("modo completo exige SMOKE_B_EMAIL, SMOKE_B_PASSWORD, SMOKE_LINHA_A e SMOKE_EXEC_QR");
  process.exit(2);
}

/** @type {unknown} */
let transporte;
try {
  transporte = (await import("ws")).default;
} catch {
  transporte = undefined; // sem o pacote `ws` o supabase-js usa o WebSocket global do Node
}

const opcoes = {
  auth: { persistSession: false, autoRefreshToken: false },
  ...(transporte ? { realtime: { transport: transporte } } : {}),
};

const ok = (nome) => console.log(`OK ${nome}`);
const falhou = (nome, detalhe) => {
  console.error(`FALHOU ${nome}: ${detalhe}`);
  process.exit(1);
};

async function esperarAte(cond, ms) {
  const fim = agoraMonotonico() + ms;
  while (agoraMonotonico() < fim) {
    if (cond()) return true;
    await dorme(100);
  }
  return cond();
}

async function entrar(email, senha) {
  const c = createClient(env.ECHO_URL, env.ANON_KEY, opcoes);
  const { data, error } = await c.auth.signInWithPassword({ email, password: senha });
  if (error || !data.session) falhou(`login ${email}`, error?.message ?? "sem sessão");
  c.realtime.setAuth(data.session.access_token);
  return { cliente: c, token: data.session.access_token };
}

/** Assina com tentativas (ver realtime-lib.mjs); `criar` monta um canal novo com os handlers a cada tentativa. */
const assinar = (cliente, topico, nome, definir) =>
  assinarComTentativas({
    nome,
    criar: () => definir(cliente.channel(topico)),
    remover: (canal) => cliente.removeChannel(canal),
  });

/** POST em /<rota> da whatsapp-webhook, de dentro do container qr (WEBHOOK_URL e QR_WEBHOOK_SECRET do ambiente dele). */
function postarNoQr(rota, payload) {
  const script = `
(async () => {
  const r = await fetch(process.env.WEBHOOK_URL + ${JSON.stringify(rota)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qr-secret': process.env.QR_WEBHOOK_SECRET },
    body: ${JSON.stringify(JSON.stringify(payload))},
  });
  console.log(JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 400) }));
})();`;
  const r = spawnSync("sh", ["-c", `${env.SMOKE_EXEC_QR} node -`], { input: script, encoding: "utf8" });
  if (r.status !== 0) falhou(`POST ${rota} no container qr`, `${r.stderr}`.slice(0, 300));
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop() ?? "");
  } catch {
    return falhou(`POST ${rota} no container qr`, `saída inesperada: ${r.stdout.slice(0, 200)}`);
  }
}

const A = await entrar(env.SMOKE_A_EMAIL, env.SMOKE_A_PASSWORD);
const B = soAssinar ? null : await entrar(env.SMOKE_B_EMAIL, env.SMOKE_B_PASSWORD);
ok(soAssinar ? "realtime: login do usuário A" : "realtime: login de A e B");

const recebidos = { A: [], B: [] };
const filtroGlobal = { event: "INSERT", schema: "public", table: "messages", filter: "direction=eq.inbound" };
const aoGlobal = (usuario) => (canal) => canal.on("postgres_changes", filtroGlobal, (p) => recebidos[usuario].push({ canal: "global", p }));
let tentativasGlobais = 0;
try {
  tentativasGlobais += (await assinar(A.cliente, "global-notifications", "A/global-notifications", aoGlobal("A"))).tentativas;
  if (B) tentativasGlobais += (await assinar(B.cliente, "global-notifications", "B/global-notifications", aoGlobal("B"))).tentativas;
} catch (e) {
  falhou("realtime: assinatura de global-notifications", e.message);
}
if (tentativasGlobais > (B ? 2 : 1)) console.log(`AVISO realtime: global-notifications precisou de ${tentativasGlobais} tentativa(s) de assinatura`);
ok(`realtime: "Subscribed to PostgreSQL" (${env.ECHO_URL.startsWith("https") ? "wss" : "ws"})`);
console.log("PRONTO");

if (soAssinar) {
  await A.cliente.removeAllChannels();
  process.exit(0);
}

const sufixo = Date.now().toString(36).toUpperCase();
const agora = () => Math.floor(Date.now() / 1000);
const contato = "5511988887777";
const wamid1Inicial = `3EB0SMK${sufixo}IN`;
const mensagem = (wamid, texto) => ({
  phone_number_id: env.SMOKE_LINHA_A,
  from: contato,
  content: texto,
  contact_name: "Contato Fumaça",
  message_id: wamid,
  timestamp: agora(),
  message_type: "text",
  is_group: false,
  from_me: false,
});

// O "Subscribed to PostgreSQL" do canal global também chega antes de o poller do Realtime aplicar o filtro dele, e num
// stack recém-criado o primeiro INSERT logo depois do PRONTO se perdia (medido: 2 falhas em 5 fumaças completas, o
// mesmo caso do canal da conversa mais abaixo). Antes da mensagem que vale, manda sondas (wamid novo a cada 3 s, até
// 30 s) até A receber uma no canal global; e a mensagem principal tem até 3 tentativas (ver abaixo).
const sondasGlobais = new Set();
const chegouGlobal = (usuario, ids) => recebidos[usuario].some((x) => x.canal === "global" && ids.includes(x.p.new?.whatsapp_message_id));
const sondaGlobal = await sondarAte({
  enviar: (i) => {
    const wamid = `3EB0SMK${sufixo}G${i}`;
    sondasGlobais.add(wamid);
    const r = postarNoQr("/qr-message", mensagem(wamid, `Sonda global ${i} ${sufixo}`));
    if (r.status !== 200) falhou(`entrada: sonda global ${i}`, `HTTP ${r.status} ${r.body}`);
    return wamid;
  },
  recebeu: (ids) => chegouGlobal("A", ids),
});
if (!sondaGlobal.recebeu) falhou("realtime: A recebe no canal global", `nenhum evento depois de ${sondaGlobal.enviados.length} sonda(s) em 30 s`);
ok(`realtime: A recebeu uma sonda no canal global (${sondaGlobal.enviados.length} enviada(s))`);

// Mensagem principal: até 3 tentativas de 10 s, wamid novo em cada uma (rede de segurança: o 1º INSERT depois do
// "Subscribed to PostgreSQL" de um stack recém-criado pode se perder dentro do Realtime mesmo com a sonda tendo chegado).
// Passou em qualquer uma = OK (com AVISO se precisou de mais de uma); nenhuma chegou = FALHOU. As checagens seguintes
// (B, duplicata, REST, o WAMID do passo 17) usam o wamid da tentativa que chegou, e a de B cobre TODAS as enviadas.
const principais = new Set();
const respostas = new Map();
const principal = await tentarMensagem({
  enviar: (n) => {
    const wamid = n === 1 ? wamid1Inicial : `${wamid1Inicial}R${n}`;
    principais.add(wamid);
    const r = postarNoQr("/qr-message", mensagem(wamid, `Olá fumaça ${sufixo}${n === 1 ? "" : ` (tentativa ${n})`}`));
    respostas.set(wamid, r);
    if (r.status !== 200) falhou("entrada: /qr-message", `HTTP ${r.status} ${r.body}`);
    return wamid;
  },
  recebeu: (wamid) => recebidos.A.some((x) => x.p.new?.whatsapp_message_id === wamid),
});
ok("entrada: /qr-message recebido (200)");
if (!principal.recebeu) {
  falhou(
    `realtime: A recebe o INSERT em até 10 s (${principal.enviados.length} tentativas)`,
    `nenhum evento (o webhook respondeu ${respostas.get(principal.enviados[principal.enviados.length - 1]).body.slice(0, 160)}; A recebeu ${recebidos.A.length} evento(s) desde o início, ${recebidos.A.filter((x) => sondasGlobais.has(x.p.new?.whatsapp_message_id)).length} deles sonda(s))`,
  );
}
const wamid1 = principal.id;
if (principal.tentativa > 1) console.log(`AVISO realtime: a mensagem principal só chegou na tentativa ${principal.tentativa}`);
ok("realtime: A recebeu o INSERT em até 10 s");
await dorme(5000);
if (recebidos.B.some((x) => x.canal === "global" && (principais.has(x.p.new?.whatsapp_message_id) || sondasGlobais.has(x.p.new?.whatsapp_message_id)))) {
  falhou("realtime: B não recebe o INSERT de A", "B recebeu");
}
ok("realtime: B não recebeu o INSERT da organização de A em 5 s");

// Canal filtrado da conversa: A assina a própria; B tenta assinar a de A (a RLS vale no filtro).
const conversaId = recebidos.A.find((x) => x.p.new?.whatsapp_message_id === wamid1).p.new.conversation_id;
const filtroConversa = { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversaId}` };
const aoConversa = (usuario) => (canal) => canal.on("postgres_changes", filtroConversa, (p) => recebidos[usuario].push({ canal: "conversa", p }));
try {
  await assinar(A.cliente, `messages-${conversaId}`, "A/messages-conversa", aoConversa("A"));
  await assinar(B.cliente, `messages-${conversaId}`, "B/messages-conversa", aoConversa("B"));
} catch (e) {
  falhou("realtime: canal da conversa", e.message);
}
// O "Subscribed to PostgreSQL" de um canal novo chega antes de o poller do Realtime aplicar o filtro dele (medido: 1 falha
// em 7 rodadas com pausa fixa de 2 s, e a pausa não bastou com a máquina carregada). Em vez de apostar num tempo, manda
// uma mensagem de sonda (wamid novo a cada tentativa) a cada 3 s, até 30 s, e para quando A receber uma no canal filtrado.
const sondas = new Set();
const chegouNaConversa = (usuario, ids) => recebidos[usuario].some((x) => x.canal === "conversa" && ids.includes(x.p.new?.whatsapp_message_id));
const sonda = await sondarAte({
  enviar: (i) => {
    const wamid = `3EB0SMK${sufixo}P${i}`;
    sondas.add(wamid);
    const r = postarNoQr("/qr-message", mensagem(wamid, `Sonda ${i} ${sufixo}`));
    if (r.status !== 200) falhou(`entrada: sonda ${i}`, `HTTP ${r.status} ${r.body}`);
    return wamid;
  },
  recebeu: (ids) => chegouNaConversa("A", ids),
});
if (!sonda.recebeu) falhou("realtime: A recebe no canal filtrado da conversa", `nenhum evento depois de ${sonda.enviados.length} sonda(s) em 30 s`);
ok(`realtime: A recebeu uma sonda no canal filtrado da conversa (${sonda.enviados.length} enviada(s))`);
await dorme(5000);
const vazou = recebidos.B.filter((x) => sondas.has(x.p.new?.whatsapp_message_id));
if (vazou.length > 0) falhou("realtime: B não recebe no canal da conversa de A", `B recebeu ${vazou.length} das ${sondas.size} sonda(s)`);
ok(`realtime: B, assinando a conversa de A, não recebeu nenhuma das ${sondas.size} sonda(s) (RLS)`);

const r3 = postarNoQr("/qr-message", mensagem(wamid1, `Olá fumaça ${sufixo}`));
if (r3.status !== 200 || !/duplicate/i.test(r3.body)) falhou("entrada: reenvio do mesmo wamid", `HTTP ${r3.status} ${r3.body}`);
ok("entrada: reenvio do mesmo wamid = duplicate message skipped");

const linhas = async (usuario) => {
  const r = await fetch(`${env.ECHO_URL}/rest/v1/messages?select=id,direction&whatsapp_message_id=eq.${wamid1}`, {
    headers: { apikey: env.ANON_KEY, Authorization: `Bearer ${usuario.token}` },
  });
  return { status: r.status, corpo: await r.json() };
};
const lA = await linhas(A);
if (lA.status !== 200 || lA.corpo.length !== 1 || lA.corpo[0].direction !== "inbound") falhou("rest: A vê 1 linha inbound", JSON.stringify(lA));
ok("rest: GET /rest/v1/messages com A = 1 linha inbound");
const lB = await linhas(B);
if (lB.status !== 200 || lB.corpo.length !== 0) falhou("rest: B vê 0 linhas", JSON.stringify(lB));
ok("rest: GET /rest/v1/messages com B = 0 linhas");

// O wamid fica para o passo 17 conferir que a mensagem sobrevive ao reinício.
console.log(`WAMID ${wamid1}`);
await A.cliente.removeAllChannels();
await B.cliente.removeAllChannels();
process.exit(0);
