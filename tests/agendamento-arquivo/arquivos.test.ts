// deno test --no-config --allow-env --allow-read tests/agendamento-arquivo
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.87.1";
import {
  AgendamentoPerdido,
  ArquivoAgendadoInvalido,
  FalhaNoArquivo,
  LotePausado,
  ORCAMENTO_MS,
  enviarArquivosAgendados,
  respostaAmbigua,
  lerItensAgendados,
  pendentes,
  progressoDoErro,
  type ContextoDoAgendamento,
  type ItemAgendado,
  type LinhaDoEnvio,
} from "../../supabase/functions/scheduled-message-execute/arquivos.ts";
import {
  caminhoDoUsuarioValido,
  conteudoDaMidia,
  corrigirMimeDeHtml,
  tipoPeloMime,
} from "../../supabase/functions/_shared/midia-envio.ts";

function equal(a: unknown, b: unknown, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const UID = "11111111-1111-1111-1111-111111111111";
const OUTRO = "22222222-2222-2222-2222-222222222222";
const SUPA = "https://x.supabase.co";

function item(nome: string, p: Partial<ItemAgendado> = {}): ItemAgendado {
  return {
    storage_path: `outbound/${UID}/1731300000000_${nome}`,
    filename: nome,
    mime_type: "application/pdf",
    size_bytes: 1000,
    caption: null,
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Supabase falso: toda cadeia termina em {data:null,error:null}, menos o que o
// teste precisa ver (upsert em messages devolve id; update registra o payload).
// ---------------------------------------------------------------------------
type Op = { table: string; ops: Array<[string, unknown[]]> };

/** Como o UPDATE de progresso responde: dono (1 linha), perdido (0 linhas) ou erro. */
type Posse = "dono" | "perdido" | "erro";

function fakeSupabase(log: Op[], posse: Posse = "dono") {
  let msgSeq = 0;
  const chain = (table: string): unknown => {
    const entry: Op = { table, ops: [] };
    log.push(entry);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then") {
          const isUpsertMsg = table === "messages" && entry.ops.some(([o]) => o === "upsert");
          const isProgresso = table === "scheduled_messages" && entry.ops.some(([o]) => o === "update");
          const result = isUpsertMsg
            ? { data: { id: `msg-${++msgSeq}` }, error: null }
            : isProgresso
              ? posse === "erro"
                ? { data: null, error: { message: "upstream timeout" } }
                : { data: posse === "dono" ? [{ id: "sched-1" }] : [], error: null }
              : { data: null, error: null };
          return (resolve: (v: unknown) => void) => resolve(result);
        }
        return (...args: unknown[]) => {
          entry.ops.push([String(prop), args]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  return {
    from: (table: string) => chain(table),
    rpc: () => chain("rpc"),
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: `${SUPA}/storage/v1/object/public/attachments/${path}` } }),
        list: () => Promise.resolve({ data: [], error: null }),
      }),
    },
  } as unknown as SupabaseClient;
}

type Envio = { url: string; form: FormData; comPrazo: boolean };

