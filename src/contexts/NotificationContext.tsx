
import { createContext, useContext, useState, ReactNode, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Conversation } from "@/types/conversation";
import { getMessagePreview, type PreviewableMessage } from "@/lib/messagePreview";
import { LIST_COLUMNS, listRowSchema, listRowToConversation } from "@/lib/conversationListQuery";
import { mergeRefreshedRow } from "@/lib/conversationListReducer";
import { chaveEscopo, idsDaChave } from "@/lib/caixaConjunta";
import { mapComLimite } from "@/lib/fetchAllPaginated";
import {
    buscarContagemDaLinha,
    criarVooUnico,
    mesclarContagens,
    respostaTruncada,
    type OpcoesDoVoo,
    type RespostaDeContagem,
} from "@/lib/unreadCounts";
import { useConversationPrefsState, type ConversationPref } from "@/hooks/useConversationPrefs";

// Avisa o webhook da organização (edge conversation-webhook) que a conversa foi
// lida ou marcada como não lida aqui. Para o sistema integrado, "lida" vale para
// o time inteiro, então só avisa com a tela à vista (o efeito que marca a
// conversa aberta pode rodar com a aba escondida). A mesma conversa não é avisada de novo
// em 30 s (o clique na lista e o efeito marcam as duas); o que cair dentro da
// janela sai uma vez quando ela acaba, senão a mensagem que chegou com a
// conversa na tela ficaria não lida no sistema integrado.
// Sem esperar e sem travar a tela: se falhar, o webhook só não fica sabendo.
const AVISO_REPETIDO_MS = 30_000;
const avisadasEm = new Map<string, number>();
const adiadas = new Map<string, ReturnType<typeof setTimeout>>();
function avisarWebhook(event: "conversation.read" | "conversation.unread", conversationIds: string[]) {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const agora = Date.now();
    const oposto = event === "conversation.read" ? "conversation.unread" : "conversation.read";
    const ids: string[] = [];
    for (const id of conversationIds) {
        // Marcou não lida e leu de novo logo em seguida (ou o contrário): o gesto
        // novo tem de sair, e o adiado do gesto anterior não vale mais.
        const chaveOposta = `${oposto}:${id}`;
        avisadasEm.delete(chaveOposta);
        clearTimeout(adiadas.get(chaveOposta));
        adiadas.delete(chaveOposta);
        const chave = `${event}:${id}`;
        const falta = AVISO_REPETIDO_MS - (agora - (avisadasEm.get(chave) ?? 0));
        if (falta <= 0) {
            avisadasEm.set(chave, agora);
            ids.push(id);
        } else if (!adiadas.has(chave)) {
            adiadas.set(chave, setTimeout(() => {
                adiadas.delete(chave);
                avisarWebhook(event, [id]);
            }, falta));
        }
    }
    if (ids.length === 0) return;
    void supabase.functions
        .invoke("conversation-webhook", { body: { event, conversationIds: ids } })
        .then(({ error }) => {
            if (error) console.warn("[conversation-webhook] falhou (não bloqueante):", error);
        })
        .catch((err) => console.warn("[conversation-webhook] invoke falhou (não bloqueante):", err));
}

// Chamadas de get_unread_counts em voo ao mesmo tempo (uma por número do escopo).
// As RPCs escopadas por RLS são caras: com dezesseis números, dezesseis juntas
// empilhariam no mesmo pool de conexões.
const UNREAD_CONCURRENCY = 4;

