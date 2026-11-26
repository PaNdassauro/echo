// Instagram Direct: resposta do painel pelo Direct.
//
// O whatsapp-send chama isto quando a conversa é do Instagram (channel =
// 'instagram'): o composer do painel continua o mesmo. Envia pela API do
// Instagram com o token da conexão, grava a bolha e atualiza a conversa.
// Não emite webhook da organização nem automação: o Direct não é telefone.
//
// Regras do Meta: só texto aqui, até 1000 bytes, e só
// até 24 horas depois da última mensagem da pessoa.
import { IG_GRAPH } from './instagram.ts';

// deno-lint-ignore no-explicit-any
type Db = any;

export const LIMITE_DO_TEXTO_BYTES = 1000;

export type PedidoDeEnvio = {
  /** Organização da linha da conversa (já provada contra o usuário no whatsapp-send). */
  organizationId: string;
  conversa: {
    id: string;
    phone_number_id: string;
    instagram_account_id: string | null;
    instagram_user_id: string | null;
  };
  texto: string;
  /** Pessoa da equipe que mandou. */
  userId: string;
  quotedMessageId: string | null;
  retryMessageId: string | null;
};

/** Erro do Meta traduzido para quem está no painel. */
export function erroDoDirect(status: number, erro: Record<string, unknown> | null): string {
  const codigo = erro?.code;
  const sub = erro?.error_subcode;
  const msg = typeof erro?.message === 'string' ? erro.message : '';
  if (sub === 2534022 || /outside of allowed window/i.test(msg)) {
    return 'Direct fora da janela: passou 24h da última mensagem da pessoa. Só dá para responder quando ela escrever de novo.';
  }
  if (codigo === 190) return 'Direct desconectado: a autorização do Instagram venceu. Reconecte a conta.';
  if (codigo === 4 || codigo === 613 || codigo === 32) return 'Direct com muitas mensagens seguidas. Aguarde um minuto e tente de novo.';
  if (sub === 2534014 || /no matching user/i.test(msg)) return 'Direct: a pessoa não está mais disponível (conta apagada ou bloqueou).';
  return `Direct recusou o envio (${status}${codigo !== undefined ? `/${codigo}` : ''}${sub !== undefined ? `/${sub}` : ''}).`;
}

const JANELA_MS = 24 * 60 * 60 * 1000;

/** A mensagem de entrada mais recente veio pelo Direct e ainda está nas 24h? */
export function ultimaEntradaAbreODirect(
  ultima: { metadata: Record<string, unknown> | null; created_at: string } | null,
  agora = Date.now(),
): boolean {
  if (!ultima || ultima.metadata?.canal !== 'instagram') return false;
  const enviadaEm = typeof ultima.metadata?.sent_at === 'string' ? ultima.metadata.sent_at : ultima.created_at;
  return agora - new Date(enviadaEm).getTime() < JANELA_MS;
}

/**
 * Conversa com WhatsApp e Direct juntos: a resposta sai pelo canal onde o
 * contato escreveu por último. Direct só vale dentro das 24h; passou disso,
 * sai pelo WhatsApp.
 */
export async function respostaVaiPeloDirect(db: Db, conversaId: string): Promise<boolean> {
  // Mesma régua da tela (lib/directDoInstagram.ts): a última entrada é a de
  // hora de ENVIO mais recente (metadata.sent_at), não a de chegada — aviso
  // reprocessado chega minutos depois.
  const { data, error } = await db
    .from('messages')
    .select('metadata, created_at')
    .eq('conversation_id', conversaId)
    .eq('direction', 'inbound')
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error('Failed to validate conversation');
  const hora = (m: { metadata: Record<string, unknown> | null; created_at: string }) =>
    new Date(typeof m.metadata?.sent_at === 'string' ? m.metadata.sent_at : m.created_at).getTime();
  const ultima = ((data ?? []) as { metadata: Record<string, unknown> | null; created_at: string }[])
    .reduce<{ metadata: Record<string, unknown> | null; created_at: string } | null>(
      (maior, m) => (!maior || hora(m) > hora(maior) ? m : maior),
      null,
    );
  return ultimaEntradaAbreODirect(ultima);
}

