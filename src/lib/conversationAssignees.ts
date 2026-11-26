/**
 * Opções do filtro por usuário da lista de conversas.
 *
 * O filtro NÃO lista o roster da organização: lista quem de fato participa das
 * conversas da linha selecionada. Isso vem de graça do que a lista já carregou
 * (`assigned_to` + `co_assignee_ids` em cada linha), garante que nenhuma opção
 * produza lista vazia e é escopado por número por construção.
 */

import type { Conversation } from "@/types/conversation";

export interface AssigneeOption {
  id: string;
  label: string;
  /** 1–2 letras para o marcador redondo do dropdown. */
  initials: string;
}

/** Nome do mapa de membros (organization_members + profiles). */
export type MemberNames = Map<string, string>;

const nameFromProfile = (profile: Conversation["profiles"]): string | undefined => {
  const full = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  return profile?.email?.split("@")[0]?.trim() || undefined;
};

/**
 * Só palavras que começam com letra ou dígito entram: nomes de verdade no banco
 * têm separador ("Bruno - Acme Suporte"), e ele viraria inicial ("B-").
 */
export const initialsFor = (label: string): string =>
  label
    .split(/\s+/)
    .filter((part) => /^[\p{L}\p{N}]/u.test(part))
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";

/**
 * Quem assumiu (dono primário, `assigned_to`) OU é co-responsável
 * (`co_assignee_ids`) de alguma das conversas recebidas, em ordem alfabética pt-BR.
 *
 * Recebe SEMPRE a lista filtrada só pelo número selecionado — nunca a lista já
 * filtrada pela busca ou pela aba, senão digitar na busca encolhe o dropdown.
 *
 * `names` é a fonte principal de rótulo porque o `profiles` embutido na linha
 * existe só para o dono primário: o FK de `conversation_assignees.user_id`
 * aponta para `auth.users`, não para `public.profiles`, então o PostgREST não
 * consegue embutir o perfil de um co-responsável.
 */
export const buildAssigneeOptions = (
  conversations: Conversation[],
  names: MemberNames,
): AssigneeOption[] => {
  const labels = new Map<string, string>();

  const remember = (id: string, fallback?: string) => {
    const label = names.get(id)?.trim() || fallback;
    // Uma segunda passada só melhora o rótulo: quem já tem nome não regride
    // para "Usuário" porque outra linha não trouxe o perfil.
    if (label) {
      labels.set(id, label);
    } else if (!labels.has(id)) {
      labels.set(id, "Usuário");
    }
  };

  for (const conv of conversations) {
    if (conv.assigned_to) remember(conv.assigned_to, nameFromProfile(conv.profiles));
    for (const coOwnerId of conv.co_assignee_ids ?? []) remember(coOwnerId);
  }

  return [...labels.entries()]
    .map(([id, label]) => ({ id, label, initials: initialsFor(label) }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
};
