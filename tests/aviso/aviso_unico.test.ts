import {
  ALERTA_NA_TENTATIVA,
  chaveDoAviso,
  chaveDoComplemento,
  contatoSemNono,
  esperaDaRepeticao,
  MAX_REPETICOES,
  partesDaChave,
  precisaComplemento,
  ERRO_URL_BLOQUEADA,
  repetirAvisos,
  resultadoDaTentativa,
} from "../../supabase/functions/_shared/aviso-unico.ts";
import { emitMessageSent, sendOrganizationWebhook } from "../../supabase/functions/_shared/webhooks.ts";

function igual(a: unknown, b: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

// ── Banco de mentira: cada consulta vira (tabela, operações) e o teste decide a resposta ────────────────────────────
type Op = [string, unknown[]];
type Resposta = { data: unknown; error: unknown };
function bancoFalso(responder: (tabela: string, ops: Op[]) => Resposta) {
  const chamadas: { tabela: string; ops: Op[] }[] = [];
  const consulta = (tabela: string) => {
    const ops: Op[] = [];
    const fim = () => {
      chamadas.push({ tabela, ops });
      return Promise.resolve(responder(tabela, ops));
    };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "or", "order", "limit", "upsert", "update", "insert", "is", "lt", "gte"]) {
      q[m] = (...args: unknown[]) => {
        ops.push([m, args]);
        return q;
      };
    }
    q.maybeSingle = () => {
      ops.push(["maybeSingle", []]);
      return fim();
    };
    q.single = () => {
      ops.push(["single", []]);
      return fim();
    };
    q.then = (ok: (r: Resposta) => unknown, falha?: (e: unknown) => unknown) => fim().then(ok, falha);
    return q;
  };
  return {
    chamadas,
    db: {
      from: (t: string) => consulta(t),
      rpc: (nome: string, args: unknown) => {
        chamadas.push({ tabela: `rpc:${nome}`, ops: [["rpc", [args]]] });
        return Promise.resolve(responder(`rpc:${nome}`, [["rpc", [args]]]));
      },
    },
  };
}
const tem = (ops: Op[], m: string) => ops.some(([n]) => n === m);
const argsDe = (ops: Op[], m: string) => ops.find(([n]) => n === m)?.[1];

const ORG = "org-1";
const JID = "120363000000000001@g.us";
const CODIGO = "3EB00000000000000001";
const CHAVE = `grupo:${JID}:${CODIGO}`;

/** Org com webhook, linhas Vendas e Suporte; `reserva` diz se a chave já tem dono. */
function cenario(reserva: { dono?: { evento: string; tem_autor: boolean; message_id: string } }, urlDoWebhook = "https://crm.test/hook") {
  const gravadas: Record<string, unknown>[] = [];
  const banco = bancoFalso((tabela, ops) => {
    if (tabela === "organization_webhooks") return { data: { url: urlDoWebhook, is_active: true }, error: null };
    if (tabela === "organizations") return { data: { name: "Acme" }, error: null };
    if (tabela === "conversations" && tem(ops, "maybeSingle")) {
      return {
        data: { id: "conv-linha-vendas", contact_phone: JID, contact_name: "Equipe Projeto X", is_group: true, group_jid: JID, phone_number_id: "linha-vendas" },
        error: null,
      };
    }
    if (tabela === "profiles") return { data: { first_name: "Carla", last_name: "Dias", email: "agente@example.com" }, error: null };
    if (tabela === "phone_numbers" && tem(ops, "maybeSingle")) {
      return {
        data: { display_name: "Vendas", id: "linha-vendas", organization_id: ORG, phone_number_id: "qr_1700000000", phone_number: "5511999990001" },
        error: null,
      };
    }
    if (tabela === "phone_numbers") {
      return { data: [{ id: "linha-vendas", display_name: "Vendas" }, { id: "linha-suporte", display_name: "Suporte" }], error: null };
    }
    if (tabela === "aviso_de_mensagem" && tem(ops, "upsert")) {
      const linha = (argsDe(ops, "upsert") as unknown[])[0] as Record<string, unknown>;
      const ehComplemento = String(linha.chave).endsWith(":autor") || String(linha.chave).endsWith(":linha");
      if (reserva.dono && !ehComplemento) return { data: [], error: null };
      return { data: [{ id: `reserva-${linha.chave}` }], error: null };
    }
    if (tabela === "aviso_de_mensagem" && tem(ops, "update")) {
      gravadas.push((argsDe(ops, "update") as unknown[])[0] as Record<string, unknown>);
      return { data: null, error: null };
    }
    if (tabela === "aviso_de_mensagem") return { data: reserva.dono ?? null, error: null };
    return { data: null, error: null };
  });
  return { ...banco, gravadas };
}

