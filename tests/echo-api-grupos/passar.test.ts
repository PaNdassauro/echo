// npx -y deno@2 test --no-config --allow-env --allow-read tests/echo-api-grupos
import { passarGrupo, type DepsPassarGrupo, type LinhaDoHandover } from "../../supabase/functions/echo-api/passar-grupo.ts";

function equal(a: unknown, b: unknown, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const ORG = "org-1";
const JID = "120363000000000001@g.us";
const J = encodeURIComponent(JID);
const SAI = "linha-sai";
const ENTRA = "linha-entra";
const ID_ENTRA = "5511999990002@s.whatsapp.net";

type R = { status: number; json: unknown } | "rede";
type Chamada = string;

/**
 * Simula o WhatsApp: quem está no grupo e quem é admin muda conforme as chamadas (entrar, promover, sair), para a
 * releitura enxergar o efeito como no qr-service de verdade. `respostas` força a resposta de uma rota.
 */
function mundo(opts: {
  saiDentro?: boolean;
  saiAdmin?: boolean;
  entraDentro?: boolean;
  entraAdmin?: boolean;
  aprovacao?: boolean;
  entraNumero?: string | null;
  linhaSai?: Partial<LinhaDoHandover> | null;
  linhaEntra?: Partial<LinhaDoHandover> | null;
  respostas?: Record<string, R>;
  /** Entrar pelo link não faz efeito (linha "entra" continua fora). */
  joinSemEfeito?: boolean;
  /** Promover não faz efeito. */
  promoteSemEfeito?: boolean;
  conversa?: string | null | "erro";
  /** Relógio: cada leitura do relógio avança tanto (ms). Padrão 0 = nunca passa do prazo. */
  passoDoRelogio?: number;
  /** Número com que o pedido de entrada aparece (padrão: igual ao da linha). */
  pedidoNumero?: string;
} = {}) {
  const estado = {
    saiDentro: opts.saiDentro ?? true,
    saiAdmin: opts.saiAdmin ?? true,
    entraDentro: opts.entraDentro ?? false,
    entraAdmin: opts.entraAdmin ?? false,
    pedidoPendente: false,
  };
  const chamadas: Chamada[] = [];
  const linha = (id: string, extra: Partial<LinhaDoHandover> | null | undefined): LinhaDoHandover | null =>
    extra === null ? null : { id, organization_id: ORG, connection_type: "qr", phone_number: null, ...extra };
  const linhas: Record<string, LinhaDoHandover | null> = {
    [SAI]: linha(SAI, opts.linhaSai),
    [ENTRA]: linha(ENTRA, { phone_number: opts.entraNumero === undefined ? "5511999990002" : opts.entraNumero, ...(opts.linhaEntra ?? {}) }),
  };
  const res = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
  const grupo = (quem: "sai" | "entra") => {
    const dentro = quem === "sai" ? estado.saiDentro : estado.entraDentro;
    if (!dentro) return res(400, { success: false, error: "forbidden" });
    const participants = [
      ...(estado.saiDentro ? [{ id: "5511999990001@s.whatsapp.net", phone: "5511999990001", isAdmin: estado.saiAdmin }] : []),
      ...(estado.entraDentro ? [{ id: ID_ENTRA, phone: "5511999990002", isAdmin: estado.entraAdmin }] : []),
      { id: "5511999990000@s.whatsapp.net", phone: "5511999990000", isAdmin: false },
    ];
    const me = quem === "sai"
      ? { id: "5511999990001@s.whatsapp.net", isAdmin: estado.saiAdmin, isSuperAdmin: false }
      : { id: ID_ENTRA, isAdmin: estado.entraAdmin, isSuperAdmin: false };
    return res(200, { success: true, group: { jid: JID, joinApprovalMode: opts.aprovacao ?? false, participants, me } });
  };
  let relogio = 0;
  const d: DepsPassarGrupo = {
    buscarLinha: (id) => Promise.resolve(linhas[id] ?? null),
    esperar: () => Promise.resolve(),
    agora: () => (relogio += opts.passoDoRelogio ?? 0),
    conversaDoGrupo: () => {
      if (opts.conversa === "erro") return Promise.reject(new Error("db"));
      return Promise.resolve(opts.conversa === undefined ? "conv-entra" : opts.conversa);
    },
    conversaExistente: () => Promise.resolve("conv-sai"),
    qr: (path, init = {}) => {
      const method = init.method ?? "GET";
      const chave = `${method} ${path}`;
      chamadas.push(chave);
      return Promise.resolve().then(() => {
        const forcada = opts.respostas?.[chave];
        if (forcada === "rede") throw new TypeError("network down");
        if (forcada) return res(forcada.status, forcada.json);
        if (chave === `GET /groups/${SAI}/${J}?picture=0`) return grupo("sai");
        if (chave === `GET /groups/${ENTRA}/${J}?picture=0`) return grupo("entra");
        if (chave === `GET /groups/${SAI}/${J}/invite-code`) {
          return estado.saiAdmin ? res(200, { success: true, code: "AbC123", inviteUrl: "https://chat.whatsapp.com/AbC123" })
            : res(400, { success: false, error: "not-authorized" });
        }
        if (chave === `POST /groups/${ENTRA}/join`) {
          const corpo = JSON.parse(String(init.body));
          if (corpo.code !== "AbC123") return res(400, { success: false, error: "bad code" });
          if (opts.aprovacao) { estado.pedidoPendente = true; return res(400, { success: false, error: "Failed to join group" }); }
          if (!opts.joinSemEfeito) estado.entraDentro = true;
          return res(200, { success: true, groupJid: JID });
        }
        if (chave === `GET /groups/${SAI}/${J}/join-requests`) {
          return res(200, { success: true, requests: estado.pedidoPendente ? [{ jid: "999@lid", phone_number: `${opts.pedidoNumero ?? "5511999990002"}@s.whatsapp.net` }] : [] });
        }
        if (chave === `POST /groups/${SAI}/${J}/join-requests`) {
          const corpo = JSON.parse(String(init.body));
          if (corpo.action === "approve" && corpo.participants?.[0] === "999@lid" && estado.pedidoPendente) {
            estado.pedidoPendente = false;
            estado.entraDentro = true;
            return res(200, { success: true });
          }
          return res(400, { success: false, error: "no request" });
        }
        if (chave === `POST /groups/${SAI}/${J}/promote`) {
          const corpo = JSON.parse(String(init.body));
          if (!estado.saiAdmin) return res(400, { success: false, error: "not-authorized" });
          if (corpo.participants?.[0] !== ID_ENTRA) return res(400, { success: false, error: "unknown participant" });
          if (!opts.promoteSemEfeito) estado.entraAdmin = true;
          return res(200, { success: true });
        }
        if (chave === `DELETE /groups/${SAI}/${J}/leave`) {
          estado.saiDentro = false;
          estado.saiAdmin = false;
          return res(200, { success: true });
        }
        throw new Error(`rota inesperada ${chave}`);
      });
    },
  };
  return { d, chamadas, estado };
}

const pedido = (extra: Record<string, unknown> = {}) =>
  ({ group_jid: JID, from_phone_number_id: SAI, to_phone_number_id: ENTRA, ...extra });

const fezSaida = (chamadas: string[]) => chamadas.includes(`DELETE /groups/${SAI}/${J}/leave`);

Deno.test("caminho feliz: entra pelo link, vira admin e só então a que sai sai", async () => {
  const { d, chamadas, estado } = mundo();
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 200);
  equal(r.body.resultado, "passou");
  equal(r.body.passos, ["entrou", "virou_admin", "saiu"]);
  equal(r.body.to_conversation_id, "conv-entra");
  equal(r.body.from_conversation_id, "conv-sai");
  equal(r.body.entra_admin, true);
  equal(estado.entraDentro && estado.entraAdmin && !estado.saiDentro, true, "estado final");
  const ordem = ["join", "promote", "leave"].map((p) => chamadas.findIndex((c) => c.includes(`/${p}`)));
  equal(ordem[0] < ordem[1] && ordem[1] < ordem[2], true, `ordem ${ordem}`);
  equal(chamadas.some((c) => c.includes("/participants")), false, "nunca adiciona participante à força");
});

