// npx -y deno@2 test --no-config --allow-env --allow-read tests/echo-api-grupos
import { criarGrupo, MAX_SUBJECT, type DepsCriarGrupo, type LinhaDoGrupo } from "../../supabase/functions/echo-api/grupos.ts";

function equal(a: unknown, b: unknown, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const ORG = "org-1";
const JID = "120363000000000001@g.us";
const LINK = "https://chat.whatsapp.com/AbCdEf123";

type Chamada = { path: string; method: string; body: unknown };

function deps(opts: {
  linha?: LinhaDoGrupo | null;
  criar?: { status: number; json: unknown } | "rede";
  descricao?: { status: number; json: unknown } | "rede";
  foto?: { status: number; json: unknown } | "rede";
  convite?: { status: number; json: unknown } | "rede";
  conversa?: string | null | "erro";
} = {}) {
  const chamadas: Chamada[] = [];
  const linha = opts.linha === undefined ? { id: "linha-qr", organization_id: ORG, connection_type: "qr" } : opts.linha;
  const responder = (r: { status: number; json: unknown } | "rede" | undefined, padrao: { status: number; json: unknown }) => {
    if (r === "rede") throw new TypeError("network down");
    const v = r ?? padrao;
    return new Response(JSON.stringify(v.json), { status: v.status });
  };
  const d: DepsCriarGrupo = {
    buscarLinha: () => Promise.resolve(linha),
    qr: (path, init = {}) => {
      chamadas.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
      if (path.endsWith("/create")) return Promise.resolve().then(() => responder(opts.criar, { status: 200, json: { success: true, groupJid: JID } }));
      if (path.endsWith("/description")) return Promise.resolve().then(() => responder(opts.descricao, { status: 200, json: { success: true } }));
      if (path.endsWith("/picture")) return Promise.resolve().then(() => responder(opts.foto, { status: 200, json: { success: true } }));
      if (path.endsWith("/invite-code")) return Promise.resolve().then(() => responder(opts.convite, { status: 200, json: { success: true, code: "AbCdEf123", inviteUrl: LINK } }));
      throw new Error(`rota inesperada ${path}`);
    },
    conversaDoGrupo: () => {
      if (opts.conversa === "erro") return Promise.reject(new Error("db"));
      return Promise.resolve(opts.conversa === undefined ? "conv-1" : opts.conversa);
    },
  };
  return { d, chamadas };
}

Deno.test("cria o grupo vazio, põe descrição e foto e devolve conversa e link", async () => {
  const { d, chamadas } = deps();
  const foto = "https://example.com/brand/grupo.jpg";
  const r = await criarGrupo({ phone_number_id: "linha-qr", subject: "  Acme | Equipe Projeto X ", description: "Oi", picture_url: foto }, ORG, d);
  equal(r.status, 201);
  equal(r.body, { group_jid: JID, conversation_id: "conv-1", invite_url: LINK, warnings: [] });
  equal(chamadas.map((c) => `${c.method} ${c.path}`), [
    "POST /groups/linha-qr/create",
    `PATCH /groups/linha-qr/${encodeURIComponent(JID)}/description`,
    `PUT /groups/linha-qr/${encodeURIComponent(JID)}/picture`,
    `GET /groups/linha-qr/${encodeURIComponent(JID)}/invite-code`,
  ]);
  equal(chamadas[0].body, { name: "Acme | Equipe Projeto X", participants: [] }, "nunca manda participante");
  equal(chamadas[1].body, { description: "Oi" });
  equal(chamadas[2].body, { media_url: foto });
});

Deno.test("foto: só link https; falha depois de criado vira aviso", async () => {
  const { d, chamadas } = deps();
  equal((await criarGrupo({ phone_number_id: "linha-qr", subject: "G", picture_url: "http://x.com/a.jpg" }, ORG, d)).status, 400);
  equal((await criarGrupo({ phone_number_id: "linha-qr", subject: "G", picture_url: "não é link" }, ORG, d)).status, 400);
  equal(chamadas.length, 0, "nada criado com foto inválida");
  const falha = deps({ foto: { status: 400, json: { success: false, error: "not admin" } } });
  const r = await criarGrupo({ phone_number_id: "linha-qr", subject: "G", picture_url: "https://x.com/a.jpg" }, ORG, falha.d);
  equal(r.status, 201);
  equal(r.body.warnings, ["picture_not_set"]);
});

Deno.test("sem descrição não chama a rota de descrição", async () => {
  const { d, chamadas } = deps();
  const r = await criarGrupo({ phone_number_id: "linha-qr", subject: "Grupo" }, ORG, d);
  equal(r.status, 201);
  equal(chamadas.some((c) => c.path.endsWith("/description")), false);
});

Deno.test("recusa participantes: gente entra pelo link", async () => {
  const { d, chamadas } = deps();
  const r = await criarGrupo({ phone_number_id: "linha-qr", subject: "Grupo", participants: ["5511999990009"] }, ORG, d);
  equal(r.status, 400);
  equal(chamadas.length, 0, "nada foi criado");
  const r2 = await criarGrupo({ phone_number_id: "linha-qr", subject: "Grupo", participants: [] }, ORG, d);
  equal(r2.status, 400, "nem lista vazia: o contrato não tem participantes");
});

Deno.test("campos obrigatórios e limites", async () => {
  const { d, chamadas } = deps();
  equal((await criarGrupo(null, ORG, d)).status, 400);
  equal((await criarGrupo({ subject: "x" }, ORG, d)).status, 400);
  equal((await criarGrupo({ phone_number_id: "linha-qr", subject: "   " }, ORG, d)).status, 400);
  equal((await criarGrupo({ phone_number_id: "linha-qr", subject: "a".repeat(MAX_SUBJECT + 1) }, ORG, d)).status, 400);
  equal((await criarGrupo({ phone_number_id: "linha-qr", subject: "a".repeat(MAX_SUBJECT) }, ORG, d)).status, 201);
  equal((await criarGrupo({ phone_number_id: "linha-qr", subject: "x", description: 5 }, ORG, d)).status, 400);
  equal(chamadas.filter((c) => c.path.endsWith("/create")).length, 1, "só a chamada válida criou");
});

Deno.test("linha de outra organização ou desconhecida é 404, sem criar", async () => {
  const outra = deps({ linha: { id: "linha-qr", organization_id: "org-2", connection_type: "qr" } });
  equal((await criarGrupo({ phone_number_id: "linha-qr", subject: "G" }, ORG, outra.d)).status, 404);
  equal(outra.chamadas.length, 0);
  const nenhuma = deps({ linha: null });
  equal((await criarGrupo({ phone_number_id: "x", subject: "G" }, ORG, nenhuma.d)).status, 404);
});

Deno.test("linha oficial (Cloud API) não cria grupo", async () => {
  const { d, chamadas } = deps({ linha: { id: "linha-api", organization_id: ORG, connection_type: "business_api" } });
  const r = await criarGrupo({ phone_number_id: "linha-api", subject: "G" }, ORG, d);
  equal(r.status, 400);
  equal(chamadas.length, 0);
});

Deno.test("falha ao criar: erro e nada mais é chamado", async () => {
  const recusado = deps({ criar: { status: 400, json: { success: false, error: "Session not connected" } } });
  const r = await criarGrupo({ phone_number_id: "linha-qr", subject: "G" }, ORG, recusado.d);
  equal(r.status, 400);
  equal(r.body.error, "Session not connected");
  equal(recusado.chamadas.length, 1);

  const fora = deps({ criar: "rede" });
  equal((await criarGrupo({ phone_number_id: "linha-qr", subject: "G" }, ORG, fora.d)).status, 502);

  const caiu = deps({ criar: { status: 500, json: {} } });
  equal((await criarGrupo({ phone_number_id: "linha-qr", subject: "G" }, ORG, caiu.d)).status, 502);

  const semJid = deps({ criar: { status: 200, json: { success: true, groupJid: "123@s.whatsapp.net" } } });
  equal((await criarGrupo({ phone_number_id: "linha-qr", subject: "G" }, ORG, semJid.d)).status, 400, "jid que não é de grupo");
});

Deno.test("depois de criado, falhas viram aviso e o grupo é devolvido", async () => {
  const { d } = deps({ descricao: "rede", conversa: "erro", convite: { status: 400, json: { success: false, error: "not admin" } } });
  const r = await criarGrupo({ phone_number_id: "linha-qr", subject: "G", description: "D" }, ORG, d);
  equal(r.status, 201);
  equal(r.body, {
    group_jid: JID,
    conversation_id: null,
    invite_url: null,
    warnings: ["description_not_set", "conversation_not_created", "invite_link_not_fetched"],
  });
});

Deno.test("link que não é do WhatsApp não é devolvido", async () => {
  const { d } = deps({ convite: { status: 200, json: { success: true, inviteUrl: "https://example.com/x" } } });
  const r = await criarGrupo({ phone_number_id: "linha-qr", subject: "G" }, ORG, d);
  equal(r.body.invite_url, null);
  equal(r.body.warnings, ["invite_link_not_fetched"]);
});
