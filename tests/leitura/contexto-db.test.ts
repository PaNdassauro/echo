// Depende de _shared/metadata-merge.ts (P4): sem ele o import falha.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.87.1";
import { carregarJanela, COLUNAS_MSG, ioDeProducao } from "../../supabase/functions/_shared/conversa-contexto-db.ts";
import type { Leitura } from "../../supabase/functions/_shared/leitura-midia.ts";

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const CONV = "00000000-0000-4000-8000-0000000000c1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const linha = (n: number, p: Record<string, unknown> = {}) => ({
  id: uuid(n),
  conversation_id: CONV,
  created_at: `2026-10-14T10:00:${String(n).padStart(2, "0")}.123456+00:00`,
  direction: "inbound",
  message_type: "text",
  content: `m${n}`,
  status: null,
  reaction: null,
  sender_name: null,
  sender_phone: null,
  sent_by: null,
  is_deleted: false,
  is_edited: false,
  quoted_message_id: null,
  media_url: null,
  media_filename: null,
  media_mime_type: null,
  media_size_bytes: null,
  metadata: null,
  ...p,
});

type Chamada = { tabela: string; metodos: Array<[string, unknown[]]> };

/** Builder falso: registra cada método encadeado e devolve a resposta da fila da tabela. */
function banco(respostas: { messages: unknown[][]; message_reactions: unknown[][] }) {
  const chamadas: Chamada[] = [];
  const filas = { messages: [...respostas.messages], message_reactions: [...respostas.message_reactions] };
  const db = {
    from(tabela: "messages" | "message_reactions") {
      const c: Chamada = { tabela, metodos: [] };
      chamadas.push(c);
      const data = filas[tabela].shift() ?? [];
      const proxy: Record<string, unknown> = new Proxy({}, {
        get(_t, metodo: string) {
          if (metodo === "then") {
            return (ok: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(ok);
          }
          return (...args: unknown[]) => {
            c.metodos.push([metodo, args]);
            return proxy;
          };
        },
      });
      return proxy;
    },
  };
  return { db: db as unknown as SupabaseClient, chamadas };
}

const base = {
  conversationId: CONV,
  cursor: { at: "2026-10-14T10:00:05.000000Z", id: uuid(5) },
  ate: { at: "2026-10-14T10:00:20.000000Z", id: uuid(20) },
  reacaoDesde: "2026-10-14T10:00:05.000000Z",
  reacaoAte: "2026-10-14T10:30:00.000000Z",
};
const metodo = (c: Chamada, nome: string) => c.metodos.filter(([m]) => m === nome).map(([, a]) => a);

Deno.test("carregarJanela: novas em ordem decrescente com +1, excedente cortado, reverse e µs preservados", async () => {
  // limiteNovas = 3 → pede 4; vieram 4 (desc) → trunca a mais antiga
  const novas = [9, 8, 7, 6].map((n) => linha(n));
  const anteriores = [4, 3].map((n) => linha(n));
  const { db, chamadas } = banco({ messages: [novas, anteriores], message_reactions: [[]] });
  const j = await carregarJanela(db, { ...base, limiteNovas: 3, anteriores: 2 });
  equal(j.novasTruncadas, true);
  equal(j.mensagens.map((m) => m.content), ["m3", "m4", "m7", "m8", "m9"]);
  equal(j.mensagens[0].created_at, "2026-10-14T10:00:03.123456Z");
  // consulta de novas
  const q = chamadas[0];
  equal(q.tabela, "messages");
  equal(metodo(q, "select"), [[COLUNAS_MSG]]);
  equal(metodo(q, "eq"), [["conversation_id", CONV]]);
  equal(metodo(q, "limit"), [[4]]);
  equal(metodo(q, "order"), [["created_at", { ascending: false }], ["id", { ascending: false }]]);
  const ors = metodo(q, "or").map((a) => a[0]);
  equal(ors, [
    `created_at.gt.2026-10-14T10:00:05.000000Z,and(created_at.eq.2026-10-14T10:00:05.000000Z,id.gt.${uuid(5)})`,
    `created_at.lt.2026-10-14T10:00:20.000000Z,and(created_at.eq.2026-10-14T10:00:20.000000Z,id.lte.${uuid(20)})`,
  ]);
  // consulta de anteriores
  equal(metodo(chamadas[1], "limit"), [[2]]);
  equal(metodo(chamadas[1], "or").map((a) => a[0]), [
    `created_at.lt.2026-10-14T10:00:05.000000Z,and(created_at.eq.2026-10-14T10:00:05.000000Z,id.lte.${uuid(5)})`,
  ]);
});

Deno.test("carregarJanela: sem excedente não trunca; cursor com id nulo usa só created_at", async () => {
  const { db, chamadas } = banco({ messages: [[linha(9), linha(8)], []], message_reactions: [[]] });
  const j = await carregarJanela(db, { ...base, cursor: { at: "2026-10-14T10:00:05.000000Z", id: null }, limiteNovas: 5 });
  equal(j.novasTruncadas, false);
  equal(j.mensagens.map((m) => m.content), ["m8", "m9"]);
  equal(metodo(chamadas[0], "or")[0][0], "created_at.gt.2026-10-14T10:00:05.000000Z");
  equal(metodo(chamadas[1], "or")[0][0], "created_at.lte.2026-10-14T10:00:05.000000Z");
});

Deno.test("carregarJanela: anteriores = 0 não consulta", async () => {
  const { db, chamadas } = banco({ messages: [[linha(9)]], message_reactions: [[]] });
  await carregarJanela(db, { ...base, anteriores: 0 });
  equal(chamadas.filter((c) => c.tabela === "messages").length, 1);
});

Deno.test("carregarJanela: reações com teto próprio (não a âncora) e citadas em lotes de 150", async () => {
  const citados = Array.from({ length: 160 }, (_, i) => uuid(1000 + i));
  const novas = citados.map((id, i) => linha(i + 100, { id: uuid(5000 + i), quoted_message_id: id, created_at: `2026-10-14T11:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000001+00:00` }));
  const reacao = { id: "r1", message_id: uuid(2000), emoji: "👍", is_from_me: null, reactor_name: null, reacted_at: "2026-10-14T10:20:00.5+00:00", messages: { conversation_id: CONV } };
  const { db, chamadas } = banco({
    messages: [novas.slice().reverse(), [], [linha(1000, { created_at: "2026-10-14T09:00:00+00:00" })], [linha(2000, { created_at: "2026-10-14T09:00:01+00:00" })]],
    message_reactions: [[reacao]],
  });
  const j = await carregarJanela(db, { ...base, limiteNovas: 200, anteriores: 5 });
  equal(j.reacoes, [{ id: "r1", message_id: uuid(2000), emoji: "👍", is_from_me: false, reactor_name: null, reacted_at: "2026-10-14T10:20:00.500000Z" }]);
  const r = chamadas.find((c) => c.tabela === "message_reactions")!;
  equal(metodo(r, "eq"), [["messages.conversation_id", CONV]]);
  equal(metodo(r, "gt"), [["reacted_at", "2026-10-14T10:00:05.000000Z"]]);
  equal(metodo(r, "lte"), [["reacted_at", "2026-10-14T10:30:00.000000Z"]]);
  // 160 citadas + 1 alvo de reação = 161 ids → 2 lotes (150 + 11)
  const lotes = chamadas.filter((c) => c.tabela === "messages").slice(2).map((c) => (metodo(c, "in")[0][1] as string[]).length);
  equal(lotes, [150, 11]);
  equal(j.citadas.map((c) => c.id).sort(), [uuid(1000), uuid(2000)]);
});

Deno.test("carregarJanela: linha inválida é ignorada; ponto inválido lança", async () => {
  const log = console.error;
  console.error = () => {};
  try {
    const { db } = banco({ messages: [[linha(9), { id: "x", direction: "sideways" }], []], message_reactions: [[]] });
    const j = await carregarJanela(db, base);
    equal(j.mensagens.map((m) => m.content), ["m9"]);
  } finally {
    console.error = log;
  }
  const { db } = banco({ messages: [[], []], message_reactions: [[]] });
  let erro = "";
  try {
    await carregarJanela(db, { ...base, cursor: { at: "2026-10-14T10:00:05Z", id: "x'); drop table" } });
  } catch (e) {
    erro = (e as Error).message;
  }
  equal(erro, "carregarJanela: cursor.id inválido");
});

Deno.test("ioDeProducao: reservar valida a leitura; gravar manda { leitura } inteiro pela RPC", async () => {
  const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const retornos: Record<string, unknown> = {
    messages_leitura_reservar: { v: 1, tentativas: 1, lacuna: false, custo_usd: 0, em_leitura_desde: "2026-10-15T15:00:00.000000Z", erro: null },
    messages_mesclar_metadata: {},
  };
  const db = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      chamadas.push({ fn, args });
      return Promise.resolve({ data: retornos[fn] ?? null, error: null });
    },
  } as unknown as SupabaseClient;
  const io = ioDeProducao(db);
  const r = await io.reservar("m1");
  equal(r?.tentativas, 1);
  equal(r?.texto, null);
  retornos.messages_leitura_reservar = null;
  equal(await io.reservar("m1"), null);
  const l = { v: 1, texto: "x" } as unknown as Leitura;
  await io.gravar("m1", l);
  const g = chamadas.find((c) => c.fn === "messages_mesclar_metadata")!;
  equal(g.args.p_message_id, "m1");
  equal(g.args.p_patch, { leitura: l });
  equal(g.args.p_nivel2, false);
});