Deno.test("a que entra já está dentro e já é admin: só sai", async () => {
  const { d, chamadas } = mundo({ entraDentro: true, entraAdmin: true });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.body.resultado, "passou");
  equal(r.body.passos, ["saiu"]);
  equal(chamadas.some((c) => c.includes("/join") || c.includes("/promote")), false);
});

Deno.test("a que entra já está dentro sem admin: promove e sai", async () => {
  const { d } = mundo({ entraDentro: true });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.body.passos, ["virou_admin", "saiu"]);
});

Deno.test("a que sai não está no grupo: nada a fazer, nada mexido", async () => {
  const { d, chamadas } = mundo({ saiDentro: false });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 200);
  equal(r.body.resultado, "sai_fora_do_grupo");
  equal(r.body.entra_no_grupo, false);
  equal(r.body.to_conversation_id, null);
  equal(chamadas, [`GET /groups/${SAI}/${J}?picture=0`, `GET /groups/${ENTRA}/${J}?picture=0`]);
});

Deno.test("a que sai já saiu e a que entra está dentro: devolve as conversas para quem chama terminar o acerto", async () => {
  const { d, chamadas } = mundo({ saiDentro: false, entraDentro: true, entraAdmin: true });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.body.resultado, "sai_fora_do_grupo");
  equal(r.body.entra_no_grupo, true);
  equal(r.body.to_conversation_id, "conv-entra");
  equal(r.body.from_conversation_id, "conv-sai");
  equal(chamadas.every((c) => c.startsWith("GET ")), true, "só leu");
});

