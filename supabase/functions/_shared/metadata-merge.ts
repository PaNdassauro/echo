// Escrita atômica em messages.metadata.
//
// Nenhum writer pode ler `metadata`, mesclar no TS e gravar o objeto inteiro: a transcrição
// escreve `leitura` e o voto de enquete escreve `poll.votes` na mesma linha, e um
// read-modify-write que leu antes apagaria o que foi gravado depois. Tudo passa pelas RPCs
// `messages_mesclar_metadata`, `messages_registrar_edicao` e `messages_leitura_reservar`
// (SECURITY DEFINER, só service_role).
// A trava tests/metadata/metadata-writers.test.ts falha se o padrão antigo voltar.

/** O mínimo que precisamos do cliente (supabase-js satisfaz isto estruturalmente). */
export interface RpcClient {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

function falhar(rpc: string, error: { message: string; code?: string }): never {
  throw new Error(`${rpc}: ${error.message}${error.code ? ` (${error.code})` : ''}`);
}

function comoObjeto(data: unknown): Record<string, unknown> | null {
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/**
 * `metadata || patch` numa UPDATE só. Com `nivel2`, chave cujo valor no patch é objeto é mesclada
 * um nível abaixo (preserva `poll.votes`, gravado por `record_poll_vote`).
 * Lança Error com a mensagem do PostgREST; devolve null se a mensagem não existe.
 */
export async function mesclarMetadata(
  db: RpcClient,
  messageId: string,
  patch: Record<string, unknown>,
  o?: { nivel2?: boolean },
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.rpc('messages_mesclar_metadata', {
    p_message_id: messageId,
    p_patch: patch,
    p_nivel2: o?.nivel2 ?? false,
  });
  if (error) falhar('messages_mesclar_metadata', error);
  return comoObjeto(data);
}

/**
 * Edição numa UPDATE só, sem ler antes. Normal: troca o content e acrescenta o texto antigo em
 * `metadata.edit_history`. `flagOnly` (sem o texto novo): marca a edição e `edit_content_unavailable`.
 * Devolve false quando nada mudou (mensagem apagada, inexistente ou, fora do flagOnly, texto igual:
 * a edição chega por dois caminhos do Baileys).
 */
export async function registrarEdicao(
  db: RpcClient,
  messageId: string,
  novoConteudo: string | null,
  editadoEm: string,
  flagOnly: boolean,
): Promise<boolean> {
  const { data, error } = await db.rpc('messages_registrar_edicao', {
    p_message_id: messageId,
    p_novo_conteudo: novoConteudo,
    p_editado_em: editadoEm,
    p_flag_only: flagOnly,
  });
  if (error) falhar('messages_registrar_edicao', error);
  return data === true;
}

/** Reserva atômica da leitura de mídia (tentativas + 1 e em_leitura_desde). null = não ler. */
export async function reservarLeitura(
  db: RpcClient,
  messageId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.rpc('messages_leitura_reservar', { p_message_id: messageId });
  if (error) falhar('messages_leitura_reservar', error);
  return comoObjeto(data);
}
