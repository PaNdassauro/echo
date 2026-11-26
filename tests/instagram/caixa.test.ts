import { aplicarReacao, bolhaDoAnexo, destinoDaConversa, pessoaDoEvento } from "../../supabase/functions/_shared/instagram-caixa.ts";
import { erroDoDirect, ultimaEntradaAbreODirect } from "../../supabase/functions/_shared/instagram-envio.ts";

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const CONTA = "17841400000000001";
const PESSOA = "9876543210987654";
const LINHA = "00000000-0000-4000-8000-000000000001";

const conexao = (modo: "off" | "on") => ({
  inbox_mode: modo,
  phone_number_id: LINHA,
});

Deno.test("pessoa: no eco é o destinatário; no resto, o remetente", () => {
  equal(pessoaDoEvento({ event_type: "message", sender_id: PESSOA, recipient_id: CONTA }), PESSOA);
  equal(pessoaDoEvento({ event_type: "read", sender_id: PESSOA, recipient_id: CONTA }), PESSOA);
  equal(pessoaDoEvento({ event_type: "echo", sender_id: CONTA, recipient_id: PESSOA }), PESSOA);
});

Deno.test("destino: desligado não vira conversa", () => {
  equal(destinoDaConversa(conexao("off")), { nota: "caixa desligada" });
});

Deno.test("destino: ligado vai para a linha da conexão", () => {
  equal(destinoDaConversa(conexao("on")), { linha: LINHA });
});

Deno.test("anexo: mídia baixa, post compartilhado vira texto com link, tipo novo não some", () => {
  equal(bolhaDoAnexo({ tipo: "image", url: "u", titulo: null }), { tipo: "image", conteudo: "[Imagem]", baixar: true });
  equal(bolhaDoAnexo({ tipo: "audio", url: "u", titulo: null }).tipo, "audio");
  equal(bolhaDoAnexo({ tipo: "file", url: "u", titulo: "contrato.pdf" }).conteudo, "contrato.pdf");
  equal(bolhaDoAnexo({ tipo: "ig_reel", url: "https://x", titulo: null }), {
    tipo: "text",
    conteudo: "Compartilhou um post: https://x",
    baixar: false,
  });
  equal(bolhaDoAnexo({ tipo: "novidade", url: null, titulo: null }), {
    tipo: "unsupported",
    conteudo: "[Direct: novidade]",
    baixar: false,
  });
});

Deno.test("erro do envio: janela de 24h e token vencido viram frase para o painel", () => {
  const janela = erroDoDirect(400, { code: 10, error_subcode: 2534022, message: "This message is sent outside of allowed window." });
  if (!janela.startsWith("Direct fora da janela")) throw new Error(janela);
  if (!erroDoDirect(400, { code: 190 }).startsWith("Direct desconectado")) throw new Error("190");
  if (!erroDoDirect(500, null).startsWith("Direct recusou")) throw new Error("genérico");
});

Deno.test("resposta no card juntado: Direct só se o contato escreveu por último lá e nas 24h", () => {
  const agora = Date.parse("2026-09-28T20:00:00Z");
  equal(ultimaEntradaAbreODirect({ metadata: { canal: "instagram" }, created_at: "2026-09-28T19:00:00Z" }, agora), true);
  equal(ultimaEntradaAbreODirect({ metadata: { canal: "instagram", sent_at: "2026-09-27T19:00:00Z" }, created_at: "2026-09-28T19:00:00Z" }, agora), false);
  equal(ultimaEntradaAbreODirect({ metadata: {}, created_at: "2026-09-28T19:59:00Z" }, agora), false);
  equal(ultimaEntradaAbreODirect(null, agora), false);
});

// Db falso: registra as operações encadeadas por tabela.
function dbFalso(ids: string[]) {
  const ops: Array<{ tabela: string; op: string; arg?: unknown }> = [];
  const db = {
    from(tabela: string) {
      let op = "select";
      let arg: unknown;
      const b: Record<string, unknown> = {
        update: (v: unknown) => { op = "update"; arg = v; return b; },
        delete: () => { op = "delete"; return b; },
        insert: (v: unknown) => { ops.push({ tabela, op: "insert", arg: v }); return Promise.resolve({ error: null }); },
        eq: () => b,
        select: () => Promise.resolve({ data: ids.map((id) => ({ id })), error: null }),
        then: (res: (v: unknown) => void) => { ops.push({ tabela, op, arg }); res({ error: null }); },
      };
      return b;
    },
  };
  return { db, ops };
}

const evReacao = (reaction: Record<string, unknown>) => ({
  id: 1, ig_account_id: CONTA, sender_id: PESSOA, recipient_id: CONTA, event_type: "reaction", mid: null, event_at: null, payload: { reaction },
});

Deno.test("reação do Direct: grava o escalar e a linha em message_reactions (ig:<IGSID>, is_from_me=false)", async () => {
  const { db, ops } = dbFalso(["m-uuid"]);
  const conversa = { id: "c1" } as Parameters<typeof aplicarReacao>[1];
  equal(await aplicarReacao(db, conversa, evReacao({ mid: "alvo", action: "react", emoji: "❤️" })), "reação aplicada");
  const ins = ops.find((o) => o.tabela === "message_reactions" && o.op === "insert");
  equal(ins?.arg, { message_id: "m-uuid", reactor_jid: `ig:${PESSOA}`, reactor_name: null, is_from_me: false, emoji: "❤️" });
  equal(ops.some((o) => o.tabela === "message_reactions" && o.op === "delete"), true);
});

Deno.test("reação do Direct: desfazer remove a linha e não insere", async () => {
  const { db, ops } = dbFalso(["m-uuid"]);
  const conversa = { id: "c1" } as Parameters<typeof aplicarReacao>[1];
  await aplicarReacao(db, conversa, evReacao({ mid: "alvo", action: "unreact" }));
  equal(ops.some((o) => o.tabela === "message_reactions" && o.op === "insert"), false);
  equal(ops.some((o) => o.tabela === "message_reactions" && o.op === "delete"), true);
});
