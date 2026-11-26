// UPDATE de conversations depois de gravar uma mensagem — só quando muda algo.
//
// As edges faziam `update({ status: 'active', last_message_at: now() })` sem
// condição a cada mensagem. Cada UPDATE é uma versão nova da linha (REPLICA IDENTITY FULL) decodificada pelo walrus para
// todas as assinaturas de conversations, mesmo quando nada mudou.
//
// O que o trigger on_message_inserted (função update_conversation_last_message_at,
// que mantém conversations.last_message_*) já faz em todo INSERT em messages:
//   - last_message_at = GREATEST(last_message_at, NEW.created_at);
//   - status closed -> active quando a mensagem é inbound e não importada;
//   - prévia last_message_* da conversa.
// O que ele NÃO faz, e por isso continua aqui (agora condicional):
//   - reabrir em mensagem outbound (envio do painel, eco do aparelho);
//   - tirar de 'waiting'/'pending' (qualquer mensagem volta a conversa a 'active');
//   - promover source para 'organic' na resposta do cliente (auto-close de 30 dias).
// closed_at/close_reason/closed_by seguem com o trg_conversation_close_lifecycle,
// que só roda quando status muda de fato.
//
// Quem atualiza uma mensagem no lugar (reenvio por retryMessageId) não passa pelo
// trigger de INSERT e continua avançando last_message_at por conta própria.

/** Só o pedaço do supabase-js que esta função usa (sem `any`). */
export interface SupabaseClientLike {
  from(table: 'conversations'): {
    update(values: Record<string, string>): {
      eq(column: 'id', value: string): {
        or(filters: string): PromiseLike<{ error: unknown }>;
      };
    };
  };
}

/** `.neq` do PostgREST não casa NULL: o `is.null` entra explícito. */
export const FILTRO_STATUS_NAO_ATIVO = 'status.is.null,status.neq.active';
export const FILTRO_NAO_ATIVO_OU_NAO_ORGANICO =
  'status.is.null,status.neq.active,source.is.null,source.neq.organic';

export interface ReativarOpcoes {
  /** Resposta do cliente: source vira 'organic' (regra do auto-close de 30 dias). */
  promoverOrganica?: boolean;
}

/** Corpo e filtro do UPDATE condicional, separados para teste. */
export function planoDeReativacao(opcoes: ReativarOpcoes = {}): {
  campos: { status: 'active'; source?: 'organic' };
  filtro: string;
} {
  return opcoes.promoverOrganica
    ? { campos: { status: 'active', source: 'organic' }, filtro: FILTRO_NAO_ATIVO_OU_NAO_ORGANICO }
    : { campos: { status: 'active' }, filtro: FILTRO_STATUS_NAO_ATIVO };
}

/**
 * Volta a conversa para 'active' (e, se pedido, source 'organic') só quando ela
 * ainda não está assim. last_message_at fica com o trigger de INSERT.
 * Falha aqui não derruba o envio/recebimento: a mensagem já foi gravada.
 */
export async function reativarConversa(
  supabase: SupabaseClientLike,
  conversationId: string,
  opcoes: ReativarOpcoes = {},
): Promise<void> {
  const { campos, filtro } = planoDeReativacao(opcoes);
  const { error } = await supabase
    .from('conversations')
    .update(campos)
    .eq('id', conversationId)
    .or(filtro);
  if (error) {
    console.error(`[conversation-touch] Falha ao reativar a conversa ${conversationId}:`, error);
  }
}
