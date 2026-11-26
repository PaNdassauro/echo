// npx -y deno@2 test --no-config --allow-env --allow-read tests/echo-api-grupos
// POST /groups/add-line: a linha "to" entra pelo link da "from" e vira admin; ninguém sai.
import { passarGrupo, type DepsPassarGrupo } from "../../supabase/functions/echo-api/passar-grupo.ts";

function equal(a: unknown, b: unknown, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const ORG = "org-1";
const JID = "120363000000000001@g.us";
const J = encodeURIComponent(JID);
const ADMIN = "linha-admin";
const ENTRA = "linha-suporte";
const ID_ENTRA = "551199990002@s.whatsapp.net";

/** Mesmo jeito do passar.test.ts: o estado do grupo muda com as chamadas, para a releitura ver o efeito. */
function mundo(opts: {
  adminDentro?: boolean;
  adminEhAdmin?: boolean;
  entraDentro?: boolean;
  entraAdmin?: boolean;
  promoteSemEfeito?: boolean;
  sessaoEntraCaida?: boolean;
} = {}) {
  const estado = {
    adminDentro: opts.adminDentro ?? true,
    adminEhAdmin: opts.adminEhAdmin ?? true,
    entraDentro: opts.entraDentro ?? false,
    entraAdmin: opts.entraAdmin ?? false,
  };
  const chamadas: string[] = [];
  const res = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
  const grupo = (quem: "admin" | "entra") => {
    if (quem === "entra" && opts.sessaoEntraCaida) return res(500, { success: false, error: "Sessão sem cliente" });
    const dentro = quem === "admin" ? estado.adminDentro : estado.entraDentro;
    if (!dentro) return res(400, { success: false, error: "forbidden" });
    const me = quem === "admin"
      ? { id: "551199990003@s.whatsapp.net", isAdmin: estado.adminEhAdmin }
      : { id: ID_ENTRA, isAdmin: estado.entraAdmin };
    return res(200, { success: true, group: { jid: JID, joinApprovalMode: false, participants: [], me } });
  };
  const d: DepsPassarGrupo = {
    buscarLinha: (id) =>
      Promise.resolve([ADMIN, ENTRA].includes(id) ? { id, organization_id: ORG, connection_type: "qr", phone_number: null } : null),
    esperar: () => Promise.resolve(),
    agora: () => 0,
    conversaDoGrupo: () => Promise.resolve("conv-entra"),
    conversaExistente: () => Promise.resolve("conv-admin"),
    qr: (path, init = {}) => {
      const chave = `${init.method ?? "GET"} ${path}`;
      chamadas.push(chave);
      return Promise.resolve().then(() => {
        if (chave === `GET /groups/${ADMIN}/${J}?picture=0`) return grupo("admin");
        if (chave === `GET /groups/${ENTRA}/${J}?picture=0`) return grupo("entra");
        if (chave === `GET /groups/${ADMIN}/${J}/invite-code`) {
          return estado.adminEhAdmin ? res(200, { success: true, code: "AbC123" }) : res(400, { success: false, error: "not-authorized" });
        }
        if (chave === `POST /groups/${ENTRA}/join`) {
          estado.entraDentro = true;
          return res(200, { success: true, groupJid: JID });
        }
        if (chave === `POST /groups/${ADMIN}/${J}/promote`) {
          if (!opts.promoteSemEfeito) estado.entraAdmin = true;
          return res(200, { success: true });
        }
        if (chave === `DELETE /groups/${ADMIN}/${J}/leave`) {
          estado.adminDentro = false;
          return res(200, { success: true });
        }
        throw new Error(`rota inesperada ${chave}`);
      });
    },
  };
  return { d, chamadas, estado };
}

const pedido = (extra: Record<string, unknown> = {}) =>
  ({ group_jid: JID, from_phone_number_id: ADMIN, to_phone_number_id: ENTRA, ...extra });

const ninguemSaiu = (chamadas: string[]) => !chamadas.some((c) => c.includes("/leave"));
const nuncaAdicionaAForca = (chamadas: string[]) => !chamadas.some((c) => c.includes("/participants"));

Deno.test("entrar: entra pelo link, vira admin e ninguém sai", async () => {
  const { d, chamadas, estado } = mundo();
  const r = await passarGrupo(pedido(), ORG, d, "entrar");
  equal(r.status, 200);
  equal(r.body.resultado, "entrou");
  equal(r.body.passos, ["entrou", "virou_admin"]);
  equal(r.body.entra_admin, true);
  equal(r.body.to_conversation_id, "conv-entra");
  equal(estado.adminDentro && estado.entraDentro && estado.entraAdmin, true, "estado final");
  equal(ninguemSaiu(chamadas), true, "ninguém sai");
  equal(nuncaAdicionaAForca(chamadas), true, "nunca adiciona participante à força");
});

Deno.test("entrar com make_admin: false: entra e não promove", async () => {
  const { d, chamadas } = mundo();
  const r = await passarGrupo(pedido({ make_admin: false }), ORG, d, "entrar");
  equal(r.body.resultado, "entrou");
  equal(r.body.passos, ["entrou"]);
  equal(r.body.entra_admin, false);
  equal(chamadas.some((c) => c.includes("/promote")), false);
  equal(ninguemSaiu(chamadas), true);
});

Deno.test("entrar de novo com a linha já dentro e admin: ja_estava, sem mexer", async () => {
  const { d, chamadas } = mundo({ entraDentro: true, entraAdmin: true });
  const r = await passarGrupo(pedido(), ORG, d, "entrar");
  equal(r.status, 200);
  equal(r.body.resultado, "ja_estava");
  equal(r.body.passos, []);
  equal(chamadas.some((c) => c.includes("/join") || c.includes("/promote") || c.includes("/leave")), false);
});

Deno.test("entrar com a linha já dentro sem admin: só promove", async () => {
  const { d, chamadas } = mundo({ entraDentro: true });
  const r = await passarGrupo(pedido(), ORG, d, "entrar");
  equal(r.body.resultado, "entrou");
  equal(r.body.passos, ["virou_admin"]);
  equal(ninguemSaiu(chamadas), true);
});

Deno.test("entrar com a admin fora do grupo: 409 sem mexer", async () => {
  const { d, chamadas } = mundo({ adminDentro: false });
  const r = await passarGrupo(pedido(), ORG, d, "entrar");
  equal(r.status, 409);
  equal(r.body.resultado, "admin_fora_do_grupo");
  equal(chamadas.some((c) => c.includes("/join") || c.includes("/leave")), false);
});

Deno.test("entrar com a de lá sem ser admin: 409, sem link para entrar", async () => {
  const { d, chamadas } = mundo({ adminEhAdmin: false });
  const r = await passarGrupo(pedido(), ORG, d, "entrar");
  equal(r.status, 409);
  equal(r.body.resultado, "sai_nao_e_admin");
  equal(chamadas.some((c) => c.includes("/join")), false);
});

Deno.test("entrar com promover sem efeito: 502 promover_falhou, a linha fica dentro e ninguém sai", async () => {
  const { d, chamadas, estado } = mundo({ promoteSemEfeito: true });
  const r = await passarGrupo(pedido(), ORG, d, "entrar");
  equal(r.status, 502);
  equal(r.body.resultado, "promover_falhou");
  equal(estado.entraDentro && estado.adminDentro, true);
  equal(ninguemSaiu(chamadas), true);
});

Deno.test("entrar com a linha que entra desconectada: 503", async () => {
  const { d } = mundo({ sessaoEntraCaida: true });
  const r = await passarGrupo(pedido(), ORG, d, "entrar");
  equal(r.status, 503);
  equal(r.body.resultado, "linha_desconectada");
});

Deno.test("passar continua igual: a admin sai no fim", async () => {
  const { d, chamadas } = mundo();
  const r = await passarGrupo(pedido(), ORG, d);
  equal(r.body.resultado, "passou");
  equal(r.body.passos, ["entrou", "virou_admin", "saiu"]);
  equal(ninguemSaiu(chamadas), false);
});
