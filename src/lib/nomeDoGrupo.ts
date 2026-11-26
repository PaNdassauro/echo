/**
 * Grupo tem dois nomes: o do WhatsApp (`group_subject`, muda pelo painel do grupo) e o
 * exibido no Echo (`contact_name`, o apelido do lápis). O webhook só move o exibido
 * enquanto os dois são iguais (`supabase/functions/_shared/nome-do-grupo.ts`).
 */
interface NomesDoGrupo {
  is_group?: boolean;
  contact_name: string;
  group_subject?: string | null;
  group_jid?: string | null;
}

/** Nome do grupo no WhatsApp quando o Echo mostra um apelido diferente; senão null. */
export function nomeNoWhatsAppSeApelido(conversa: NomesDoGrupo): string | null {
  if (!conversa.is_group) return null;
  const nome = conversa.group_subject?.trim();
  return nome && nome !== conversa.contact_name?.trim() ? nome : null;
}

/**
 * Campos que o lápis grava. Em grupo sem `group_subject` (antigo ou criado pelo Echo), o
 * `contact_name` atual É o nome no WhatsApp: grava-o na coluna junto, senão o webhook vê
 * NULL, acompanha a próxima mensagem e apaga o apelido (`_shared/nome-do-grupo.ts`).
 *
 * `conversa` tem de vir do banco na hora do save (não do estado da tela, que pode não ter
 * `group_subject` ainda). Fora disso: grupo importado sem `group_jid` não recebe webhook,
 * e nome só de dígitos é o JID de reserva, não um nome do WhatsApp.
 */
export function camposDoApelido(
  conversa: NomesDoGrupo,
  novoNome: string,
): { contact_name: string; group_subject?: string } {
  const nome = novoNome.trim();
  const nomeAtual = conversa.contact_name?.trim();
  const ehNomeDoWhatsApp = !!nomeAtual && !/^\d+$/.test(nomeAtual);
  if (conversa.is_group && conversa.group_jid && conversa.group_subject == null && ehNomeDoWhatsApp) {
    return { contact_name: nome, group_subject: nomeAtual };
  }
  return { contact_name: nome };
}

/** Rótulo do lápis: no grupo ele grava um apelido, não renomeia o grupo no WhatsApp. */
export const rotuloEditarNome = (conversa: Pick<NomesDoGrupo, "is_group">): string =>
  conversa.is_group ? "Editar apelido" : "Editar nome";

interface MensagemDoGrupo {
  id: string;
  message_type?: string | null;
  metadata?: { groupAction?: { action?: string } | null } | null;
}

/**
 * Id da última mensagem de sistema "mudou o nome do grupo" (`group_action` com action
 * `subject`, gravada pelo `/qr-group-event` DEPOIS de atualizar a conversa), ou null.
 * O cabeçalho não escuta UPDATE em `conversations`: quando este id muda, ele relê a
 * conversa. Olha só o fim da lista, onde chegam as mensagens novas.
 */
export function ultimaTrocaDeNome(mensagens: readonly MensagemDoGrupo[], janela = 30): string | null {
  for (let i = mensagens.length - 1; i >= 0 && i >= mensagens.length - janela; i--) {
    const m = mensagens[i];
    if (m.message_type === "group_action" && m.metadata?.groupAction?.action === "subject") return m.id;
  }
  return null;
}