export async function enviarPeloDirect(db: Db, pedido: PedidoDeEnvio): Promise<{ mid: string }> {
  const { conversa } = pedido;
  if (!conversa.instagram_account_id || !conversa.instagram_user_id) {
    throw new Error('Direct: conversa sem conta do Instagram');
  }
  if (new TextEncoder().encode(pedido.texto).length > LIMITE_DO_TEXTO_BYTES) {
    throw new Error('Direct: mensagem longa demais (o Instagram aceita até 1000 caracteres simples).');
  }

  // O token só serve à conta da MESMA organização e à linha dela: as colunas
  // instagram_* da conversa podem ser escritas por quem tem acesso à linha.
  const { data: conexao, error: conexaoErro } = await db
    .from('instagram_connections')
    .select('ig_user_id, access_token, status, phone_number_id')
    .eq('ig_user_id', conversa.instagram_account_id)
    .eq('organization_id', pedido.organizationId)
    .maybeSingle();
  if (conexaoErro) throw new Error('Direct: falha ao ler a conexão');
  if (!conexao || conexao.status !== 'connected') {
    throw new Error('Direct desconectado: reconecte a conta do Instagram.');
  }
  if (conversa.phone_number_id !== conexao.phone_number_id) {
    throw new Error('Direct: esta linha não responde por esta conta do Instagram.');
  }

  let resposta: Response;
  try {
    resposta = await fetch(`${IG_GRAPH}/${conexao.ig_user_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conexao.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: conversa.instagram_user_id },
        message: { text: pedido.texto },
      }),
    });
  } catch {
    throw new Error('Direct: falha de rede ao enviar. Tente de novo.');
  }
  const corpo = (await resposta.json().catch(() => ({}))) as Record<string, unknown>;
  const mid = typeof corpo.message_id === 'string' ? corpo.message_id : '';
  if (!resposta.ok || !mid) {
    const erro = corpo.error && typeof corpo.error === 'object' ? (corpo.error as Record<string, unknown>) : null;
    console.error('[instagram-envio] recusado', resposta.status, JSON.stringify({ code: erro?.code, sub: erro?.error_subcode }));
    throw new Error(erroDoDirect(resposta.status, erro));
  }

  if (pedido.retryMessageId) {
    const { error } = await db
      .from('messages')
      .update({ whatsapp_message_id: mid, status: 'sent', error_message: null })
      .eq('id', pedido.retryMessageId);
    if (error) console.error('[instagram-envio] bolha do reenvio não atualizada', error.code);
  } else {
    // O eco do Meta pode chegar antes desta linha e gravar a mesma bolha sem
    // autor: aí só o autor é completado (status e hora do eco ficam).
    const { data: nova, error } = await db
      .from('messages')
      .upsert(
        {
          conversation_id: conversa.id,
          content: pedido.texto,
          direction: 'outbound',
          status: 'sent',
          sent_by: pedido.userId,
          whatsapp_message_id: mid,
          quoted_message_id: pedido.quotedMessageId,
          message_type: 'text',
          metadata: { canal: 'instagram' },
        },
        { onConflict: 'whatsapp_message_id,conversation_id', ignoreDuplicates: true },
      )
      .select('id')
      .maybeSingle();
    if (error) {
      console.error('[instagram-envio] bolha não gravada', error.code);
    } else if (!nova) {
      // Eco chegou antes: completa o autor.
      const { data: eco } = await db
        .from('messages')
        .select('id, sent_by')
        .eq('conversation_id', conversa.id)
        .eq('whatsapp_message_id', mid)
        .maybeSingle();
      if (eco) {
        await db
          .from('messages')
          .update({
            sent_by: eco.sent_by ?? pedido.userId,
            quoted_message_id: pedido.quotedMessageId,
          })
          .eq('id', eco.id);
      }
    }
  }

  await db
    .from('conversations')
    .update({ last_message_at: new Date().toISOString(), status: 'active' })
    .eq('id', conversa.id);

  return { mid };
}
