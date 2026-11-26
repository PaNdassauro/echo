/**
 * Utilitários de telefone compartilhados. Antes cada tela tinha sua própria
 * cópia do formatador (GroupInfoPanel, MentionPopup, MessageBubble) e elas
 * divergiam: a do MessageBubble não conhecia LID e renderizava o ID cru como
 * se fosse telefone ("+260200000001001").
 */

/**
 * Rótulo exibível de um telefone de participante.
 *
 * `isLid = true` significa que o WhatsApp NÃO expôs o número: o valor recebido
 * é o LID cru (identificador interno), então mostramos um ID abreviado em vez
 * de fingir que é telefone.
 */
export function formatParticipantPhone(phone: string, isLid?: boolean): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return "";

  if (isLid) {
    if (digits.length > 10) {
      return `ID: ${digits.slice(0, 4)}...${digits.slice(-4)}`;
    }
    return `ID: ${digits}`;
  }

  // +55 11 99999-9999
  if (digits.length >= 12 && digits.length <= 13) {
    const country = digits.slice(0, 2);
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    if (rest.length >= 8) {
      const firstPart = rest.slice(0, rest.length - 4);
      const lastPart = rest.slice(-4);
      return `+${country} ${ddd} ${firstPart}-${lastPart}`;
    }
  }

  return `+${digits}`;
}

/**
 * Builds the set of contact_phone values to look up when checking whether a
 * conversation already exists. The exact digits are always included. For
 * Brazilian numbers (country code 55) we also add the with/without extra-9
 * variants, since legacy rows may have been stored either way. Numbers from a
 * WhatsApp export already carry their country code, so non-55 numbers are
 * trusted as-is — we never prepend 55 (that would corrupt international
 * numbers).
 *
 * Espelha `phone_lookup_variations()` no banco (baseline). As duas TÊM de casar: se
 * o painel do grupo vincular um contato que o findOrCreateConversation
 * considera outra pessoa, o app se contradiz.
 */
export function getLookupVariations(digits: string): string[] {
  const variations: string[] = [digits];

  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.substring(2, 4);
    const localNumber = digits.substring(4);

    if (digits.length === 13 && localNumber.startsWith("9")) {
      variations.push("55" + ddd + localNumber.substring(1));
      variations.push(ddd + localNumber);
      variations.push(ddd + localNumber.substring(1));
    } else if (digits.length === 12) {
      variations.push("55" + ddd + "9" + localNumber);
      variations.push(ddd + localNumber);
      variations.push(ddd + "9" + localNumber);
    }
  }

  return [...new Set(variations)];
}
