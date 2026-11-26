// Copiloto de respostas do atendente. A conversa aberta chama esta edge quando chega
// mensagem do cliente; ela lê a janela recente e devolve a leitura do momento e até
// 3 respostas sugeridas. Nada é enviado: o front só insere o texto no composer.
// Liga/desliga por USUÁRIO em profiles.copiloto_enabled (Configurações > Perfil). Sem leitura de mídia.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.87.1";
import { z } from "https://esm.sh/zod@3.23.8";
import { requirePhoneAccess, requireUser } from "../_shared/authz.ts";
import { anthropicComplete, isAnthropicKey } from "../_shared/ai-provider.ts";
import { carregarJanela } from "../_shared/conversa-contexto-db.ts";
import { serializarConversa } from "../_shared/conversa-contexto.ts";
import { isoUs } from "../_shared/iso-us.ts";
import { MODELOS, responder } from "../_shared/openai.ts";
import {
  COPILOTO_JSON_SCHEMA,
  montarSystemPrompt,
  parseSaidaCopiloto,
} from "./prompt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RequestSchema = z.object({ conversationId: z.string().uuid() });

const MENSAGENS_NA_JANELA = 40;
const TETO_CHARS = 12000;
const REACOES_DIAS = 14;
const TIMEOUT_IA_MS = 20_000;
const MODELO_ANTHROPIC = "claude-haiku-4-5";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Erro de autenticação/autorização dos helpers de `_shared/authz.ts` → status HTTP. */
function statusDeAuth(msg: string): number | null {
  if (/not a member|do not have access/i.test(msg)) return 403;
  if (/^Unauthorized/i.test(msg)) return 401;
  return null;
}