interface NotificationContextType {
    activeConversationId: string | null;
    setActiveConversationId: (id: string | null) => void;
    unreadCounts: Map<string, number>;
    /**
     * Conversas que o usuário marcou como não lidas à mão. Estado PESSOAL e
     * independente do contador: vale mesmo onde não há mensagem nova (ver
     * src/lib/unread.ts para como os dois se compõem na renderização).
     */
    markedUnread: Set<string>;
    incrementUnread: (conversationId: string) => void;
    resetUnread: (conversationId: string) => void;
    /**
     * Marca a conversa como não lida à mão. Devolve false se a gravação falhou.
     * O caminho inverso é o `resetUnread` — ele zera contador E marcação de uma
     * vez, que é o que "marcar como lida" precisa significar.
     */
    markConversationUnread: (conversationId: string) => Promise<boolean>;
    markAllAsRead: () => Promise<number>;
    setUnreadCountsFromMap: (counts: Map<string, number>) => void;
    /**
     * Rebusca o não-lido; devolve o mapa aplicado (undefined se nenhuma RPC
     * respondeu). Uma busca por vez: quem chama no meio de uma em voo recebe a mesma,
     * e a foto do servidor dela é anterior à chamada. Com `fresca`, o resultado vem de
     * uma busca iniciada DEPOIS da chamada (canal reassinado: o que ele perdeu enquanto
     * esteve fora não está numa foto tirada antes).
     */
    refreshUnreadCounts: (opcoes?: OpcoesDoVoo) => Promise<Map<string, number> | undefined>;
    /**
     * Números que delimitam a busca de não-lido (os mesmos da lista na tela). Vazio =
     * nenhum escolhido: a busca vai sem filtro, como antes de a lista escolher.
     */
    setUnreadScope: (phoneNumberIds: readonly string[]) => void;
    /**
     * A chave do escopo do mapa de não-lidos aplicado por último. Quem compara dois mapas
     * (o poll de reserva do som) precisa saber se são do mesmo escopo: se a lista trocou de
     * número no meio, o de antes e o de depois não são comparáveis.
     */
    chaveDoMapaDeNaoLidos: () => string;

    // Send-failure badge (red "!" on conversation list items) — session-scoped
    failedCounts: Map<string, number>;
    incrementFailed: (conversationId: string) => void;
    resetFailed: (conversationId: string) => void;

    // Fixar/arquivar/silenciar POR USUÁRIO (tabela conversation_prefs)
    conversationPrefs: Map<string, ConversationPref>;
    togglePinned: (conversationId: string) => Promise<boolean>;
    toggleArchived: (conversationId: string) => Promise<boolean>;
    /** ISO, "infinity" (sempre) ou null para reativar o som. */
    setMutedUntil: (conversationId: string, until: string | null) => Promise<boolean>;
    isMuted: (conversationId: string) => boolean;

    // Conversation State
    conversations: Conversation[];
    setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
    /** Lê a lista atual por ref: identidade estável, sem rede. */
    findConversation: (id: string) => Conversation | undefined;
    /**
     * Rebusca UMA conversa com as colunas da lista e a funde no estado.
     * 0 linhas = a conversa saiu do escopo RLS deste usuário (transferida de
     * setor/linha): some da lista. Erro só loga.
     */
    refreshConversationById: (id: string) => Promise<void>;
    handleNewMessage: (message: NewMessageInput, opts?: { reopen?: boolean }) => Promise<void>;

    /**
     * Pedido de refresh da lista. `conversationId` preenchido = só aquela
     * conversa precisa ser rebuscada (broadcast de transferência/setor);
     * null = refetch completo da linha. `conversationRefreshTrigger` é o
     * alias numérico (= seq) mantido para quem só observa o contador.
     */
    conversationRefreshRequest: ConversationRefreshRequest;
    conversationRefreshTrigger: number;
    triggerConversationRefresh: (conversationId?: string) => void;
}

export interface ConversationRefreshRequest {
    seq: number;
    conversationId: string | null;
}

