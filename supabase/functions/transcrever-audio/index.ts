// Transcrição de áudio sob demanda: o botão "Transcrever" da bolha de áudio chama
// esta edge. Reusa a leitura de mídia (`lerMidia` + reserva atômica) e grava em
// `messages.metadata.leitura`, o mesmo campo que o copiloto lê: o texto aparece
// para todos da conversa e alimenta as sugestões.
// Áudio já transcrito volta sem custo. Só a OpenAI transcreve (chave da org).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.87.1";
import { z } from "https://esm.sh/zod@3.23.8";
import { requirePhoneAccess, requireUser } from "../_shared/authz.ts";
import { COLUNAS_MSG, ioDeProducao } from "../_shared/conversa-contexto-db.ts";
import {
  lacunaImediata,
  lerMidia,
  type MensagemMidia,
} from "../_shared/leitura-midia.ts";
import { OpenAIErro, type Uso } from "../_shared/openai.ts";
import {
  antesDeLer,
  depoisDeLer,
  ehMensagemDeAudio,
  motivoDaChave,
  type RespostaTranscricao,
} from "./logica.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RequestSchema = z.object({ messageId: z.string().uuid() });

const MensagemSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  message_type: z.string().nullable(),
  content: z.string().nullable(),
  is_deleted: z
    .boolean()
    .nullable()
    .transform((v) => v === true),
  media_url: z.string().nullable(),
  media_mime_type: z.string().nullable(),
  media_filename: z.string().nullable(),
  media_size_bytes: z.number().nullable(),
  metadata: z.record(z.unknown()).nullable(),
});

