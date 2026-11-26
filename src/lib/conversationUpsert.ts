import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert } from "@/integrations/supabase/types";
import { getLookupVariations } from "@/lib/phone";

// is_group/group_jid existem no banco (baseline)
// mas os types gerados estão desatualizados — cast estreito até regenerá-los.
type GroupConversationInsert = TablesInsert<"conversations"> & {
  is_group: boolean;
  group_jid: string | null;
};

export interface FindOrCreateConversationParams {
  /**
   * Contact phone as it appears in the source (e.g. a WhatsApp CSV export):
   * the full number including country code, digits only, no leading "+".
   */
  contactPhone: string;
  contactName: string;
  phoneNumberDbId: string;
  userId: string;
}

export interface FindOrCreateConversationResult {
  conversationId: string;
  /** true when a new conversation row was inserted, false when an existing one was reused. */
  created: boolean;
}

/**
 * Finds an existing conversation for the given contact under a connected phone
 * number, or creates one. Mirrors the find-or-create logic in
 * StartConversationDialog.handleSend but never applies the Brazilian 55-prefix
 * heuristic on insert, since callers (CSV import) already provide a complete
 * WhatsApp number.
 */
export async function findOrCreateConversation({
  contactPhone,
  contactName,
  phoneNumberDbId,
  userId,
}: FindOrCreateConversationParams): Promise<FindOrCreateConversationResult> {
  const digits = (contactPhone || "").replace(/\D/g, "");
  if (!digits) {
    throw new Error("Telefone do contato vazio ou inválido.");
  }

  const variations = getLookupVariations(digits);

  const { data: existing, error: lookupError } = await supabase
    .from("conversations")
    .select("id")
    .eq("phone_number_id", phoneNumberDbId)
    .in("contact_phone", variations)
    .limit(1);

  if (lookupError) throw lookupError;
  if (existing?.[0]?.id) {
    return { conversationId: existing[0].id, created: false };
  }

  const { data: created, error: insertError } = await supabase
    .from("conversations")
    .insert({
      contact_phone: digits,
      contact_name: contactName.trim() || digits,
      whatsapp_id: digits,
      status: "active",
      assigned_to: userId,
      phone_number_id: phoneNumberDbId,
    })
    .select("id")
    .single();

  if (insertError) {
    // Unique violation: another path created it concurrently (or it already
    // existed under the exact digits). Re-fetch and reuse.
    if (insertError.code === "23505") {
      const { data: conflict } = await supabase
        .from("conversations")
        .select("id")
        .eq("phone_number_id", phoneNumberDbId)
        .eq("contact_phone", digits)
        .maybeSingle();

      if (conflict?.id) {
        return { conversationId: conflict.id, created: false };
      }
    }
    throw insertError;
  }

  return { conversationId: created.id, created: true };
}

export interface FindOrCreateGroupConversationParams {
  /** Full group JID, e.g. "120363000000000001@g.us". */
  groupJid: string;
  groupName: string;
  phoneNumberDbId: string;
  userId: string;
}

/**
 * Finds an existing group conversation by its JID under a connected phone
 * number, or creates one following the whatsapp-webhook convention:
 * contact_phone/group_jid hold the JID and whatsapp_id gets the
 * qr_group_ prefix, so webhook messages for the group land in this row.
 */
export async function findOrCreateGroupConversation({
  groupJid,
  groupName,
  phoneNumberDbId,
  userId,
}: FindOrCreateGroupConversationParams): Promise<FindOrCreateConversationResult> {
  const jid = (groupJid || "").trim();
  if (!jid.endsWith("@g.us")) {
    throw new Error(`JID de grupo inválido: "${groupJid}"`);
  }

  // Group conversations always store the JID in contact_phone (webhook and
  // CreateGroupDialog both do), so the lookup can use the typed column.
  const { data: existing, error: lookupError } = await supabase
    .from("conversations")
    .select("id")
    .eq("phone_number_id", phoneNumberDbId)
    .eq("contact_phone", jid)
    .limit(1);

  if (lookupError) throw lookupError;
  if (existing?.[0]?.id) {
    return { conversationId: existing[0].id, created: false };
  }

  const insertPayload: GroupConversationInsert = {
    contact_phone: jid,
    contact_name: groupName.trim() || jid.replace("@g.us", ""),
    whatsapp_id: `qr_group_${phoneNumberDbId}_${jid}`,
    status: "active",
    assigned_to: userId,
    phone_number_id: phoneNumberDbId,
    is_group: true,
    group_jid: jid,
  };

  const { data: created, error: insertError } = await supabase
    .from("conversations")
    .insert(insertPayload as TablesInsert<"conversations">)
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      const { data: conflict } = await supabase
        .from("conversations")
        .select("id")
        .eq("phone_number_id", phoneNumberDbId)
        .eq("contact_phone", jid)
        .maybeSingle();

      if (conflict?.id) {
        return { conversationId: conflict.id, created: false };
      }
    }
    throw insertError;
  }

  return { conversationId: created.id, created: true };
}

export interface CreateUnlinkedGroupConversationParams {
  groupName: string;
  phoneNumberDbId: string;
  userId: string;
}

/**
 * Creates a group conversation NOT linked to a real WhatsApp group (no
 * group_jid) — used when importing history of a group the account is no
 * longer in. Synthetic ids keep it out of the webhook's JID lookup, so new
 * group messages never land here.
 */
export async function createUnlinkedGroupConversation({
  groupName,
  phoneNumberDbId,
  userId,
}: CreateUnlinkedGroupConversationParams): Promise<FindOrCreateConversationResult> {
  const syntheticId = `imported_group_${crypto.randomUUID()}`;

  const insertPayload: GroupConversationInsert = {
    contact_phone: syntheticId,
    contact_name: groupName.trim() || "Grupo importado",
    whatsapp_id: syntheticId,
    status: "active",
    assigned_to: userId,
    phone_number_id: phoneNumberDbId,
    is_group: true,
    group_jid: null,
  };

  const { data: created, error: insertError } = await supabase
    .from("conversations")
    .insert(insertPayload as TablesInsert<"conversations">)
    .select("id")
    .single();

  if (insertError) throw insertError;

  return { conversationId: created.id, created: true };
}