Deno.test("404 sem texto do WhatsApp (outra rota, proxy) NÃO é 'fora do grupo': falha sem mexer", async () => {
  const { d, chamadas } = mundo({ respostas: { [`GET /groups/${SAI}/${J}?picture=0`]: { status: 404, json: "<html>Not Found</html>" } } });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 502);
  equal(r.body.resultado, "falha_ao_ler_grupo");
  equal(chamadas.length, 1);
});

Deno.test("grupo lido sem a própria linha na lista NÃO é 'fora do grupo': falha sem mexer", async () => {
  const { d, chamadas } = mundo({
    respostas: { [`GET /groups/${SAI}/${J}?picture=0`]: { status: 200, json: { success: true, group: { jid: JID, participants: [], me: null } } } },
  });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 502);
  equal(r.body.resultado, "falha_ao_ler_grupo");
  equal(chamadas.length, 1);
});

Deno.test("prazo da rota: passou de 90 s antes de entrar ou sair, para sem a que sai sair", async () => {
  // Cada leitura do relógio anda 31 s: entra e promove dentro do prazo, estoura antes de sair.
  const { d, chamadas } = mundo({ passoDoRelogio: 31_000 });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 504);
  equal(r.body.resultado, "tempo_esgotado");
  equal(fezSaida(chamadas), false);
  // Já dentro e admin: estoura antes de sair, e devolve a conversa da que entra.
  const dentro = mundo({ entraDentro: true, entraAdmin: true, passoDoRelogio: 100_000 });
  const r2 = await passarGrupo(pedido(), ORG, dentro.d);
  equal(r2.body.resultado, "tempo_esgotado");
  equal(r2.body.to_conversation_id, "conv-entra");
  equal(fezSaida(dentro.chamadas), false);
});

Deno.test("a que sai não é admin e a que entra está fora: para sem sair", async () => {
  const { d, chamadas } = mundo({ saiAdmin: false });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 409);
  equal(r.body.resultado, "sai_nao_e_admin");
  equal(fezSaida(chamadas), false);
});

Deno.test("a que sai não é admin e a que entra está dentro sem admin: para sem sair (número nosso fica admin)", async () => {
  const { d, chamadas, estado } = mundo({ saiAdmin: false, entraDentro: true });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 409);
  equal(r.body.resultado, "entra_sem_admin");
  equal(typeof r.body.error === "string" && r.body.error.startsWith("o número que entra não é admin do grupo"), true, "texto que vai a quem chama");
  equal(r.body.to_conversation_id, "conv-entra", "a que entra está dentro: quem chama acerta a conversa dela");
  equal(fezSaida(chamadas), false);
  equal(chamadas.some((c) => c.includes("/promote") || c.includes("/join")), false);
  equal(estado.saiDentro, true, "a que sai continua no grupo");
});

Deno.test("a que sai não é admin e a que entra já é admin: sai sem promover", async () => {
  const { d, chamadas } = mundo({ saiAdmin: false, entraDentro: true, entraAdmin: true });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.body.resultado, "passou");
  equal(r.body.passos, ["saiu"]);
  equal(r.body.entra_admin, true);
  equal(chamadas.some((c) => c.includes("/promote")), false);
});

Deno.test("no add-line nada muda: a que entra já dentro sem admin, com a que traz sem admin, devolve ja_estava", async () => {
  const { d, chamadas } = mundo({ saiAdmin: false, entraDentro: true });
  const r = await passarGrupo(pedido(), ORG, d, "entrar");
  equal(r.status, 200);
  equal(r.body.resultado, "ja_estava");
  equal(r.body.entra_admin, false);
  equal(fezSaida(chamadas), false);
});

