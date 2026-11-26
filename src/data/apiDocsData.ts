import { MessageSquare, Users, Phone, Tag, X, FileText, User, CalendarClock, Megaphone } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FieldDoc {
    name: string;
    type: string;
    description: string;
    required?: boolean;
    defaultValue?: string;
}

/** Tipo de conexão do número em que o endpoint funciona (phone_numbers.connection_type). */
export type ConnectionMode = "qr" | "business_api";

/** Como o endpoint se autentica. Deriva de `baseUrl`, nunca é escrito à mão. */
export type AuthProfile = "api-key" | "qr-bearer";

export interface EndpointItem {
    method: string;
    path: string;
    /** Identidade estável na URL (/api-docs/:slug). Autoral, não derivado de
     *  method+path: /tags/:id existe em GET, PATCH e DELETE e colidiria. */
    slug: string;
    /** Só em endpoints internos: slug do endpoint da Echo API que faz o mesmo
     *  trabalho e é chamável com `x-api-key`. O echo-api já faz o proxy para o
     *  QR service usando a service-role key, então na prática o integrador não
     *  precisa de Bearer nenhum para estes casos. Ausente = não existe caminho
     *  público ainda. */
    publicEquivalent?: string;
    /** Exibe GROUP_SEND_NOTICE no topo: endpoint de envio que aceita JID de
     *  grupo mas depende de `conversation_id` para arquivar no lugar certo. */
    groupCaveat?: boolean;
    description: string;
    /** Preencher SÓ quando o endpoint é restrito a um modo. Ausente significa
     *  "funciona nos dois" — o selo marca a exceção, não a regra, senão vira
     *  ruído em todo item da lista. A convenção está escrita na descrição da
     *  categoria Mensagens. */
    modes?: ConnectionMode[];
    detailedDescription?: string;
    queryParams?: FieldDoc[];
    pathParams?: FieldDoc[];
    body?: string;
    bodyFields?: FieldDoc[];
    response: string;
    responseFields?: FieldDoc[];
    /** `body` sobrescreve o corpo de erro padrão do perfil de auth quando a
     *  mensagem real do endpoint é específica o bastante para valer a linha. */
    responses?: { status: number; description: string; body?: string }[];
    baseUrl?: string;
}

export interface EndpointCategory {
    category: string;
    icon: React.ElementType;
    description: string;
    /** Superfície server-to-server: exige credencial que integrador externo não
     *  tem (JWT de sessão ou service-role key). Renderiza com aviso e nunca
     *  imprime uma chave real no exemplo. */
    internal?: boolean;
    items: EndpointItem[];
}

/** Marcador de baseUrl do QR Service, resolvido em runtime para o `qrServiceUrl` da configuração. */
export const QR_SERVICE_BASE = "__QR_SERVICE__";

/**
 * O QR Service é outro host (Node/Express hospedado à parte) e só lê
 * `Authorization: Bearer`. Mandar `x-api-key` ali devolve exatamente a mesma
 * resposta de uma requisição sem auth nenhuma — o header não é lido.
 */
export const getAuthProfile = (endpoint: Pick<EndpointItem, "baseUrl">): AuthProfile =>
    endpoint.baseUrl === QR_SERVICE_BASE ? "qr-bearer" : "api-key";

/** Páginas de conteúdo fixo, no mesmo espaço de slugs dos endpoints. */
export const STATIC_PAGES = [
    { slug: "auth", label: "Autenticação" },
    { slug: "tutorial", label: "Guia de Configuração" },
] as const;

export type StaticPageSlug = (typeof STATIC_PAGES)[number]["slug"];

// ─── Echo API Endpoints ──────────────────────────────────────────────────────