function payloadDoGrupo(args: { messageId: string; linha: string; saida: boolean; temAutor: boolean }) {
  return {
    phone_number_id: args.linha,
    phone_number_internal_id: args.linha,
    aviso_unico: { chave: CHAVE, saida: args.saida, tem_autor: args.temAutor },
    message: {
      id: args.messageId,
      content: "Bom dia, pessoal!",
      type: "text",
      codigo: CODIGO,
      sent_by: args.temAutor ? "user-1" : undefined,
      sent_by_name: args.temAutor ? "Carla Dias" : null,
      origin: args.temAutor ? "panel" : null,
    },
    contact: { id: "conv", phone: JID, name: "Equipe Projeto X" },
    conversation: { id: `conv-${args.linha}` },
    is_group: true,
    group_jid: JID,
    group_name: "Equipe Projeto X",
    sender_phone: "5511999990001",
    sender_name: "Carla Dias",
    sender_jid: null,
  };
}

async function comFetchFalso<T>(resposta: number | Error, fn: (enviados: Record<string, unknown>[]) => Promise<T>) {
  const original = globalThis.fetch;
  // O host do teste não resolve (e a guarda recusa nome sem endereço): libera-o pela lista de exceção, como um operador faria.
  const hostsAntes = Deno.env.get("ECHO_OUTBOUND_ALLOW_HOSTS");
  Deno.env.set("ECHO_OUTBOUND_ALLOW_HOSTS", "crm.test");
  const enviados: Record<string, unknown>[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    enviados.push(JSON.parse(String(init.body)));
    if (resposta instanceof Error) return Promise.reject(resposta);
    return Promise.resolve(new Response("{}", { status: resposta }));
  }) as typeof fetch;
  try {
    return await fn(enviados);
  } finally {
    globalThis.fetch = original;
    if (hostsAntes === undefined) Deno.env.delete("ECHO_OUTBOUND_ALLOW_HOSTS");
    else Deno.env.set("ECHO_OUTBOUND_ALLOW_HOSTS", hostsAntes);
  }
}

// ── Regras puras ────────────────────────────────────────────────────────────────────────────────────────────────────
Deno.test("contato sem o 9º dígito: as duas conversas do contato dão a mesma chave", () => {
  igual(contatoSemNono("5511999990002"), "551199990002", "com 9");
  igual(contatoSemNono("551199990002"), "551199990002", "sem 9");
  igual(contatoSemNono("+1 (555) 010-0000"), "15550100000", "outro país fica");
  igual(
    chaveDoAviso({ grupo: false, linhaId: "linha", contato: "5511999990002", codigo: "ABC" }),
    chaveDoAviso({ grupo: false, linhaId: "linha", contato: "551199990002", codigo: "ABC" }),
    "1 a 1",
  );
});

Deno.test("chave: grupo pelo JID e código; 1 a 1 com a linha; sem código de verdade não há chave", () => {
  igual(chaveDoAviso({ grupo: true, groupJid: JID, linhaId: "x", codigo: CODIGO }), CHAVE, "grupo");
  igual(chaveDoAviso({ grupo: true, groupJid: JID, linhaId: "y", codigo: CODIGO }), CHAVE, "grupo, outra linha");
  igual(
    chaveDoAviso({ grupo: false, linhaId: "linha-a", contato: "5511999998888", codigo: CODIGO }),
    `conversa:linha-a:551199998888:${CODIGO}`,
    "1 a 1",
  );
  igual(chaveDoAviso({ grupo: true, groupJid: JID, codigo: "qr_123" }), null, "marcador do Echo");
  igual(chaveDoAviso({ grupo: true, groupJid: JID, codigo: "grpevt_1" }), null, "aviso de sistema");
  igual(chaveDoAviso({ grupo: true, groupJid: JID, codigo: null }), null, "sem código");
  igual(chaveDoAviso({ grupo: false, linhaId: "", contato: "5511999998888", codigo: CODIGO }), null, "sem linha");
});

