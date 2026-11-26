
export interface Conversation {
    id: string;
    contact_name: string;
    contact_phone: string;
    last_message_at: string;
    status: string;
    /** Linha (número) do WhatsApp; vem do select "*" e escopa lista, tags e filtros. */
    phone_number_id?: string | null;
    /**
     * Setor responsável. `null` = triagem: visível a todos os atendentes da
     * linha, é assim que toda conversa nova nasce. Só divide de fato quando a
     * linha tem `sector_isolation_enabled` — quem
     * recorta é a RLS, não o front.
     */
    sector_id?: string | null;
    assigned_to: string | null;
    is_group?: boolean;
    last_message_preview?: string;
    last_message_direction?: 'inbound' | 'outbound';
    contact_avatar_url?: string | null;
    contact_avatar_updated_at?: string | null;
    profiles?: {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
    } | null;
    /**
     * UUIDs of users who are co-owners of this conversation (shared custody).
     * The primary owner (`assigned_to`) is never in this list — enforced by the
     * `prevent_primary_in_assignees` trigger.
     */
    co_assignee_ids?: string[];
    /** 'instagram' = Direct do Instagram (contact_phone guarda `ig:<id>`, não telefone). */
    channel?: 'whatsapp' | 'instagram';
    instagram_username?: string | null;
    /** Pessoa do Instagram ligada à conversa: Direct puro ou card juntado ao WhatsApp. */
    instagram_user_id?: string | null;
    /**
     * Não nulo = a conversa só recebeu disparo e mora na aba Disparos. Quem põe
     * e tira a marca é o banco (gatilhos): a resposta do contato a limpa.
     */
    disparo_desde?: string | null;
    /** Rótulo do último disparo (ex.: "Campanha · Convite"). */
    disparo_rotulo?: string | null;
    /** Status do último disparo (sent, delivered, read, failed): a linha da aba diz se a pessoa leu. */
    disparo_status?: string | null;
    /** Campanhas dos disparos enquanto a conversa está na aba. */
    disparo_campanhas?: string[] | null;
    /**
     * Não nulo = uma IA está atendendo e a conversa mora na aba Com a IA. Quem
     * põe e tira a marca é o banco: a resposta do contato NÃO a limpa.
     */
    ia_desde?: string | null;
    /** Qual IA atendeu por último (ex.: "bot-vendas"). */
    ia_origem?: string | null;
    /** Com a IA: primeira mensagem do contato ainda sem resposta da IA ou do time (rede de 10 minutos). */
    ia_sem_resposta_desde?: string | null;
}