/** fetch falso: HEAD do Storage responde o arquivo; o qr-service devolve W1, W2…; `falharNo` derruba o envio n (1-based). */
function stubFetch(envios: Envio[], falharNo?: number, respostaDaFalha?: () => Promise<Response>) {
  const original = globalThis.fetch;
  // Env só durante o teste: outros arquivos da mesma rodada leem SUPABASE_URL.
  const qrAntes = Deno.env.get("QR_SERVICE_URL");
  const supaAntes = Deno.env.get("SUPABASE_URL");
  const publicaAntes = Deno.env.get("ECHO_PUBLIC_URL");
  Deno.env.set("QR_SERVICE_URL", "https://qr.test");
  // A URL do anexo vem de _shared/url-publica.ts (SUPABASE_URL, ou ECHO_PUBLIC_URL quando existe).
  Deno.env.set("SUPABASE_URL", SUPA);
  Deno.env.delete("ECHO_PUBLIC_URL");
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "HEAD") {
      return Promise.resolve(new Response(null, { status: 200, headers: { "content-type": "application/pdf", "content-length": "1000" } }));
    }
    if (url.startsWith("https://qr.test/message/send-media/")) {
      const n = envios.length + 1;
      if (n === falharNo) return respostaDaFalha ? respostaDaFalha() : Promise.reject(new TypeError("connection reset"));
      envios.push({ url, form: init?.body as FormData, comPrazo: init?.signal instanceof AbortSignal });
      return Promise.resolve(Response.json({ success: true, messageId: `W${n}` }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    if (qrAntes === undefined) Deno.env.delete("QR_SERVICE_URL");
    else Deno.env.set("QR_SERVICE_URL", qrAntes);
    if (supaAntes === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", supaAntes);
    if (publicaAntes !== undefined) Deno.env.set("ECHO_PUBLIC_URL", publicaAntes);
  };
}

const LINHA: LinhaDoEnvio = {
  id: "phone-1",
  phone_number_id: null,
  connection_type: "qr",
  organization_id: "org-1",
  accessToken: null,
};

function agendamento(media: ItemAgendado[], p: Partial<ContextoDoAgendamento> = {}): ContextoDoAgendamento {
  return {
    id: "sched-1",
    attempts: 1,
    conversation_id: "conv-1",
    contact_phone: "5511999990000",
    created_by: UID,
    quoted_message_id: null,
    media,
    ...p,
  };
}

/** Payloads dos UPDATEs de progresso em scheduled_messages. */
function progressos(log: Op[]): ItemAgendado[][] {
  return log
    .filter((e) => e.table === "scheduled_messages")
    .flatMap((e) => e.ops.filter(([o]) => o === "update").map(([, args]) => (args[0] as { media: ItemAgendado[] }).media));
}

/** Filtros `.eq` de cada UPDATE de progresso. */
function filtrosDoProgresso(log: Op[]): Array<Array<[string, unknown]>> {
  return log
    .filter((e) => e.table === "scheduled_messages" && e.ops.some(([o]) => o === "update"))
    .map((e) => e.ops.filter(([o]) => o === "eq").map(([, args]) => [args[0] as string, args[1]]));
}

function linhasDeMensagem(log: Op[]): Array<Record<string, unknown>> {
  return log
    .filter((e) => e.table === "messages")
    .flatMap((e) => e.ops.filter(([o]) => o === "upsert").map(([, args]) => args[0] as Record<string, unknown>));
}

Deno.test("manda os arquivos em ordem, grava o wamid de cada um e devolve o último", async () => {
  const log: Op[] = [];
  const envios: Envio[] = [];
  const restore = stubFetch(envios);
  try {
    const ultimo = await enviarArquivosAgendados(
      fakeSupabase(log),
      agendamento([item("a.pdf", { caption: "Proposta enviada" }), item("b.pdf"), item("c.pdf")]),
      LINHA,
    );
    equal(ultimo, "W3");
    equal(envios.map((e) => e.form.get("filename")), ["a.pdf", "b.pdf", "c.pdf"]);
    equal(envios.map((e) => e.form.get("caption")), ["Proposta enviada", null, null]);
    equal(envios[0].form.get("to"), "5511999990000");
    equal(envios[0].form.get("skipSave"), "true");
    // Agendamento manda com prazo (PRAZO_DO_ARQUIVO_MS); o painel não.
    equal(envios.every((e) => e.comPrazo), true);
    // Progresso: depois do 1º só ele tem wamid; depois do 3º, todos.
    const p = progressos(log);
    equal(p.length, 3);
    equal(p[0].map((i) => i.whatsapp_message_id ?? null), ["W1", null, null]);
    equal(p[2].map((i) => i.whatsapp_message_id ?? null), ["W1", "W2", "W3"]);
    const msgs = linhasDeMensagem(log);
    equal(msgs.map((m) => [m.message_type, m.content, m.whatsapp_message_id, m.sent_by]), [
      ["document", "Proposta enviada", "W1", UID],
      ["document", "[Documento]", "W2", UID],
      ["document", "[Documento]", "W3", UID],
    ]);
    equal((msgs[0].metadata as Record<string, unknown>).scheduled_message_id, "sched-1");
  } finally {
    restore();
  }
});

Deno.test("nova tentativa pula o arquivo que já saiu (sem mandar duas vezes)", async () => {
  const log: Op[] = [];
  const envios: Envio[] = [];
  const restore = stubFetch(envios);
  try {
    const ultimo = await enviarArquivosAgendados(
      fakeSupabase(log),
      agendamento([item("a.pdf", { whatsapp_message_id: "JA-SAIU" }), item("b.pdf")], { quoted_message_id: "q-1" }),
      LINHA,
    );
    equal(envios.length, 1);
    equal(envios[0].form.get("filename"), "b.pdf");
    // A citação é do 1º arquivo, que já saiu: o 2º não cita e nem busca a citada.
    equal(envios[0].form.get("quotedMessageId"), null);
    equal(log.filter((e) => e.table === "messages" && !e.ops.some(([o]) => o === "upsert")).length, 0, "busca da citada");
    equal(ultimo, "W1");
    equal(progressos(log)[0].map((i) => i.whatsapp_message_id), ["JA-SAIU", "W1"]);
  } finally {
    restore();
  }
});

Deno.test("falha no meio: lança com o progresso e o wamid do que saiu já está gravado", async () => {
  const log: Op[] = [];
  const envios: Envio[] = [];
  const restore = stubFetch(envios, 2);
  try {
    let erro = "";
    let retentavel: boolean | null = null;
    try {
      await enviarArquivosAgendados(fakeSupabase(log), agendamento([item("a.pdf"), item("b.pdf"), item("c.pdf")]), LINHA);
    } catch (e) {
      erro = (e as Error).message;
      retentavel = e instanceof FalhaNoArquivo ? e.retentavel : null;
    }
    equal(erro, "1 de 3 arquivos enviados. b.pdf: QR service unreachable: connection reset");
    // Queda de conexão antes da resposta: o serviço não aceitou, vale outra tentativa.
    equal(retentavel, true);
    equal(envios.length, 1);
    const p = progressos(log);
    equal(p.length, 1);
    equal(p[0].map((i) => i.whatsapp_message_id ?? null), ["W1", null, null]);
  } finally {
    restore();
  }
});

Deno.test("lerItensAgendados recusa forma inválida, caminho de outra pessoa e falta de autor", () => {
  const recusa = (media: unknown, autor: string | null) => {
    try {
      lerItensAgendados(media, autor);
    } catch (e) {
      return e instanceof ArquivoAgendadoInvalido;
    }
    return false;
  };
  equal(recusa([], UID), true, "lista vazia");
  equal(recusa(null, UID), true, "null");
  equal(recusa([{ filename: "a.pdf" }], UID), true, "sem storage_path");
  equal(recusa([item("a.pdf")], OUTRO), true, "pasta de outra pessoa");
  equal(recusa([item("a.pdf", { storage_path: `outbound/${UID}/../x/a.pdf` })], UID), true, "..");
  equal(recusa([item("a.pdf", { storage_path: `outbound/${UID}/sub/a.pdf` })], UID), true, "subpasta");
  equal(recusa([item("a.pdf")], null), true, "sem autor");
  equal(lerItensAgendados([item("a.pdf")], UID).length, 1);
});

Deno.test("pendentes e progressoDoErro", () => {
  const itens = [item("a.pdf", { whatsapp_message_id: "W1" }), item("b.pdf"), item("c.pdf")];
  equal(pendentes(itens), [1, 2]);
  equal(progressoDoErro(itens), "1 de 3 arquivos enviados. ");
  equal(progressoDoErro([item("a.pdf")]), "");
});

Deno.test("midia-envio: tipo, html, caminho e texto da bolha", () => {
  equal(tipoPeloMime("image/jpeg"), "image");
  equal(tipoPeloMime("video/mp4"), "video");
  equal(tipoPeloMime("audio/ogg"), "audio");
  equal(tipoPeloMime("application/pdf"), "document");
  equal(corrigirMimeDeHtml("document", "orcamento.html", "text/plain; charset=utf-8"), "text/html");
  equal(corrigirMimeDeHtml("document", "nota.txt", "text/plain"), "text/plain");
  equal(caminhoDoUsuarioValido(`outbound/${UID}/a.pdf`, UID), true);
  equal(caminhoDoUsuarioValido(`outbound/${UID}/`, UID), false);
  equal(caminhoDoUsuarioValido(`outbound/${OUTRO}/a.pdf`, UID), false);
  equal(conteudoDaMidia("document", null), "[Documento]");
  equal(conteudoDaMidia("image", "Olha"), "Olha");
  equal(conteudoDaMidia("sticker", "x"), "[Sticker]");
});

/** Roda e devolve o erro lançado (ou null). */
async function rodar(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

Deno.test("progresso renova o relógio do reaper e só vale para a execução dona da linha", async () => {
  const log: Op[] = [];
  const restore = stubFetch([]);
  try {
    await enviarArquivosAgendados(fakeSupabase(log), agendamento([item("a.pdf")], { attempts: 2 }), LINHA);
    const update = log.find((e) => e.table === "scheduled_messages")!.ops.find(([o]) => o === "update")!;
    equal(typeof (update[1][0] as Record<string, unknown>).last_attempt_at, "string");
    equal(filtrosDoProgresso(log)[0], [["id", "sched-1"], ["status", "processing"], ["attempts", 2]]);
  } finally {
    restore();
  }
});

Deno.test("progresso que não grava: grava a bolha, para e não deixa reenviar", async () => {
  const log: Op[] = [];
  const envios: Envio[] = [];
  const restore = stubFetch(envios);
  try {
    const e = await rodar(() => enviarArquivosAgendados(fakeSupabase(log, "erro"), agendamento([item("a.pdf"), item("b.pdf")]), LINHA));
    equal(e instanceof FalhaNoArquivo, true);
    equal((e as FalhaNoArquivo).retentavel, false);
    equal((e as Error).message, "1 de 2 arquivos enviados. a.pdf saiu, mas o progresso não foi gravado; os próximos não foram enviados para não duplicar.");
    equal(envios.length, 1, "b.pdf não sai");
    equal(linhasDeMensagem(log).length, 1, "a bolha do a.pdf existe");
    equal(progressos(log).length, 3, "três tentativas de gravar");
  } finally {
    restore();
  }
});

Deno.test("linha que deixou de ser desta execução: grava a bolha do que saiu e para", async () => {
  const log: Op[] = [];
  const envios: Envio[] = [];
  const restore = stubFetch(envios);
  try {
    const e = await rodar(() => enviarArquivosAgendados(fakeSupabase(log, "perdido"), agendamento([item("a.pdf"), item("b.pdf")]), LINHA));
    equal(e instanceof AgendamentoPerdido, true);
    equal(envios.length, 1);
    equal(linhasDeMensagem(log).length, 1);
  } finally {
    restore();
  }
});

Deno.test("passou do orçamento de tempo: pausa entre arquivos (sempre manda pelo menos um)", async () => {
  const log: Op[] = [];
  const envios: Envio[] = [];
  const restore = stubFetch(envios);
  let t = 0;
  // O relógio é lido no início e entre arquivos; cada leitura avança 120 s: o 1º sai e o lote pausa antes do 2º.
  const relogio = () => (t += 120_000);
  try {
    const e = await rodar(() => enviarArquivosAgendados(fakeSupabase(log), agendamento([item("a.pdf"), item("b.pdf"), item("c.pdf")]), LINHA, relogio));
    equal(ORCAMENTO_MS, 50_000);
    equal(e instanceof LotePausado, true);
    equal((e as LotePausado).enviadosNestaExecucao, 1);
    equal(envios.map((x) => x.form.get("filename")), ["a.pdf"]);
  } finally {
    restore();
  }
});

Deno.test("resposta ambígua do serviço (502 em HTML) não reenvia e avisa que pode ter saído", async () => {
  const log: Op[] = [];
  const restore = stubFetch([], 1, () => Promise.resolve(new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } })));
  try {
    const e = await rodar(() => enviarArquivosAgendados(fakeSupabase(log), agendamento([item("a.pdf")]), LINHA));
    equal(e instanceof FalhaNoArquivo, true);
    equal((e as FalhaNoArquivo).retentavel, false);
    equal((e as Error).message, "a.pdf: o envio pode ter saído (QR service returned invalid response (502)). Confira a conversa antes de agendar de novo.");
  } finally {
    restore();
  }
});

Deno.test("nome do arquivo não decide o retry (network-plan.pdf que sumiu do Storage)", async () => {
  const log: Op[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch;
  try {
    const e = await rodar(() => enviarArquivosAgendados(fakeSupabase(log), agendamento([item("network-plan.pdf")]), LINHA));
    equal(e instanceof FalhaNoArquivo, true);
    equal((e as FalhaNoArquivo).retentavel, false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("prazo estourado é ambíguo: não reenvia", () => {
  equal(respostaAmbigua("QR service timed out after 60000 ms"), true);
  equal(respostaAmbigua("WhatsApp API timed out after 60000 ms"), true);
  equal(respostaAmbigua("QR service returned invalid response (504)"), true);
  equal(respostaAmbigua("Session not connected"), false);
});