Deno.test("complemento: só a cópia da linha que falou, quando o aviso saiu por quem ouviu ou sem quem digitou", () => {
  igual(precisaComplemento({ saida: true, tem_autor: true }, { evento: "message.received", tem_autor: false }), true, "ouviu primeiro");
  igual(precisaComplemento({ saida: true, tem_autor: false }, { evento: "message.received", tem_autor: false }), true, "aparelho depois de quem ouviu");
  igual(precisaComplemento({ saida: true, tem_autor: true }, { evento: "message.sent", tem_autor: false }), true, "eco do aparelho primeiro");
  igual(precisaComplemento({ saida: true, tem_autor: false }, { evento: "message.sent", tem_autor: true }), false, "envio primeiro");
  igual(precisaComplemento({ saida: false, tem_autor: false }, { evento: "message.received", tem_autor: false }), false, "outra cópia de quem ouviu");
  igual(chaveDoComplemento(CHAVE, true), `${CHAVE}:autor`, "com autor");
  igual(chaveDoComplemento(CHAVE, false), `${CHAVE}:linha`, "só a linha");
  igual(partesDaChave(`${CHAVE}:autor`), { conversa: JID, codigo: CODIGO }, "partes do grupo");
  igual(partesDaChave("conversa:linha:5511:ABC"), { conversa: "5511", codigo: "ABC" }, "partes do 1 a 1");
});

Deno.test("repetição: 10 depois da 1ª entrega, de 1 minuto a 1 hora, e depois falhou", () => {
  igual(esperaDaRepeticao(1), 1, "1ª");
  igual(esperaDaRepeticao(MAX_REPETICOES), 60, "última");
  const agora = new Date("2026-10-20T12:00:00Z");
  const r1 = resultadoDaTentativa(1, false, "HTTP 500", agora);
  igual([r1.estado, r1.proxima_em], ["repetir", "2026-10-20T12:01:00.000Z"], "1ª falhou");
  igual(resultadoDaTentativa(MAX_REPETICOES, false, "x", agora).estado, "repetir", "10ª tentativa ainda repete");
  igual(resultadoDaTentativa(MAX_REPETICOES + 1, false, "x", agora).estado, "falhou", "11ª tentativa encerra");
  const ok = resultadoDaTentativa(3, true, null, agora);
  igual([ok.estado, ok.corpo, ok.entregue_em], ["entregue", null, "2026-10-20T12:00:00.000Z"], "entregue apaga o corpo");
});

// ── Caminho inteiro do aviso ────────────────────────────────────────────────────────────────────────────────────────
Deno.test("a primeira cópia reserva e avisa com o aviso_id da mensagem; com ok, fica entregue", async () => {
  const c = cenario({});
  await comFetchFalso(202, async (enviados) => {
    await sendOrganizationWebhook(c.db, ORG, "message.received", payloadDoGrupo({ messageId: "m-suporte", linha: "linha-suporte", saida: false, temAutor: false }));
    igual(enviados.length, 1, "um aviso");
    igual([enviados[0].event, enviados[0].aviso_id, enviados[0].codigo_whatsapp], ["message.received", CHAVE, CODIGO], "aviso");
    const reserva = c.chamadas.find((x) => x.tabela === "aviso_de_mensagem" && tem(x.ops, "upsert"))!;
    const linha = (argsDe(reserva.ops, "upsert") as unknown[])[0] as Record<string, unknown>;
    igual([linha.organization_id, linha.chave, linha.message_id, linha.evento, linha.estado], [ORG, CHAVE, "m-suporte", "message.received", "enviando"], "reserva");
    igual(c.gravadas.map((g) => g.estado ?? (g.corpo ? "corpo" : "?")), ["corpo", "entregue"], "corpo guardado e entregue");
  });
});

Deno.test("outra cópia de quem ouviu não avisa", async () => {
  const c = cenario({ dono: { evento: "message.received", tem_autor: false, message_id: "m-suporte" } });
  await comFetchFalso(202, async (enviados) => {
    const r = await sendOrganizationWebhook(c.db, ORG, "message.received", payloadDoGrupo({ messageId: "m-terceira", linha: "linha-3", saida: false, temAutor: false }));
    igual(enviados.length, 0, "nenhum aviso");
    igual(r, { skipped: "aviso_ja_enviado" }, "motivo");
  });
});

