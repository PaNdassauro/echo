import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { checkEdgeFunctionResponseAsync } from "@/lib/utils";
import { substitutePlaceholders } from "@/lib/actionButtonPlaceholders";
import { useNumeroPorId } from "@/hooks/useAccessiblePhoneNumbers";

export type ActionButtonType = 'webhook' | 'link' | 'import_history';

export interface ActionButtonConfig {
    id: string;
    position: number;
    label: string;
    button_type: ActionButtonType;
    url: string | null;
    icon: string;
    is_active: boolean;
}

/**
 * All the runtime data the click handler needs to substitute placeholders.
 * Required: conversationId, userId. Everything else is optional and falls
 * back to empty string in the substituted URL.
 */
export interface ActionButtonClickContext {
    conversationId: string;
    userId: string;
    contactName?: string;
    contactPhone?: string;
    agentEmail?: string;
}

interface UseActionButtonOptions {
    organizationId: string | null;
    phoneNumberDbId: string | null;
}

interface UseActionButtonReturn {
    buttons: ActionButtonConfig[];
    isLoading: boolean;
    sendingButtonId: string | null;
    handleButtonClick: (button: ActionButtonConfig, ctx: ActionButtonClickContext) => Promise<{ success: boolean; error?: string }>;
}

export function useActionButton({ organizationId, phoneNumberDbId }: UseActionButtonOptions): UseActionButtonReturn {
    const [buttons, setButtons] = useState<ActionButtonConfig[]>([]);
    const [allowedPhoneIds, setAllowedPhoneIds] = useState<Record<string, string[]>>({});
    const [isLoading, setIsLoading] = useState(true);
    const [sendingButtonId, setSendingButtonId] = useState<string | null>(null);

    // Nome da linha para o placeholder {phone_number.display_name}. Sai do mapa de
    // números acessíveis (uma busca para a tela toda), sem consulta por linha. O
    // mapa só lista linhas ativas: uma conversa de linha desativada, aberta por deep
    // link, cai na leitura pela PK, que o useSectors do mesmo chat divide (ver
    // `useNumeroPorId`).
    const { linha } = useNumeroPorId(organizationId, phoneNumberDbId);
    const phoneDisplayName = linha?.displayName ?? "";

    // Fetch config when org changes
    useEffect(() => {
        const fetchConfig = async () => {
            if (!organizationId) {
                setButtons([]);
                setAllowedPhoneIds({});
                setIsLoading(false);
                return;
            }

            setIsLoading(true);

            try {
                // Fetch all action buttons for the org
                const { data: buttonsData, error: buttonsError } = await supabase
                    .from('organization_action_buttons')
                    .select('id, position, label, button_type, url, icon, is_active')
                    .eq('organization_id', organizationId)
                    .eq('is_active', true)
                    .order('position');

                if (buttonsError) {
                    console.error('Error fetching action buttons:', buttonsError);
                    setButtons([]);
                    setAllowedPhoneIds({});
                    return;
                }

                if (!buttonsData || buttonsData.length === 0) {
                    setButtons([]);
                    setAllowedPhoneIds({});
                    return;
                }

                const btns = buttonsData as ActionButtonConfig[];
                setButtons(btns);

                // Vínculos de todos os botões numa query só. Antes era um SELECT
                // por botão, em SÉRIE (await dentro do for), no mount de todo
                // usuário — o mesmo N+1 que ActionButtonSettings.tsx:393 já
                // tinha corrigido; este hook ficou para trás.
                const buttonIds = btns.map((btn) => btn.id);
                const phoneMap: Record<string, string[]> = {};
                const { data: phoneData, error: phoneError } = await supabase
                    .from('action_button_phone_numbers')
                    .select('action_button_id, phone_number_id')
                    .in('action_button_id', buttonIds);

                if (phoneError) throw phoneError;

                for (const link of (phoneData || []) as Array<{ action_button_id: string; phone_number_id: string }>) {
                    (phoneMap[link.action_button_id] ??= []).push(link.phone_number_id);
                }
                // Botão sem vínculo precisa existir como [] no mapa: enabledButtons
                // lê `allowed.length === 0` como "aparece em todas as linhas".
                for (const id of buttonIds) phoneMap[id] ??= [];

                setAllowedPhoneIds(phoneMap);
            } catch (error) {
                console.error('Error in useActionButton:', error);
                setButtons([]);
                setAllowedPhoneIds({});
            } finally {
                setIsLoading(false);
            }
        };

        fetchConfig();
    }, [organizationId]);

    // Filter buttons based on current phone number
    const enabledButtons = buttons.filter(btn => {
        if (!phoneNumberDbId) return false;
        const allowed = allowedPhoneIds[btn.id] || [];
        // If no phones specified, show on all; otherwise check if current phone is in list
        return allowed.length === 0 || allowed.includes(phoneNumberDbId);
    });

    // Handle button click - either open link or send webhook.
    // For the built-in type 'import_history' the click is
    // handled by the consumer (e.g. ChatArea opens the dialog) — this hook just signals success.
    const handleButtonClick = useCallback(async (
        button: ActionButtonConfig,
        ctx: ActionButtonClickContext
    ): Promise<{ success: boolean; error?: string }> => {
        if (button.button_type === 'import_history') {
            return { success: true };
        }

        if (!button.url) {
            return { success: false, error: 'URL não configurada' };
        }

        if (button.button_type === 'link') {
            // Substitute all available placeholders. Both `{x}` and `{{x}}`
            // syntaxes are supported by substitutePlaceholders, so legacy
            // configs using `{{phone}}` keep working.
            let url = substitutePlaceholders(button.url, {
                "conversation.id": ctx.conversationId,
                "contact.name": ctx.contactName || "",
                "contact.phone": ctx.contactPhone || "",
                "phone": ctx.contactPhone || "", // legacy alias
                "phone_number.id": phoneNumberDbId || "",
                "phone_number.display_name": phoneDisplayName,
                "agent.email": ctx.agentEmail || "",
            });
            // Ensure URL has protocol, default to https if missing
            if (!/^https?:\/\//i.test(url)) {
                url = 'https://' + url;
            }
            window.open(url, '_blank', 'noopener,noreferrer');
            return { success: true };
        }

        // For webhooks, send via edge function
        setSendingButtonId(button.id);

        try {
            const result = await supabase.functions.invoke('action-button-webhook', {
                body: {
                    conversation_id: ctx.conversationId,
                    user_id: ctx.userId,
                    button_id: button.id,
                    button_label: button.label,
                },
            });

            const response = await checkEdgeFunctionResponseAsync(result) as any;
            if (response.webhook_sent) {
                return { success: true };
            } else if (response.webhook_error) {
                return { success: false, error: response.webhook_error };
            } else {
                return { success: true };
            }
        } catch (error: any) {
            console.error('Error sending action button webhook:', error);
            return { success: false, error: error.message || 'Unknown error' };
        } finally {
            setSendingButtonId(null);
        }
    }, [phoneNumberDbId, phoneDisplayName]);

    return {
        buttons: enabledButtons,
        isLoading,
        sendingButtonId,
        handleButtonClick,
    };
}