const ConversaSchema = z.object({
  id: z.string(),
  phone_numbers: z.object({
    id: z.string(),
    organization_id: z.string().nullable(),
  }),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function responder(r: RespostaTranscricao): Response {
  return json(r);
}

/** Erro de autenticação/autorização dos helpers de `_shared/authz.ts` → status HTTP. */
function statusDeAuth(msg: string): number | null {
  if (/not a member|do not have access/i.test(msg)) return 403;
  if (/^Unauthorized/i.test(msg)) return 401;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const db = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // 1. Identidade SEMPRE do JWT, nunca do corpo.
    let userId: string;
    try {
      userId = await requireUser(db, req);
    } catch (e) {
      console.warn(
        "[transcrever-audio] não autenticado:",
        e instanceof Error ? e.message : "erro",
      );
      return json({ error: "unauthorized" }, 401);
    }

    // 2. Corpo validado.
    const parsed = RequestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid_payload" }, 400);
    const { messageId } = parsed.data;

    // 3. A pessoa ENXERGA esta mensagem? Com o token dela valem as regras da RLS
    // (messages → conversations: setor, "só quem assumiu vê"), que o
    // requirePhoneAccess abaixo não cobre. Mesmo padrão do copiloto.
    const doUsuario = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization") ?? "" },
        },
        auth: { persistSession: false },
      },
    );
    const { data: visivel, error: visivelErro } = await doUsuario
      .from("messages")
      .select("id")
      .eq("id", messageId)
      .maybeSingle();
    if (visivelErro) {
      console.error(
        "[transcrever-audio] falha ao conferir o acesso à mensagem:",
        messageId,
        visivelErro.message,
      );
      return json({ error: "erro_interno" }, 500);
    }
    if (!visivel) return json({ error: "mensagem_nao_encontrada" }, 404);

    // 4. Mensagem completa (service role) e linha → organização.
    const { data: bruta, error: msgErro } = await db
      .from("messages")
      .select(COLUNAS_MSG)
      .eq("id", messageId)
      .maybeSingle();
    if (msgErro) {
      console.error(
        "[transcrever-audio] falha ao ler a mensagem:",
        messageId,
        msgErro.message,
      );
      return json({ error: "erro_interno" }, 500);
    }
    const msgParse = MensagemSchema.safeParse(bruta);
    if (!msgParse.success)
      return json({ error: "mensagem_nao_encontrada" }, 404);
    const msg: MensagemMidia = msgParse.data;
    if (!ehMensagemDeAudio(msg)) return json({ error: "nao_e_audio" }, 400);

    const { data: conversaBruta, error: conversaErro } = await db
      .from("conversations")
      .select(
        "id, phone_numbers!conversations_phone_number_id_fkey(id, organization_id)",
      )
      .eq("id", msg.conversation_id)
      .maybeSingle();
    if (conversaErro) {
      console.error(
        "[transcrever-audio] falha ao ler a conversa:",
        msg.conversation_id,
        conversaErro.message,
      );
      return json({ error: "erro_interno" }, 500);
    }
    const conversa = ConversaSchema.safeParse(conversaBruta);
    const organizationId = conversa.success
      ? conversa.data.phone_numbers.organization_id
      : null;
    if (!conversa.success || !organizationId)
      return json({ error: "mensagem_nao_encontrada" }, 404);
    const phoneId = conversa.data.phone_numbers.id;

    try {
      await requirePhoneAccess(db, userId, phoneId, organizationId);
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      const status = statusDeAuth(m);
      if (status === null) throw e;
      console.warn(
        `[transcrever-audio] acesso negado (${status}) mensagem=${messageId} user=${userId}`,
      );
      return json(
        { error: status === 403 ? "forbidden" : "unauthorized" },
        status,
      );
    }

    // 5. Já transcrito, apagado, em curso ou esgotado: responde sem custo.
    const agora = new Date();
    const antes = antesDeLer(msg, agora);
    if (antes !== "ler") return responder(antes);

    // 5b. Formato fora da lista ou tamanho acima do limite: o lerMidia grava a lacuna sem
    // chamar o provedor (a chave não é usada), e o botão não volta na próxima montagem.
    if (lacunaImediata(msg)) {
      const leitura = await lerMidia(ioDeProducao(db), msg, "");
      return responder(depoisDeLer(leitura));
    }

    // 6. Chave de IA da organização (só a OpenAI transcreve).
    const { data: chave, error: chaveErro } = await db.rpc(
      "get_decrypted_ai_key",
      { p_org_id: organizationId },
    );
    if (chaveErro) {
      // Falha passageira do banco não é "org sem chave": o botão não pode sumir por ela.
      console.error(
        "[transcrever-audio] falha ao ler a chave de IA da org:",
        organizationId,
        chaveErro.message,
      );
      return json({ error: "erro_interno" }, 500);
    }
    const motivo = motivoDaChave(chave);
    if (motivo) return responder({ status: "indisponivel", motivo });

    // 7. Transcreve (reserva atômica, download, OpenAI, grava em metadata.leitura).
    const usos: Uso[] = [];
    try {
      const leitura = await lerMidia(
        ioDeProducao(db),
        msg,
        String(chave).trim(),
        {
          aoUsar: (u) => {
            usos.push(u);
          },
        },
      );
      const resposta = depoisDeLer(leitura);
      const custo = usos.reduce((s, u) => s + u.custo_usd, 0);
      console.info(
        `[transcrever-audio] mensagem=${messageId} org=${organizationId} user=${userId} ` +
          `status=${resposta.status} segundos=${leitura.segundos ?? "?"} custo_usd=${custo.toFixed(5)}`,
      );
      return responder(resposta);
    } catch (e) {
      // lerMidia só lança chave inválida ou sem saldo (a leitura já gravou o erro).
      if (
        e instanceof OpenAIErro &&
        (e.codigo === "sem_saldo" || e.codigo === "chave_invalida")
      ) {
        console.warn(
          `[transcrever-audio] chave da org recusada (${e.codigo}) org=${organizationId}`,
        );
        return responder({ status: "falhou", erro: e.codigo, definitivo: false });
      }
      throw e;
    }
  } catch (e) {
    console.error(
      "[transcrever-audio] erro inesperado:",
      e instanceof Error ? e.message : "erro",
    );
    return json({ error: "erro_interno" }, 500);
  }
});