Deno.test("a linha que falou, depois de quem ouviu, manda só o complemento com quem digitou", async () => {
  const c = cenario({ dono: { evento: "message.received", tem_autor: false, message_id: "m-suporte" } });
  await comFetchFalso(202, async (enviados) => {
    await sendOrganizationWebhook(c.db, ORG, "message.sent", payloadDoGrupo({ messageId: "m-vendas", linha: "linha-vendas", saida: true, temAutor: true }));
    igual(enviados.length, 1, "só o complemento");
    const e = enviados[0];
    igual([e.event, e.aviso_id, e.aviso_original, e.message_id, e.conversation_id], ["message.author", `${CHAVE}:autor`, CHAVE, "m-vendas", "conv-linha-vendas"], "complemento");
    igual([e.from_me, e.direction, e.origin, e.sent_by_name, e.text], [true, "outgoing", "panel", "Carla Dias", undefined], "sem mensagem nova");
    igual(e.falou, { tipo: "equipe", linha_id: "linha-vendas", linha_nome: "Vendas", pessoa: "Carla Dias", origem: "panel" }, "quem falou");
    igual(e.linhas_no_grupo, undefined, "sem a lista de linhas");
  });
});

Deno.test("o envio que chega depois do próprio eco do aparelho não manda nada de novo sem quem digitou", async () => {
  const c = cenario({ dono: { evento: "message.sent", tem_autor: true, message_id: "m-vendas" } });
  await comFetchFalso(202, async (enviados) => {
    await sendOrganizationWebhook(c.db, ORG, "message.sent", payloadDoGrupo({ messageId: "m-eco", linha: "linha-vendas", saida: true, temAutor: false }));
    igual(enviados.length, 0, "nada");
  });
});

Deno.test("sem ok do receptor, o aviso fica para repetir em 1 minuto", async () => {
  const c = cenario({});
  await comFetchFalso(500, async () => {
    await sendOrganizationWebhook(c.db, ORG, "message.received", payloadDoGrupo({ messageId: "m-suporte", linha: "linha-suporte", saida: false, temAutor: false }));
  });
  const ultimo = c.gravadas[c.gravadas.length - 1];
  igual([ultimo.estado, ultimo.tentativas, ultimo.ultimo_erro], ["repetir", 1, "HTTP 500"], "repetir");
  await comFetchFalso(new Error("timeout"), async () => {
    await sendOrganizationWebhook(c.db, ORG, "message.received", payloadDoGrupo({ messageId: "m-suporte", linha: "linha-suporte", saida: false, temAutor: false }));
  });
  igual(c.gravadas[c.gravadas.length - 1].estado, "repetir", "queda de rede também repete");
});

Deno.test("aviso sem chave (sem código) sai como sempre, sem reserva", async () => {
  const c = cenario({});
  await comFetchFalso(202, async (enviados) => {
    const p = { ...payloadDoGrupo({ messageId: "m-x", linha: "linha-suporte", saida: false, temAutor: false }), aviso_unico: undefined };
    await sendOrganizationWebhook(c.db, ORG, "message.received", p);
    igual(enviados.length, 1, "avisa");
    igual(enviados[0].aviso_id, "m-x:message.received", "aviso_id do passo 1");
    igual(c.chamadas.some((x) => x.tabela === "aviso_de_mensagem"), false, "sem reserva");
  });
});

