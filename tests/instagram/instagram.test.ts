import {
  abrirAvisos,
  assinarEstado,
  assinaturaConfere,
  hmacHex,
  lerEstado,
  linhaPodeHospedar,
  linkDeAutorizacao,
  precisaRenovar,
  segredosDoApp,
  sha256Hex,
} from "../../supabase/functions/_shared/instagram.ts";

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const CONTA = "17841400000000001";
const PESSOA = "9876543210987654";
const SEGREDO = "s".repeat(40);

function aviso(evento: Record<string, unknown>) {
  return {
    object: "instagram",
    entry: [{ id: CONTA, time: 1759090000000, messaging: [{ sender: { id: PESSOA }, recipient: { id: CONTA }, timestamp: 1759090000000, ...evento }] }],
  };
}

Deno.test("assinatura: confere com o segredo certo, em qualquer posição da lista", async () => {
  const corpo = JSON.stringify(aviso({ message: { mid: "m1", text: "oi" } }));
  const cabecalho = `sha256=${await hmacHex("segredo-b", corpo)}`;
  equal(await assinaturaConfere(corpo, cabecalho, ["segredo-a", "segredo-b"]), true);
  equal(await assinaturaConfere(corpo, cabecalho.toUpperCase().replace("SHA256=", "sha256="), ["segredo-b"]), true);
});

Deno.test("assinatura: recusa segredo errado, corpo mexido, cabeçalho ausente e lista vazia", async () => {
  const corpo = JSON.stringify(aviso({ message: { mid: "m1", text: "oi" } }));
  const cabecalho = `sha256=${await hmacHex("segredo", corpo)}`;
  equal(await assinaturaConfere(corpo, cabecalho, ["outro"]), false);
  equal(await assinaturaConfere(corpo + " ", cabecalho, ["segredo"]), false);
  equal(await assinaturaConfere(corpo, null, ["segredo"]), false);
  equal(await assinaturaConfere(corpo, "sha1=abc", ["segredo"]), false);
  equal(await assinaturaConfere(corpo, cabecalho, []), false);
});

Deno.test("segredos: vírgula separa, espaço e vazio somem", () => {
  equal(segredosDoApp(" a , ,b,"), ["a", "b"]);
  equal(segredosDoApp(""), []);
});

Deno.test("state: ida e volta; mexido, vencido ou com outro segredo vira nulo", async () => {
  const estado = { org: "00000000-0000-4000-8000-000000000001", linha: "00000000-0000-4000-8000-000000000002", exp: 2_000_000_000, n: "abc" };
  const texto = await assinarEstado(estado, SEGREDO);
  equal(await lerEstado(texto, SEGREDO, 1_999_999_000), estado);
  equal(await lerEstado(texto, "o".repeat(40), 1_999_999_000), null);
  equal(await lerEstado(texto, SEGREDO, 2_000_000_001), null);
  const [corpo, assinatura] = texto.split(".");
  equal(await lerEstado(`${corpo}x.${assinatura}`, SEGREDO, 1_999_999_000), null);
  equal(await lerEstado("sem-ponto", SEGREDO, 1_999_999_000), null);
  equal(await lerEstado(null, SEGREDO, 1_999_999_000), null);
  equal(await lerEstado(texto, "", 1_999_999_000), null);
});

Deno.test("state: segredo curto e validade longa demais são recusados", async () => {
  const curto = "c".repeat(20);
  const estado = { org: "o", linha: "l", exp: 2_000_000_000, n: "n" };
  equal(await lerEstado(await assinarEstado(estado, curto), curto, 1_999_999_000), null);
  // validade 3 horas à frente: não saiu de nós (o link vale 30 min)
  equal(await lerEstado(await assinarEstado(estado, SEGREDO), SEGREDO, 2_000_000_000 - 3 * 3600), null);
});

Deno.test("avisos: mensagem, eco, apagada, botão, marca do link, leitura, reação e edição", async () => {
  const casos: [Record<string, unknown>, string, string | null][] = [
    [{ message: { mid: "m1", text: "oi" } }, "message", "m1"],
    [{ message: { mid: "m2", text: "resposta", is_echo: true } }, "echo", "m2"],
    [{ message: { mid: "m3", is_deleted: true } }, "deleted", "m3"],
    [{ postback: { mid: "m4", title: "Quero saber mais", payload: "ICE_SABER_MAIS" } }, "postback", "m4"],
    [{ referral: { ref: "bio", source: "SHORTLINKS", type: "OPEN_THREAD" } }, "referral", null],
    [{ read: { mid: "m5" } }, "read", "m5"],
    [{ reaction: { mid: "m6", action: "react", emoji: "❤️" } }, "reaction", "m6"],
    [{ message_edit: { mid: "m7", text: "corrigido" } }, "edit", "m7"],
    [{ algo_novo: true }, "other", null],
  ];
  for (const [evento, tipo, mid] of casos) {
    const [a] = await abrirAvisos(aviso(evento));
    equal(a.tipo, tipo);
    equal(a.mid, mid);
    equal(a.igAccountId, CONTA);
    equal(a.senderId, PESSOA);
    equal(a.recipientId, CONTA);
    equal(a.eventAt, new Date(1759090000000).toISOString());
    equal(a.hash.length, 64);
  }
});

