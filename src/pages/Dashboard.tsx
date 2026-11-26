import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { User } from "@supabase/supabase-js";
import ConversationsList from "@/components/ConversationsList";
import { ResizableListColumn } from "@/components/ResizableListColumn";
import ChatArea from "@/components/ChatArea";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { avisoConversaDeOutra, buscarConversaDoTelefone } from "@/lib/conversaDoTelefone";
import { usePhoneTheme } from "@/hooks/usePhoneTheme";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useIsMobile } from "@/hooks/use-mobile";
import { BottomNavigation } from "@/components/layout";
import { FeedbackPopup } from "@/components/feedback/FeedbackPopup";
import FeatureAnnouncementDialog from "@/components/FeatureAnnouncementDialog";
import { useVoiceCalls } from "@/contexts/VoiceCallContext";
import { cn } from "@/lib/utils";
import { conversationListCache } from "@/lib/conversationListCache";
import { chaveEscopo, conjuntaDisponivel, idsDaChave, numerosDaConjunta } from "@/lib/caixaConjunta";
import { useCaixaConjunta } from "@/hooks/useCaixaConjunta";
import { CaixaConjuntaDialog } from "@/components/CaixaConjuntaDialog";
import {
  chaveNumerosAcessiveis,
  numerosAcessiveisEmCache,
  useAccessiblePhoneNumbers,
} from "@/hooks/useAccessiblePhoneNumbers";
import {
  chatLineId,
  lineMetaFromEmbed,
  resolveChatLine,
  resolveSelectedLineId,
  type ChatTarget,
} from "@/lib/numeroDaConversa";

// Cor do app antes de o número resolver: o teal da marca, que era o estado
// inicial do tema. Número resolvido sem cor própria (null) usa o padrão do hook.
const HUE_ANTES_DE_RESOLVER = 176;

// Último número escolhido, por organização. localStorage pode lançar (modo
// privado, cota): sem ele a seleção só deixa de ser lembrada.
const chaveNumeroSalvo = (orgId: string) => `echo_last_phone_${orgId}`;

const lerNumeroSalvo = (orgId: string | null | undefined): string | null => {
  if (!orgId) return null;
  try {
    return localStorage.getItem(chaveNumeroSalvo(orgId));
  } catch {
    return null;
  }
};

const gravarNumeroSalvo = (orgId: string | null | undefined, numeroId: string | null) => {
  if (!orgId) return;
  try {
    if (numeroId) {
      localStorage.setItem(chaveNumeroSalvo(orgId), numeroId);
    } else {
      localStorage.removeItem(chaveNumeroSalvo(orgId));
    }
  } catch {
    // Sem armazenamento: a escolha vale só nesta sessão.
  }
};