Deno.test("envio pelo Echo reserva antes de responder; montar e entregar fica para o waitUntil", async () => {
  const c = cenario({});
  const pendentes: Promise<unknown>[] = [];
  const g = globalThis as unknown as { EdgeRuntime?: unknown };
  g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => pendentes.push(p) };
  try {
    await comFetchFalso(202, async (enviados) => {
      await emitMessageSent(c.db, {
        conversationId: "conv-linha-vendas",
        messageId: "m-vendas",
        whatsappMessageId: CODIGO,
        content: "Bom dia, pessoal!",
        sentBy: "user-1",
        origin: "panel",
        organizationId: ORG,
        phoneNumberDbId: "linha-vendas",
        metaPhoneNumberId: "qr_1700000000",
      });
      const reserva = c.chamadas.find((x) => x.tabela === "aviso_de_mensagem" && tem(x.ops, "upsert"));
      igual(!!reserva, true, "reservou antes de responder");
      const linha = (argsDe(reserva!.ops, "upsert") as unknown[])[0] as Record<string, unknown>;
      igual([linha.chave, linha.evento, linha.tem_autor], [CHAVE, "message.sent", true], "reserva do envio");
      igual(enviados.length, 0, "a entrega ainda não saiu");
      await Promise.all(pendentes);
      igual(enviados.length, 1, "entregou no waitUntil");
      igual([enviados[0].event, enviados[0].aviso_id, enviados[0].sent_by_name], ["message.sent", CHAVE, "Carla Dias"], "aviso do envio");
      igual(c.chamadas.filter((x) => x.tabela === "aviso_de_mensagem" && tem(x.ops, "upsert")).length, 1, "uma reserva só");
    });
  } finally {
    delete g.EdgeRuntime;
  }
});

Deno.test("envio por linha oficial não reserva", async () => {
  const c = cenario({});
  await comFetchFalso(202, async (enviados) => {
    await emitMessageSent(c.db, {
      conversationId: "conv-linha-vendas",
      messageId: "m-oficial",
      whatsappMessageId: "wamid.ABC",
      organizationId: ORG,
      phoneNumberDbId: "linha-oficial",
      metaPhoneNumberId: "100000000000001",
    });
    igual(c.chamadas.some((x) => x.tabela === "aviso_de_mensagem"), false, "sem reserva");
    igual([enviados.length, enviados[0]?.aviso_id], [1, "m-oficial:message.sent"], "aviso como no passo 1");
  });
});

// ── Repetição pelo cron ─────────────────────────────────────────────────────────────────────────────────────────────
Deno.test("repetição: manda o corpo guardado com a hora nova; na 11ª tentativa encerra e alerta", async () => {
  const lote = [
    { id: "a1", organization_id: ORG, chave: CHAVE, message_id: "m1", tentativas: 1, corpo: { event: "message.received", aviso_id: CHAVE, ts: 1, ts_iso: "velho", message_created_at: "2026-10-20T11:00:00Z" } },
    { id: "a2", organization_id: ORG, chave: `${CHAVE}:autor`, message_id: "m2", tentativas: MAX_REPETICOES, corpo: { event: "message.author", aviso_id: `${CHAVE}:autor` } },
    { id: "a3", organization_id: ORG, chave: `${CHAVE}:linha`, message_id: "m3", tentativas: ALERTA_NA_TENTATIVA - 1, corpo: { event: "message.author", aviso_id: `${CHAVE}:linha` } },
  ];
  const gravadas: Record<string, Record<string, unknown>> = {};
  const logs: Record<string, unknown>[] = [];
  const banco = bancoFalso((tabela, ops) => {
    if (tabela === "rpc:aviso_de_mensagem_pegar_lote") return { data: lote, error: null };
    if (tabela === "organization_webhooks") return { data: { url: "https://crm.test/hook", is_active: true }, error: null };
    if (tabela === "aviso_de_mensagem" && tem(ops, "update")) {
      gravadas[String((argsDe(ops, "eq") as unknown[])[1])] = (argsDe(ops, "update") as unknown[])[0] as Record<string, unknown>;
    }
    if (tabela === "qr_message_log") logs.push((argsDe(ops, "insert") as unknown[])[0] as Record<string, unknown>);
    return { data: null, error: null };
  });
  const enviados: Record<string, unknown>[] = [];
  const enviar = ((_u: string, init: RequestInit) => {
    const corpo = JSON.parse(String(init.body));
    enviados.push(corpo);
    return Promise.resolve(new Response("{}", { status: corpo.event === "message.author" ? 409 : 202 }));
  }) as typeof fetch;
  const placar = await repetirAvisos(banco.db, enviar);
  igual(placar, { lote: 3, entregues: 1, repetir: 1, falharam: 1 }, "placar");
  const primeiro = enviados.find((e) => e.event === "message.received")!;
  igual([primeiro.ts_iso !== "velho", primeiro.message_created_at], [true, "2026-10-20T11:00:00Z"], "hora do aviso nova, da mensagem igual");
  igual([gravadas.a1.estado, gravadas.a1.tentativas], ["entregue", 2], "entregue");
  igual([gravadas.a2.estado, gravadas.a2.tentativas], ["falhou", MAX_REPETICOES + 1], "falhou");
  igual([gravadas.a3.estado, gravadas.a3.tentativas], ["repetir", ALERTA_NA_TENTATIVA], "6ª tentativa segue repetindo");
  igual(logs.length, 2, "alerta na 6ª tentativa e no fim");
  for (const log of logs) {
    igual([log.action, (log.baileys_result as { route?: string })?.route, log.message_id], ["webhook_dead", "aviso-webhook", CODIGO], "alerta");
  }
  igual(logs.some((l) => String(l.error).includes("segue repetindo")), true, "o da 6ª diz que segue");
});