Deno.test("entrar pelo link não faz efeito: para sem sair", async () => {
  const { d, chamadas } = mundo({ joinSemEfeito: true });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 502);
  equal(r.body.resultado, "entra_nao_entrou");
  equal(fezSaida(chamadas), false);
});

Deno.test("promover não faz efeito: para sem sair (o admin nunca vai para o cliente)", async () => {
  const { d, chamadas } = mundo({ promoteSemEfeito: true });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 502);
  equal(r.body.resultado, "promover_falhou");
  equal(fezSaida(chamadas), false);
});

Deno.test("grupo com aprovação de entrada: a que sai aprova o pedido da que entra", async () => {
  const { d, chamadas } = mundo({ aprovacao: true });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.body.resultado, "passou", JSON.stringify(r.body));
  equal(chamadas.includes(`POST /groups/${SAI}/${J}/join-requests`), true);
});

Deno.test("grupo com aprovação: acha o pedido mesmo com o número sem o 9º dígito", async () => {
  const { d } = mundo({ aprovacao: true, pedidoNumero: "551199990002" });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.body.resultado, "passou", JSON.stringify(r.body));
});

Deno.test("grupo com aprovação e número da que entra desconhecido: para sem sair", async () => {
  const { d, chamadas } = mundo({ aprovacao: true, entraNumero: "Vendas" });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 409);
  equal(r.body.resultado, "entrada_pendente");
  equal(fezSaida(chamadas), false);
});

Deno.test("linha que sai desconectada: 503 sem mexer", async () => {
  const { d, chamadas } = mundo({ respostas: { [`GET /groups/${SAI}/${J}?picture=0`]: { status: 400, json: { success: false, error: "Session not connected" } } } });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 503);
  equal(r.body.resultado, "linha_desconectada");
  equal(chamadas.length, 1);
});

Deno.test("linha que entra com 'Sessão sem cliente' (caso real): 503 desconectada, sem link nem entrada", async () => {
  // Antes: virava falha comum, o Echo pegava o link pela que sai, tentava entrar e quem chamava recebia "não conseguiu entrar".
  const { d, chamadas } = mundo({ respostas: { [`GET /groups/${ENTRA}/${J}?picture=0`]: { status: 400, json: { success: false, error: "Sessão sem cliente" } } } });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 503);
  equal(r.body.resultado, "linha_desconectada");
  equal(r.body.linha, "to");
  equal(chamadas.some((c) => c.includes("/invite-code") || c.includes("/join")), false, chamadas.join(","));
  equal(fezSaida(chamadas), false);
});

Deno.test("linha que sai com 'Sessão sem socket' (Baileys): 503 desconectada", async () => {
  const { d, chamadas } = mundo({ respostas: { [`GET /groups/${SAI}/${J}?picture=0`]: { status: 400, json: { success: false, error: "Sessão sem socket" } } } });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 503);
  equal(r.body.resultado, "linha_desconectada");
  equal(chamadas.length, 1);
});

Deno.test("linha caída no meio (link, admin, saída): sempre 503 desconectada, nunca a frase de outro passo", async () => {
  const caiu = { status: 400, json: { success: false, error: "Sessão sem cliente" } };
  // Ao pegar o link pela que sai.
  const a = mundo({ respostas: { [`GET /groups/${SAI}/${J}/invite-code`]: caiu } });
  const ra = await passarGrupo(pedido(), ORG, a.d);
  equal([ra.status, ra.body.resultado, ra.body.linha], [503, "linha_desconectada", "from"]);
  equal(fezSaida(a.chamadas), false);
  // Ao promover pela que sai (a que entra já está dentro).
  const b = mundo({ entraDentro: true, respostas: { [`POST /groups/${SAI}/${J}/promote`]: caiu } });
  const rb = await passarGrupo(pedido(), ORG, b.d);
  equal([rb.status, rb.body.resultado, rb.body.linha], [503, "linha_desconectada", "from"]);
  equal(fezSaida(b.chamadas), false);
  // A que entra cai na releitura depois de promover.
  const c = mundo({ entraDentro: true, promoteSemEfeito: true });
  let leituras = 0;
  const qrOriginal = c.d.qr;
  c.d.qr = (path, init) => {
    if (path === `/groups/${ENTRA}/${J}?picture=0` && ++leituras > 1) {
      return Promise.resolve(new Response(JSON.stringify(caiu.json), { status: 400 }));
    }
    return qrOriginal(path, init);
  };
  const rc = await passarGrupo(pedido(), ORG, c.d);
  equal([rc.status, rc.body.resultado, rc.body.linha], [503, "linha_desconectada", "to"]);
  equal(fezSaida(c.chamadas), false);
  // Ao sair: a que entra já está dentro e admin; a saída recusa por sessão caída.
  const d = mundo({ entraDentro: true, entraAdmin: true, respostas: { [`DELETE /groups/${SAI}/${J}/leave`]: caiu } });
  const rd = await passarGrupo(pedido(), ORG, d.d);
  equal([rd.status, rd.body.resultado, rd.body.linha], [503, "linha_desconectada", "from"]);
  equal(rd.body.to_conversation_id, "conv-entra");
});

