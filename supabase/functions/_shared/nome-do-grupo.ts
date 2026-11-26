/**
 * Nome do grupo no WhatsApp (`conversations.group_subject`) × nome exibido no Echo
 * (`contact_name`). O exibido acompanha o do WhatsApp enquanto os dois forem iguais;
 * se o atendente pôs um apelido pelo lápis, o apelido fica.
 *
 * `group_subject` NULL é grupo de antes da coluna. Até ali o webhook
 * sobrescrevia `contact_name` com o nome do WhatsApp a cada mensagem, então nenhum
 * apelido sobrevivia: o `contact_name` desses grupos é o nome antigo e acompanha a
 * troca. Tratar como apelido travava o nome antigo por cima da primeira troca feita
 * depois do deploy.
 *
 * A comparação ignora espaço nas pontas: o webhook antigo gravava o nome sem `trim`,
 * e "Vendas " × "Vendas" não é apelido. Par no front: `src/lib/nomeDoGrupo.ts`.
 */
export interface NomesDoGrupo {
  contact_name: string | null;
  group_subject?: string | null;
}

/** Campos a gravar quando chega o nome do grupo, ou null se nada muda. */
export function atualizacaoDoNomeDoGrupo(
  atual: NomesDoGrupo,
  nomeNoWhatsApp: string | null | undefined,
): { group_subject?: string; contact_name?: string } | null {
  const nome = nomeNoWhatsApp?.trim();
  if (!nome) return null;

  const anterior = atual.group_subject ?? null;
  const exibido = atual.contact_name?.trim() || null;
  const acompanha = anterior === null || !exibido || exibido === anterior.trim();

  const campos: { group_subject?: string; contact_name?: string } = {};
  if (anterior !== nome) campos.group_subject = nome;
  if (acompanha && atual.contact_name !== nome) campos.contact_name = nome;
  return Object.keys(campos).length > 0 ? campos : null;
}