interface LinhaDaConversa {
  id: string;
  contact_name: string | null;
  is_group: boolean | null;
  phone_numbers: { id: string; organization_id: string | null } | null;
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
        "[copiloto] não autenticado:",
        e instanceof Error ? e.message : "erro",
      );
      return json({ error: "unauthorized" }, 401);
    }

    // 2. Corpo validado.
    const parsed = RequestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid_payload" }, 400);
    const { conversationId } = parsed.data;

    // 2b. A pessoa ENXERGA esta conversa? Consulta com o token dela, para valerem as
    // regras da RLS de conversations (setor, "só quem assumiu vê"), que o
    // requirePhoneAccess abaixo não cobre. Mesmo padrão da conversation-webhook.
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
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .maybeSingle();
    if (visivelErro) {
      console.error(
        "[copiloto] falha ao conferir o acesso à conversa:",
        conversationId,
        visivelErro.message,
      );
      return json({ error: "erro_interno" }, 500);
    }
    if (!visivel) return json({ error: "conversa_nao_encontrada" }, 404);

    // 3. Conversa → linha → organização (um round trip).
    const { data: conversa, error: conversaErro } = await db
      .from("conversations")
      .select(
        "id, contact_name, is_group, phone_numbers!conversations_phone_number_id_fkey(id, organization_id)",
      )
      .eq("id", conversationId)
      .maybeSingle();
    if (conversaErro) {
      console.error(
        "[copiloto] falha ao ler a conversa:",
        conversationId,
        conversaErro.message,
      );
      return json({ error: "erro_interno" }, 500);
    }
    // O embed (FK única) devolve objeto; o tipo inferido sem schema o dá como array.
    const linha = conversa as unknown as LinhaDaConversa | null;
    const phone = linha?.phone_numbers ?? null;
    if (!linha || !phone?.organization_id)
      return json({ error: "conversa_nao_encontrada" }, 404);
    const organizationId = phone.organization_id;

    try {
      await requirePhoneAccess(db, userId, phone.id, organizationId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      const status = statusDeAuth(msg);
      if (status === null) throw e;
      console.warn(
        `[copiloto] acesso negado (${status}) conversa=${conversationId} user=${userId}`,
      );
      return json(
        { error: status === 403 ? "forbidden" : "unauthorized" },
        status,
      );
    }

    // 4. Gate por dado: quem pede precisa ter ligado o copiloto no próprio perfil.
    const { data: perfil, error: perfilErro } = await db
      .from("profiles")
      .select("copiloto_enabled")
      .eq("id", userId)
      .maybeSingle();
    if (perfilErro) {
      console.error(
        "[copiloto] falha ao ler a preferência do usuário:",
        userId,
        perfilErro.message,
      );
      return json({ error: "erro_interno" }, 500);
    }
    if (perfil?.copiloto_enabled !== true)
      return json({ status: "indisponivel", motivo: "desligado" });

    // 5. Chave de IA da organização.
    const { data: apiKey, error: chaveErro } = await db.rpc(
      "get_decrypted_ai_key",
      { p_org_id: organizationId },
    );
    if (chaveErro)
      console.error(
        "[copiloto] falha ao ler a chave de IA da org:",
        organizationId,
        chaveErro.message,
      );
    if (chaveErro || typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return json({ status: "indisponivel", motivo: "sem_chave" });
    }

    // 6. Janela recente (as últimas mensagens; sem leitura de mídia).
    const agora = new Date();
    const limite = isoUs(new Date(agora.getTime() + 5 * 60_000)); // margem: o relógio da edge pode atrasar em relação ao do banco
    const janela = await carregarJanela(db, {
      conversationId,
      cursor: { at: "1970-01-01T00:00:00.000000Z", id: null },
      ate: { at: limite, id: null },
      reacaoDesde: isoUs(
        new Date(agora.getTime() - REACOES_DIAS * 24 * 3_600_000),
      ),
      reacaoAte: limite,
      anteriores: 0,
      limiteNovas: MENSAGENS_NA_JANELA,
    });
    const vazio = {
      status: "ok",
      momento: "",
      sugestoes: [],
      analisado_ate: null,
    };
    if (janela.mensagens.length === 0) return json(vazio);

    const serial = serializarConversa({
      conversa: {
        id: conversationId,
        contact_name: linha.contact_name ?? "",
        is_group: Boolean(linha.is_group),
      },
      mensagens: janela.mensagens,
      citadas: janela.citadas,
      reacoes: janela.reacoes,
      cursor: null,
      agora,
      tetoChars: TETO_CHARS,
    });
    const ultimaMensagem = [...serial.linhas]
      .reverse()
      .find((l) => l.tipo === "mensagem");
    if (!ultimaMensagem) return json(vazio);
    const transcricao = serial.texto;

    // 7. Prompt e modelo.
    const system = montarSystemPrompt();
    const schema = COPILOTO_JSON_SCHEMA as unknown as Record<string, unknown>;

    let bruto: string;
    try {
      if (isAnthropicKey(apiKey)) {
        // O SDK não recebe o prazo: a corrida o impõe (o timer é limpo para não segurar o isolate).
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          bruto = await Promise.race([
            anthropicComplete({
              apiKey,
              model: MODELO_ANTHROPIC,
              system,
              messages: [{ role: "user", content: transcricao }],
              maxTokens: 1500,
              jsonSchema: schema,
            }),
            new Promise<never>((_, rejeitar) => {
              timer = setTimeout(
                () => rejeitar(new Error("AI provider error: timeout")),
                TIMEOUT_IA_MS,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } else {
        const r = await responder({
          chave: apiKey,
          modelo: MODELOS.analise,
          esforco: "none",
          instrucoes: system,
          entrada: [{ role: "user", content: transcricao }],
          schema: { nome: "copiloto", schema },
          maxSaida: 1500,
          cacheKey: "copiloto-v1",
          timeoutMs: TIMEOUT_IA_MS,
        });
        bruto = r.texto;
      }
    } catch (e) {
      console.error(
        `[copiloto] provedor de IA falhou conversa=${conversationId} org=${organizationId}:`,
        e instanceof Error ? e.message : "erro",
      );
      return json({ error: "ia_indisponivel" }, 502);
    }

    let saida: ReturnType<typeof parseSaidaCopiloto>;
    try {
      saida = parseSaidaCopiloto(bruto);
    } catch (e) {
      console.error(
        `[copiloto] saída do modelo inválida conversa=${conversationId} org=${organizationId}:`,
        e instanceof Error ? e.message : "erro",
      );
      return json({ error: "ia_indisponivel" }, 502);
    }

    return json({
      status: "ok",
      momento: saida.momento,
      sugestoes: saida.sugestoes,
      analisado_ate: ultimaMensagem.message_id,
    });
  } catch (e) {
    console.error(
      "[copiloto] erro inesperado:",
      e instanceof Error ? e.message : "erro",
    );
    return json({ error: "erro_interno" }, 500);
  }
});