/** Campos de `messages` que a lista usa para mover a conversa ao topo e montar a prévia. */
export interface NewMessageInput extends PreviewableMessage {
    conversation_id: string;
    created_at?: string | null;
    direction: "inbound" | "outbound";
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const NotificationProvider = ({ children }: { children: ReactNode }) => {
    const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
    const [unreadCounts, setUnreadCounts] = useState<Map<string, number>>(new Map());
    const [markedUnread, setMarkedUnread] = useState<Set<string>>(new Set());
    const [failedCounts, setFailedCounts] = useState<Map<string, number>>(new Map());
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [conversationRefreshRequest, setConversationRefreshRequest] = useState<ConversationRefreshRequest>({
        seq: 0,
        conversationId: null,
    });

    // Espelho síncrono da lista para leitura em callbacks estáveis
    // (findConversation, handleNewMessage) sem entrar nos deps.
    const conversationsRef = useRef<Conversation[]>(conversations);
    conversationsRef.current = conversations;
    const findConversation = useCallback(
        (id: string) => conversationsRef.current.find((c) => c.id === id),
        [],
    );

    // Refs para resetUnread e para a busca de não-lido lerem o estado atual SEM
    // tê-lo nos deps: com unreadCounts nos deps a identidade mudava a cada mensagem
    // recebida em QUALQUER conversa, e o efeito de "abrir marca como lida" rodava
    // mark_conversations_read de novo a cada uma delas.
    const unreadCountsRef = useRef(unreadCounts);
    unreadCountsRef.current = unreadCounts;
    const markedUnreadRef = useRef(markedUnread);
    markedUnreadRef.current = markedUnread;

    // Fixar/arquivar/silenciar — estado próprio num hook para o contexto não inchar
    const {
        conversationPrefs,
        togglePinned,
        toggleArchived,
        setMutedUntil,
        isMuted,
    } = useConversationPrefsState();

    // Conversas com marcação de leitura EM VOO. O refresh de focus/visibility
    // dispara a qualquer momento e podia ler o servidor ANTES do commit do
    // watermark, ressuscitando o badge que o usuário acabou de limpar — a mesma
    // classe de bug que fazia a limpeza "se desfazer sozinha" antes de a
    // marcação ser persistida. Enquanto o id estiver aqui, o refresh o ignora.
    const pendingReadsRef = useRef<Set<string>>(new Set());

    // Mesma corrida, do lado da marcação manual: entre o clique no menu e o
    // commit da RPC, um refresh de focus lê o servidor sem a flag e desmarca o
    // que o usuário acabou de marcar. Enquanto o id estiver aqui, o refresh
    // preserva o valor local em vez de aceitar o do servidor.
    const pendingMarkedRef = useRef<Set<string>>(new Set());

    // Números da lista na tela (o escopo). Numa ref, e não em estado, porque
    // refreshUnreadCounts é chamado de handlers de janela e do canal realtime:
    // um valor em deps recriaria a função e resubscreveria o canal a cada troca
    // de escopo. Sem escopo, um admin com acesso a todos os números buscava as
    // contagens dos 14 telefones para renderizar badge de um só — e era assim
    // que se aproximava do teto de 999 linhas do PostgREST.
    // `set` serve a quem pergunta "este número é daqui?" (conversa nova, refresh de
    // uma conversa); `ids` a quem percorre os números (a busca de não-lido).
    const escopoRef = useRef<{ chave: string; ids: readonly string[]; set: ReadonlySet<string> }>({
        chave: "",
        ids: [],
        set: new Set(),
    });
    // Escopo de que é o mapa de não-lidos aplicado (gravado junto do setUnreadCounts).
    const chaveDoMapaRef = useRef("");

    const triggerConversationRefresh = useCallback((conversationId?: string) => {
        setConversationRefreshRequest((prev) => ({ seq: prev.seq + 1, conversationId: conversationId ?? null }));
    }, []);

    // Ids com select em voo (refresh pontual ou conversa nova em handleNewMessage):
    // dois eventos seguidos da mesma conversa custam UMA ida ao banco.
    const inflightConversationFetches = useRef<Set<string>>(new Set());

    const fetchListRow = useCallback(async (id: string): Promise<Conversation | null | undefined> => {
        const { data, error } = await supabase
            .from("conversations")
            .select(LIST_COLUMNS)
            .eq("id", id)
            .maybeSingle();
        if (error) {
            console.error("[NotificationContext] refresh de conversa falhou:", id, error);
            return undefined;
        }
        if (!data) return null; // 0 linhas = saiu do escopo RLS
        const parsed = listRowSchema.safeParse(data);
        if (!parsed.success) {
            // Linha fora do contrato NÃO é "sumiu": deixa a lista como está.
            console.error("[NotificationContext] linha de conversa fora do contrato:", id, parsed.error.issues[0]);
            return undefined;
        }
        return listRowToConversation(parsed.data);
    }, []);

    const refreshConversationById = useCallback(async (id: string) => {
        if (inflightConversationFetches.current.has(id)) return;
        inflightConversationFetches.current.add(id);
        try {
            const row = await fetchListRow(id);
            // undefined = erro de rede/servidor: não mexe na lista. null = 0 linhas:
            // a conversa saiu do escopo RLS deste usuário (transferida de setor ou
            // de linha). O walrus não entrega o UPDATE que tira a linha do escopo,
            // então este select é o único jeito de ela sumir da lista.
            if (row === undefined) return;
            setConversations((prev) => mergeRefreshedRow(prev, id, row, escopoRef.current.set));
        } finally {
            inflightConversationFetches.current.delete(id);
        }
    }, [fetchListRow]);

    const incrementUnread = useCallback((conversationId: string) => {
        setUnreadCounts((prev) => {
            const newMap = new Map(prev);
            const current = newMap.get(conversationId) || 0;
            newMap.set(conversationId, current + 1);
            return newMap;
        });
    }, []);

    const incrementFailed = useCallback((conversationId: string) => {
        setFailedCounts((prev) => {
            const newMap = new Map(prev);
            const current = newMap.get(conversationId) || 0;
            newMap.set(conversationId, current + 1);
            return newMap;
        });
    }, []);

    const resetFailed = useCallback((conversationId: string) => {
        setFailedCounts((prev) => {
            if (!prev.has(conversationId)) return prev;
            const newMap = new Map(prev);
            newMap.delete(conversationId);
            return newMap;
        });
    }, []);

    // Aplica o retorno do select de flags respeitando o que está em voo. Fora do
    // refresh para o caminho de erro ficar visível: falha ao ler as marcações não
    // pode derrubar a contagem, que é o sinal mais importante dos dois.
    const applyMarkedUnreadSnapshot = useCallback(
        (result: {
            data: { conversation_id: string }[] | null;
            error: { message: string } | null;
        }) => {
            if (result.error) {
                console.error("Error fetching manual unread flags:", result.error);
                return;
            }

            setMarkedUnread((prev) => {
                const next = new Set<string>();
                for (const row of result.data || []) next.add(row.conversation_id);

                // O local manda para o que ainda não commitou — nos DOIS
                // sentidos: marcar recém-feito não pode sumir, desmarcar
                // recém-feito não pode voltar.
                for (const id of pendingMarkedRef.current) {
                    if (prev.has(id)) next.add(id);
                    else next.delete(id);
                }
                return next;
            });
        },
        [],
    );

    // Duas fontes numa ida só. A RPC agrega por usuário no servidor (marca d'água em
    // conversation_reads) e roda UMA vez por número do escopo: cada chamada tem o
    // próprio teto de 999 conversas, e um número lento ou com erro não esconde o
    // badge dos outros. As marcações manuais vêm da mesma tabela, filtradas pela
    // policy conversation_reads_select_own — só as MINHAS voltam, e são poucas.
    //
    // Buscar as duas aqui dentro faz todo caminho de auto-cura já existente
    // (visibilitychange, focus, online, resubscribe do canal, troca de linha,
    // pull-to-refresh) curar a marcação de graça, sem um segundo agendador.
    //
    // `buscar` não toca no estado: quem decide se o resultado ainda vale é o voo
    // único (um escopo que mudou no meio descarta a resposta velha e refaz).
    const buscarNaoLidos = useCallback(async () => {
        const { ids } = escopoRef.current;
        // Escopo vazio = nenhum número escolhido (fora do Dashboard, ou antes de ele
        // resolver a seleção): uma chamada sem filtro, como sempre foi.
        const linhas: Array<string | null> = ids.length === 0 ? [null] : [...ids];

        const [respostas, marcadas] = await Promise.all([
            mapComLimite(
                linhas,
                // Cada chamada tem prazo (`buscarContagemDaLinha`): uma RPC pendurada segurava o
                // voo único e, com ele, badge, troca de escopo, reassinar e poll.
                (linha): Promise<RespostaDeContagem> =>
                    buscarContagemDaLinha(linha, (numero, sinal) =>
                        supabase.rpc("get_unread_counts", { p_phone_number_id: numero }).abortSignal(sinal),
                    ),
                { concurrency: UNREAD_CONCURRENCY },
            ),
            // Sem paginação de propósito: o PostgREST corta em 1000 linhas, e
            // passar disso exigiria marcar mil conversas UMA A UMA pelo menu.
            // Se algum dia virar ação em lote, isto precisa de .range().
            supabase
                .from("conversation_reads")
                .select("conversation_id")
                .not("marked_unread_at", "is", null),
        ]);

        return { respostas, marcadas };
    }, []);

    const aplicarNaoLidos = useCallback(
        ({ respostas, marcadas }: Awaited<ReturnType<typeof buscarNaoLidos>>) => {
            applyMarkedUnreadSnapshot(marcadas);

            // O PostgREST corta a resposta em 1000 linhas, RPC incluída. A RPC ordena
            // e corta em 999 para o corte ser determinístico e devolve o total antes
            // dele — sem comparar aqui, a truncagem seria invisível e apareceria
            // como badge faltando nas conversas mais paradas.
            for (const resposta of respostas) {
                const truncada = respostaTruncada(resposta.rows);
                if (truncada) {
                    console.warn(
                        `[unread] resposta truncada (${resposta.linha ?? "todos os números"}): ` +
                            `${truncada.recebidas} de ${truncada.total} conversas com não-lido. ` +
                            "As mais paradas ficaram sem badge — hora de estreitar o escopo da contagem.",
                    );
                }
            }

            // Só um número que falhou precisa saber a quem cada conversa pertence
            // (para manter as contagens dele): o índice só é montado nesse caso.
            let linhaPorConversa: Map<string, string | null | undefined> | null = null;
            const countMap = mesclarContagens({
                respostas,
                anterior: unreadCountsRef.current,
                linhaDaConversa: (conversationId) => {
                    if (!linhaPorConversa) {
                        linhaPorConversa = new Map(conversationsRef.current.map((c) => [c.id, c.phone_number_id]));
                    }
                    return linhaPorConversa.get(conversationId);
                },
                // Ignora o que está sendo marcado como lido neste instante: a
                // resposta em mãos foi montada antes do watermark ser gravado.
                ignorar: pendingReadsRef.current,
            });
            // Nenhuma RPC respondeu: o mapa fica como está (o erro já foi logado).
            if (!countMap) return undefined;

            // A busca só chega aqui sem `invalidar` desde que começou (criarVooUnico): o escopo
            // da ref é o que ela olhou, e a chave acompanha o mapa.
            chaveDoMapaRef.current = escopoRef.current.chave;
            setUnreadCounts(countMap);
            return countMap;
        },
        [applyMarkedUnreadSnapshot],
    );

    // Uma busca por vez: focus, visibilidade, reassinar do canal, troca de escopo,
    // poll e abertura da lista disparam a mesma coisa, e antes cada disparo custava
    // as chamadas inteiras. Quem chega no meio recebe o resultado da que está em voo.
    // A identidade é estável (deps estáveis): vai para efeitos que assinam canal.
    const refreshUnreadCounts = useMemo(
        () => criarVooUnico(buscarNaoLidos, aplicarNaoLidos),
        [buscarNaoLidos, aplicarNaoLidos],
    );

    const setUnreadScope = useCallback(
        (ids: readonly string[]) => {
            const chave = chaveEscopo(ids);
            if (chave === escopoRef.current.chave) return;
            const unicos = idsDaChave(chave);
            escopoRef.current = { chave, ids: unicos, set: new Set(unicos) };
            // A busca em voo olhou o escopo anterior: o que ela trouxer não vale, e
            // quem a espera recebe o resultado de uma nova, já com o escopo certo.
            refreshUnreadCounts.invalidar();
        },
        [refreshUnreadCounts],
    );

    const chaveDoMapaDeNaoLidos = useCallback(() => chaveDoMapaRef.current, []);

    // Persiste a leitura como estado PESSOAL (uma linha por usuário+conversa),
    // não mais estampando messages.read_at — aquela coluna é global e fazia o
    // badge sumir para TODA a org no primeiro que abrisse a conversa.
    // A RPC usa o relógio do servidor: com o relógio do cliente atrasado, uma
    // mensagem recém-chegada ficaria acima da marca e o badge não limparia.
    const persistRead = useCallback(
        async (conversationIds: string[], avisarOWebhook = true) => {
            if (conversationIds.length === 0) return;
            conversationIds.forEach((id) => pendingReadsRef.current.add(id));

            // A RPC zera marked_unread_at junto com a marca d'água (ver a RPC
            // mark_conversations_read no baseline). Espelhar aqui é o
            // que faz "abrir a conversa limpa a marcação" ser instantâneo em vez
            // de esperar o próximo refresh.
            setMarkedUnread((prev) => {
                if (!conversationIds.some((id) => prev.has(id))) return prev;
                const next = new Set(prev);
                conversationIds.forEach((id) => next.delete(id));
                return next;
            });

            const { error } = await supabase.rpc("mark_conversations_read", {
                p_conversation_ids: conversationIds,
            });

            conversationIds.forEach((id) => pendingReadsRef.current.delete(id));

            if (error) {
                console.error("Error persisting read state:", error);
                // Falhou: o badge tem que VOLTAR em vez de mentir "lido".
                void refreshUnreadCounts();
            } else if (avisarOWebhook) {
                avisarWebhook("conversation.read", conversationIds);
            }
        },
        [refreshUnreadCounts],
    );

    const resetUnread = useCallback(
        async (conversationId: string) => {
            // Recibo de leitura p/ o CONTATO (tique azul) — fire-and-forget e
            // só quando havia algo não lido. A edge function decide pelo toggle
            // do número (send_read_receipts, default OFF) com early-out barato.
            const hadUnread =
                (unreadCountsRef.current.get(conversationId) || 0) > 0 ||
                markedUnreadRef.current.has(conversationId);
            if (hadUnread) {
                void supabase.functions
                    .invoke("whatsapp-mark-read", { body: { conversationId } })
                    .catch((err) => console.warn("[MarkRead] invoke falhou (não bloqueante):", err));
            }

            // Limpeza otimista local — o badge some no clique, sem esperar a rede.
            setUnreadCounts((prev) => {
                if (!prev.has(conversationId)) return prev;
                const newMap = new Map(prev);
                newMap.delete(conversationId);
                return newMap;
            });

            await persistRead([conversationId]);
        },
        [persistRead],
    );

    // Marcação manual: "li, mas ainda não resolvi".
    //
    // Só o sentido LIGAR mora aqui. Desligar é `resetUnread`, e não o mesmo
    // caminho com um booleano: numa conversa com 3 mensagens não lidas de
    // verdade, "marcar como lida" que apagasse apenas a flag deixaria o badge
    // teimando em 3 — o rótulo prometeria uma coisa e o servidor faria outra.
    // A RPC de leitura zera contador E marcação numa tacada.
    const markConversationUnread = useCallback(
        async (conversationId: string) => {
            pendingMarkedRef.current.add(conversationId);

            setMarkedUnread((prev) => {
                if (prev.has(conversationId)) return prev;
                const next = new Set(prev);
                next.add(conversationId);
                return next;
            });

            const { error } = await supabase.rpc("set_conversation_manual_unread", {
                p_conversation_id: conversationId,
                p_unread: true,
            });

            pendingMarkedRef.current.delete(conversationId);

            if (error) {
                console.error("Error setting manual unread flag:", error);
                // Mesmo contrato de falha do persistRead: o estado volta do
                // servidor em vez de a UI mentir sobre o que foi gravado.
                void refreshUnreadCounts();
                return false;
            }
            avisarWebhook("conversation.unread", [conversationId]);
            return true;
        },
        [refreshUnreadCounts],
    );

    const markAllAsRead = useCallback(async (): Promise<number> => {
        // Só as conversas DO ESCOPO da tela, e só as que a lista tem em memória (são as
        // que a pessoa vê). O mapa de não-lidos também recebe, pelo realtime, o
        // incremento de conversas de outros números (o canal é da organização inteira
        // para quem é admin), e "Marcar tudo como lido" que as limpasse mexeria no que
        // ela nem está vendo. Sem número escolhido a lista não filtra nada, e vale tudo
        // o que está em memória.
        const escopo = escopoRef.current.set;
        const visiveis = new Set<string>();
        for (const conv of conversationsRef.current) {
            if (escopo.size === 0 || (conv.phone_number_id && escopo.has(conv.phone_number_id))) visiveis.add(conv.id);
        }
        // As marcadas à mão entram na conta: "Marcar tudo como lido" que deixa
        // linhas em negrito na tela não cumpriu o que prometeu. A RPC de leitura
        // já zera a flag no servidor, então basta incluir os ids.
        const targetIds = new Set<string>();
        for (const id of unreadCounts.keys()) if (visiveis.has(id)) targetIds.add(id);
        for (const id of markedUnread) if (visiveis.has(id)) targetIds.add(id);
        const count = targetIds.size;
        if (count === 0) return 0;
        // Otimista + persistência: a versão local-only "se desfazia sozinha" —
        // o refreshUnreadCounts do focus/visibilitychange repopulava tudo e o
        // usuário via as notificações voltarem depois do toast de limpeza.
        //
        // A antiga guarda de posse (persistir só conversas próprias) existia
        // porque o UPDATE em messages era org-wide e destrutivo. Com marca
        // d'água por usuário a escrita é pessoal: dá para limpar TODAS as
        // conversas do escopo, inclusive as que o usuário só acompanha — era
        // justamente nessas que o badge voltava depois do toast.
        const unreadIds = Array.from(targetIds);
        setUnreadCounts((prev) => {
            if (!unreadIds.some((id) => prev.has(id))) return prev;
            const next = new Map(prev);
            for (const id of unreadIds) next.delete(id);
            return next;
        });
        setMarkedUnread((prev) => {
            if (!unreadIds.some((id) => prev.has(id))) return prev;
            const next = new Set(prev);
            for (const id of unreadIds) next.delete(id);
            return next;
        });

        // A RPC recebe os ids no corpo do POST (o limite de ~30KB do gateway
        // vale para URL de GET), mas mantemos lotes para limitar o statement.
        const CHUNK = 500;
        for (let i = 0; i < unreadIds.length; i += CHUNK) {
            // "Marcar tudo como lido" arruma a caixa PESSOAL: não é ler. O webhook não
            // é avisado, senão uma limpeza daqui zerava as não lidas do time inteiro no sistema integrado.
            await persistRead(unreadIds.slice(i, i + CHUNK), false);
        }
        return count;
    }, [unreadCounts, markedUnread, persistRead]);

    const setUnreadCountsFromMap = (counts: Map<string, number>) => {
        setUnreadCounts(counts);
    };

    const handleNewMessage = useCallback(async (newMessage: NewMessageInput, opts?: { reopen?: boolean }) => {
        if (!newMessage || !newMessage.conversation_id) return;
        const conversationId = newMessage.conversation_id;
        const preview = getMessagePreview(newMessage);

        // Conversa já na lista: move ao topo e aplica a prévia otimista.
        setConversations(prev => {
            const existingIndex = prev.findIndex(c => c.id === conversationId);
            if (existingIndex === -1) return prev;

            const existing = prev[existingIndex];
            const updated: Conversation = {
                ...existing,
                last_message_at: newMessage.created_at || new Date().toISOString(),
                last_message_preview: preview,
                last_message_direction: newMessage.direction,
                // Inbound reabre a conversa no backend (webhook seta active/organic),
                // mas o UPDATE em conversations não chega via realtime (RLS) — espelha aqui
                ...(opts?.reopen ? { status: 'active' } : {})
            };

            const newConversations = [...prev];
            newConversations.splice(existingIndex, 1);
            return [updated, ...newConversations];
        });

        // Já estava na lista: nada a buscar. O trigger do banco emite o UPDATE
        // realtime em conversations com last_message_at/prévia autoritativos
        // logo depois; refazer o select aqui era uma ida ao banco por mensagem.
        if (conversationsRef.current.some(c => c.id === conversationId)) return;

        if (inflightConversationFetches.current.has(conversationId)) return;
        inflightConversationFetches.current.add(conversationId);
        try {
            const row = await fetchListRow(conversationId);
            if (!row) return;
            // Só entra se for de um número da tela e ainda não tiver chegado por
            // outro caminho (realtime INSERT/refresh) enquanto o select rodava.
            if (!row.phone_number_id || !escopoRef.current.set.has(row.phone_number_id)) return;
            // A prévia da mensagem em mãos só vence se ela for mais nova que a
            // última que o servidor conhece (a row pode já trazer uma posterior).
            const messageIsLatest =
                !!newMessage.created_at && newMessage.created_at >= row.last_message_at;
            const toInsert: Conversation = messageIsLatest
                ? { ...row, last_message_preview: preview, last_message_direction: newMessage.direction }
                : row;
            setConversations(prev => (prev.some(c => c.id === conversationId) ? prev : [toInsert, ...prev]));
        } finally {
            inflightConversationFetches.current.delete(conversationId);
        }
    }, [fetchListRow]);

    useEffect(() => {
        refreshUnreadCounts();
    }, []);

    // Self-heal unread counts when the tab regains focus / network returns.
    // The realtime channel can silently drop INSERTs (dead socket, RLS-filtered
    // rows, PWA reload windows), which freezes the sidebar badge at zero and
    // makes conversations wrongly appear "read". Re-fetching from the server on
    // focus/visibility/online recovers any missed unread counts without an F5.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === "visible") void refreshUnreadCounts();
        };
        const onFocusOrOnline = () => {
            void refreshUnreadCounts();
        };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onFocusOrOnline);
        window.addEventListener("online", onFocusOrOnline);
        return () => {
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("focus", onFocusOrOnline);
            window.removeEventListener("online", onFocusOrOnline);
        };
    }, [refreshUnreadCounts]);

    // Abrir a conversa marca como lida, não só clicar na linha da lista.
    // Deep-link, resultado da busca global e o "Ver" de toast/notificação nativa
    // abrem a conversa sem passar pelo clique da lista — e com leitura por
    // usuário o badge desses caminhos ficaria preso PARA SEMPRE (antes o clique
    // de um colega mascarava, porque a leitura era global). O ChatArea seta
    // activeConversationId em toda abertura, então este é o ponto único.
    // Só dispara na TROCA de conversa: resetUnread tem identidade estável (lê
    // unreadCounts/markedUnread por ref), então mensagem que chega — nesta ou
    // em qualquer outra conversa — não roda mark_conversations_read de novo.
    // Mensagem na conversa já aberta continua marcando não-lido (auto-lido do
    // ativo é decisão em aberto).
    useEffect(() => {
        if (!activeConversationId) return;
        void resetUnread(activeConversationId);
    }, [activeConversationId, resetUnread]);

    return (
        <NotificationContext.Provider
            value={{
                activeConversationId,
                setActiveConversationId,
                unreadCounts,
                markedUnread,
                incrementUnread,
                resetUnread,
                markConversationUnread,
                markAllAsRead,
                setUnreadCountsFromMap,
                refreshUnreadCounts,
                setUnreadScope,
                chaveDoMapaDeNaoLidos,
                conversations,
                setConversations,
                findConversation,
                refreshConversationById,
                handleNewMessage,
                conversationRefreshRequest,
                conversationRefreshTrigger: conversationRefreshRequest.seq,
                triggerConversationRefresh,
                failedCounts,
                incrementFailed,
                resetFailed,
                conversationPrefs,
                togglePinned,
                toggleArchived,
                setMutedUntil,
                isMuted,
            }}
        >
            {children}
        </NotificationContext.Provider>
    );
};

export const useNotifications = () => {
    const context = useContext(NotificationContext);
    if (context === undefined) {
        throw new Error("useNotifications must be used within a NotificationProvider");
    }
    return context;
};
