import type { LucideIcon } from "lucide-react";
import { Hash, User, Phone, Smartphone, Tag, Mail } from "lucide-react";

export interface ActionButtonPlaceholder {
  /** Token used in the URL, without braces. e.g. "contact.name" */
  token: string;
  /** Human-readable label (PT-BR) */
  label: string;
  /** Description used as tooltip on the chip */
  description: string;
  /** Visual icon for the chip */
  icon: LucideIcon;
}

/**
 * Single source of truth: drives both the UI palette in ActionButtonSettings
 * and the runtime substitution in useActionButton.
 */
export const ACTION_BUTTON_PLACEHOLDERS: ActionButtonPlaceholder[] = [
  {
    token: "conversation.id",
    label: "ID da conversa",
    description: "UUID interno da conversa atual",
    icon: Hash,
  },
  {
    token: "contact.name",
    label: "Nome do contato",
    description: "Nome salvo do contato",
    icon: User,
  },
  {
    token: "contact.phone",
    label: "Telefone do contato",
    description: "Telefone do contato (somente dígitos)",
    icon: Phone,
  },
  {
    token: "phone_number.id",
    label: "ID do número",
    description: "UUID do número conectado que está atendendo",
    icon: Smartphone,
  },
  {
    token: "phone_number.display_name",
    label: "Nome do número",
    description: "Nome de exibição do número conectado",
    icon: Tag,
  },
  {
    token: "agent.email",
    label: "Email do agente",
    description: "Email do usuário logado que clicou no botão",
    icon: Mail,
  },
];

/**
 * Substitutes {token} OR {{token}} placeholders in a URL string.
 * Tokens are matched longest-first to avoid collisions
 * (e.g. "phone" vs "contact.phone").
 *
 * Each value is URL-encoded so accented names and special characters
 * survive intact in the resulting URL.
 */
export function substitutePlaceholders(
  url: string,
  values: Record<string, string>
): string {
  const sorted = Object.entries(values).sort(
    ([a], [b]) => b.length - a.length
  );

  let result = url;
  for (const [token, value] of sorted) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Matches both {token} and {{token}}
    const pattern = new RegExp(`\\{\\{?${escaped}\\}?\\}`, "g");
    result = result.replace(pattern, encodeURIComponent(value));
  }
  return result;
}
