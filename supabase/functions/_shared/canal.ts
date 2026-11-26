// Direct do Instagram: conversa com channel = 'instagram'
// guarda 'ig:<id>' em contact_phone. As funções que só existem no WhatsApp
// (mídia, modelo, encaminhar, botões de ação, digitando, editar, apagar)
// recusam essa conversa em vez de mandar o id do Instagram como telefone.

// deno-lint-ignore no-explicit-any
export async function recusarSeDirect(supabase: any, conversationIds: (string | null | undefined)[]): Promise<void> {
  const ids = conversationIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return;
  const { data, error } = await supabase
    .from('conversations')
    .select('id')
    .in('id', ids)
    .eq('channel', 'instagram')
    .limit(1);
  if (error) throw new Error('Failed to validate conversation');
  if (data && data.length > 0) throw new Error('Direct: esta ação só existe no WhatsApp.');
}
