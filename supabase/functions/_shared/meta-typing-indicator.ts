import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';

export interface SendTypingIndicatorParams {
  accessToken: string;
  metaPhoneNumberId: string;
  inboundMessageId: string;
}

export interface GetLatestInboundWamidOptions {
  /** Maximum age of the inbound message in milliseconds (e.g. 24h window). */
  maxAgeMs?: number;
}

/**
 * Sends a typing indicator to Meta WhatsApp Cloud API.
 * This marks the message as read and displays "typing..." in WhatsApp for up to 25s (or until a reply is sent).
 * Fire-and-forget friendly: never throws, logs failures and returns the result.
 */
export async function sendMetaTypingIndicator({
  accessToken,
  metaPhoneNumberId,
  inboundMessageId,
}: SendTypingIndicatorParams): Promise<{ success: boolean; error?: string }> {
  if (!accessToken || !metaPhoneNumberId || !inboundMessageId) {
    console.warn('[MetaTypingIndicator] Missing required params:', {
      hasToken: Boolean(accessToken),
      hasPhoneId: Boolean(metaPhoneNumberId),
      hasMessageId: Boolean(inboundMessageId),
    });
    return { success: false, error: 'Missing required parameters' };
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${metaPhoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: inboundMessageId,
          typing_indicator: {
            type: 'text',
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.warn('[MetaTypingIndicator] Graph API error response:', {
        status: response.status,
        error: errorText,
        inboundMessageId,
      });
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    return { success: data?.success ?? true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[MetaTypingIndicator] Network or unexpected error:', message);
    return { success: false, error: message };
  }
}

/**
 * Retrieves the most recent inbound message for a conversation that has a valid Meta whatsapp_message_id.
 * Optionally checks if the message is within a maximum age limit (e.g. 24h window).
 */
export async function getLatestInboundWamid(
  supabase: SupabaseClient,
  conversationId: string,
  options?: GetLatestInboundWamidOptions
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('whatsapp_message_id, created_at')
      .eq('conversation_id', conversationId)
      .eq('direction', 'inbound')
      // Card juntado ao Direct: id do Instagram não vale para o WhatsApp.
      .or('metadata->>canal.is.null,metadata->>canal.neq.instagram')
      .not('whatsapp_message_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('[MetaTypingIndicator] Error fetching latest inbound message:', error);
      return null;
    }

    if (!data || !data.whatsapp_message_id) {
      return null;
    }

    const wamid = data.whatsapp_message_id.trim();
    if (!wamid || wamid.startsWith('qr_')) {
      return null;
    }

    if (options?.maxAgeMs && data.created_at) {
      const messageAgeMs = Date.now() - new Date(data.created_at).getTime();
      if (messageAgeMs > options.maxAgeMs) {
        return null;
      }
    }

    return wamid;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[MetaTypingIndicator] Unexpected error fetching inbound message:', message);
    return null;
  }
}