Deno.test("grupo com aprovação e a que sai caída ao ler os pedidos: 503 desconectada", async () => {
  const caiu = { status: 400, json: { success: false, error: "Sessão sem socket" } };
  const { d, chamadas } = mundo({ aprovacao: true, respostas: { [`GET /groups/${SAI}/${J}/join-requests`]: caiu } });
  const r = await passarGrupo(pedido(), ORG, d);
  equal([r.status, r.body.resultado, r.body.linha], [503, "linha_desconectada", "from"]);
  equal(fezSaida(chamadas), false);
});

Deno.test("erro desconhecido ao ler pela linha que sai: 502 sem mexer", async () => {
  const { d, chamadas } = mundo({ respostas: { [`GET /groups/${SAI}/${J}?picture=0`]: { status: 500, json: { error: "timeout" } } } });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 502);
  equal(r.body.resultado, "falha_ao_ler_grupo");
  equal(chamadas.length, 1);
});

Deno.test("qr-service fora do ar na leitura: 502 sem mexer", async () => {
  const { d } = mundo({ respostas: { [`GET /groups/${SAI}/${J}?picture=0`]: "rede" } });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 502);
});

Deno.test("leitura da que entra com erro desconhecido: tenta entrar e decide pela releitura", async () => {
  // 1ª leitura falha; depois do join a releitura (sem resposta forçada… a forçada vale sempre) segue falhando.
  const { d, chamadas } = mundo({ respostas: { [`GET /groups/${ENTRA}/${J}?picture=0`]: { status: 500, json: { error: "timeout" } } } });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 502);
  equal(r.body.resultado, "entra_nao_entrou");
  equal(fezSaida(chamadas), false);
});

Deno.test("saída recusada pelo WhatsApp: 502, a que entra fica dentro como admin", async () => {
  const { d, estado } = mundo({ respostas: { [`DELETE /groups/${SAI}/${J}/leave`]: { status: 400, json: { success: false, error: "not-authorized" } } } });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.status, 502);
  equal(r.body.resultado, "saida_falhou");
  equal(r.body.passos, ["entrou", "virou_admin"]);
  equal(r.body.to_conversation_id, "conv-entra");
  equal(estado.entraAdmin, true);
});

Deno.test("prévia só lê", async () => {
  const { d, chamadas } = mundo();
  const r = await passarGrupo(pedido({ dry_run: true }), ORG, d);
  equal(r.body.resultado, "previa");
  equal(r.body.sai_admin, true);
  equal(r.body.entra_no_grupo, false);
  equal(chamadas.every((c) => c.startsWith("GET ") && c.endsWith("?picture=0")), true, chamadas.join(","));
});

Deno.test("conversa da que entra não achada vira aviso, a passagem vale", async () => {
  const { d } = mundo({ conversa: "erro" });
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.body.resultado, "passou");
  equal((r.body.avisos as string[]).includes("conversation_not_found"), true);
});

Deno.test("validações: campos, jid, mesma linha, outra org, linha oficial", async () => {
  const { d } = mundo();
  equal((await passarGrupo({}, ORG, d)).status, 400);
  equal((await passarGrupo(pedido({ group_jid: "5511999990009" }), ORG, d)).status, 400);
  equal((await passarGrupo(pedido({ to_phone_number_id: SAI }), ORG, d)).status, 400);
  equal((await passarGrupo(pedido(), "org-2", d)).status, 404);
  const oficial = mundo({ linhaEntra: { connection_type: "business_api" } });
  equal((await passarGrupo(pedido(), ORG, oficial.d)).status, 400);
  const sumiu = mundo({ linhaSai: null });
  equal((await passarGrupo(pedido(), ORG, sumiu.d)).status, 404);
});