Deno.test("ioDeProducao: baixar usa o caminho do bucket; host de fora é recusado", async () => {
  const antes = [Deno.env.get("SUPABASE_URL"), Deno.env.get("ECHO_PUBLIC_URL")] as const;
  Deno.env.set("SUPABASE_URL", "https://abc.supabase.co");
  Deno.env.delete("ECHO_PUBLIC_URL");
  try {
    await baixarUsaOCaminhoDoBucket();
  } finally {
    if (antes[0] === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", antes[0]);
    if (antes[1] !== undefined) Deno.env.set("ECHO_PUBLIC_URL", antes[1]);
  }
});

async function baixarUsaOCaminhoDoBucket(): Promise<void> {
  const baixados: string[] = [];
  const db = {
    storage: {
      from: (bucket: string) => ({
        download: (caminho: string) => {
          baixados.push(`${bucket}:${caminho}`);
          return Promise.resolve({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
        },
      }),
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
  const io = ioDeProducao(db);
  const m = (media_url: string | null) => ({
    id: "m", conversation_id: CONV, direction: "inbound" as const, message_type: "audio", content: null, is_deleted: false,
    media_url, media_mime_type: "audio/ogg", media_filename: null, media_size_bytes: 3, metadata: null,
  });
  const bytes = await io.baixar(m("https://abc.supabase.co/storage/v1/object/public/attachments/inbound/a%20b.ogg"));
  equal([...bytes], [1, 2, 3]);
  equal(baixados, ["attachments:inbound/a b.ogg"]);
  const recusa = async (url: string | null) => {
    try {
      await io.baixar(m(url));
      return "ok";
    } catch (e) {
      return (e as Error).message;
    }
  };
  equal(await recusa("https://evil.com/x.ogg"), "host da mídia não permitido");
  equal(await recusa(null), "sem media_url");
  equal(await recusa("não url"), "media_url inválida");
}

Deno.test("ioDeProducao: baixar sem caminho no bucket aceita a base pública (vira a interna) e a URL assinada; host de fora segue recusado", async () => {
  const antes = [Deno.env.get("SUPABASE_URL"), Deno.env.get("ECHO_PUBLIC_URL")] as const;
  Deno.env.set("SUPABASE_URL", "http://gateway:8000");
  Deno.env.set("ECHO_PUBLIC_URL", "https://echo.example.com");
  const fetchOriginal = globalThis.fetch;
  const buscados: string[] = [];
  globalThis.fetch = ((url: string | URL | Request) => {
    buscados.push(String(url));
    return Promise.resolve(new Response(new Uint8Array([9, 8]), { status: 200 }));
  }) as typeof fetch;
  try {
    const db = { rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
    const io = ioDeProducao(db);
    const m = (media_url: string) => ({
      id: "m", conversation_id: CONV, direction: "inbound" as const, message_type: "audio", content: null, is_deleted: false,
      media_url, media_mime_type: "audio/ogg", media_filename: null, media_size_bytes: 2, metadata: null,
    });
    // URL assinada na base pública: não é "anexo nosso" (só object/public/), cai no fallback e é buscada pela interna.
    const bytes = await io.baixar(m("https://echo.example.com/storage/v1/object/sign/attachments/a.ogg?token=t"));
    equal([...bytes], [9, 8]);
    equal(buscados, ["http://gateway:8000/storage/v1/object/sign/attachments/a.ogg?token=t"]);
    // A interna passa direto; host de fora e outra porta da pública não.
    await io.baixar(m("http://gateway:8000/storage/v1/object/sign/attachments/b.ogg?token=t"));
    equal(buscados.length, 2);
    for (const url of ["https://evil.example.com/x.ogg", "https://echo.example.com:8443/x.ogg"]) {
      let erro = "";
      try {
        await io.baixar(m(url));
      } catch (e) {
        erro = (e as Error).message;
      }
      equal(`${url} -> ${erro}`, `${url} -> host da mídia não permitido`);
    }
    equal(buscados.length, 2);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (antes[0] === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", antes[0]);
    if (antes[1] === undefined) Deno.env.delete("ECHO_PUBLIC_URL");
    else Deno.env.set("ECHO_PUBLIC_URL", antes[1]);
  }
});