// ── URL do webhook recusada pela guarda SSRF (regra 6 da SPEC 2.5) ──────────────────────────────────────────────────
/** Roda `fn` com o fetch global trocado por um que acusa qualquer chamada de rede e a conta. */
async function semRede(fn: () => Promise<void>): Promise<number> {
  const original = globalThis.fetch;
  let chamadas = 0;
  globalThis.fetch = (() => {
    chamadas++;
    return Promise.reject(new Error("rede proibida neste teste"));
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return chamadas;
}

Deno.test("resultadoDaTentativa: URL bloqueada encerra na hora, sem agendar repetição", () => {
  const r = resultadoDaTentativa(1, false, `${ERRO_URL_BLOQUEADA}host_interno`, new Date("2026-10-20T12:00:00Z"), true);
  igual([r.estado, r.proxima_em, r.ultimo_erro], ["falhou", null, "url_bloqueada:host_interno"], "falha final");
});

Deno.test("repetição com o enviar padrão: webhook em rede interna é recusado pela guarda, sem fetch, e encerra com alerta", async () => {
  for (const url of ["http://rest:3000/rpc/x", "http://169.254.169.254/latest/meta-data/", "http://172.17.0.1:8080/"]) {
    const lote = [{ id: "a1", organization_id: ORG, chave: CHAVE, message_id: "m1", tentativas: 1, corpo: { event: "message.received", aviso_id: CHAVE } }];
    const gravadas: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const banco = bancoFalso((tabela, ops) => {
      if (tabela === "rpc:aviso_de_mensagem_pegar_lote") return { data: lote, error: null };
      if (tabela === "organization_webhooks") return { data: { url, is_active: true }, error: null };
      if (tabela === "aviso_de_mensagem" && tem(ops, "update")) gravadas.push((argsDe(ops, "update") as unknown[])[0] as Record<string, unknown>);
      if (tabela === "qr_message_log") logs.push((argsDe(ops, "insert") as unknown[])[0] as Record<string, unknown>);
      return { data: null, error: null };
    });
    let placar: Awaited<ReturnType<typeof repetirAvisos>> | null = null;
    const chamadas = await semRede(async () => {
      placar = await repetirAvisos(banco.db);
    });
    igual(chamadas, 0, `${url}: nenhum fetch real`);
    igual(placar, { lote: 1, entregues: 0, repetir: 0, falharam: 1 }, `${url}: placar`);
    igual(String(gravadas[0]?.estado), "falhou", `${url}: estado`);
    igual(gravadas[0]?.proxima_em, null, `${url}: sem nova repetição`);
    igual(String(gravadas[0]?.ultimo_erro).startsWith(ERRO_URL_BLOQUEADA), true, `${url}: ultimo_erro url_bloqueada:*`);
    igual(logs.length, 1, `${url}: webhook_dead avisa a equipe`);
  }
});

Deno.test("1ª entrega com URL interna: a guarda recusa e o aviso já nasce 'falhou', sem repetição", async () => {
  const c = cenario({}, "http://rest:3000/rpc/x");
  const chamadas = await semRede(async () => {
    await sendOrganizationWebhook(c.db, ORG, "message.received", payloadDoGrupo({ messageId: "m-suporte", linha: "linha-suporte", saida: false, temAutor: false }));
  });
  igual(chamadas, 0, "nenhum fetch real");
  const ultima = c.gravadas[c.gravadas.length - 1];
  igual([ultima.estado, ultima.proxima_em], ["falhou", null], "sem repetição agendada");
  igual(String(ultima.ultimo_erro), "url_bloqueada:host_interno", "motivo sem a URL");
});