const Dashboard = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { conversationId: urlConversationId } = useParams<{ conversationId?: string }>();
  const { toast } = useToast();
  const isMobile = useIsMobile();

  // ProtectedRoute ensures user and org are loaded
  const [user, setUser] = useState<User | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  // Qual conversa o último refreshTrigger se refere: capturado ANTES de a
  // seleção ser limpa (os dois setState são batched, então a lista já vê
  // selectedConversationId=null quando o efeito do trigger roda).
  const [refreshConversationId, setRefreshConversationId] = useState<string | null>(null);
  // Número SELECIONADO: o que o seletor mostra e que escopa a lista. Não é o
  // número do chat: a conversa aberta pode ser de outro (ver chatTarget).
  const [selectedPhoneNumberId, setSelectedPhoneNumberId] = useState<string | null>(null);
  // Número da conversa aberta. Guarda o id da conversa junto, para nunca servir o
  // número da conversa anterior a uma diferente. Fica vivo depois de fechar o
  // chat de propósito: no mobile o painel ainda está saindo da tela.
  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(null);
  const [isLoadingDeepLink, setIsLoadingDeepLink] = useState(!!urlConversationId);

  // Mobile: track conversation name for header
  const [selectedConversationName, setSelectedConversationName] = useState<string>("");

  // Track if deep link was already processed to avoid re-processing
  const deepLinkProcessedRef = useRef<string | null>(null);

  const { currentOrganization } = useOrganization();
  const queryClient = useQueryClient();

  // Metadados dos números (id da Meta, tipo de canal, cor) saem de um mapa só,
  // compartilhado com o resto da tela. O Dashboard NÃO lê `conversations` do
  // NotificationContext: renderizaria a cada mudança da lista, e o número do
  // chat já chega com a conversa (linha da lista ou deep link).
  const {
    phoneNumbers: accessibleLines,
    isReady: linesReady,
    isError: linesError,
  } = useAccessiblePhoneNumbers(currentOrganization?.id);
  const linesById = useMemo(
    () => new Map(accessibleLines.map((line) => [line.id, line])),
    [accessibleLines],
  );
  // O mapa em refs: o clique na lista e o deep link o leem sem entrar nas deps
  // (handleSelectConversation precisa ficar estável, a lista o recebe por prop).
  const linesByIdRef = useRef(linesById);
  linesByIdRef.current = linesById;
  const linesReadyRef = useRef(linesReady);
  linesReadyRef.current = linesReady;
  const selectedLine = selectedPhoneNumberId ? linesById.get(selectedPhoneNumberId) ?? null : null;

  // Caixa conjunta: a escolha mora neste aparelho (localStorage por usuário e organização)
  // e nasce síncrona, para uma montagem nova (clique numa notificação push) já saber o
  // modo antes de o deep link decidir se troca de número. O que se guarda são as
  // EXCLUSÕES: um número novo liberado entra sozinho.
  // Outra aba saiu da conjunta: esta passa para o número que a outra escolheu (já gravado em
  // echo_last_phone). Sem isso ela mostraria o último número único dela, de antes, e o efeito
  // de resolução o gravaria por cima da escolha nova.
  const caixa = useCaixaConjunta(currentOrganization?.id, user?.id, (modo) => {
    if (modo !== "numero") return;
    setLinhaDoDeepLinkPendente(null);
    setSelectedPhoneNumberId(lerNumeroSalvo(currentOrganization?.id));
  });
  const idsAcessiveis = useMemo(() => accessibleLines.map((line) => line.id), [accessibleLines]);
  const idsDaConjunta = useMemo(
    () => numerosDaConjunta(idsAcessiveis, caixa.fora),
    [idsAcessiveis, caixa.fora],
  );
  // Ativa: modo conjunta E 2 ou mais números DEPOIS das exclusões. Com menos, cai no modo
  // número (a escolha fica guardada: se um número voltar, a conjunta volta).
  const conjuntaAtiva = caixa.modo === "conjunta" && conjuntaDisponivel(idsAcessiveis, caixa.fora);
  // Modo conjunta, mas os números ainda não chegaram: o escopo espera vazio (a lista
  // segura o skeleton) em vez de buscar o último número e trocar logo depois. Conta a FALTA
  // DE DADO, e não a busca em voo: com a primeira carga em erro ou pausada (offline) o
  // `isLoading` já é falso e a tela cairia no modo número, e um deep link nessa janela
  // gravaria o número da conversa. Uma revalidação mantém a lista boa (já há números).
  const aguardandoNumeros = caixa.modo === "conjunta" && !linesReady && accessibleLines.length === 0;
  const emConjunta = conjuntaAtiva || aguardandoNumeros;
  // Esperando o mapa, e a busca dele falhou: a lista mostra a falha (com nova tentativa) em vez de
  // um skeleton eterno. O refetchInterval de 30 s do mapa segue recuperando sozinho.
  const numerosEmErro = aguardandoNumeros && linesError;
  const tentarNumerosNovamente = () => {
    void queryClient.refetchQueries({ queryKey: chaveNumerosAcessiveis(currentOrganization?.id) });
  };
  // Lido por quem vive além do render (o efeito do deep link).
  const emConjuntaRef = useRef(emConjunta);
  emConjuntaRef.current = emConjunta;
  // Número de um deep link que chegou com os números ainda carregando e a conjunta só
  // "esperada": decide quando o mapa chega (no efeito de resolução, logo abaixo).
  const [linhaDoDeepLinkPendente, setLinhaDoDeepLinkPendente] = useState<string | null>(null);

  // Os números que a lista mostra: o conjunto escolhido na caixa conjunta, ou só o
  // selecionado (ou nenhum). `selectedPhoneNumberId` segue sendo o último número ÚNICO
  // (um uuid de verdade) mesmo na conjunta. O array é estável pela CHAVE do conjunto, e
  // não recriado a cada render: a lista refaz a busca quando o conjunto muda, não quando
  // o pai renderiza.
  const chaveDoEscopo = chaveEscopo(
    conjuntaAtiva ? idsDaConjunta : aguardandoNumeros ? [] : selectedPhoneNumberId ? [selectedPhoneNumberId] : [],
  );
  const escopo = useMemo(() => idsDaChave(chaveDoEscopo), [chaveDoEscopo]);
  // Nulo na conjunta, e nunca um sentinela: um não-uuid em `.eq('phone_number_id')` dá 22P02.
  const numeroUnico = emConjunta ? null : selectedPhoneNumberId;
  const lineFor = (conversationId: string | null) => resolveChatLine(chatTarget, conversationId, linesById);
  // O id interno do número do chat quando o mapa não o dá (ainda carregando, ou a
  // busca falhou): vale se a conversa é do número SELECIONADO, cujo id a lista já
  // tem antes do mapa. Com ele o texto, o agendamento e os botões de ação
  // seguem funcionando como antes do mapa; só o id da Meta, o canal e a cor
  // esperam por ele. Conversa de outro número, ou de uma linha que a RLS esconde
  // (embed nulo), segue sem número: nada de emprestar o de outra conversa.
  const idSemMapa = (conversationId: string | null) => {
    const lineId = chatLineId(chatTarget, conversationId);
    return lineId && lineId === selectedPhoneNumberId ? lineId : null;
  };

  // Tema, ligação e navegação seguem a conversa ABERTA (selectedConversationId),
  // e não lastConversationIdRef: esse nunca é limpo e serviria o número velho.
  const chatLine = lineFor(selectedConversationId);
  // Na caixa conjunta o número selecionado não manda em nada: só a conversa aberta.
  const activeLine = chatLine ?? (emConjunta ? null : selectedLine);
  // Cor do app: na conjunta segue a conversa aberta e, sem ela, o padrão (null); no modo
  // número, a do número da conversa ou do selecionado, como sempre. O tema manda: o hook
  // só recolore no preset `echo`.
  usePhoneTheme(emConjunta ? (chatLine ? chatLine.themeHue : null) : activeLine ? activeLine.themeHue : HUE_ANTES_DE_RESOLVER);

  // Mantém o retrato do número do chat em dia enquanto a linha está no mapa. É o
  // que sobra se ela sair dele no meio da conversa (um admin a desativa, e o
  // mapa só lista linhas ativas), e cobre o clique que veio antes de o mapa
  // chegar. O mapa continua mandando em resolveChatLine.
  useEffect(() => {
    if (!chatTarget) return;
    const line = linesById.get(chatTarget.lineId);
    if (line && chatTarget.fallback !== line) {
      setChatTarget((prev) => (prev === chatTarget ? { ...prev, fallback: line } : prev));
    }
  }, [chatTarget, linesById]);

  // Handle deep link - verify access to conversation from URL
  useEffect(() => {
    // Troca de URL (ou desmontagem) no meio da busca: a resposta da URL velha não
    // aplica nada, nem mexe no "carregando" (a execução nova cuida dele).
    let cancelado = false;

    const verifyAndSelectConversation = async () => {
      // Sem conversa na URL: esquece a última processada. Senão o toast, a busca
      // global ou o voltar/avançar para ela seria pulado como "já processado".
      if (!urlConversationId) {
        deepLinkProcessedRef.current = null;
        setIsLoadingDeepLink(false);
        return;
      }

      // A lista já selecionou e marcou antes de navegar (handleSelectConversation).
      if (deepLinkProcessedRef.current === urlConversationId) {
        setIsLoadingDeepLink(false);
        return;
      }

      // Skip if user not loaded yet
      if (!user) return;

      setIsLoadingDeepLink(true);

      try {
        // Query the conversation - RLS will automatically filter by user access
        // Also fetch the associated phone number details to set the theme and context
        const { data: conversation, error } = await supabase
          .from('conversations')
          .select(`
            id,
            contact_name,
            phone_number_id,
            phone_number:phone_numbers (
              id,
              phone_number_id,
              theme_hue,
              connection_type,
              display_name
            )
          `)
          .eq('id', urlConversationId)
          .maybeSingle();

        if (cancelado) return;

        if (error) {
          console.error('Error verifying conversation access:', error);
          navigate('/dashboard', { replace: true });
          return;
        }

        if (!conversation) {
          // No access or conversation doesn't exist - redirect to dashboard
          toast({
            title: "Conversa não encontrada",
            description: "Você não tem acesso a esta conversa ou ela não existe.",
            variant: "destructive",
          });
          navigate('/dashboard', { replace: true });
          return;
        }

        // User has access - select the conversation
        const line = lineMetaFromEmbed(conversation.phone_number);
        const lineId = line?.id ?? conversation.phone_number_id;

        // O mapa pode estar velho: uma linha liberada ou criada depois da última
        // busca ainda não está nele, e a resolução da seleção trataria o número da
        // conversa como inválido (a lista pularia para o primeiro número). Com o
        // mapa pronto e sem a linha, revalida ANTES de selecionar. Com o mapa ainda
        // carregando não espera: a busca em voo já é a revalidação, e o embed dá o
        // número do chat enquanto isso.
        // Só com o embed: ele prova que o usuário enxerga a linha, e uma linha
        // liberada ou criada depois da última busca sempre volta nele. Com o embed
        // nulo a RLS a esconde também do mapa (as duas leituras passam por
        // `phone_numbers_select`), então refazê-lo não a traria, e o mapa fresco só
        // é lido adiante, dentro de `if (line)`: seria um GET à toa antes de abrir.
        // Decidido ANTES do await: depois dele os refs ainda guardam o render de
        // "buscando" (o React Query avisa os observadores num setTimeout(0), depois
        // da continuação), e linesReadyRef já valeria false.
        const mapaPronto = linesReadyRef.current;
        if (line && mapaPronto && !linesByIdRef.current.has(line.id)) {
          await queryClient.refetchQueries({
            queryKey: chaveNumerosAcessiveis(currentOrganization?.id),
            exact: true,
          });
          if (cancelado) return;
        }

        deepLinkProcessedRef.current = urlConversationId;

        // O número da conversa entra no MESMO batch da seleção: o chat nunca
        // aparece com o número de outra conversa. O embed vale de reserva para
        // número fora do mapa (linha desativada, que o mapa não lista).
        if (lineId) {
          setChatTarget({ conversationId: urlConversationId, lineId, fallback: line });
        }
        setSelectedConversationId(urlConversationId);
        setSelectedConversationName(conversation.contact_name || "Conversa");

        // Caixa conjunta: o deep link NUNCA troca a seleção nem o localStorage. A conversa
        // abre pelo chatTarget acima, por cima da lista conjunta (mesmo se for de um número
        // que o usuário tirou dela): o chat já não depende da lista.
        //
        // Modo número: a lista passa a mostrar o número da conversa. Só com o
        // embed, que prova que o usuário enxerga a linha (a RLS libera a conversa
        // atribuída a ele mesmo numa linha que ele não acessa). A escolha fica
        // salva depois que o efeito de resolução confirma que o número vale; aqui
        // gravar seria sobrescrever o número salvo por um que pode ser inválido.
        // Com o mapa pronto, só vira o número da lista o que está nele (o fresco,
        // lido do cache): linha desativada ou de outra org não passa nem por um
        // render, senão a lista busca o número errado, perde os filtros e a
        // resolução ainda a devolve ao salvo (ou ao primeiro, sem localStorage).
        // Com o mapa carregando vale o embed, e a resolução confere depois.
        if (line && !emConjuntaRef.current) {
          const mapaFresco = numerosAcessiveisEmCache(queryClient, currentOrganization?.id);
          const noMapa = mapaFresco?.some((numero) => numero.id === line.id) ?? false;
          if (!mapaPronto || noMapa) setSelectedPhoneNumberId(line.id);
        } else if (line && !mapaPronto) {
          // "Na conjunta" só porque os números ainda não chegaram (modo guardado): se ao
          // chegarem a conjunta não valer (menos de 2 números depois das exclusões), a tela
          // cai no modo número e a lista precisa mostrar o número da conversa, como sempre.
          setLinhaDoDeepLinkPendente(line.id);
        }
      } catch (err) {
        if (cancelado) return;
        console.error('Error in deep link verification:', err);
        navigate('/dashboard', { replace: true });
      } finally {
        if (!cancelado) setIsLoadingDeepLink(false);
      }
    };

    verifyAndSelectConversation();
    return () => {
      cancelado = true;
    };
  }, [urlConversationId, user, navigate, toast, queryClient]);

  // Reset selection when organization changes
  useEffect(() => {
    // Don't reset if we're processing a deep link
    if (isLoadingDeepLink) return;

    // Restaura o número salvo de forma otimista, para a lista já buscar por ele.
    // Quem confere se ele ainda vale é o efeito de resolução logo abaixo, quando
    // a lista de números da org chegar.
    setSelectedPhoneNumberId(lerNumeroSalvo(currentOrganization?.id));

    setSelectedConversationId(null);
    setSelectedConversationName("");
    setChatTarget(null);
    setRefreshTrigger(prev => prev + 1);

    // Clear URL if there was a conversation ID
    if (location.pathname !== '/dashboard') {
      navigate('/dashboard', { replace: true });
    }
  }, [currentOrganization?.id]);

  // Resolve o número selecionado quando os números da org chegam: o atual, se
  // ainda vale; senão o salvo; senão o primeiro. Org sem número fica sem seleção
  // (a lista decide mostrar "org sem número"). Antes isso era o PhoneNumberSelector
  // chamando onSelect no mount, o que fechava a conversa aberta por deep link
  // (escolher número limpa a conversa). Aqui só troca o número, nunca a conversa.
  // Espera o deep link: ele escolhe o número da conversa e o efeito conferiria
  // um número que ainda vai mudar.
  useEffect(() => {
    if (!currentOrganization?.id || !linesReady || isLoadingDeepLink) return;

    // Deep link que chegou com os números carregando e a conjunta só "esperada": com o mapa
    // pronto, a conjunta valendo o descarta (o deep link nunca troca a seleção nela); sem ela,
    // a lista passa para o número da conversa, se ele está no mapa. Entra aqui, e não num efeito
    // à parte, para valer como o número atual: dois setState no mesmo commit ficam com o último.
    const pendente = linhaDoDeepLinkPendente;
    if (pendente) setLinhaDoDeepLinkPendente(null);
    const doDeepLink = pendente && !conjuntaAtiva && linesById.has(pendente) ? pendente : null;

    const saved = lerNumeroSalvo(currentOrganization.id);
    const resolved = resolveSelectedLineId({
      selectedId: doDeepLink ?? selectedPhoneNumberId,
      savedId: saved,
      lineIds: accessibleLines.map((line) => line.id),
    });

    if (resolved !== selectedPhoneNumberId) setSelectedPhoneNumberId(resolved);
    if (resolved !== saved) gravarNumeroSalvo(currentOrganization.id, resolved);
  }, [
    currentOrganization?.id,
    linesReady,
    accessibleLines,
    selectedPhoneNumberId,
    isLoadingDeepLink,
    linhaDoDeepLinkPendente,
    conjuntaAtiva,
    linesById,
  ]);

  // Qual linha a ligação de voz vigia. Um efeito só, em vez de avisar nos três
  // pontos que trocam a linha — e SEM limpar na desmontagem: sair do Dashboard
  // (ir para Configurações, por exemplo) não pode derrubar uma ligação em curso.
  // Com conversa aberta vale o número DELA; sem, o selecionado.
  const { setLine } = useVoiceCalls();
  // Na conjunta sem conversa aberta nenhuma linha é vigiada (nenhum número tem voz hoje).
  const voiceLineId = chatLine?.id ?? (emConjunta ? null : selectedPhoneNumberId);
  const voiceLineIsQr = activeLine?.connectionType === 'qr';
  useEffect(() => {
    setLine(voiceLineId, voiceLineIsQr, user?.id ?? null);
  }, [voiceLineId, voiceLineIsQr, user?.id, setLine]);

  // Update browser tab title with organization name
  useEffect(() => {
    if (currentOrganization?.name) {
      document.title = `Echo · ${currentOrganization.name}`;
    } else {
      document.title = 'Echo';
    }
  }, [currentOrganization]);

  // Só o usuário chega aqui (o seletor não dispara mais sozinho): escolher outro
  // número fecha a conversa aberta, como sempre.
  const handlePhoneSelect = (id: string) => {
    // O número novo vai ao armazenamento ANTES de sair da conjunta: a outra aba reage ao
    // evento do modo e lê echo_last_phone nesse instante. Na ordem inversa ela leria o número
    // antigo e o efeito de resolução o regravaria por cima desta escolha.
    gravarNumeroSalvo(currentOrganization?.id, id);
    // Escolher um número sai da caixa conjunta (a escolha de números dela fica guardada).
    if (caixa.modo === "conjunta") caixa.escolherNumero();
    // Escolha explícita vence o deep link que ficou esperando o mapa de números.
    setLinhaDoDeepLinkPendente(null);
    setSelectedPhoneNumberId(id);
    setSelectedConversationId(null);
    setSelectedConversationName("");

    // Clear URL when phone is selected (deselects conversation)
    if (location.pathname !== '/dashboard') {
      navigate('/dashboard', { replace: true });
    }
  };

  // Qual abertura do diálogo de números da caixa conjunta: "editar" (já na conjunta) ou
  // "ativar" (escolheu o item sem ter 2 números depois das exclusões: salvar também liga).
  const [dialogoConjunta, setDialogoConjunta] = useState<"editar" | "ativar" | null>(null);

  // `fora` são as exclusões que valem depois de ligar (o diálogo as grava no mesmo clique,
  // e `caixa.fora` ainda não as reflete neste render).
  const ativarConjunta = (fora: readonly string[]) => {
    caixa.escolherConjunta();
    setLinhaDoDeepLinkPendente(null);
    // A conversa aberta só fecha se o número dela NÃO fica na conjunta: se fica, a lista
    // a mostra e fechar interromperia o atendente sem motivo.
    const aberta = chatLineId(chatTarget, selectedConversationId);
    if (aberta && numerosDaConjunta(idsAcessiveis, fora).includes(aberta)) return;
    setSelectedConversationId(null);
    setSelectedConversationName("");
    if (location.pathname !== '/dashboard') {
      navigate('/dashboard', { replace: true });
    }
  };

  // O item "Caixa conjunta" do seletor. Sem 2 números depois das exclusões ela não existe:
  // abre a escolha dos números em vez de ligar uma caixa vazia.
  const handleSelecionarConjunta = () => {
    // Mapa de números ainda carregando (ou em erro): não há o que escolher ainda. Só liga o
    // modo; `aguardandoNumeros` segura o escopo até o mapa chegar, e com menos de 2 números
    // depois dele a tela cai no modo número. Sem `ativarConjunta`, a conversa aberta não fecha.
    if (!linesReady && accessibleLines.length === 0) {
      caixa.escolherConjunta();
      return;
    }
    if (!conjuntaDisponivel(idsAcessiveis, caixa.fora)) {
      setDialogoConjunta("ativar");
      return;
    }
    ativarConjunta(caixa.fora);
  };

  // Handle conversation selection - update URL.
  // `lineId` é o número DA CONVERSA (a linha da lista já o traz). Com ele a
  // seleção e o número do chat entram no mesmo batch, e o deep link não precisa
  // rodar. Sem ele (conversa que a lista não achou), só navega e deixa o efeito
  // de deep link descobrir o número, como em handleOpenConversationById.
  const handleSelectConversation = useCallback((id: string, name?: string, lineId?: string | null) => {
    if (lineId) {
      // Retrato do número neste instante: se a linha sair do mapa depois (um admin
      // a desativa com a conversa aberta), o chat segue com os dados com que abriu.
      // Sem o mapa ainda, vale a reserva anterior, e só se for do mesmo número.
      const retrato = linesByIdRef.current.get(lineId) ?? null;
      setChatTarget((prev) => ({
        conversationId: id,
        lineId,
        fallback: retrato ?? (prev?.fallback?.id === lineId ? prev.fallback : null),
      }));
      setSelectedConversationId(id);
      setSelectedConversationName(name || "Conversa");
      deepLinkProcessedRef.current = id;
    } else if (deepLinkProcessedRef.current === id) {
      // Sem isto o efeito pularia a conversa como "já processada" e nada abriria.
      deepLinkProcessedRef.current = null;
    }
    // Update URL to include conversation ID (don't replace so back button works)
    navigate(`/dashboard/${id}`);
  }, [navigate]);

  /**
   * Abre uma conversa que já existe, pelo id (vínculo participante -> 1:1).
   *
   * Navega SEM marcar deepLinkProcessedRef de propósito: é o effect de deep-link
   * que valida o acesso e troca o número selecionado e o do chat, e a conversa
   * 1:1 pode estar em OUTRO número conectado da organização. Usar
   * handleSelectConversation aqui faria o effect ser pulado e a conversa abriria
   * no contexto do número errado.
   */
  const handleOpenConversationById = useCallback(
    (id: string) => {
      navigate(`/dashboard/${id}`);
    },
    [navigate]
  );

  // Mobile: go back to conversation list
  const handleMobileBack = useCallback(() => {
    setSelectedConversationId(null);
    setSelectedConversationName("");
    // replace: fechar não empilha outra entrada sobre /dashboard/<id>. Senão o
    // Voltar do histórico cai na URL da conversa, e o efeito de deep link a
    // reabre (e a marca como lida, com o recibo de leitura se a linha o manda).
    navigate('/dashboard', { replace: true });
  }, [navigate]);

  // Escape em cascata, decidido num único lugar: Radix (overlays) consome
  // antes e marca defaultPrevented → senão a coluna da direita fecha (interceptor do
  // ChatArea) → senão desseleciona a conversa.
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedConversationId;
  const mobileBackRef = useRef(handleMobileBack);
  mobileBackRef.current = handleMobileBack;
  const escapeInterceptorRef = useRef<(() => boolean) | null>(null);
  // Tecla resolve na hora: o Esc fecha o painel mobile sem os 300ms do slide
  // (o gesto e o botão Voltar continuam animando). Ref, não state: é lida no
  // render disparado pelo próprio fechamento e zerada logo depois.
  const instantCloseRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (escapeInterceptorRef.current?.()) {
        e.preventDefault();
        return;
      }
      if (selectedIdRef.current) {
        e.preventDefault();
        instantCloseRef.current = true;
        mobileBackRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- Painel mobile do chat: slide + swipe-back de borda ---
  // Mantém o último id vivo durante o slide-out, para o conteúdo não sumir no
  // meio da animação de saída.
  const lastConversationIdRef = useRef<string | null>(null);
  if (selectedConversationId) lastConversationIdRef.current = selectedConversationId;

  const [chatMounted, setChatMounted] = useState(false);
  useEffect(() => {
    if (!isMobile) return;
    if (selectedConversationId) {
      setChatMounted(true);
      return;
    }
    // O fechamento (instantâneo ou não) já foi pintado; a próxima abertura anima.
    instantCloseRef.current = false;
    // Desmonta só depois do slide-out (320ms > 300ms da transição): o unmount
    // do ChatArea é o que limpa o activeConversationId das notificações.
    const timer = setTimeout(() => setChatMounted(false), 320);
    return () => clearTimeout(timer);
  }, [selectedConversationId, isMobile]);

  // Swipe-from-edge para voltar (padrão iOS): handlers no PRÓPRIO painel (uma
  // faixa sobreposta criava zona morta sobre composer/bolhas). Só arma quando
  // o toque nasce nos 24px da borda esquerda, e uma trava de eixo solta o
  // gesto se ele for vertical (o scroll nativo segue vivo — nada é prevented).
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const edgeSwipeRef = useRef({
    dragging: false,
    axis: null as "x" | "y" | null,
    startX: 0,
    startY: 0,
    dx: 0,
    startedAt: 0,
  });

  const handleEdgeTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (touch.clientX > 24) return; // não é gesto de borda
    edgeSwipeRef.current = {
      dragging: true,
      axis: null,
      startX: touch.clientX,
      startY: touch.clientY,
      dx: 0,
      startedAt: performance.now(),
    };
  };

  const handleEdgeTouchMove = (e: React.TouchEvent) => {
    const drag = edgeSwipeRef.current;
    if (!drag.dragging) return;
    const touch = e.touches[0];
    const rawDx = touch.clientX - drag.startX;
    const rawDy = touch.clientY - drag.startY;

    // Trava de eixo na primeira intenção clara: vertical = scroll, não back.
    if (!drag.axis) {
      if (Math.abs(rawDx) < 6 && Math.abs(rawDy) < 6) return;
      drag.axis = Math.abs(rawDx) > Math.abs(rawDy) ? "x" : "y";
      if (drag.axis === "x" && chatPanelRef.current) {
        chatPanelRef.current.style.transition = "none";
      }
    }
    if (drag.axis !== "x") return;

    const dx = Math.max(0, rawDx);
    drag.dx = dx;
    if (chatPanelRef.current) chatPanelRef.current.style.transform = `translateX(${dx}px)`;
  };

  const handleEdgeTouchEnd = () => {
    const drag = edgeSwipeRef.current;
    if (!drag.dragging) return;
    drag.dragging = false;
    const panel = chatPanelRef.current;
    if (!panel || drag.axis !== "x") return;

    const elapsedMs = Math.max(1, performance.now() - drag.startedAt);
    const velocity = drag.dx / elapsedMs; // px/ms
    const commit = drag.dx > 80 || velocity > 0.35;

    if (commit) {
      // Continua do ponto atual até fora da tela e só então navega de volta.
      // Os estilos inline só saem DEPOIS de o React ter aplicado a classe
      // translate-x-full — limpá-los antes fazia o painel voltar por 1 frame.
      let finished = false;
      const finish = (e?: TransitionEvent) => {
        if (e && (e.target !== panel || e.propertyName !== "transform")) return;
        if (finished) return;
        finished = true;
        panel.removeEventListener("transitionend", finish);
        handleMobileBack();
        window.setTimeout(() => {
          panel.style.transition = "";
          panel.style.transform = "";
        }, 400);
      };
      panel.style.transition = "transform 260ms cubic-bezier(0.32, 0.72, 0, 1)";
      panel.style.transform = "translateX(100%)";
      panel.addEventListener("transitionend", finish);
      window.setTimeout(finish, 320); // fallback se transitionend não disparar
    } else {
      // Solta antes do limiar: volta ao lugar com a mesma curva.
      panel.style.transition = "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)";
      panel.style.transform = "";
      window.setTimeout(() => {
        panel.style.transition = "";
      }, 240);
    }
  };

  // Sync state with URL when browser back/forward is pressed
  useEffect(() => {
    // If URL has no conversation ID but state has one, clear it
    if (!urlConversationId && selectedConversationId && !isLoadingDeepLink) {
      setSelectedConversationId(null);
      setSelectedConversationName("");
    }
  }, [urlConversationId, isLoadingDeepLink]);

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        setUser(session.user);
      }
    };

    checkAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setUser(session.user);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => {
    try {
      await supabase.auth.signOut();
      queryClient.clear();
      // A lista de conversas vive num cache de módulo (sobrevive ao unmount):
      // sem limpar, o próximo login veria a lista do usuário anterior.
      conversationListCache.clear();
      toast({
        title: "Sessão encerrada",
        description: "Você saiu da sua conta.",
      });
      navigate("/auth");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      toast({
        title: "Não foi possível fazer logout",
        description: errorMessage,
        variant: "destructive",
      });
      // Force navigation even if error occurs, to ensure user can exit
      navigate("/auth");
    }
  };

  const handleConversationUpdate = useCallback((clearSelection = true) => {
    setRefreshConversationId(selectedConversationId);
    if (clearSelection) {
      setSelectedConversationId(null);
      setSelectedConversationName("");
      // Clear URL when conversation is cleared
      if (location.pathname !== '/dashboard') {
        navigate('/dashboard', { replace: true });
      }
    }
    setRefreshTrigger(prev => prev + 1);
  }, [location.pathname, navigate, selectedConversationId]);

  // A conversa aberta deixou de ser visível (a RLS devolve 0 linhas: outra pessoa a
  // assumiu). A lista já foi atualizada pelo ChatArea; aqui só avisa e sai dela.
  const handleConversationInaccessible = useCallback((conversationId: string) => {
    toast({
      title: "Esta conversa não está mais com você",
      description: "Ela foi assumida por outra pessoa ou saiu do seu acesso.",
      variant: "destructive",
    });
    setSelectedConversationId((atual) => (atual === conversationId ? null : atual));
    setSelectedConversationName("");
    if (location.pathname !== '/dashboard') {
      navigate('/dashboard', { replace: true });
    }
  }, [location.pathname, navigate, toast]);

  // Handle navigation to a conversation by phone number (e.g., from contact card "Iniciar conversa").
  // Procura e cria pelo número da conversa ABERTA (é de onde o atendente chamou),
  // e não pelo selecionado: os dois podem ser diferentes.
  const handleNavigateToConversation = useCallback(async (phone: string, name: string) => {
    // Só há número do chat com conversa aberta: sem ela não há de onde chamar.
    const aberta = chatLineId(chatTarget, selectedConversationId);
    // O número da conversa só serve se o atendente enxerga a linha (o mapa, ou o
    // retrato do embed). A RLS libera a conversa atribuída a ele numa linha que ele
    // não acessa (embed nulo): buscar e criar nela dá 42501 sempre, e tentar de novo
    // não adianta. Aí vale o número selecionado, como antes de o chat seguir a
    // conversa. Na caixa conjunta não: o selecionado é só o último número único, guardado
    // e invisível (a tela mostra "Caixa conjunta"), e criar a conversa nele seria usar um
    // número que o atendente não escolheu.
    const emConjuntaAgora = emConjuntaRef.current;
    const reserva = emConjuntaAgora ? null : selectedPhoneNumberId;
    const lineId = aberta
      ? (resolveChatLine(chatTarget, selectedConversationId, linesByIdRef.current)?.id ?? reserva)
      : null;
    if (!lineId) {
      toast({
        title: emConjuntaAgora ? "Não foi possível abrir a conversa" : "Nenhum número selecionado",
        description: emConjuntaAgora
          ? "Não foi possível saber o número desta conversa. Use Nova conversa e escolha o número."
          : "Escolha um número para abrir a conversa.",
        variant: "destructive",
      });
      return;
    }

    try {
      // A leading "+" is the user's signal that the number already includes a
      // country code (e.g. "+34 622…" for Spain). Without "+", we keep the
      // legacy assumption that 10–11 digit inputs are Brazilian and prepend 55.
      const trimmedPhone = phone.trim();
      const hasIntlPrefix = trimmedPhone.startsWith('+');
      const normalizedPhone = trimmedPhone.replace(/\D/g, '');

      const phoneForStorage = hasIntlPrefix
        ? normalizedPhone
        : (normalizedPhone.startsWith('55') || normalizedPhone.length > 11
            ? normalizedPhone
            : '55' + normalizedPhone);

      // A RPC acha a conversa mesmo quando a RLS a esconde de quem chama (conversa
      // assumida por outra atendente): a busca direta devolvia 0 linhas e o fluxo
      // caía no INSERT.
      const achada = await buscarConversaDoTelefone(lineId, phoneForStorage);

      if (achada.tipo === 'de_outra') {
        toast({ ...avisoConversaDeOutra(achada.dono), variant: "destructive" });
        return;
      }

      if (achada.tipo === 'visivel') {
        // Navigate to existing conversation
        handleSelectConversation(achada.id, name, lineId);
        toast({
          title: "Conversa encontrada",
          description: `Abrindo conversa com ${name}`,
        });
      } else {
        // Create new conversation
        const { data: newConv, error: createError } = await supabase
          .from('conversations')
          .insert({
            contact_phone: phoneForStorage,
            contact_name: name || phoneForStorage,
            phone_number_id: lineId,
            whatsapp_id: `${phoneForStorage}_${lineId}`,
            status: 'active'
          })
          .select('id')
          .single();

        if (createError) {
          console.error('Error creating conversation:', createError);
          throw createError;
        }

        // Refresh conversation list and navigate
        setRefreshTrigger(prev => prev + 1);
        handleSelectConversation(newConv.id, name, lineId);
        toast({
          title: "Conversa criada",
          description: `Nova conversa com ${name}`,
        });
      }
    } catch (error: any) {
      console.error('Error navigating to conversation:', error);
      toast({
        title: "Não foi possível abrir a conversa",
        description: toUserMessage(error, "Tente de novo em instantes."),
        variant: "destructive",
      });
    }
  }, [chatTarget, selectedConversationId, selectedPhoneNumberId, handleSelectConversation, toast]);

  if (!user) return null;

  // A escolha dos números da caixa conjunta. Salvar grava as exclusões; quando veio do item
  // "Caixa conjunta" sem 2 números disponíveis, salvar também liga a conjunta.
  const dialogoDaConjunta = (
    <CaixaConjuntaDialog
      open={dialogoConjunta !== null}
      onOpenChange={(open) => {
        if (!open) setDialogoConjunta(null);
      }}
      numeros={accessibleLines}
      fora={caixa.fora}
      onSalvar={(fora) => {
        caixa.salvarFora(fora);
        if (dialogoConjunta === "ativar") ativarConjunta(fora);
      }}
    />
  );

  // Mobile layout: lista sempre montada (sem refetch ao voltar) e chat num
  // painel que desliza da direita — antes era um corte seco de display:none.
  if (isMobile) {
    const showChat = !!selectedConversationId;
    const chatConversationId = selectedConversationId ?? lastConversationIdRef.current;
    // Só as props do ChatArea usam a conversa que atrasa por causa do slide: o
    // painel ainda mostra a conversa que saiu, então precisa do número DELA.
    const paneLine = lineFor(chatConversationId);

    return (
      <div className="h-dvh flex flex-col bg-background overflow-hidden relative">
        <FeedbackPopup />
        <FeatureAnnouncementDialog userId={user.id} />
        {dialogoDaConjunta}
        {/* Lista: recua 25% e esmaece quando o chat abre (push-from-right).
            inert (além do aria-hidden): sem display:none, os inputs/botões da
            lista continuariam tabuláveis atrás do painel opaco. */}
        <div
          className={cn(
            "flex-1 flex flex-col overflow-hidden transition-[transform,opacity] duration-300 ease-drawer",
            showChat && "pointer-events-none -translate-x-1/4 opacity-60",
          )}
          aria-hidden={showChat}
          {...(showChat ? { inert: "" } : {})}
        >
          <div className="flex-1 overflow-hidden pb-bottom-nav">
            <ConversationsList
              userId={user.id}
              user={user}
              onSignOut={handleSignOut}
              selectedConversationId={selectedConversationId}
              onSelectConversation={handleSelectConversation}
              onDeselectConversation={handleMobileBack}
              refreshTrigger={refreshTrigger}
              refreshConversationId={refreshConversationId}
              escopo={escopo}
              numeroUnico={numeroUnico}
              metaPhoneNumberId={emConjunta ? null : selectedLine?.metaPhoneNumberId ?? null}
              onPhoneSelect={handlePhoneSelect}
              isQrConnection={!emConjunta && selectedLine?.connectionType === 'qr'}
              conjunta={emConjunta}
              numerosDaConjunta={accessibleLines.length > 0 ? idsDaConjunta : undefined}
              onSelecionarConjunta={handleSelecionarConjunta}
              onEscolherNumeros={() => setDialogoConjunta("editar")}
              numeroDaConversaAberta={emConjunta ? chatLineId(chatTarget, selectedConversationId) : null}
              numerosEmErro={numerosEmErro}
              escopoPendente={aguardandoNumeros}
              onTentarNumerosNovamente={tentarNumerosNovamente}
              isMobileView={true}
            />
          </div>
          <BottomNavigation />
        </div>

        {/* Painel do chat: entra/sai por transform (300ms ease-drawer); o
            conteúdo permanece montado durante o slide-out (ver chatMounted). */}
        <div
          ref={chatPanelRef}
          className={cn(
            "absolute inset-0 z-30 flex flex-col bg-background",
            instantCloseRef.current ? "transition-none" : "transition-transform duration-300 ease-drawer",
            showChat ? "translate-x-0" : "translate-x-full pointer-events-none",
          )}
          aria-hidden={!showChat}
          {...(!showChat ? { inert: "" } : {})}
          onTouchStart={handleEdgeTouchStart}
          onTouchMove={handleEdgeTouchMove}
          onTouchEnd={handleEdgeTouchEnd}
          onTouchCancel={handleEdgeTouchEnd}
        >
          {chatMounted && chatConversationId && (
            <>
              <ChatArea
                escapeInterceptorRef={escapeInterceptorRef}
                conversationId={chatConversationId}
                userId={user.id}
                agentEmail={user.email}
                onConversationUpdate={handleConversationUpdate}
                onConversationInaccessible={handleConversationInaccessible}
                phoneNumberId={paneLine?.metaPhoneNumberId ?? null}
                phoneNumberDbId={paneLine?.id ?? idSemMapa(chatConversationId)}
                isQrConnection={paneLine?.connectionType === 'qr'}
                isFreeTextChannel={paneLine?.connectionType === 'qr'}
                numeroNome={paneLine?.displayName ?? null}
                numeroHue={paneLine?.themeHue ?? null}
                onNavigateToConversation={handleNavigateToConversation}
                onOpenConversation={handleOpenConversationById}
                onMobileBack={handleMobileBack}
              />
            </>
          )}
        </div>
      </div>
    );
  }

  // Desktop layout: side by side
  return (
    <div className="h-screen flex flex-col bg-background">
      <FeedbackPopup />
      <FeatureAnnouncementDialog userId={user.id} />
      {dialogoDaConjunta}
      <div className="flex-1 flex overflow-hidden">
        {/* onDeselectConversation = handleMobileBack: apesar do nome, ele já é o
            desselecionar genérico — é ele que a cascata de Escape chama no
            desktop. */}
        <ResizableListColumn>
          <ConversationsList
            userId={user.id}
            user={user}
            onSignOut={handleSignOut}
            selectedConversationId={selectedConversationId}
            onSelectConversation={handleSelectConversation}
            onDeselectConversation={handleMobileBack}
            refreshTrigger={refreshTrigger}
            refreshConversationId={refreshConversationId}
            escopo={escopo}
            numeroUnico={numeroUnico}
            metaPhoneNumberId={emConjunta ? null : selectedLine?.metaPhoneNumberId ?? null}
            onPhoneSelect={handlePhoneSelect}
            isQrConnection={!emConjunta && selectedLine?.connectionType === 'qr'}
            conjunta={emConjunta}
            numerosDaConjunta={accessibleLines.length > 0 ? idsDaConjunta : undefined}
            onSelecionarConjunta={handleSelecionarConjunta}
            onEscolherNumeros={() => setDialogoConjunta("editar")}
            numeroDaConversaAberta={emConjunta ? chatLineId(chatTarget, selectedConversationId) : null}
            numerosEmErro={numerosEmErro}
            escopoPendente={aguardandoNumeros}
            onTentarNumerosNovamente={tentarNumerosNovamente}
          />
        </ResizableListColumn>
        <ChatArea
                escapeInterceptorRef={escapeInterceptorRef}
          conversationId={selectedConversationId}
          userId={user.id}
          agentEmail={user.email}
          onConversationUpdate={handleConversationUpdate}
          onConversationInaccessible={handleConversationInaccessible}
          phoneNumberId={chatLine?.metaPhoneNumberId ?? null}
          phoneNumberDbId={chatLine?.id ?? idSemMapa(selectedConversationId)}
          isQrConnection={chatLine?.connectionType === 'qr'}
          isFreeTextChannel={chatLine?.connectionType === 'qr'}
          numeroNome={chatLine?.displayName ?? null}
          numeroHue={chatLine?.themeHue ?? null}
          onNavigateToConversation={handleNavigateToConversation}
          onOpenConversation={handleOpenConversationById}
        />
      </div>
    </div>
  );
};

export default Dashboard;