Deno.test("avisos: reentrega igual repete a impressão; reagir e desfazer na mesma mensagem não", async () => {
  const reagir = aviso({ reaction: { mid: "alvo", action: "react", emoji: "❤️" } });
  const desfazer = aviso({ reaction: { mid: "alvo", action: "unreact" } });
  const [a1] = await abrirAvisos(reagir);
  const [a2] = await abrirAvisos(JSON.parse(JSON.stringify(reagir)));
  const [a3] = await abrirAvisos(desfazer);
  equal(a1.hash, a2.hash);
  equal(a1.hash === a3.hash, false);
});

Deno.test("avisos: vários eventos viram vários itens; entrada desconhecida e corpo estranho ficam registrados", async () => {
  const corpo = {
    object: "instagram",
    entry: [
      { id: CONTA, messaging: [{ message: { mid: "a" } }, { message: { mid: "b" } }] },
      { id: CONTA, time: 1759090000000, standby: [{ message: { mid: "c" } }] },
    ],
  };
  const itens = await abrirAvisos(corpo);
  equal(itens.map((a) => a.tipo), ["message", "message", "other"]);
  equal(itens.map((a) => a.mid), ["a", "b", null]);
  const estranho = await abrirAvisos({ qualquer: 1 });
  equal(estranho.length, 1);
  equal(estranho[0].tipo, "other");
  equal(estranho[0].payload, { qualquer: 1 });
  equal((await abrirAvisos("texto")).length, 1);
});

Deno.test("avisos: timestamp em segundos também vira data", async () => {
  const [a] = await abrirAvisos({ object: "instagram", entry: [{ id: CONTA, messaging: [{ timestamp: 1759090000, message: { mid: "s" } }] }] });
  equal(a.eventAt, new Date(1759090000 * 1000).toISOString());
});

Deno.test("sha256Hex: valor conhecido", async () => {
  equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

Deno.test("state: marca app (volta para o Echo) passa ida e volta", async () => {
  const estado = { org: "o", linha: "l", exp: 2_000_000_000, n: "n", app: true };
  equal(await lerEstado(await assinarEstado(estado, SEGREDO), SEGREDO, 1_999_999_000), estado);
});

Deno.test("linha que divide a caixa: QR e API sim, outro tipo não", () => {
  equal(["qr", "business_api", "business", "official", null, undefined].map(linhaPodeHospedar), [true, true, true, true, true, true]);
  equal(["instagram", "twilio", ""].map(linhaPodeHospedar), [false, false, false]);
});

Deno.test("link de autorização: app, volta, escopos do Direct e state", () => {
  const link = new URL(linkDeAutorizacao("123", "https://x.supabase.co/functions/v1/instagram-oauth", "abc.def"));
  equal(link.origin + link.pathname, "https://www.instagram.com/oauth/authorize");
  equal(link.searchParams.get("client_id"), "123");
  equal(link.searchParams.get("redirect_uri"), "https://x.supabase.co/functions/v1/instagram-oauth");
  equal(link.searchParams.get("response_type"), "code");
  equal(link.searchParams.get("scope"), "instagram_business_basic,instagram_business_manage_messages");
  equal(link.searchParams.get("state"), "abc.def");
});

Deno.test("renovação do token: só conectada, perto de vencer, no máximo a cada 12 h", () => {
  const agora = Date.parse("2026-11-20T12:00:00Z");
  const base = { status: "connected", access_token: "tok", token_expires_at: "2026-11-27T18:32:01Z", token_refresh_tried_at: null };
  equal(precisaRenovar(base, agora), true);
  equal(precisaRenovar({ ...base, token_expires_at: "2026-12-30T00:00:00Z" }, agora), false);
  equal(precisaRenovar({ ...base, status: "disconnected" }, agora), false);
  equal(precisaRenovar({ ...base, access_token: "" }, agora), false);
  equal(precisaRenovar({ ...base, token_expires_at: null }, agora), false);
  equal(precisaRenovar({ ...base, token_refresh_tried_at: "2026-11-20T06:00:00Z" }, agora), false);
  equal(precisaRenovar({ ...base, token_refresh_tried_at: "2026-11-19T23:00:00Z" }, agora), true);
});