export const endpoints: EndpointCategory[] = [
    {
        category: "Conversas",
        icon: Users,
        description: "Gerencie conversas com clientes",
        items: [
            {
                method: "GET",
                path: "/conversations",
                slug: "list-conversations",
                description: "Lista todas as conversas",
                detailedDescription: "Retorna uma lista de todas as conversas disponíveis. Use os parâmetros de query para filtrar por status, número de telefone ou atendente responsável.",
                queryParams: [
                    { name: "status", type: "string", description: "Filtrar por status: active, waiting, closed", defaultValue: "active" },
                    { name: "phone_number_id", type: "string", description: "Filtrar por número de telefone", defaultValue: "" },
                    { name: "assigned_to", type: "string", description: "Filtrar por atendente (UUID ou 'null')", defaultValue: "" },
                    { name: "co_owner", type: "string", description: "Filtrar por co-proprietário (UUID) — guarda compartilhada", defaultValue: "" },
                    { name: "limit", type: "integer", description: "Limite de registros", defaultValue: "50" },
                    { name: "offset", type: "integer", description: "Deslocamento para paginação", defaultValue: "0" },
                ],
                responseFields: [
                    { name: "id", type: "string", description: "Identificador único da conversa" },
                    { name: "contact_name", type: "string", description: "Nome do contato/cliente" },
                    { name: "contact_phone", type: "string", description: "Número de telefone do contato" },
                    { name: "status", type: "string", description: "Status atual: 'active', 'waiting', 'closed'" },
                    { name: "close_reason", type: "string | null", description: "Motivo do encerramento (se fechada)" },
                    { name: "assigned_to", type: "string | null", description: "ID do usuário atendente responsável" },
                    { name: "assigned_user", type: "object | null", description: "Objeto com detalhes do atendente (first_name, last_name, email)" },
                    { name: "phone_number_id", type: "string", description: "ID do número de telefone usado" },
                    { name: "tags", type: "array", description: "Array de tags associadas à conversa" },
                    { name: "last_message_at", type: "string", description: "Data/hora da última mensagem" },
                ],
                responses: [
                    { status: 200, description: "Lista de conversas retornada com sucesso" },
                    { status: 401, description: "API Key inválida ou não fornecida" },
                ],
                response: `{
  "conversations": [
    {
      "id": "uuid",
      "contact_name": "João Silva",
      "contact_phone": "5584999999999",
      "status": "active",
      "close_reason": null,
      "assigned_to": "uuid",
      "phone_number_id": "uuid",
      "tags": [
        { "id": "uuid", "name": "VIP", "color": "#FFD700" }
      ],
      "last_message_at": "2024-01-01T00:00:00Z"
    }
  ],
  "count": 1,
  "offset": 0,
  "limit": 50
}`,
            },
            {
                method: "GET",
                path: "/conversations/:id",
                slug: "get-conversation",
                description: "Busca uma conversa",
                detailedDescription: "Retorna os detalhes completos de uma conversa específica pelo seu ID.",
                pathParams: [
                    { name: "id", type: "string", description: "ID da conversa", required: true, defaultValue: "CONVERSATION_ID" },
                ],
                responses: [
                    { status: 200, description: "Conversa retornada com sucesso" },
                    { status: 404, description: "Conversa não encontrada" },
                ],
                response: `{
  "conversation": {
    "id": "uuid",
    "contact_name": "João Silva",
    "contact_phone": "5584999999999",
    "status": "closed",
    "close_reason": "Problema resolvido",
    "tags": [
      { "id": "uuid", "name": "Suporte", "color": "#3b82f6" }
    ]
  }
}`,
            },
            {
                method: "GET",
                path: "/conversations/:id/messages",
                slug: "list-conversation-messages",
                description: "Lista mensagens",
                detailedDescription: "Retorna todas as mensagens de uma conversa específica.",
                pathParams: [
                    { name: "id", type: "string", description: "ID da conversa", required: true, defaultValue: "CONVERSATION_ID" },
                ],
                responses: [
                    { status: 200, description: "Lista de mensagens retornada" },
                    { status: 404, description: "Conversa não encontrada" },
                ],
                response: `[
  {
    "id": "uuid",
    "content": "Olá!",
    "direction": "inbound",
    "message_type": "text",
    "created_at": "2024-01-01T00:00:00Z"
  }
]`,
            },
            {
                method: "POST",
                path: "/conversations/:id/assign",
                slug: "assign-conversation",
                description: "Atribui conversa",
                detailedDescription: "Atribui uma conversa a um atendente específico. Atribuir tira a conversa das abas Disparos e Com a IA: é assim que uma IA passa a conversa para o time. Com \"avisar\": true, a pessoa recebe o mesmo aviso da transferência pelo painel (som e \"Nova conversa transferida\").",
                pathParams: [
                    { name: "id", type: "string", description: "ID da conversa", required: true, defaultValue: "CONVERSATION_ID" },
                ],
                bodyFields: [
                    { name: "user_id", type: "string", description: "ID do usuário responsável. Obrigatório sem user_email.", required: false, defaultValue: "USER_UUID" },
                    { name: "user_email", type: "string", description: "E-mail do usuário responsável, no lugar do user_id. Com os dois, eles precisam apontar para o mesmo membro.", required: false, defaultValue: "" },
                    { name: "avisar", type: "boolean", description: "true manda à pessoa o aviso da transferência (som e \"Nova conversa transferida\"). Sem ele, a atribuição sai calada.", required: false, defaultValue: "" },
                    { name: "se_sem_dono", type: "boolean", description: "true só atribui se a conversa ainda não tem dono. Uma IA usa para nunca tirar a conversa de quem já assumiu.", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Conversa atribuída com sucesso" },
                    { status: 400, description: "Sem user_id nem user_email, ou os dois apontam para pessoas diferentes" },
                    { status: 404, description: "Conversa ou usuário não encontrado na organização" },
                    { status: 409, description: "Com se_sem_dono, a conversa já tem dono e nada mudou" },
                ],
                response: `{ "success": true }`,
            },
            {
                method: "POST",
                path: "/conversations/:id/release",
                slug: "release-conversation",
                description: "Libera conversa",
                detailedDescription: "Remove a atribuição da conversa e a coloca de volta na fila (Aguardando). Também tira a conversa da aba Com a IA: é o que uma IA faz quando para de atender e não tem para quem passar.",
                pathParams: [
                    { name: "id", type: "string", description: "ID da conversa", required: true, defaultValue: "CONVERSATION_ID" },
                ],
                bodyFields: [
                    { name: "se_sem_dono", type: "boolean", description: "true só libera se a conversa ainda não tem dono: quem já assumiu fica com ela.", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Conversa liberada com sucesso" },
                    { status: 404, description: "Conversa não encontrada" },
                    { status: 409, description: "Com se_sem_dono, a conversa já tem dono e nada mudou" },
                ],
                response: `{ "success": true }`,
            },
            {
                method: "POST",
                path: "/conversations/:id/close",
                slug: "close-conversation",
                description: "Encerra conversa",
                detailedDescription: "Encerra uma conversa com um motivo opcional.",
                pathParams: [
                    { name: "id", type: "string", description: "ID da conversa", required: true, defaultValue: "CONVERSATION_ID" },
                ],
                bodyFields: [
                    { name: "reason", type: "string", description: "Motivo do encerramento", required: false, defaultValue: "Problema resolvido" },
                ],
                responses: [
                    { status: 200, description: "Conversa encerrada com sucesso" },
                    { status: 404, description: "Conversa não encontrada" },
                ],
                response: `{ "success": true }`,
            },
            {
                method: "POST",
                path: "/conversations/read",
                slug: "mark-read",
                description: "Marca conversas como lidas por uma pessoa",
                detailedDescription: "A pessoa leu as conversas em outro sistema (ex.: o seu CRM): elas ficam lidas no painel para ela, como se tivesse aberto aqui (a leitura é por pessoa). A pessoa é achada pelo e-mail dentro da organização da chave; só entram conversas das linhas que ela enxerga. Não gera o aviso conversation.read de volta.",
                bodyFields: [
                    { name: "user_email", type: "string", description: "E-mail da pessoa no Echo", required: true, defaultValue: "atendente@empresa.com" },
                    { name: "conversation_ids", type: "string[]", description: "IDs das conversas (até 50)", required: true, defaultValue: "[\"CONVERSATION_ID\"]" },
                ],
                responses: [
                    { status: 200, description: "Leitura gravada (marked = conversas gravadas; user_found = a pessoa existe na organização)" },
                    { status: 400, description: "Faltou user_email ou conversation_ids" },
                ],
                response: `{ "marked": 1, "user_found": true }`,
            },
            {
                method: "GET",
                path: "/conversations/:id/co-owners",
                slug: "list-co-owners",
                description: "Lista co-proprietários",
                detailedDescription: "Lista os atendentes co-proprietários de uma conversa (guarda compartilhada). O dono principal está em `assigned_to` e não aparece aqui.",
                pathParams: [
                    { name: "id", type: "string", description: "ID da conversa", required: true, defaultValue: "CONVERSATION_ID" },
                ],
                responses: [
                    { status: 200, description: "Lista de co-proprietários retornada" },
                    { status: 404, description: "Conversa não encontrada" },
                ],
                response: `{
  "co_owners": [
    {
      "user_id": "uuid",
      "added_by": "uuid",
      "added_at": "2026-04-06T14:30:00Z",
      "role": "co_owner",
      "user": {
        "id": "uuid",
        "first_name": "Maria",
        "last_name": "Silva",
        "full_name": "Maria Silva",
        "email": "maria@example.com"
      }
    }
  ],
  "count": 1
}`,
            },
            {
                method: "POST",
                path: "/conversations/:id/co-owners",
                slug: "add-co-owner",
                description: "Adiciona co-proprietário",
                detailedDescription: "Adiciona um atendente como co-proprietário de uma conversa. O usuário deve pertencer à mesma organização e não pode ser o dono principal.",
                pathParams: [
                    { name: "id", type: "string", description: "ID da conversa", required: true, defaultValue: "CONVERSATION_ID" },
                ],
                bodyFields: [
                    { name: "user_id", type: "string", description: "ID do usuário a adicionar como co-proprietário", required: true, defaultValue: "USER_UUID" },
                ],
                responses: [
                    { status: 201, description: "Co-proprietário adicionado" },
                    { status: 404, description: "Usuário ou conversa não encontrada" },
                    { status: 409, description: "Usuário já é o dono principal" },
                ],
                response: `{ "message": "Co-owner added", "co_owner": { "id": "uuid", "user_id": "uuid", "added_at": "..." } }`,
            },
            {
                method: "DELETE",
                path: "/conversations/:id/co-owners",
                slug: "remove-co-owner",
                description: "Remove co-proprietário",
                detailedDescription: "Remove um co-proprietário de uma conversa. O usuário sai da aba 'Copropriedades' dele.",
                pathParams: [
                    { name: "id", type: "string", description: "ID da conversa", required: true, defaultValue: "CONVERSATION_ID" },
                ],
                queryParams: [
                    { name: "user_id", type: "string", description: "ID do co-proprietário a remover", required: true, defaultValue: "USER_UUID" },
                ],
                responses: [
                    { status: 200, description: "Co-proprietário removido" },
                    { status: 404, description: "Conversa não encontrada" },
                ],
                response: `{ "message": "Co-owner removed" }`,
            },
            {
                method: "GET",
                path: "/conversations/:id/invite-link",
                slug: "get-group-invite-link",
                modes: ["qr"],
                description: "Busca o link de convite do grupo",
                detailedDescription: "Retorna o link de convite (https://chat.whatsapp.com/...) de uma conversa de grupo. Disponível apenas para grupos em números com conexão QR (Baileys) — a Cloud API da Meta não expõe grupos. A sessão do WhatsApp precisa estar conectada e ser admin do grupo. O link pode ser revogado/regenerado por qualquer admin a qualquer momento, então busque sob demanda em vez de armazenar.",
                pathParams: [
                    { name: "id", type: "string", description: "ID da conversa (deve ser um grupo)", required: true, defaultValue: "CONVERSATION_ID" },
                ],
                responseFields: [
                    { name: "invite_code", type: "string", description: "Código de convite do grupo" },
                    { name: "invite_url", type: "string", description: "URL completa do convite (https://chat.whatsapp.com/<código>)" },
                ],
                responses: [
                    { status: 200, description: "Link de convite retornado com sucesso" },
                    { status: 400, description: "Conversa não é grupo, número não é conexão QR, ou a sessão não é admin do grupo" },
                    { status: 401, description: "API Key inválida ou não fornecida" },
                    { status: 404, description: "Conversa não encontrada" },
                ],
                response: `{
  "invite_code": "Ab1Cd2Ef3Gh4Ij5Kl6Mn7o",
  "invite_url": "https://chat.whatsapp.com/Ab1Cd2Ef3Gh4Ij5Kl6Mn7o"
}`,
            },
            {
                method: "POST",
                path: "/groups",
                slug: "create-empty-group",
                modes: ["qr"],
                description: "Cria um grupo vazio e devolve o link de convite",
                detailedDescription: "Cria um grupo só com o dono do número (conexão QR) e devolve o link de convite. Não aceita participantes: as pessoas entram pelo link. Pôr gente num grupo a partir de número QR é o que mais leva o WhatsApp a restringir a linha. Sem idempotência: duas chamadas criam dois grupos. Descrição, conversa e link que falham depois de o grupo existir voltam em warnings, e o grupo é devolvido assim mesmo (o link pode ser buscado depois em GET /conversations/:id/invite-link).",
                bodyFields: [
                    { name: "phone_number_id", type: "string", description: "Número QR da organização (UUID do Echo ou ID da Meta)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "subject", type: "string", description: "Nome do grupo (até 100 caracteres)", required: true, defaultValue: "Acme | Equipe Projeto X" },
                    { name: "description", type: "string", description: "Descrição do grupo (até 2048 caracteres)", required: false },
                    { name: "picture_url", type: "string", description: "Link https de uma imagem para a foto do grupo (o serviço do QR baixa)", required: false },
                ],
                responseFields: [
                    { name: "group_jid", type: "string", description: "JID do grupo (...@g.us)" },
                    { name: "conversation_id", type: "string | null", description: "Conversa do grupo no Echo" },
                    { name: "invite_url", type: "string | null", description: "Link de convite (https://chat.whatsapp.com/...)" },
                    { name: "warnings", type: "string[]", description: "description_not_set, picture_not_set, conversation_not_created, invite_link_not_fetched" },
                ],
                responses: [
                    { status: 201, description: "Grupo criado" },
                    { status: 400, description: "Campo faltando, participantes enviados, número não é QR, ou o WhatsApp recusou" },
                    { status: 401, description: "API Key inválida ou não fornecida" },
                    { status: 404, description: "Número não encontrado na organização" },
                    { status: 502, description: "Serviço do QR fora do ar" },
                ],
                response: `{
  "group_jid": "120363000000000001@g.us",
  "conversation_id": "CONVERSATION_ID",
  "invite_url": "https://chat.whatsapp.com/Ab1Cd2Ef3Gh4Ij5Kl6Mn7o",
  "warnings": []
}`,
            },
            {
                method: "POST",
                path: "/groups/handover",
                slug: "handover-group",
                modes: ["qr"],
                description: "Passa um grupo de um número para outro",
                detailedDescription: "O número que entra entra pelo link do grupo (nunca é adicionado à força), vira admin, e só então o número que sai deixa o grupo. O número que sai só sai com o que entra como admin: se o que entra não é admin e o que sai não é admin para promovê-lo, para com entra_sem_admin. Qualquer passo que falhe para tudo antes da saída: o número que sai continua no grupo. Grupo com aprovação de entrada: o que sai aprova o pedido do que entra. Chamar de novo depois de passar devolve sai_fora_do_grupo sem mexer em nada. Com dry_run, só lê e diz o que faria.",
                bodyFields: [
                    { name: "group_jid", type: "string", description: "JID do grupo (...@g.us)", required: true, defaultValue: "120363000000000001@g.us" },
                    { name: "from_phone_number_id", type: "string", description: "Número QR que sai (UUID do Echo ou ID da Meta)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "to_phone_number_id", type: "string", description: "Número QR que entra (UUID do Echo ou ID da Meta)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "dry_run", type: "boolean", description: "Só lê: diz se cada número está no grupo e se é admin", required: false },
                ],
                responseFields: [
                    { name: "resultado", type: "string", description: "passou, sai_fora_do_grupo, previa; nos erros: linha_desconectada, falha_ao_ler_grupo, sai_nao_e_admin, convite_falhou, entrada_pendente, entra_nao_entrou, promover_falhou, entra_sem_admin, saida_falhou, tempo_esgotado" },
                    { name: "passos", type: "string[]", description: "O que foi feito: entrou, virou_admin, saiu" },
                    { name: "to_conversation_id", type: "string | null", description: "Conversa do grupo no número que entrou (também quando parou com ele já dentro, e em sai_fora_do_grupo se ele está no grupo)" },
                    { name: "from_conversation_id", type: "string | null", description: "Conversa do grupo no número que saiu (só se já existia)" },
                    { name: "entra_no_grupo", type: "boolean", description: "Em sai_fora_do_grupo: o número que entra está no grupo" },
                    { name: "avisos", type: "string[]", description: "Respostas do WhatsApp que não pararam a passagem, saida_nao_conferida, conversation_not_found" },
                ],
                responses: [
                    { status: 200, description: "Passou, ou o número que sai já não estava no grupo, ou prévia" },
                    { status: 400, description: "Campo faltando, mesmo número nos dois lados, ou número que não é QR" },
                    { status: 401, description: "API Key inválida ou não fornecida" },
                    { status: 404, description: "Número não encontrado na organização" },
                    { status: 409, description: "O que sai não é admin para pegar o link, o pedido de entrada não pôde ser aprovado, ou o que entra não é admin e o que sai não pode promovê-lo (entra_sem_admin)" },
                    { status: 502, description: "O WhatsApp recusou um passo ou o serviço do QR está fora do ar; o número que sai continua no grupo (menos em saida_falhou, quando o que entra já entrou)" },
                    { status: 503, description: "Um dos números está desconectado" },
                    { status: 504, description: "Prazo de 90 s passou antes de entrar, promover ou sair: o número que sai continua; chamar de novo continua de onde parou" },
                ],
                response: `{
  "resultado": "passou",
  "group_jid": "120363000000000001@g.us",
  "from_phone_number_id": "PHONE_NUMBER_UUID",
  "to_phone_number_id": "PHONE_NUMBER_UUID",
  "entra_admin": true,
  "to_conversation_id": "CONVERSATION_ID",
  "passos": ["entrou", "virou_admin", "saiu"],
  "avisos": []
}`,
            },
            {
                method: "POST",
                path: "/groups/add-line",
                slug: "add-line-to-group",
                modes: ["qr"],
                description: "Põe outro número nosso no grupo, sem tirar ninguém",
                detailedDescription: "O número que entra entra pelo link do grupo (nunca é adicionado à força) e vira admin, a não ser com make_admin: false. O número de origem precisa estar no grupo e ser admin, porque só admin tem o link. Ninguém sai. Mesmos passos e mesmos erros do handover, sem a saída. Chamar de novo com o número já dentro e admin devolve ja_estava.",
                bodyFields: [
                    { name: "group_jid", type: "string", description: "JID do grupo (...@g.us)", required: true, defaultValue: "120363000000000001@g.us" },
                    { name: "from_phone_number_id", type: "string", description: "Número QR nosso que já está no grupo e é admin (UUID do Echo ou ID da Meta)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "to_phone_number_id", type: "string", description: "Número QR que entra (UUID do Echo ou ID da Meta)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "make_admin", type: "boolean", description: "Vira admin ao entrar (padrão: true)", required: false },
                    { name: "dry_run", type: "boolean", description: "Só lê: diz se cada número está no grupo e se é admin", required: false },
                ],
                responseFields: [
                    { name: "resultado", type: "string", description: "entrou, ja_estava, previa; nos erros: admin_fora_do_grupo, linha_desconectada, falha_ao_ler_grupo, sai_nao_e_admin, convite_falhou, entrada_pendente, entra_nao_entrou, promover_falhou, tempo_esgotado" },
                    { name: "passos", type: "string[]", description: "O que foi feito: entrou, virou_admin" },
                    { name: "entra_admin", type: "boolean", description: "O número que entrou é admin" },
                    { name: "to_conversation_id", type: "string | null", description: "Conversa do grupo no número que entrou" },
                    { name: "avisos", type: "string[]", description: "Respostas do WhatsApp que não pararam a entrada, conversation_not_found" },
                ],
                responses: [
                    { status: 200, description: "Entrou, ou já estava dentro, ou prévia" },
                    { status: 400, description: "Campo faltando, mesmo número nos dois lados, ou número que não é QR" },
                    { status: 401, description: "API Key inválida ou não fornecida" },
                    { status: 404, description: "Número não encontrado na organização" },
                    { status: 409, description: "O de origem não está no grupo ou não é admin para pegar o link" },
                    { status: 502, description: "O WhatsApp recusou um passo ou o serviço do QR está fora do ar" },
                    { status: 503, description: "Um dos números está desconectado" },
                    { status: 504, description: "Prazo de 90 s passou antes de entrar ou promover; chamar de novo continua de onde parou" },
                ],
                response: `{
  "resultado": "entrou",
  "group_jid": "120363000000000001@g.us",
  "from_phone_number_id": "PHONE_NUMBER_UUID",
  "to_phone_number_id": "PHONE_NUMBER_UUID",
  "entra_admin": true,
  "to_conversation_id": "CONVERSATION_ID",
  "passos": ["entrou", "virou_admin"],
  "avisos": []
}`,
            },
        ],
    },
    {
        category: "Mensagens",
        icon: MessageSquare,
        description: "Texto, mídia, áudio e templates. Endpoints sem selo funcionam em qualquer número; os marcados Somente QR ou Somente Business API dependem do connection_type",
        items: [
            {
                method: "POST",
                path: "/send-message",
                slug: "send-message",
                groupCaveat: true,
                description: "Envia mensagem de texto",
                detailedDescription: "Envia uma mensagem de texto simples para um número de telefone.",
                bodyFields: [
                    { name: "to", type: "string", description: "Número do destinatário com DDI, ou JID do grupo (…@g.us) em números QR.", required: true, defaultValue: "5584999999999" },
                    { name: "message", type: "string", description: "Conteúdo da mensagem", required: true, defaultValue: "Olá!" },
                    { name: "phone_number_id", type: "string", description: "ID do número remetente", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "conversation_id", type: "string", description: "Envia dentro de uma conversa específica. Omitir faz o Echo achar a conversa aberta com esse contato nesse número, ou criar uma. Em grupo, dispensa a busca pelo JID.", required: false, defaultValue: "" },
                    { name: "user_id", type: "string", description: "Atribui o envio a um atendente (grava em sent_by). Se ele for membro da organização e o número tiver \"Identificar agente\" ligado, o nome dele vai em negrito no começo do texto, igual ao painel. Quem não é membro não trava o envio: sai sem autor e a resposta traz author_unresolved. Omitir (e omitir user_email) deixa a mensagem sem autor.", required: false, defaultValue: "" },
                    { name: "user_email", type: "string", description: "Mesmo efeito do user_id, achando o atendente pelo e-mail dele no Echo. Pessoa que não é membro da organização não trava o envio: a mensagem sai sem autor e a resposta traz author_unresolved. Com user_id junto, os dois precisam ser o mesmo membro, senão 400.", required: false, defaultValue: "atendente@empresa.com" },
                    { name: "typing_ms", type: "number", description: "Mostra \"digitando\" por N ms antes de enviar (máx 10000). Suportado em QR e Cloud API (se houver mensagem inbound prévia). Omitir mantém o envio idêntico ao de sempre, sem atraso.", required: false, defaultValue: "2500" },
                    { name: "mentions", type: "array", description: "Marca participantes do grupo. Aceita números com DDI (a API resolve o JID consultando os participantes) ou JIDs prontos. Só funciona em conversa de GRUPO de número QR — em Business API ou em 1:1 devolve 400. Número que não está no grupo volta em \"mentions_unresolved\" e o resto da menção sai normal. O WhatsApp só destaca a menção se o texto tiver o token \"@numero\": se ele não estiver na sua \"message\", a API acrescenta no fim (e grava o texto como foi enviado).", required: false, defaultValue: "" },
                    { name: "reply_to", type: "string", description: "Faz a mensagem sair como resposta a outra, citando-a. Aceita o UUID da mensagem no Echo ou o whatsapp_message_id que os envios devolvem. A mensagem citada precisa ser da mesma conversa (e já ter chegado ao WhatsApp), senão 400. Funciona em QR e Business API.", required: false, defaultValue: "" },
                    { name: "disparo", type: "boolean | object", description: "Marca o envio como disparo (mensagem em massa). A conversa que só recebeu disparo vai para a aba Disparos e só volta para as abas normais quando a pessoa responde ou alguém da equipe escreve; conversa já em atendimento não muda de lugar. Aceita true ou { rotulo, campanha, origem } (ex.: { \"rotulo\": \"Campanha · Convite\", \"campanha\": \"Evento Acme\" }).", required: false, defaultValue: "" },
                    { name: "ia", type: "boolean | object", description: "Marca o envio como fala de uma IA que está atendendo. A conversa sem dono vai para a aba Com a IA e fica lá mesmo quando a pessoa responde; volta para o time quando a IA a atribui (/conversations/:id/assign) ou alguém da equipe escreve. Se a pessoa escrever e a IA não responder em 10 minutos, a conversa volta para Aguardando. Conversa com dono não muda de lugar. Aceita true ou { origem, rotulo } (ex.: { \"origem\": \"bot-vendas\", \"rotulo\": \"Bot de vendas\" }).", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Mensagem enviada com sucesso" },
                    { status: 400, description: "Parâmetros inválidos, reply_to de outra conversa, mentions fora de grupo QR, ou user_id e user_email de pessoas diferentes" },
                ],
                responseFields: [
                    { name: "success", type: "boolean", description: "Sempre true em caso de envio aceito" },
                    { name: "whatsapp_message_id", type: "string", description: "ID da mensagem no WhatsApp (wamid...)" },
                    { name: "conversation_id", type: "string", description: "ID da conversa usada ou criada" },
                    { name: "conversation_created", type: "boolean", description: "true se a conversa foi criada por este envio" },
                    { name: "typing_applied", type: "boolean", description: "Presente apenas quando typing_ms foi enviado" },
                    { name: "mentions_unresolved", type: "array", description: "Presente apenas quando algum número de \"mentions\" não foi encontrado entre os participantes do grupo" },
                    { name: "author_unresolved", type: "boolean", description: "Presente apenas quando user_id ou user_email foi enviado e não é de um membro da organização: a mensagem saiu sem autor" },
                    { name: "message", type: "object", description: "A mensagem gravada no banco (content é o texto que saiu, com o nome do atendente quando ele foi colado)" },
                ],
                response: `{
  "success": true,
  "whatsapp_message_id": "wamid.xxx",
  "conversation_id": "uuid",
  "conversation_created": false,
  "message": { "id": "uuid", "content": "..." }
}

// Com typing_ms, a resposta ganha typing_applied
// (true se o indicador de digitação foi aplicado com sucesso).
// Com mentions, ganha mentions_unresolved quando algum número
// não está no grupo: ["5584911112222"]`,
            },
            {
                method: "POST",
                path: "/react",
                slug: "send-reaction",
                description: "Reage a uma mensagem com emoji",
                detailedDescription:
                    "Coloca (ou remove) a reação de emoji da SUA linha em cima de uma mensagem, igual ao aparelho. Funciona em QR e Business API, em conversa individual e em grupo.\n\nA mensagem é identificada por \"message_id\", que aceita o UUID interno do Echo ou o whatsapp_message_id que os endpoints de envio devolvem — e precisa pertencer a uma conversa do \"phone_number_id\" informado.\n\nMandar \"emoji\" vazio (ou omitir) REMOVE a reação. Cada linha tem uma reação por mensagem: reagir de novo substitui a anterior, não acumula.",
                bodyFields: [
                    { name: "message_id", type: "string", description: "Mensagem a reagir. Aceita o UUID no Echo ou o whatsapp_message_id.", required: true, defaultValue: "MESSAGE_UUID" },
                    { name: "phone_number_id", type: "string", description: "ID do número que reage (UUID interno ou Meta ID). A mensagem tem de estar numa conversa desse número.", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "emoji", type: "string", description: "O emoji da reação. Vazio ou omitido remove a reação existente.", required: false, defaultValue: "👍" },
                    { name: "user_id", type: "string", description: "Registra quem reagiu, para auditoria (reactor_user_id). Precisa ser membro da organização.", required: false, defaultValue: "" },
                    { name: "conversation_id", type: "string", description: "Desempata quando o mesmo whatsapp_message_id existe em mais de uma conversa do número (caso de linhas espelhadas). Só necessário se a API devolver 400 de id ambíguo.", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Reação enviada (ou removida, quando emoji vem vazio)" },
                    { status: 400, description: "Campos faltando, mensagem sem id do WhatsApp, message_id ambíguo, ou falha no envio" },
                    { status: 404, description: "Número não encontrado na organização, ou mensagem não encontrada nesse número" },
                    { status: 502, description: "Serviço QR inacessível" },
                ],
                responseFields: [
                    { name: "success", type: "boolean", description: "Sempre true quando a reação foi aceita" },
                    { name: "message_id", type: "string", description: "UUID da mensagem reagida no Echo" },
                    { name: "whatsapp_message_id", type: "string", description: "wamid da mensagem reagida" },
                    { name: "conversation_id", type: "string", description: "Conversa da mensagem reagida" },
                    { name: "emoji", type: "string", description: "Emoji aplicado, ou null quando a reação foi removida" },
                    { name: "removed", type: "boolean", description: "true quando a chamada removeu a reação" },
                ],
                response: `{
  "success": true,
  "message_id": "uuid",
  "whatsapp_message_id": "wamid.xxx",
  "conversation_id": "uuid",
  "emoji": "👍",
  "removed": false
}

// Para remover, mande emoji: "" — a resposta volta com
// "emoji": null e "removed": true.`,
            },
            {
                method: "POST",
                path: "/typing",
                slug: "send-typing",
                description: "Mostra \"digitando\" ao contato",
                detailedDescription: "Exibe o indicador de digitação no WhatsApp do contato, sem enviar mensagem nenhuma. Serve para cobrir o tempo real de processamento da sua integração (consulta, IA) — chame ANTES de começar o trabalho. No QR (Baileys), expira em ~10s (chame a cada ~8s ou envie state=\"paused\"). Na Cloud API (Meta Oficial), expira em até 25s e requer que o contato já tenha enviado ao menos uma mensagem anterior. Não cria conversa nem grava mensagem no banco.",
                bodyFields: [
                    { name: "to", type: "string", description: "Número do destinatário, ou JID do grupo (...@g.us)", required: true, defaultValue: "5584999999999" },
                    { name: "phone_number_id", type: "string", description: "ID do número remetente (UUID ou Meta ID)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "state", type: "string", description: "composing (padrão) | recording | paused", required: false, defaultValue: "composing" },
                ],
                responses: [
                    { status: 200, description: "Indicador enviado (ou success:false se a sessão estiver fora do ar ou sem inbound)" },
                    { status: 400, description: "Parâmetros inválidos ou state inválido" },
                    { status: 404, description: "Número não encontrado na organização" },
                    { status: 502, description: "Serviço QR inacessível ou erro da API Meta" },
                ],
                response: `{
  "success": true,
  "state": "composing",
  "expires_in_seconds": 10
}

// Em caso de indisponibilidade (sessão QR offline ou Cloud API sem inbound anterior),
// devolve 200 com success:false para não quebrar fluxos de bots:
// { "success": false, "reason": "session_unavailable" | "no_inbound_message" }`,
            },
            {
                method: "POST",
                path: "/send-template",
                slug: "send-template",
                modes: ["business_api"],
                description: "Envia template",
                detailedDescription: "Envia uma mensagem usando um template aprovado pelo WhatsApp.",
                bodyFields: [
                    { name: "to", type: "string", description: "Número do destinatário", required: true, defaultValue: "5584999999999" },
                    { name: "template_name", type: "string", description: "Nome do template", required: true, defaultValue: "hello_world" },
                    { name: "language_code", type: "string", description: "Código do idioma (ex: pt_BR)", required: false, defaultValue: "pt_BR" },
                    { name: "phone_number_id", type: "string", description: "ID do número remetente", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "body_parameters", type: "array | string", description: "Preenche {{1}}, {{2}}... Aceita array ou texto separado por ponto-e-vírgula", required: false, defaultValue: "João; 10:00" },
                    { name: "button_parameters", type: "array | string", description: "URLs dinâmicas. Aceita array ou texto separado por ponto-e-vírgula", required: false, defaultValue: "12345" },
                    { name: "components", type: "array", description: "Array de componentes cru da Meta, para o que body_parameters/button_parameters não cobrem (header com mídia, por exemplo). Tem precedência: se vier preenchido, os outros dois são ignorados.", required: false, defaultValue: "" },
                    { name: "disparo", type: "boolean | object", description: "Marca o envio como disparo (mensagem em massa). A conversa que só recebeu disparo vai para a aba Disparos e só volta para as abas normais quando a pessoa responde ou alguém da equipe escreve; conversa já em atendimento não muda de lugar. Aceita true ou { rotulo, campanha, origem } (ex.: { \"rotulo\": \"Campanha · Convite\", \"campanha\": \"Evento Acme\" }).", required: false, defaultValue: "" },
                    { name: "conversation_id", type: "string", description: "Envia dentro de uma conversa específica. Omitir faz o Echo achar ou criar uma.", required: false, defaultValue: "" },
                    { name: "user_id", type: "string", description: "Atribui o envio a um atendente (grava em sent_by).", required: false, defaultValue: "" },
                    { name: "ia", type: "boolean | object", description: "Marca o envio como fala de uma IA que está atendendo. A conversa sem dono vai para a aba Com a IA e fica lá mesmo quando a pessoa responde; volta para o time quando a IA a atribui (/conversations/:id/assign) ou alguém da equipe escreve. Se a pessoa escrever e a IA não responder em 10 minutos, a conversa volta para Aguardando. Conversa com dono não muda de lugar. Aceita true ou { origem, rotulo } (ex.: { \"origem\": \"bot-vendas\", \"rotulo\": \"Bot de vendas\" }).", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Template enviado com sucesso" },
                    { status: 400, description: "Template inválido ou parâmetros faltando" },
                ],
                response: `{
  "success": true,
  "whatsapp_message_id": "wamid.xxx",
  "conversation_id": "uuid",
  "conversation_created": false,
  "message": {
    "id": "uuid",
    "content": "...",
    "message_type": "template",
    "metadata": { "template_name": "hello_world", "language_code": "pt_BR" }
  }
}`,
            },
            {
                method: "POST",
                path: "/send-image",
                slug: "send-media",
                groupCaveat: true,
                description: "Envia mídia (imagem/vídeo/doc)",
                detailedDescription: "Envia mídia de duas formas: 1) JSON com media_url ou 2) multipart/form-data com arquivo (recomendado). ⚠️ Business API: A URL deve ser pública, retornar arquivo diretamente (não HTML), e ter SSL válido. URLs do Google Drive/Dropbox NÃO funcionam. Para maior compatibilidade, use upload de arquivo.",
                bodyFields: [
                    { name: "media_url", type: "string", description: "URL pública direta da mídia (não Drive/Dropbox)", required: false, defaultValue: "https://cdn.exemplo.com/imagem.jpg" },
                    { name: "to", type: "string", description: "Número do destinatário com DDI, ou JID do grupo (…@g.us) em números QR.", required: true, defaultValue: "5584999999999" },
                    { name: "phone_number_id", type: "string", description: "ID do número remetente (UUID ou Meta ID)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "caption", type: "string", description: "Legenda opcional para a mídia", required: false, defaultValue: "Veja esta imagem!" },
                    { name: "mime_type", type: "string", description: "Tipo MIME (ex: image/jpeg) - usado com media_url", required: false, defaultValue: "image/jpeg" },
                    { name: "filename", type: "string", description: "Nome do arquivo - usado com media_url", required: false, defaultValue: "foto.jpg" },
                    { name: "conversation_id", type: "string", description: "ID da conversa (auto-cria se não fornecido) Em grupo, dispensa a busca pelo JID.", required: false, defaultValue: "" },
                    { name: "user_id", type: "string", description: "ID do usuário enviando", required: false, defaultValue: "" },
                    { name: "file", type: "File", description: "Arquivo binário (usar com multipart/form-data)", required: false, defaultValue: "" },
                    { name: "reply_to", type: "string", description: "Faz a mídia sair como resposta a outra mensagem, citando-a. Aceita o UUID da mensagem no Echo ou o whatsapp_message_id devolvido nos envios. A citada precisa ser da mesma conversa e já ter chegado ao WhatsApp.", required: false, defaultValue: "" },
                    { name: "disparo", type: "boolean | object", description: "Marca o envio como disparo (mensagem em massa). A conversa que só recebeu disparo vai para a aba Disparos e só volta para as abas normais quando a pessoa responde ou alguém da equipe escreve; conversa já em atendimento não muda de lugar. Aceita true ou { rotulo, campanha, origem } (ex.: { \"rotulo\": \"Campanha · Convite\", \"campanha\": \"Evento Acme\" }). Só no envio por JSON (media_url).", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Mídia enviada com sucesso" },
                    { status: 400, description: "Campos obrigatórios faltando ou arquivo inválido" },
                    { status: 404, description: "Número de telefone não encontrado" },
                ],
                response: `// Envio via JSON com URL (recomendado):
// curl -X POST ".../send-image" -H "x-api-key: KEY" \\
//   -H "Content-Type: application/json" \\
//   -d '{"media_url":"https://...", "to":"5511...", "phone_number_id":"UUID"}'

{
  "success": true,
  "whatsapp_message_id": "wamid.xxx",
  "media_url": "https://...",
  "conversation_id": "uuid",
  "conversation_created": false,
  "message": {
    "id": "uuid",
    "content": "Legenda",
    "message_type": "image",
    "media_url": "https://...",
    "media_mime_type": "image/jpeg"
  }
}`,
            },
            {
                method: "POST",
                path: "/send-voice",
                slug: "send-voice",
                groupCaveat: true,
                modes: ["qr"],
                description: "Envia áudio como mensagem de voz (PTT)",
                detailedDescription: "Envia um áudio que aparece como mensagem de voz (push-to-talk), com a onda sonora, e não como arquivo anexado. Aceita qualquer formato de áudio — o serviço transcodifica para opus. Duas formas: JSON com media_url ou multipart/form-data com o arquivo.",
                bodyFields: [
                    { name: "to", type: "string", description: "Número do destinatário com DDI, ou JID do grupo (…@g.us).", required: true, defaultValue: "5584999999999" },
                    { name: "phone_number_id", type: "string", description: "ID do número remetente (UUID ou Meta ID)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "media_url", type: "string", description: "URL pública direta do áudio", required: false, defaultValue: "https://cdn.exemplo.com/audio.mp3" },
                    { name: "file", type: "File", description: "Arquivo binário (usar com multipart/form-data)", required: false, defaultValue: "" },
                    { name: "conversation_id", type: "string", description: "ID da conversa (auto-cria se não fornecido) Em grupo, dispensa a busca pelo JID.", required: false, defaultValue: "" },
                    { name: "user_id", type: "string", description: "Atribui o envio a um atendente (grava em sent_by).", required: false, defaultValue: "" },
                    { name: "mime_type", type: "string", description: "Tipo MIME do áudio — usado com media_url. Detectado automaticamente se omitido.", required: false, defaultValue: "audio/mpeg" },
                    { name: "filename", type: "string", description: "Nome do arquivo — usado com media_url.", required: false, defaultValue: "audio.mp3" },
                    { name: "reply_to", type: "string", description: "Faz o áudio sair como resposta a outra mensagem, citando-a. Aceita o UUID da mensagem no Echo ou o whatsapp_message_id devolvido nos envios. A citada precisa ser da mesma conversa e já ter chegado ao WhatsApp.", required: false, defaultValue: "" },
                    { name: "disparo", type: "boolean | object", description: "Marca o envio como disparo (mensagem em massa). A conversa que só recebeu disparo vai para a aba Disparos e só volta para as abas normais quando a pessoa responde ou alguém da equipe escreve; conversa já em atendimento não muda de lugar. Aceita true ou { rotulo, campanha, origem } (ex.: { \"rotulo\": \"Campanha · Convite\", \"campanha\": \"Evento Acme\" }). Só no envio por JSON (media_url).", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Áudio enviado com sucesso" },
                    { status: 400, description: "Campos faltando, áudio inválido ou número não é QR" },
                    { status: 404, description: "Número de telefone não encontrado" },
                ],
                response: `{
  "success": true,
  "whatsapp_message_id": "wamid.xxx",
  "conversation_id": "uuid",
  "message": {
    "id": "uuid",
    "message_type": "audio",
    "media_url": "https://..."
  }
}`,
            },
            {
                method: "POST",
                path: "/send-sticker",
                slug: "send-sticker",
                groupCaveat: true,
                description: "Envia figurinha (sticker)",
                detailedDescription:
                    "Envia uma figurinha. Três fontes, e uma delas é obrigatória:\n\n1. \"sticker_url\": se a URL já for um webp, ele é enviado como está; qualquer outra imagem (PNG, JPEG, GIF animado) é convertida para figurinha 512x512 dentro da spec do WhatsApp antes de sair.\n2. \"file\" em multipart/form-data: mesma regra do item 1.\n3. \"sticker_id\": uma figurinha da coleção de um usuário — exige \"user_id\", que precisa ser o dono dela.\n\nGIF animado vira figurinha animada (a conversão preserva os quadros). Figurinha não tem legenda: um \"caption\" seria ignorado, então o campo não existe aqui.\n\nEm números Business API a Meta só aceita figurinha dentro da spec (webp, 512x512, ≤100KB estática / ≤500KB animada) — imagem convertida por aqui já sai conforme; um webp pronto que estiver fora da spec é recusado pela Meta. Figurinha da coleção fora da spec devolve 400 antes de tentar.",
                bodyFields: [
                    { name: "to", type: "string", description: "Número do destinatário com DDI, ou JID do grupo (…@g.us) em números QR.", required: true, defaultValue: "5584999999999" },
                    { name: "phone_number_id", type: "string", description: "ID do número remetente (UUID interno ou Meta ID)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "sticker_url", type: "string", description: "URL pública direta de um webp (enviado como está) ou de uma imagem comum (convertida para figurinha). Exclui \"file\" e \"sticker_id\".", required: false, defaultValue: "https://cdn.exemplo.com/figurinha.webp" },
                    { name: "file", type: "File", description: "Arquivo binário da imagem ou webp (usar com multipart/form-data).", required: false, defaultValue: "" },
                    { name: "sticker_id", type: "string", description: "ID de uma figurinha na coleção de um usuário. Exige \"user_id\" e só funciona para o dono da figurinha.", required: false, defaultValue: "" },
                    { name: "conversation_id", type: "string", description: "Envia dentro de uma conversa específica. Omitir faz o Echo achar ou criar a conversa desse contato nesse número.", required: false, defaultValue: "" },
                    { name: "user_id", type: "string", description: "Atribui o envio a um atendente (grava em sent_by). Obrigatório quando se usa \"sticker_id\".", required: false, defaultValue: "" },
                    { name: "reply_to", type: "string", description: "Faz a figurinha sair como resposta a outra mensagem, citando-a. Aceita o UUID da mensagem no Echo ou o whatsapp_message_id devolvido nos envios. A citada precisa ser da mesma conversa e já ter chegado ao WhatsApp.", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Figurinha enviada com sucesso" },
                    { status: 400, description: "Campos faltando, sticker_id sem user_id, figurinha fora da spec em Business API, reply_to de outra conversa, ou falha no envio" },
                    { status: 404, description: "Número não encontrado na organização, ou figurinha não encontrada para esse user_id" },
                    { status: 422, description: "Imagem complexa demais para caber no limite de figurinha (mesmo na menor qualidade)" },
                    { status: 502, description: "Serviço QR inacessível (necessário para converter e para enviar em números QR)" },
                ],
                responseFields: [
                    { name: "success", type: "boolean", description: "Sempre true quando o envio foi aceito" },
                    { name: "whatsapp_message_id", type: "string", description: "ID da mensagem no WhatsApp" },
                    { name: "media_url", type: "string", description: "URL pública do webp que foi enviado" },
                    { name: "animated", type: "boolean", description: "true quando a figurinha é animada" },
                    { name: "conversation_id", type: "string", description: "Conversa usada ou criada" },
                    { name: "conversation_created", type: "boolean", description: "true se a conversa foi criada por este envio" },
                    { name: "message", type: "object", description: "A mensagem gravada no banco (message_type \"sticker\")" },
                ],
                response: `{
  "success": true,
  "whatsapp_message_id": "wamid.xxx",
  "media_url": "https://.../sticker.webp",
  "animated": false,
  "conversation_id": "uuid",
  "conversation_created": false,
  "message": {
    "id": "uuid",
    "content": "[Sticker]",
    "message_type": "sticker",
    "media_mime_type": "image/webp"
  }
}`,
            },
        ],
    },
    {
        category: "Agendamentos",
        icon: CalendarClock,
        description: "Programe mensagens para sair depois. O agendador roda a cada minuto; até a hora marcada o agendamento pode ser reagendado ou cancelado",
        items: [
            {
                method: "POST",
                path: "/scheduled-messages",
                slug: "create-scheduled-message",
                groupCaveat: true,
                description: "Agenda uma mensagem",
                detailedDescription:
                    "Cria um agendamento em vez de enviar na hora. O tipo é inferido do payload: mande \"message\" para texto livre (funciona em QR e Business API) ou \"template_name\" para template aprovado (só Business API). Mandar os dois devolve 400. Grupo (\"to\" terminando em @g.us) só existe em números QR — em Business API a criação já devolve 400, em vez de falhar horas depois na hora do envio.\n\nO destinatário vem de \"to\" ou de \"conversation_id\" — com conversation_id o \"to\" pode ser omitido.\n\nscheduled_at exige offset de fuso explícito — \"2026-08-20T15:00:00-03:00\" ou UTC com \"Z\". Um datetime sem offset é recusado com 400, porque a API não tem fuso de browser para resolver a ambiguidade. O horário mínimo é 60 segundos no futuro; para enviar agora use /send-message.",
                bodyFields: [
                    { name: "to", type: "string", description: "Número do destinatário com DDI, ou JID do grupo (…@g.us) em números QR. Obrigatório quando \"conversation_id\" não é informado.", required: false, defaultValue: "5584999999999" },
                    { name: "phone_number_id", type: "string", description: "ID do número remetente (UUID interno ou Meta ID)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "scheduled_at", type: "string", description: "Quando enviar. ISO 8601 com offset obrigatório (…-03:00) ou UTC (…Z). Mínimo 60s no futuro.", required: true, defaultValue: "2026-08-20T15:00:00-03:00" },
                    { name: "message", type: "string", description: "Texto da mensagem. Obrigatório quando não é template.", required: false, defaultValue: "Bom dia! Passando para confirmar." },
                    { name: "template_name", type: "string", description: "Nome do template aprovado. Obrigatório quando é template — e exclui \"message\". Só Business API.", required: false, defaultValue: "" },
                    { name: "language_code", type: "string", description: "Idioma do template. Só se aplica quando \"template_name\" é usado — texto livre ignora este campo.", required: false, defaultValue: "pt_BR" },
                    { name: "body_parameters", type: "array | string", description: "Preenche {{1}}, {{2}}… do template. Aceita array ou texto separado por ponto-e-vírgula.", required: false, defaultValue: "" },
                    { name: "button_parameters", type: "array | string", description: "Parâmetros de botão URL do template. Aceita array ou texto separado por ponto-e-vírgula.", required: false, defaultValue: "" },
                    { name: "header_media", type: "object", description: "Mídia do header do template: { format: IMAGE|VIDEO|DOCUMENT, link, filename? }", required: false, defaultValue: "" },
                    { name: "conversation_id", type: "string", description: "Agenda dentro de uma conversa específica — que precisa pertencer ao mesmo phone_number_id, senão 400. Quando informado, o destino sai da conversa e o \"to\" pode ser omitido (é ignorado se enviado). Omitir faz o Echo achar ou criar a conversa desse contato nesse número.", required: false, defaultValue: "" },
                    { name: "user_id", type: "string", description: "Atribui o agendamento a um atendente (grava em created_by). Precisa ser membro da organização.", required: false, defaultValue: "" },
                    { name: "quoted_message_id", type: "string", description: "Faz a mensagem sair como resposta a outra. Só em texto, e a mensagem citada precisa ser da mesma conversa.", required: false, defaultValue: "" },
                    { name: "mentions", type: "array", description: "JIDs a mencionar quando o destino é grupo em número QR.", required: false, defaultValue: "" },
                    { name: "contact_name", type: "string", description: "Nome exibido na listagem. Omitir usa o nome da conversa.", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 201, description: "Agendamento criado" },
                    { status: 400, description: "Campos faltando (nem \"to\" nem \"conversation_id\"), scheduled_at sem offset/no passado, template em número não-Business API, ou grupo (@g.us) em número não-QR" },
                    { status: 404, description: "Número, conversa ou usuário não encontrado na organização" },
                ],
                responseFields: [
                    { name: "success", type: "boolean", description: "Sempre true quando o agendamento foi criado" },
                    { name: "scheduled_message", type: "object", description: "A linha criada, incluindo id e status" },
                    { name: "conversation_id", type: "string", description: "Conversa usada ou criada" },
                    { name: "conversation_created", type: "boolean", description: "true se a conversa foi criada por este agendamento" },
                ],
                response: `{
  "success": true,
  "scheduled_message": {
    "id": "uuid",
    "status": "scheduled",
    "message_type": "text",
    "content": "Bom dia! Passando para confirmar.",
    "contact_phone": "5584999999999",
    "scheduled_at": "2026-08-20T18:00:00+00:00",
    "attempts": 0
  },
  "conversation_id": "uuid",
  "conversation_created": false
}

// scheduled_at sem offset é recusado:
// { "error": "scheduled_at is missing a timezone offset",
//   "example": "2026-08-20T15:00:00-03:00" }`,
            },
            {
                method: "GET",
                path: "/scheduled-messages",
                slug: "list-scheduled-messages",
                description: "Lista agendamentos",
                detailedDescription: "Lista os agendamentos da organização, do mais próximo para o mais distante. Sem filtro de status vêm todos, inclusive os já enviados e cancelados.\n\nmessage_type é \"text\", \"template\" ou \"media\". O \"media\" (arquivos agendados pelo painel) traz a lista em \"media\" ({ filename, mime_type, size_bytes, caption, whatsapp_message_id quando já saiu }) e \"content\" vazio; pela API só se cria texto ou template.",
                queryParams: [
                    { name: "status", type: "string", description: "scheduled | processing | sent | failed | cancelled", defaultValue: "scheduled" },
                    { name: "conversation_id", type: "string", description: "Só os agendamentos de uma conversa", defaultValue: "" },
                    { name: "phone_number_id", type: "string", description: "Só os de um número remetente (UUID ou Meta ID)", defaultValue: "" },
                    { name: "limit", type: "number", description: "Quantidade por página (máx 200)", defaultValue: "50" },
                    { name: "offset", type: "number", description: "Deslocamento para paginar", defaultValue: "0" },
                ],
                responses: [
                    { status: 200, description: "Lista retornada" },
                    { status: 400, description: "status inválido" },
                ],
                responseFields: [
                    { name: "scheduled_messages", type: "array", description: "Os agendamentos encontrados" },
                    { name: "limit", type: "number", description: "Limite aplicado" },
                    { name: "offset", type: "number", description: "Deslocamento aplicado" },
                ],
                response: `{
  "scheduled_messages": [
    {
      "id": "uuid",
      "status": "scheduled",
      "message_type": "text",
      "content": "Bom dia!",
      "contact_phone": "5584999999999",
      "contact_name": "Maria",
      "scheduled_at": "2026-08-20T18:00:00+00:00",
      "attempts": 0,
      "error_message": null
    }
  ],
  "limit": 50,
  "offset": 0
}`,
            },
            {
                method: "GET",
                path: "/scheduled-messages/{id}",
                slug: "get-scheduled-message",
                description: "Detalha um agendamento",
                detailedDescription: "Retorna um agendamento específico. Útil para conferir o desfecho: status, whatsapp_message_id quando enviado, e error_message quando falhou.",
                pathParams: [
                    { name: "id", type: "string", description: "ID do agendamento", required: true, defaultValue: "SCHEDULED_MESSAGE_UUID" },
                ],
                responses: [
                    { status: 200, description: "Agendamento retornado" },
                    { status: 404, description: "Não encontrado na organização" },
                ],
                response: `{
  "scheduled_message": {
    "id": "uuid",
    "status": "sent",
    "scheduled_at": "2026-08-20T18:00:00+00:00",
    "sent_at": "2026-08-20T18:00:07+00:00",
    "whatsapp_message_id": "wamid.xxx",
    "attempts": 1,
    "error_message": null
  }
}`,
            },
            {
                method: "PATCH",
                path: "/scheduled-messages/{id}",
                slug: "update-scheduled-message",
                description: "Reagenda ou edita",
                detailedDescription:
                    "Altera um agendamento que ainda não saiu. Só funciona enquanto o status é \"scheduled\": depois que o agendador pegou a linha, a resposta é 409 com o status atual — \"já foi enviada\" e \"não existe\" são problemas diferentes.\n\nEm agendamento de texto você edita \"message\"; em template, body_parameters e button_parameters; em arquivo (\"media\"), só o horário. Trocar o tipo não é possível — cancele e crie outro.",
                pathParams: [
                    { name: "id", type: "string", description: "ID do agendamento", required: true, defaultValue: "SCHEDULED_MESSAGE_UUID" },
                ],
                bodyFields: [
                    { name: "scheduled_at", type: "string", description: "Novo horário. Mesmas regras do POST: offset obrigatório e mínimo 60s no futuro.", required: false, defaultValue: "2026-08-20T16:30:00-03:00" },
                    { name: "message", type: "string", description: "Novo texto (só em agendamento de texto)", required: false, defaultValue: "" },
                    { name: "body_parameters", type: "array | string", description: "Novos parâmetros de corpo (só em template)", required: false, defaultValue: "" },
                    { name: "button_parameters", type: "array | string", description: "Novos parâmetros de botão (só em template)", required: false, defaultValue: "" },
                    { name: "contact_name", type: "string", description: "Nome exibido na listagem", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Agendamento atualizado" },
                    { status: 400, description: "Nada para atualizar, campo incompatível com o tipo, ou scheduled_at inválido" },
                    { status: 404, description: "Não encontrado na organização" },
                    { status: 409, description: "Já saiu de \"scheduled\" (enviado, cancelado, em processamento)" },
                ],
                response: `{
  "success": true,
  "scheduled_message": {
    "id": "uuid",
    "status": "scheduled",
    "scheduled_at": "2026-08-20T19:30:00+00:00"
  }
}

// Se o agendador já pegou a linha:
// 409 { "error": "Scheduled message can no longer be edited",
//       "status": "processing" }`,
            },
            {
                method: "DELETE",
                path: "/scheduled-messages/{id}",
                slug: "cancel-scheduled-message",
                description: "Cancela um agendamento",
                detailedDescription:
                    "Cancelamento lógico: a linha vira status=\"cancelled\" e continua consultável, igual ao painel. Não remove nada — o histórico de \"isso ia ser enviado e foi cancelado\" fica.\n\nSó vale enquanto o status é \"scheduled\". Cancelar algo já enviado ou já cancelado devolve 409.",
                pathParams: [
                    { name: "id", type: "string", description: "ID do agendamento", required: true, defaultValue: "SCHEDULED_MESSAGE_UUID" },
                ],
                responses: [
                    { status: 200, description: "Agendamento cancelado" },
                    { status: 404, description: "Não encontrado na organização" },
                    { status: 409, description: "Já saiu de \"scheduled\" (enviado, cancelado, em processamento)" },
                ],
                response: `{
  "success": true,
  "scheduled_message": {
    "id": "uuid",
    "status": "cancelled"
  }
}`,
            },
        ],
    },
    {
        category: "Disparos",
        icon: Megaphone,
        description: "Envie um template aprovado para uma lista de contatos. O motor entrega em segundo plano — a criação devolve na hora e o progresso é consultado depois",
        items: [
            {
                method: "POST",
                path: "/broadcasts",
                slug: "create-broadcast",
                modes: ["business_api"],
                description: "Cria um disparo",
                detailedDescription:
                    "Cria um disparo de template para até 5.000 contatos numa chamada. Só Business API: disparo é template puro pela Cloud API, e número QR não tem esse caminho — a criação devolve 400 em vez de falhar destinatário por destinatário horas depois.\n\nVocê manda só \"template_name\": a API busca o template aprovado na Meta no idioma pedido e deriva sozinha o id, os componentes e quantas variáveis o corpo e os botões esperam. Se o template não existe, não está aprovado ou não existe nesse idioma, a resposta é 400 (com os idiomas disponíveis) e nada é gravado.\n\n\"variables\" é UM array posicional por contato: primeiro as do corpo ({{1}}, {{2}}…), depois as dos botões URL com variável, nessa ordem. O tamanho tem de bater exatamente com o que o template pede — divergência devolve 400 apontando o índice do contato, porque a alternativa é a Meta recusar as 5.000 mensagens uma a uma.\n\nSem \"scheduled_at\" o disparo começa imediatamente. Com \"scheduled_at\" (ISO 8601 com offset explícito, mínimo 60s no futuro) ele fica agendado e o cron pega na hora.\n\nTelefone: com \"+\" os dígitos são tratados como número internacional completo e nada é acrescentado; sem \"+\", um número de 10-11 dígitos é assumido brasileiro e ganha o 55. Contatos repetidos na lista são deduplicados (o total vem em \"duplicates_skipped\").",
                bodyFields: [
                    { name: "name", type: "string", description: "Nome da campanha, como aparece na listagem", required: true, defaultValue: "Campanha — Lote 1" },
                    { name: "phone_number_id", type: "string", description: "ID do número remetente (UUID interno ou Meta ID). Precisa ser Business API.", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "template_name", type: "string", description: "Nome do template aprovado. Os componentes e a contagem de variáveis são buscados na Meta.", required: true, defaultValue: "convite_evento" },
                    { name: "recipients", type: "array", description: "Lista de { phone_number, contact_name?, variables? }. Máximo 5.000 por chamada.", required: true, defaultValue: "" },
                    { name: "language_code", type: "string", description: "Idioma do template. Tem de ser um idioma em que o template está aprovado.", required: false, defaultValue: "pt_BR" },
                    { name: "scheduled_at", type: "string", description: "Quando disparar. ISO 8601 com offset obrigatório (…-03:00) ou UTC (…Z), mínimo 60s no futuro. Omitir dispara agora.", required: false, defaultValue: "" },
                    { name: "header_media", type: "object", description: "Mídia do header: { format: IMAGE|VIDEO|DOCUMENT, link, filename? }. Obrigatório se o template tem header de mídia, e recusado se não tem.", required: false, defaultValue: "" },
                    { name: "user_id", type: "string", description: "Atribui a campanha a um atendente (grava em created_by). Precisa ser membro da organização.", required: false, defaultValue: "" },
                ],
                body: `{
  "name": "Campanha — Lote 1",
  "phone_number_id": "PHONE_NUMBER_UUID",
  "template_name": "convite_evento",
  "language_code": "pt_BR",
  "recipients": [
    { "phone_number": "5584999999999", "contact_name": "Ana", "variables": ["Ana", "18h"] },
    { "phone_number": "+34612345678", "contact_name": "Bruno", "variables": ["Bruno", "18h"] }
  ]
}`,
                responses: [
                    { status: 201, description: "Disparo criado e já em processamento (ou agendado)" },
                    { status: 400, description: "Campos faltando, número não-Business API, template inexistente/não aprovado/idioma errado, contagem de variáveis divergente, header_media faltando ou sobrando, telefone inválido, ou mais de 5.000 contatos" },
                    { status: 404, description: "Número ou usuário não encontrado na organização" },
                    { status: 413, description: "Corpo da requisição acima de 6 MB" },
                    { status: 500, description: "Credenciais WhatsApp ausentes, ou lista gravada só parcialmente (o disparo fica como draft e não envia nada)" },
                ],
                responseFields: [
                    { name: "success", type: "boolean", description: "Sempre true quando o disparo foi criado" },
                    { name: "broadcast", type: "object", description: "A campanha criada, já com o status final da criação" },
                    { name: "recipients_created", type: "number", description: "Contatos gravados na fila" },
                    { name: "duplicates_skipped", type: "number", description: "Contatos repetidos que foram descartados" },
                ],
                response: `{
  "success": true,
  "broadcast": {
    "id": "uuid",
    "name": "Campanha — Lote 1",
    "status": "processing",
    "template_name": "convite_evento",
    "template_language": "pt_BR",
    "body_variable_count": 2,
    "button_variable_count": 0,
    "total_recipients": 2,
    "sent_count": 0,
    "failed_count": 0,
    "scheduled_at": null
  },
  "recipients_created": 2,
  "duplicates_skipped": 0
}

// Contagem de variáveis divergente aponta o contato:
// { "error": "Wrong number of variables for this template",
//   "recipient_index": 41, "expected": 2, "received": 1 }`,
            },
            {
                method: "GET",
                path: "/broadcasts",
                slug: "list-broadcasts",
                modes: ["business_api"],
                description: "Lista disparos",
                detailedDescription: "Lista as campanhas da organização, da mais recente para a mais antiga, com os contadores de progresso. Um disparo em \"draft\" é uma criação que não terminou (timeout no meio da gravação da lista): ele não envia nada e pode ser apagado com DELETE.",
                queryParams: [
                    { name: "status", type: "string", description: "draft | scheduled | processing | completed | failed | cancelled", defaultValue: "processing" },
                    { name: "phone_number_id", type: "string", description: "Só os de um número remetente (UUID ou Meta ID)", defaultValue: "" },
                    { name: "limit", type: "number", description: "Quantidade por página (máx 200)", defaultValue: "50" },
                    { name: "offset", type: "number", description: "Deslocamento para paginar", defaultValue: "0" },
                ],
                responses: [
                    { status: 200, description: "Lista retornada" },
                    { status: 400, description: "status inválido" },
                    { status: 404, description: "phone_number_id não encontrado" },
                ],
                responseFields: [
                    { name: "broadcasts", type: "array", description: "As campanhas encontradas" },
                    { name: "limit", type: "number", description: "Limite aplicado" },
                    { name: "offset", type: "number", description: "Deslocamento aplicado" },
                ],
                response: `{
  "broadcasts": [
    {
      "id": "uuid",
      "name": "Campanha — Lote 1",
      "status": "completed",
      "total_recipients": 1240,
      "sent_count": 1231,
      "failed_count": 9,
      "started_at": "2026-08-28T12:00:04+00:00",
      "completed_at": "2026-08-28T12:07:41+00:00"
    }
  ],
  "limit": 50,
  "offset": 0
}`,
            },
            {
                method: "GET",
                path: "/broadcasts/{id}",
                slug: "get-broadcast",
                modes: ["business_api"],
                description: "Consulta um disparo",
                detailedDescription: "Retorna a campanha com os contadores de progresso (total_recipients, sent_count, failed_count) — é por aqui que se acompanha um disparo em andamento. Os contadores são mantidos pelo banco, não pela resposta do envio, então valem mesmo se o processo de entrega for reiniciado no meio.",
                pathParams: [
                    { name: "id", type: "string", description: "ID do disparo", required: true, defaultValue: "BROADCAST_UUID" },
                ],
                responses: [
                    { status: 200, description: "Disparo retornado" },
                    { status: 404, description: "Não encontrado na organização" },
                ],
                responseFields: [
                    { name: "broadcast", type: "object", description: "A campanha, incluindo status e contadores" },
                ],
                response: `{
  "broadcast": {
    "id": "uuid",
    "name": "Campanha — Lote 1",
    "status": "processing",
    "template_name": "convite_evento",
    "total_recipients": 1240,
    "sent_count": 380,
    "failed_count": 2
  }
}`,
            },
            {
                method: "GET",
                path: "/broadcasts/{id}/recipients",
                slug: "list-broadcast-recipients",
                modes: ["business_api"],
                description: "Lista os contatos de um disparo",
                detailedDescription: "Lista contato por contato, com status, wamid e o motivo da falha quando houve. Filtrar por status=\"failed\" é o caminho para descobrir o que não saiu e por quê antes de chamar o retry.",
                pathParams: [
                    { name: "id", type: "string", description: "ID do disparo", required: true, defaultValue: "BROADCAST_UUID" },
                ],
                queryParams: [
                    { name: "status", type: "string", description: "pending | sending | sent | failed", defaultValue: "failed" },
                    { name: "limit", type: "number", description: "Quantidade por página (máx 500)", defaultValue: "100" },
                    { name: "offset", type: "number", description: "Deslocamento para paginar", defaultValue: "0" },
                ],
                responses: [
                    { status: 200, description: "Lista retornada" },
                    { status: 400, description: "status inválido" },
                    { status: 404, description: "Disparo não encontrado na organização" },
                ],
                responseFields: [
                    { name: "recipients", type: "array", description: "Os contatos do disparo" },
                    { name: "limit", type: "number", description: "Limite aplicado" },
                    { name: "offset", type: "number", description: "Deslocamento aplicado" },
                ],
                response: `{
  "recipients": [
    {
      "id": "uuid",
      "phone_number": "5584999999999",
      "contact_name": "Ana",
      "variables": ["Ana", "18h"],
      "status": "sent",
      "whatsapp_message_id": "wamid...",
      "sent_at": "2026-08-28T12:00:09+00:00",
      "error_message": null,
      "attempts": 1
    }
  ],
  "limit": 100,
  "offset": 0
}`,
            },
            {
                method: "DELETE",
                path: "/broadcasts/{id}",
                slug: "cancel-broadcast",
                modes: ["business_api"],
                description: "Cancela um disparo",
                detailedDescription:
                    "Cancela a campanha e ESVAZIA a fila na mesma operação: os contatos que ainda não saíram são marcados como falha com o motivo \"Disparo cancelado\". Esvaziar a fila é o que efetivamente para o motor — só marcar a campanha como cancelada deixaria os contatos pendentes para sempre.\n\nGarantia: nenhuma mensagem nova sai a partir do retorno. Mensagens já reivindicadas por um processo em andamento (até ~45s) ainda podem ser entregues.\n\nSó vale em \"draft\", \"scheduled\" e \"processing\". Um disparo já concluído, falho ou cancelado devolve 409. Em \"draft\" (criação que não terminou, que nunca enviou nada) a campanha é apagada de verdade em vez de ficar como cancelada.",
                pathParams: [
                    { name: "id", type: "string", description: "ID do disparo", required: true, defaultValue: "BROADCAST_UUID" },
                ],
                responses: [
                    { status: 200, description: "Disparo cancelado (ou draft apagado)" },
                    { status: 404, description: "Não encontrado na organização" },
                    { status: 409, description: "Já concluído, falho ou cancelado" },
                ],
                responseFields: [
                    { name: "success", type: "boolean", description: "Sempre true quando o cancelamento foi aplicado" },
                    { name: "broadcast_id", type: "string", description: "A campanha afetada" },
                    { name: "cancelled_from", type: "string", description: "Status que a campanha tinha antes do cancelamento" },
                    { name: "recipients_drained", type: "number", description: "Contatos que estavam na fila e não serão mais enviados" },
                ],
                response: `{
  "success": true,
  "broadcast_id": "uuid",
  "cancelled_from": "processing",
  "recipients_drained": 860,
  "note": "No new message is sent from now on. Messages already claimed by a running worker (up to ~45s) may still be delivered."
}`,
            },
            {
                method: "POST",
                path: "/broadcasts/{id}/retry",
                slug: "retry-broadcast",
                modes: ["business_api"],
                description: "Reenvia os contatos que falharam",
                detailedDescription: "Devolve para a fila todos os contatos em status \"failed\" e reabre a campanha — as tentativas são zeradas, então cada contato tem o mesmo orçamento de retentativas de um envio novo. Contatos que já saíram (\"sent\") não são tocados: ninguém recebe duas vezes.\n\nSó vale em campanha terminal (\"completed\" ou \"failed\"). Em \"scheduled\", \"draft\", \"processing\" ou \"cancelled\" devolve 409 — retentar um agendamento dispararia a campanha inteira adiantada, e retentar um cancelado ressuscitaria o que alguém acabou de parar.",
                pathParams: [
                    { name: "id", type: "string", description: "ID do disparo", required: true, defaultValue: "BROADCAST_UUID" },
                ],
                responses: [
                    { status: 200, description: "Contatos reenfileirados e campanha reaberta" },
                    { status: 404, description: "Não encontrado na organização" },
                    { status: 409, description: "Campanha não é terminal, ou não há contato falho para reenviar" },
                ],
                responseFields: [
                    { name: "success", type: "boolean", description: "Sempre true quando o reenvio foi enfileirado" },
                    { name: "requeued", type: "number", description: "Contatos devolvidos para a fila" },
                ],
                response: `{
  "success": true,
  "requeued": 9
}`,
            },
        ],
    },
    {
        category: "Templates",
        icon: FileText,
        description: "Consulte e crie templates do WhatsApp",
        items: [
            {
                method: "GET",
                path: "/templates",
                slug: "list-templates",
                description: "Lista templates",
                detailedDescription: "Retorna todos os templates de mensagem da organização. Requer um número de telefone para buscar as credenciais WABA.",
                queryParams: [
                    { name: "phone_number_id", type: "string", description: "ID do número de telefone (obrigatório)", required: true, defaultValue: "PHONE_NUMBER_UUID" },
                    { name: "status", type: "string", description: "Filtrar por status do template", required: false, defaultValue: "APPROVED" },
                    { name: "name", type: "string", description: "Um template pelo nome exato, em qualquer status (PENDING, APPROVED, REJECTED com rejected_reason). Ignora status.", required: false },
                ],
                responses: [
                    { status: 200, description: "Lista de templates retornada" },
                    { status: 400, description: "phone_number_id não fornecido" },
                    { status: 404, description: "Credenciais WhatsApp não encontradas" },
                ],
                response: `{
  "templates": [
    {
      "name": "hello_world",
      "status": "APPROVED",
      "language": "pt_BR",
      "components": [...]
    }
  ],
  "count": 1
}`,
            },
            {
                method: "POST",
                path: "/templates",
                slug: "create-template",
                description: "Cria template de texto",
                modes: ["business_api"],
                detailedDescription: "Manda um template de texto para a análise da Meta, na conta WABA do número informado. A resposta traz o status inicial (em geral PENDING); acompanhe com GET /templates?name=. Header de mídia não entra por aqui.",
                bodyFields: [
                    { name: "phone_number_id", type: "string", description: "ID do número (UUID ou ID da Meta) cuja conta recebe o template", required: true },
                    { name: "name", type: "string", description: "Só letras minúsculas, números e sublinhado. A Meta recusa nome repetido.", required: true },
                    { name: "language", type: "string", description: "Idioma, ex.: pt_BR", required: true },
                    { name: "category", type: "string", description: "MARKETING ou UTILITY", required: true },
                    { name: "components", type: "array", description: "Componentes no formato da Meta; precisa de um BODY com text (e example.body_text quando tem {{1}}). BUTTONS de QUICK_REPLY sem emoji.", required: true },
                ],
                body: `{
  "phone_number_id": "PHONE_NUMBER_UUID",
  "name": "boas_vindas_cliente",
  "language": "pt_BR",
  "category": "MARKETING",
  "components": [
    { "type": "BODY", "text": "Olá, {{1}}! Que bom ter você.", "example": { "body_text": [["Mariana"]] } }
  ]
}`,
                responses: [
                    { status: 201, description: "Template enviado para a análise da Meta" },
                    { status: 400, description: "Campo inválido ou recusa imediata da Meta (a mensagem dela vem em error)" },
                    { status: 404, description: "Credenciais WhatsApp não encontradas" },
                ],
                response: `{
  "template": { "id": "1234567890", "name": "boas_vindas_cliente", "status": "PENDING", "category": "MARKETING" }
}`,
            },
        ],
    },
    {
        category: "Números de Telefone",
        icon: Phone,
        description: "Gerencie números do WhatsApp",
        items: [
            {
                method: "GET",
                path: "/phone-numbers",
                slug: "list-phone-numbers",
                description: "Lista números",
                detailedDescription: "Retorna todos os números de telefone da organização.",
                responses: [{ status: 200, description: "Lista de números retornada" }],
                response: `{
  "phone_numbers": [
    {
      "id": "uuid",
      "phone_number": "5584999999999",
      "phone_number_id": "META_ID",
      "display_name": "Atendimento",
      "theme_hue": 15,
      "is_active": true
    }
  ]
}`,
            },
            {
                method: "GET",
                path: "/phone-numbers/:id",
                slug: "get-phone-number",
                description: "Busca número",
                detailedDescription: "Retorna um número de telefone específico pelo ID.",
                pathParams: [{ name: "id", type: "string", description: "ID do número", required: true, defaultValue: "PHONE_UUID" }],
                responses: [
                    { status: 200, description: "Número retornado" },
                    { status: 404, description: "Número não encontrado" },
                ],
                response: `{ "phone_number": { "id": "uuid", ... } }`,
            },
            {
                method: "POST",
                path: "/phone-numbers",
                slug: "create-phone-number",
                description: "Cadastra número",
                // organization_id NÃO entra aqui: o handler desestrutura só os
                // campos abaixo e sempre usa a org da API key ("Always use
                // organizationId from API key, not from body").
                detailedDescription: "Cadastra um novo número de telefone do WhatsApp Business. A organização é definida automaticamente pela API key — não envie organization_id, ele é ignorado.",
                bodyFields: [
                    { name: "phone_number", type: "string", description: "Número de telefone completo", required: true, defaultValue: "5584999999999" },
                    { name: "phone_number_id", type: "string", description: "ID do número na API do WhatsApp (Meta)", required: true, defaultValue: "META_PHONE_NUMBER_ID" },
                    { name: "display_name", type: "string", description: "Nome de exibição", required: true, defaultValue: "Vendas" },
                    { name: "theme_hue", type: "integer", description: "Cor do tema (0-360)", required: false, defaultValue: "15" },
                    { name: "is_active", type: "boolean", description: "Se o número está ativo", required: false, defaultValue: "true" },
                ],
                responses: [
                    { status: 201, description: "Número cadastrado com sucesso" },
                    { status: 400, description: "Dados inválidos" },
                ],
                response: `{ "phone_number": { "id": "uuid", ... } }`,
            },
            {
                method: "PATCH",
                path: "/phone-numbers/:id",
                slug: "update-phone-number",
                description: "Atualiza número",
                detailedDescription: "Atualiza informações de um número de telefone.",
                pathParams: [{ name: "id", type: "string", description: "ID do número", required: true, defaultValue: "PHONE_UUID" }],
                bodyFields: [
                    { name: "display_name", type: "string", description: "Nome de exibição", required: false, defaultValue: "Suporte" },
                    { name: "theme_hue", type: "integer", description: "Cor do tema (0-360)", required: false, defaultValue: "200" },
                    { name: "is_active", type: "boolean", description: "Se o número está ativo", required: false, defaultValue: "true" },
                ],
                responses: [
                    { status: 200, description: "Número atualizado" },
                    { status: 400, description: "Erro na atualização" },
                ],
                response: `{ "phone_number": { "id": "uuid", ... } }`,
            },
            {
                method: "DELETE",
                path: "/phone-numbers/:id",
                slug: "delete-phone-number",
                description: "Remove número",
                detailedDescription: "Remove um número de telefone do sistema.",
                pathParams: [{ name: "id", type: "string", description: "ID do número", required: true, defaultValue: "PHONE_UUID" }],
                responses: [
                    { status: 200, description: "Número removido" },
                    { status: 400, description: "Erro ao remover" },
                ],
                response: `{ "message": "Phone number deleted" }`,
            },
        ],
    },
    {
        category: "Tags",
        icon: Tag,
        description: "Organize conversas com tags",
        items: [
            {
                method: "GET",
                path: "/tags",
                slug: "list-tags",
                description: "Lista tags",
                detailedDescription: "Retorna todas as tags da organização.",
                responses: [{ status: 200, description: "Lista de tags retornada" }],
                response: `{
  "tags": [
    {
      "id": "uuid",
      "name": "Urgente",
      "color": "#ff0000",
      "organization_id": "uuid"
    }
  ]
}`,
            },
            {
                method: "GET",
                path: "/tags/:id",
                slug: "get-tag",
                description: "Busca tag",
                detailedDescription: "Retorna uma tag específica pelo ID.",
                pathParams: [{ name: "id", type: "string", description: "ID da tag", required: true, defaultValue: "TAG_UUID" }],
                responses: [
                    { status: 200, description: "Tag retornada" },
                    { status: 404, description: "Tag não encontrada" },
                ],
                response: `{ "tag": { "id": "uuid", "name": "Urgente", "color": "#ff0000" } }`,
            },
            {
                method: "POST",
                path: "/tags",
                slug: "create-tag",
                description: "Cria tag",
                detailedDescription: "Cria uma nova tag para categorização. A organization_id é definida automaticamente pela API key.",
                bodyFields: [
                    { name: "name", type: "string", description: "Nome da tag", required: true, defaultValue: "VIP" },
                    { name: "user_id", type: "string", description: "ID do usuário criador", required: true, defaultValue: "USER_UUID" },
                    { name: "color", type: "string", description: "Cor hexadecimal", required: false, defaultValue: "#FFD700" },
                ],
                responses: [
                    { status: 201, description: "Tag criada com sucesso" },
                    { status: 400, description: "Campos obrigatórios faltando" },
                ],
                response: `{ "tag": { "id": "uuid", ... } }`,
            },
            {
                method: "PATCH",
                path: "/tags/:id",
                slug: "update-tag",
                description: "Atualiza tag",
                detailedDescription: "Atualiza nome ou cor de uma tag.",
                pathParams: [{ name: "id", type: "string", description: "ID da tag", required: true, defaultValue: "TAG_UUID" }],
                bodyFields: [
                    { name: "name", type: "string", description: "Novo nome da tag", required: false, defaultValue: "Premium" },
                    { name: "color", type: "string", description: "Nova cor hexadecimal", required: false, defaultValue: "#00FF00" },
                ],
                responses: [
                    { status: 200, description: "Tag atualizada" },
                    { status: 400, description: "Erro na atualização" },
                ],
                response: `{ "tag": { "id": "uuid", ... } }`,
            },
            {
                method: "DELETE",
                path: "/tags/:id",
                slug: "delete-tag",
                description: "Remove tag",
                detailedDescription: "Remove uma tag do sistema.",
                pathParams: [{ name: "id", type: "string", description: "ID da tag", required: true, defaultValue: "TAG_UUID" }],
                responses: [
                    { status: 200, description: "Tag removida" },
                    { status: 400, description: "Erro ao remover" },
                ],
                response: `{ "message": "Tag deleted" }`,
            },
            {
                method: "POST",
                path: "/conversations/:id/tags",
                slug: "add-conversation-tag",
                description: "Adiciona tag à conversa",
                detailedDescription: "Associa uma tag existente a uma conversa.",
                pathParams: [{ name: "id", type: "string", description: "ID da conversa", required: true, defaultValue: "CONVERSATION_ID" }],
                bodyFields: [{ name: "tag_id", type: "string", description: "ID da tag", required: true, defaultValue: "TAG_UUID" }],
                responses: [
                    { status: 200, description: "Tag adicionada com sucesso" },
                    { status: 404, description: "Conversa ou tag não encontrada" },
                ],
                response: `{ "success": true }`,
            },
            {
                method: "DELETE",
                path: "/conversations/:id/tags",
                slug: "remove-conversation-tag",
                description: "Remove tag da conversa",
                // A tag vai na QUERY, não como 5º segmento do path: o handler lê
                // url.searchParams.get('tag_id') e devolve 400 sem ele.
                detailedDescription: "Remove a associação entre uma tag e uma conversa. O ID da tag vai na query string, não no path.",
                pathParams: [
                    { name: "id", type: "string", description: "ID da conversa", required: true, defaultValue: "CONVERSATION_ID" },
                ],
                queryParams: [
                    { name: "tag_id", type: "string", description: "ID da tag a remover", required: true, defaultValue: "TAG_UUID" },
                ],
                responses: [
                    { status: 200, description: "Tag removida com sucesso" },
                    { status: 400, description: "tag_id não informado na query" },
                    { status: 404, description: "Associação não encontrada" },
                ],
                response: `{ "message": "Tag removed" }`,
            },
        ],
    },
    {
        category: "Motivos de Encerramento",
        icon: X,
        description: "Configure motivos de encerramento",
        items: [
            {
                method: "GET",
                path: "/close-reasons",
                slug: "list-close-reasons",
                description: "Lista motivos",
                detailedDescription: "Retorna todos os motivos de encerramento da organização.",
                responses: [{ status: 200, description: "Lista de motivos retornada" }],
                response: `{
  "close_reasons": [
    {
      "id": "uuid",
      "name": "Problema resolvido",
      "organization_id": "uuid"
    }
  ]
}`,
            },
            {
                method: "POST",
                path: "/close-reasons",
                slug: "create-close-reason",
                description: "Cria motivo",
                detailedDescription: "Cria um novo motivo de encerramento. A organization_id é definida automaticamente pela API key.",
                bodyFields: [
                    { name: "name", type: "string", description: "Descrição do motivo", required: true, defaultValue: "Cliente desistiu" },
                    { name: "user_id", type: "string", description: "ID do usuário criador", required: true, defaultValue: "USER_UUID" },
                ],
                responses: [
                    { status: 201, description: "Motivo criado com sucesso" },
                    { status: 400, description: "Campos obrigatórios faltando" },
                ],
                response: `{ "close_reason": { "id": "uuid", ... } }`,
            },
            {
                method: "DELETE",
                path: "/close-reasons/:id",
                slug: "delete-close-reason",
                description: "Remove motivo",
                detailedDescription: "Remove um motivo de encerramento do sistema.",
                pathParams: [{ name: "id", type: "string", description: "ID do motivo", required: true, defaultValue: "REASON_UUID" }],
                responses: [
                    { status: 200, description: "Motivo removido" },
                    { status: 400, description: "Erro ao remover" },
                ],
                response: `{ "message": "Close reason deleted" }`,
            },
        ],
    },
];

// ─── QR Service Endpoints ────────────────────────────────────────────────────
//
// Superfície INTERNA. Outro host (Node/Express hospedado à parte), não uma edge
// function, e o middleware só lê `Authorization: Bearer` — a `x-api-key` do
// usuário não é sequer lida ali. As duas credenciais que ele aceita (JWT de
// sessão Supabase, service-role key) não podem ser entregues a um integrador
// externo, então estes endpoints são documentados como server-to-server.

/**
 * Aviso da superfície interna.
 *
 * Estas rotas exigem `Authorization: Bearer` (JWT de sessão ou service role). A
 * `x-api-key` do integrador não é lida pelo serviço, então exemplos que a usem
 * devolvem 401.
 */
export const INTERNAL_SURFACE_NOTICE =
    "Superfície interna, server-to-server. Roda em outro host e autentica com Authorization: Bearer — um JWT de sessão do Echo ou a chave de serviço (service role). A sua API Key (x-api-key) não vale aqui: o header nem chega a ser lido. Nunca chame estas rotas do navegador nem exponha essas credenciais no cliente.";

/** Complemento quando NÃO existe equivalente público. */
export const INTERNAL_NO_EQUIVALENT_NOTICE =
    "Ainda não há um equivalente na Echo API para esta operação — ela só é alcançável a partir do seu próprio servidor.";

/**
 * Aviso nos endpoints de envio que aceitam JID de grupo.
 *
 * Histórico, porque o texto já esteve errado: até o fix de
 * `findOrCreateConversation`, o JID passava por `normalize_phone` (que faz
 * `regexp_replace(phone,'\D','','g')`) e a conversa era inserida sem
 * `is_group` — o trigger `trg_normalize_conversation_phone` só preserva o
 * campo quando a flag está ligada. Resultado: JID truncado, conversa fantasma
 * separada da que o webhook cria, e o envio arquivado no lugar errado.
 * Hoje o echo-api detecta o sufixo e grava `is_group`/`group_jid`, casando com
 * o webhook. Este aviso só existe para explicar o escopo (QR) e a resolução.
 */
export const GROUP_SEND_NOTICE =
    "O campo to aceita o JID do grupo (…@g.us). O Echo encontra a conversa do grupo pelo JID, ou cria uma já marcada como grupo. Informar conversation_id continua sendo a forma mais direta, por dispensar essa busca. Grupos existem apenas em números com conexão QR — na Cloud API da Meta eles não existem.";

export const qrEndpoints: EndpointCategory[] = [
    {
        category: "QR Service - Mensagens",
        icon: MessageSquare,
        description: "Envio de mensagens",
        internal: true,
        items: [
            {
                method: "POST",
                path: "/message/send/:phoneNumberId",
                slug: "qr-send-text",
                publicEquivalent: "send-message",
                baseUrl: "__QR_SERVICE__",
                description: "Enviar Texto",
                detailedDescription: "Envia uma mensagem de texto simples.",
                pathParams: [{ name: "phoneNumberId", type: "string", description: "ID do telefone", required: true, defaultValue: "PHONE_ID" }],
                bodyFields: [
                    { name: "to", type: "string", description: "Destinatário (com DDI)", required: true, defaultValue: "5511999999999" },
                    { name: "content", type: "string", description: "Texto da mensagem", required: true, defaultValue: "Olá!" },
                ],
                responses: [{ status: 200, description: "Enviado com sucesso" }],
                response: `{ "success": true, "messageId": "..." }`,
            },
            {
                method: "POST",
                path: "/message/send-media/:phoneNumberId",
                slug: "qr-send-media",
                publicEquivalent: "send-media",
                baseUrl: "__QR_SERVICE__",
                description: "Enviar Mídia",
                detailedDescription: "Envia mídia de duas formas: 1) JSON com media_url (recomendado) ou 2) multipart/form-data com arquivo. Suporta imagem, vídeo, áudio e documento.",
                pathParams: [{ name: "phoneNumberId", type: "string", description: "ID do telefone (UUID do banco)", required: true, defaultValue: "PHONE_UUID" }],
                bodyFields: [
                    { name: "media_url", type: "string", description: "URL pública direta da mídia (não Drive/Dropbox)", required: false, defaultValue: "https://cdn.exemplo.com/imagem.jpg" },
                    { name: "to", type: "string", description: "Destinatário com DDI", required: true, defaultValue: "5511999999999" },
                    { name: "caption", type: "string", description: "Legenda opcional", required: false, defaultValue: "Veja isso!" },
                    { name: "mime_type", type: "string", description: "Tipo MIME (detecta automaticamente)", required: false, defaultValue: "image/jpeg" },
                    { name: "filename", type: "string", description: "Nome do arquivo", required: false, defaultValue: "foto.jpg" },
                    { name: "isPtt", type: "string", description: "Se 'true', envia áudio como nota de voz", required: false, defaultValue: "false" },
                    { name: "file", type: "File", description: "Arquivo binário (usar com multipart/form-data)", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Enviado com sucesso" },
                    { status: 400, description: "Campos obrigatórios faltando" },
                ],
                response: `// Envio via JSON com URL (recomendado):
// curl -X POST ".../send-media/PHONE_UUID" \\
//   -H "Content-Type: application/json" \\
//   -d '{"media_url":"https://...", "to":"5511..."}'

{
  "success": true,
  "messageId": "BAEXXXXXXX",
  "conversation_id": "uuid",
  "message_id": "uuid"
}`,
            },
            {
                method: "POST",
                path: "/message/send-voice/:phoneNumberId",
                slug: "qr-send-voice",
                publicEquivalent: "send-voice",
                baseUrl: "__QR_SERVICE__",
                description: "Enviar Mensagem de Voz (PTT)",
                detailedDescription: "Envia uma nota de voz de verdade (a 'bolinha com onda', como se gravada na hora) — não um anexo de áudio. Aceita áudio em QUALQUER formato (MP3, M4A, OGG, WebM...) via JSON com media_url ou multipart/form-data com arquivo; o serviço transcodifica automaticamente para OGG/Opus antes de enviar. Exclusivo de números conectados por QR Code.",
                pathParams: [{ name: "phoneNumberId", type: "string", description: "ID do telefone (UUID do banco)", required: true, defaultValue: "PHONE_UUID" }],
                bodyFields: [
                    { name: "media_url", type: "string", description: "URL pública direta do áudio (não Drive/Dropbox)", required: false, defaultValue: "https://cdn.exemplo.com/audio.mp3" },
                    { name: "to", type: "string", description: "Destinatário com DDI", required: true, defaultValue: "5511999999999" },
                    { name: "file", type: "File", description: "Arquivo de áudio binário (usar com multipart/form-data)", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Nota de voz enviada com sucesso" },
                    { status: 400, description: "Campos obrigatórios faltando ou áudio inválido" },
                ],
                response: `// Aceita qualquer formato (ex: MP3) e entrega como nota de voz:
// curl -X POST ".../send-voice/PHONE_UUID" \\
//   -H "Content-Type: application/json" \\
//   -d '{"media_url":"https://.../audio.mp3", "to":"5511..."}'

{
  "success": true,
  "messageId": "BAEXXXXXXX",
  "conversation_id": "uuid",
  "message_id": "uuid"
}`,
            },
            {
                method: "POST",
                path: "/message/presence/:phoneNumberId",
                slug: "qr-presence",
                publicEquivalent: "send-typing",
                baseUrl: "__QR_SERVICE__",
                description: "Mostrar \"digitando\"",
                detailedDescription: "Exibe o indicador de digitação no WhatsApp do contato, sem enviar mensagem. É a rota de baixo nível — o equivalente pelo Echo API é POST /typing, que aceita o ID da Meta além do UUID e valida a organização. Chame ANTES de começar o processamento, para cobrir o tempo real de trabalho. Expira sozinho em ~10s: chame de novo a cada ~8s para manter, ou envie state=\"paused\" para interromper. Não grava nada no banco.",
                pathParams: [{ name: "phoneNumberId", type: "string", description: "ID do telefone (UUID do banco)", required: true, defaultValue: "PHONE_UUID" }],
                bodyFields: [
                    { name: "to", type: "string", description: "Destinatário com DDI, ou JID do grupo (...@g.us)", required: true, defaultValue: "5511999999999" },
                    { name: "state", type: "string", description: "composing (digitando) | recording (gravando áudio) | paused (limpa)", required: true, defaultValue: "composing" },
                ],
                responses: [
                    { status: 200, description: "Enviado (ou success:false se a sessão estiver fora do ar)" },
                    { status: 400, description: "to ou state faltando, ou state inválido" },
                ],
                response: `{ "success": true }`,
            },
        ],
    },
    {
        category: "QR Service - Grupos",
        icon: Users,
        description: "Gerenciamento de grupos",
        internal: true,
        items: [
            {
                method: "GET",
                path: "/groups/:phoneNumberId",
                slug: "qr-list-groups",
                baseUrl: "__QR_SERVICE__",
                description: "Listar grupos",
                detailedDescription: "Lista todos os grupos que o número participa.",
                pathParams: [{ name: "phoneNumberId", type: "string", description: "ID do telefone conectado", required: true, defaultValue: "PHONE_ID" }],
                responses: [{ status: 200, description: "Lista retornada" }],
                response: `{ "groups": [{ "id": "g.us", "subject": "Grupo 1" }] }`,
            },
            {
                method: "POST",
                path: "/groups/:phoneNumberId/create",
                slug: "qr-create-group",
                baseUrl: "__QR_SERVICE__",
                description: "Criar grupo",
                detailedDescription: "Cria um novo grupo com participantes iniciais.",
                pathParams: [{ name: "phoneNumberId", type: "string", description: "ID do telefone", required: true, defaultValue: "PHONE_ID" }],
                bodyFields: [
                    { name: "name", type: "string", description: "Nome do grupo", required: true, defaultValue: "Novo Grupo" },
                    { name: "participants", type: "array", description: "Lista de números (com country code)", required: true, defaultValue: '["5511999999999"]' },
                ],
                responses: [{ status: 200, description: "Grupo criado" }],
                response: `{ "success": true, "groupJid": "..." }`,
            },
            {
                method: "PUT",
                path: "/groups/:phoneNumberId/:groupJid/picture",
                slug: "qr-group-picture",
                baseUrl: "__QR_SERVICE__",
                description: "Alterar foto do grupo",
                detailedDescription: "Atualiza a foto do grupo. Envie de duas formas: 1) JSON com media_url (URL pública de imagem) ou 2) multipart/form-data com o campo file. Requer que o número seja admin do grupo.",
                pathParams: [
                    { name: "phoneNumberId", type: "string", description: "ID do telefone", required: true, defaultValue: "PHONE_ID" },
                    { name: "groupJid", type: "string", description: "JID do grupo", required: true, defaultValue: "123456789@g.us" },
                ],
                bodyFields: [
                    { name: "media_url", type: "string", description: "URL pública direta da imagem", required: false, defaultValue: "https://cdn.exemplo.com/foto.jpg" },
                    { name: "file", type: "File", description: "Arquivo de imagem (usar com multipart/form-data)", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Foto atualizada" },
                    { status: 400, description: "Imagem inválida ou sem permissão (não é admin)" },
                ],
                response: `{ "success": true }`,
            },
            {
                method: "PATCH",
                path: "/groups/:phoneNumberId/:groupJid/description",
                slug: "qr-group-description",
                baseUrl: "__QR_SERVICE__",
                description: "Alterar descrição do grupo",
                detailedDescription: "Atualiza a descrição do grupo. Envie string vazia para limpar.",
                pathParams: [
                    { name: "phoneNumberId", type: "string", description: "ID do telefone", required: true, defaultValue: "PHONE_ID" },
                    { name: "groupJid", type: "string", description: "JID do grupo", required: true, defaultValue: "123456789@g.us" },
                ],
                bodyFields: [
                    { name: "description", type: "string", description: "Nova descrição do grupo", required: true, defaultValue: "Descrição do grupo" },
                ],
                responses: [
                    { status: 200, description: "Descrição atualizada" },
                    { status: 400, description: "description obrigatório" },
                ],
                response: `{ "success": true }`,
            },
        ],
    },
    {
        category: "QR Service - Perfil",
        icon: User,
        description: "Perfil do WhatsApp do número conectado",
        internal: true,
        items: [
            {
                method: "GET",
                path: "/profile/:phoneNumberId",
                slug: "qr-get-profile",
                baseUrl: "__QR_SERVICE__",
                description: "Ver perfil",
                detailedDescription: "Retorna o nome e a foto de perfil do WhatsApp do número conectado.",
                pathParams: [{ name: "phoneNumberId", type: "string", description: "ID do telefone conectado", required: true, defaultValue: "PHONE_ID" }],
                responses: [
                    { status: 200, description: "Perfil retornado" },
                    { status: 400, description: "Sessão não conectada" },
                ],
                response: `{ "success": true, "profile": { "name": "Meu Nome", "pictureUrl": "https://..." } }`,
            },
            {
                method: "PUT",
                path: "/profile/:phoneNumberId/picture",
                slug: "qr-profile-picture",
                baseUrl: "__QR_SERVICE__",
                description: "Alterar foto do perfil",
                detailedDescription: "Atualiza a foto de perfil do WhatsApp do número conectado. Envie de duas formas: 1) JSON com media_url (URL pública de imagem) ou 2) multipart/form-data com o campo file.",
                pathParams: [{ name: "phoneNumberId", type: "string", description: "ID do telefone conectado", required: true, defaultValue: "PHONE_ID" }],
                bodyFields: [
                    { name: "media_url", type: "string", description: "URL pública direta da imagem", required: false, defaultValue: "https://cdn.exemplo.com/foto.jpg" },
                    { name: "file", type: "File", description: "Arquivo de imagem (usar com multipart/form-data)", required: false, defaultValue: "" },
                ],
                responses: [
                    { status: 200, description: "Foto atualizada" },
                    { status: 400, description: "Imagem inválida ou sessão desconectada" },
                ],
                response: `{ "success": true }`,
            },
            {
                method: "PATCH",
                path: "/profile/:phoneNumberId/name",
                slug: "qr-profile-name",
                baseUrl: "__QR_SERVICE__",
                description: "Alterar nome do perfil",
                detailedDescription: "Atualiza o nome público do perfil do WhatsApp do número conectado.",
                pathParams: [{ name: "phoneNumberId", type: "string", description: "ID do telefone conectado", required: true, defaultValue: "PHONE_ID" }],
                bodyFields: [
                    { name: "name", type: "string", description: "Novo nome do perfil", required: true, defaultValue: "Meu Nome" },
                ],
                responses: [
                    { status: 200, description: "Nome atualizado" },
                    { status: 400, description: "name obrigatório" },
                ],
                response: `{ "success": true }`,
            },
        ],
    },
];

// ─── Índice por slug ─────────────────────────────────────────────────────────

/** Echo API primeiro, QR Service depois — a ordem da sidebar. */
export const allEndpointCategories: EndpointCategory[] = [...endpoints, ...qrEndpoints];

export interface EndpointLookup {
    endpoint: EndpointItem;
    category: EndpointCategory;
}

const endpointsBySlug = new Map<string, EndpointLookup>();
for (const category of allEndpointCategories) {
    for (const endpoint of category.items) {
        endpointsBySlug.set(endpoint.slug, { endpoint, category });
    }
}

export const findEndpointBySlug = (slug: string | undefined): EndpointLookup | null =>
    (slug && endpointsBySlug.get(slug)) || null;

export const isStaticPageSlug = (slug: string | undefined): slug is StaticPageSlug =>
    STATIC_PAGES.some((page) => page.slug === slug);

// Colisão de slug quebraria o deep-link silenciosamente (o Map fica com o
// último e um endpoint some da navegação). Falha alto em dev, e o custo em
// produção é zero porque o bloco é removido no build.
if (import.meta.env.DEV) {
    const all = [
        ...allEndpointCategories.flatMap((c) => c.items.map((i) => i.slug)),
        ...STATIC_PAGES.map((p) => p.slug),
    ];
    const seen = new Set<string>();
    const dupes = all.filter((slug) => (seen.has(slug) ? true : (seen.add(slug), false)));
    if (dupes.length > 0) {
        throw new Error(`apiDocsData: slugs duplicados — ${[...new Set(dupes)].join(", ")}`);
    }

    // Ponteiro quebrado não estoura: o aviso só deixa de mostrar o
    // encaminhamento e volta a ser um beco sem saída, silenciosamente.
    for (const category of allEndpointCategories) {
        for (const item of category.items) {
            if (!item.publicEquivalent) continue;
            const target = endpointsBySlug.get(item.publicEquivalent);
            if (!target) {
                throw new Error(
                    `apiDocsData: ${item.slug}.publicEquivalent aponta para "${item.publicEquivalent}", que não existe`,
                );
            }
            if (target.category.internal) {
                throw new Error(
                    `apiDocsData: ${item.slug}.publicEquivalent aponta para "${item.publicEquivalent}", que também é interno`,
                );
            }
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Cores por método, em pares light/dark.
 *
 * O preset padrão da aplicação (`echo`) é claro. As variantes `-400` sozinhas,
 * como estavam antes, davam ~1,9:1 de contraste sobre branco — a paleta inteira
 * da página tinha sido calibrada só para o tema escuro. O tom escuro serve o
 * claro e vice-versa.
 *
 * Strings simples de propósito, não `cva`: variante com modificador dentro de
 * `cva` já quebrou call sites neste repo por causa do tailwind-merge.
 */
export const METHOD_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
    GET: {
        bg: "bg-emerald-500/10 dark:bg-emerald-500/15",
        text: "text-emerald-700 dark:text-emerald-400",
        dot: "bg-emerald-500",
    },
    POST: {
        bg: "bg-blue-500/10 dark:bg-blue-500/15",
        text: "text-blue-700 dark:text-blue-400",
        dot: "bg-blue-500",
    },
    PUT: {
        bg: "bg-amber-500/10 dark:bg-amber-500/15",
        text: "text-amber-700 dark:text-amber-400",
        dot: "bg-amber-500",
    },
    PATCH: {
        bg: "bg-purple-500/10 dark:bg-purple-500/15",
        text: "text-purple-700 dark:text-purple-400",
        dot: "bg-purple-500",
    },
    DELETE: {
        bg: "bg-red-500/10 dark:bg-red-500/15",
        text: "text-red-700 dark:text-red-400",
        dot: "bg-red-500",
    },
};

export const getMethodBadgeClass = (method: string) => {
    const style = METHOD_STYLES[method];
    if (!style) return "bg-muted text-muted-foreground";
    return `${style.bg} ${style.text}`;
};

export const getMethodDotClass = (method: string) => {
    return METHOD_STYLES[method]?.dot ?? "bg-muted-foreground";
};

/**
 * Selo de compatibilidade de conexão. Devolve null quando o endpoint serve os
 * dois modos — a ausência de selo é a informação "funciona em qualquer número",
 * e marcar todos deixaria a lista ilegível.
 */
export const getModeBadge = (
    modes?: ConnectionMode[]
): { label: string; short: string; className: string } | null => {
    if (!modes || modes.length !== 1) return null;

    return modes[0] === "qr"
        ? {
            label: "Somente QR",
            short: "QR",
            className: "bg-violet-500/10 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400",
        }
        : {
            label: "Somente Business API",
            short: "API",
            className: "bg-sky-500/10 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400",
        };
};

// ─── Webhook Event Payloads ──────────────────────────────────────────────────

export const webhookEvents = [
    {
        name: "note.created",
        description: "Disparado quando uma nota interna é criada em uma conversa.",
        payload: `{
  "event": "note.created",
  "timestamp": "2024-01-01T12:00:00Z",
  "data": {
    "note_id": "uuid",
    "content": "Texto da nota...",
    "created_at": "2024-01-01T12:00:00Z"
  },
  "agent": {
    "id": "uuid",
    "name": "Nome do Agente",
    "email": "agente@empresa.com"
  },
  "contact": {
    "id": "conversation_uuid",
    "name": "João Silva",
    "phone": "+5584999999999"
  },
  "organization": {
    "id": "org_uuid",
    "name": "Minha Empresa"
  },
  "phone_number": {
    "id": "phone_uuid",
    "display_name": "Vendas",
    "number": "+5584888888888"
  }
}`,
    },
    {
        name: "message.received",
        description: "Disparado quando uma nova mensagem é recebida. \"ts\"/\"ts_iso\" são a hora do aviso; a hora da mensagem gravada no Echo vem em \"message_created_at\" (no QR, a hora do WhatsApp; na linha oficial, a da chegada ao Echo). Numa linha QR que volta depois de desconectada, as duas ficam a dias de distância. Todo aviso de mensagem (received e sent) traz também: \"aviso_id\", o id deste aviso, para descartar repetido (num número QR é um só por mensagem: \"grupo:<jid>:<código>\" em grupo e \"conversa:<id do número no Echo>:<contato sem o 9º dígito>:<código>\" no 1:1; sem código do WhatsApp ou em número oficial, \"<message_id>:<evento>\", um por cópia); \"codigo_whatsapp\", o código da mensagem no WhatsApp (null quando não há); \"falou\", quem falou (tipo \"equipe\" com o número e, quando o Echo sabe, a pessoa e por onde; \"cliente\" com nome, telefone e jid; ou \"desconhecido\"); e, em grupo, \"linhas_no_grupo\", cada número seu no grupo com a conversa dele e a hora da última mensagem real. Num número QR, a mensagem com código do WhatsApp chega UMA vez, pela primeira cópia que o Echo gravou (de qualquer número seu que está no grupo), e o aviso só conta como entregue com resposta 2xx: sem ela, o Echo repete até 10 vezes (de 1 minuto a 1 hora de espera) com o mesmo aviso_id e alerta a equipe se nenhuma der certo. A cópia de grupo que chega sem remetente nenhum sai à parte, com o aviso_id de cópia.",
        payload: `{
  "status": 0,
  "event": "message.received",
  "ts": 1715000000000,
  "ts_iso": "2024-05-01T12:00:00.000Z",
  "message_created_at": "2024-05-01T11:58:41.000Z",
  "aviso_id": "grupo:120363000000000002@g.us:3EB00000000000000001",
  "codigo_whatsapp": "3EB00000000000000001",
  "falou": {
    "tipo": "equipe",
    "linha_id": "phone-uuid",
    "linha_nome": "Atendimento"
  },
  "linhas_no_grupo": [
    {
      "phone_number_id": "phone-uuid",
      "linha_nome": "Atendimento",
      "conversation_id": "uuid",
      "ultima_mensagem_em": "2024-05-01T11:58:41.000Z"
    }
  ],
  "organization": "Minha Empresa",
  "organization_id": "uuid",
  "phone_number": "Suporte Principal",
  "conversation_id": "uuid",
  "message_id": "uuid",
  "whatsapp_message_id": "wamid.xxx",
  "contact_phone": "5511999999999",
  "contact_name": "João Silva",
  "text": "Olá, gostaria de saber mais.",
  "message_type": "text",
  "direction": "incoming",
  "from_me": false,
  "actor_type": "customer",
  "read": false,
  "error": false
}`,
    },
    {
        name: "message.sent / status",
        description:
          "Disparado quando uma mensagem sai — pelo painel, pela API, por automação ou pelo próprio aparelho — ou quando o status dela muda. Vale igual para conversa 1:1 e para grupo.",
        payload: `// Mensagem Enviada
{
  "status": 2,
  "event": "message.sent",
  "ts": 1715000000000,
  "organization_id": "uuid",
  "phone_number": "Suporte",
  "conversation_id": "uuid",
  "message_id": "uuid",
  "contact_phone": "5511999999999",
  "text": "Olá! Como posso ajudar?",
  "message_type": "template",
  "template_name": "boas_vindas",
  "direction": "outgoing",
  "from_me": true,
  // 'agent' quando uma pessoa escreveu; 'system' para automação e resposta automática
  "actor_type": "agent",
  // De onde saiu: panel | api | automation | auto_reply | scheduled | broadcast | device
  "origin": "panel",
  "sent_by": "user-uuid",
  "sent_by_name": "Maria Souza",
  "sent_by_email": "maria@empresa.com"
}

// Mensagem enviada em um GRUPO
// 'contact_phone' é o JID do grupo; 'sender' identifica quem escreveu.
{
  "status": 2,
  "event": "message.sent",
  "organization_id": "uuid",
  "conversation_id": "uuid",
  "message_id": "uuid",
  "contact_phone": "120363000000000002@g.us",
  "text": "Bom dia, pessoal!",
  "message_type": "text",
  "direction": "outgoing",
  "from_me": true,
  "actor_type": "agent",
  "origin": "panel",
  "sent_by": "user-uuid",
  "sent_by_name": "Maria Souza",
  "is_group": true,
  "group": {
    "jid": "120363000000000002@g.us",
    "name": "Equipe Projeto X"
  },
  "sender": {
    "phone": "5584888888888",
    "name": "Maria Souza",
    "jid": null
  }
}

// Atualização de Status
{
  "status": 3,
  "status_name": "delivered",
  "event": "message.status",
  "ts": 1715000005000,
  "organization_id": "uuid",
  "message_id": "uuid",
  "whatsapp_message_id": "wamid.xxx",
  "conversation_id": "uuid",
  "contact_phone": "5511999999999"
}`,
    },
    {
        name: "message.author",
        description:
            "Complemento de uma mensagem que você já recebeu (só número QR). Num grupo com mais de um número seu, a cópia de quem só ouviu pode chegar ao Echo antes da cópia do número que falou; o aviso sai pela primeira e, quando a do número que falou chega, vem este evento, sem mensagem nova: \"aviso_original\" é o aviso_id da mensagem que ele completa, \"falou\" diz o número que falou e, quando o Echo sabe, quem digitou (\"pessoa\") e por onde (\"origem\"); \"conversation_id\" e \"phone_number_id\" são os do número que falou. No 1:1 acontece quando o contato tem duas conversas no mesmo número (com e sem o 9º dígito). Responda 2xx só depois de ter a mensagem original: sem ela, responda 409 e o Echo repete. O aviso_id é o do original mais \":autor\" (sabe quem digitou) ou \":linha\" (digitado no aparelho); os dois podem chegar.",
        payload: `{
  "event": "message.author",
  "ts": 1715000003000,
  "ts_iso": "2024-05-01T12:00:03.000Z",
  "aviso_id": "grupo:120363000000000002@g.us:3EB00000000000000001:autor",
  "aviso_original": "grupo:120363000000000002@g.us:3EB00000000000000001",
  "codigo_whatsapp": "3EB00000000000000001",
  "falou": {
    "tipo": "equipe",
    "linha_id": "phone-uuid",
    "linha_nome": "Vendas",
    "pessoa": "Maria Souza",
    "origem": "panel"
  },
  "organization_id": "uuid",
  "phone_number_id": "phone-uuid",
  "phone_number": "Vendas",
  "conversation_id": "uuid",
  "message_id": "uuid",
  "contact_phone": "120363000000000002@g.us",
  "is_group": true,
  "group": { "jid": "120363000000000002@g.us", "name": "Equipe Projeto X" },
  "sender": { "phone": "5584888888888", "name": "Maria Souza", "jid": null },
  "direction": "outgoing",
  "from_me": true,
  "actor_type": "agent",
  "origin": "panel",
  "sent_by": "user-uuid",
  "sent_by_name": "Maria Souza",
  "sent_by_email": "maria@empresa.com"
}`,
    },
    {
        // A falha NÃO chega como "message.failed". sendOrganizationWebhook
        // normaliza tudo que não é .received/.sent/.author para "message.status"
        // (_shared/webhooks.ts: `else if (event.startsWith('message.'))`),
        // e o que distingue a falha é status_name.
        name: "message.status (falha)",
        description:
            "Falha de envio chega como message.status com status_name: \"failed\" e status: -1 — não existe um evento message.failed no que é entregue. Trate pelo status_name, nunca pelo nome do evento.",
        payload: `{
  "status": -1,
  "status_name": "failed",
  "event": "message.status",
  "ts": 1715000000000,
  "organization_id": "uuid",
  "message_id": "uuid",
  "whatsapp_message_id": "wamid.xxx",
  "conversation_id": "uuid",
  "contact_phone": "5511999999999",
  "text": "Conteúdo da mensagem que falhou",
  "message_type": "text"
}

// O mesmo evento cobre delivered (status 3) e read (status 4).
// Só o status_name muda.`,
    },
];
