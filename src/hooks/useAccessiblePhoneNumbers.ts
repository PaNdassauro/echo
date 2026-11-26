import { useQuery, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface AccessiblePhoneNumber {
  id: string;
  displayName: string;
  themeHue: number | null;
  /** O número em si (dígitos), necessário para colocar a própria linha em um grupo. */
  phoneNumber: string;
  /**
   * 'qr' | 'business_api'. Só linha QR participa de grupo — a Cloud API da Meta
   * não tem grupos. O default histórico da coluna é 'business_api', então a
   * checagem é sempre `=== 'qr'`, nunca `!== 'business_api'`.
   */
  connectionType: string | null;
  /**
   * `phone_numbers.phone_number_id`: o id da Meta, que as edges de envio pedem
   * (`id` é o UUID interno). Linha QR guarda `qr_<timestamp>`.
   */
  metaPhoneNumberId: string;
  /**
   * `phone_numbers.sector_isolation_enabled`. Serve só para a UI decidir se
   * mostra o filtro e a aba de setor: quem recorta as conversas é a RLS.
   */
  sectorIsolationEnabled: boolean;
  /**
   * `phone_numbers.sector_follows_owner` ("só quem assumiu vê"): o setor da
   * conversa acompanha o dono no banco. A UI só esconde o Encaminhar para setor,
   * que nessa linha seria passar a conversa para a fila de uma pessoa sem dono.
   */
  sectorFollowsOwner: boolean;
}

/**
 * Prefixo da chave do React Query. Quem edita uma linha (Configurações >
 * Números) invalida por ele, para o nome, a cor e o estado dela chegarem às
 * telas que leem este mapa.
 */
export const NUMEROS_ACESSIVEIS_KEY = ["numeros-acessiveis"] as const;

/**
 * O que quem grava uma linha chama depois do UPDATE: marca como velhos o mapa e a
 * leitura de reserva por id (`useNumeroPorId`) e refaz a busca de quem os observa.
 * Fica aqui, e não copiada em cada painel, para ninguém precisar saber o prefixo.
 */
export const invalidarNumerosAcessiveis = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: NUMEROS_ACESSIVEIS_KEY });

/**
 * Chave do mapa de UMA organização. O hook e quem refaz a busca daquela org
 * (o deep link do Dashboard) montam a chave por aqui, para não divergirem.
 */
export const chaveNumerosAcessiveis = (organizationId: string | null | undefined) =>
  [...NUMEROS_ACESSIVEIS_KEY, organizationId ?? null] as const;

/**
 * Mapa de números da organização que está no cache AGORA, ou null se ainda não
 * carregou. O hook só entrega a lista nova no render seguinte (o React Query
 * avisa os observadores num setTimeout(0), depois da continuação de um
 * `await refetchQueries`), então quem acaba de revalidar e precisa decidir na
 * hora (o deep link do Dashboard) lê por aqui.
 */
export function numerosAcessiveisEmCache(
  queryClient: QueryClient,
  organizationId: string | null | undefined,
): AccessiblePhoneNumber[] | null {
  return queryClient.getQueryData<AccessiblePhoneNumber[]>(chaveNumerosAcessiveis(organizationId)) ?? null;
}

// Referência estável: `data ?? []` criaria um array novo a cada render e
// reexecutaria todo effect que tem a lista nas deps.
const SEM_NUMEROS: AccessiblePhoneNumber[] = [];

/**
 * Linhas que o usuário atual pode consultar, para escolher DE ONDE puxar
 * contatos (ex.: adicionar ao grupo da linha Vendas alguém que só tem
 * conversa na linha Suporte) e para o Dashboard resolver o número de cada
 * conversa (id da Meta, tipo de canal, cor, isolamento por setor).
 *
 * Quem decide o acesso é a RLS: `phone_numbers_select` já resolve
 * `user_has_phone_access(id)` / admin da org, então NÃO replicamos a regra
 * aqui — filtrar de novo no cliente só criaria uma segunda fonte da verdade
 * capaz de divergir da policy.
 *
 * Uma busca só para todos os consumidores (React Query, por organização).
 *
 * O mapa fica no cache durante a sessão (`gcTime: Infinity`): é pequeno (dezenas de
 * linhas por organização) e só a árvore do Dashboard o observa. Com o padrão de
 * 5 min, uma volta por Atendimentos ou Configurações o apagava, enquanto a lista de
 * conversas sobrevive (NotificationContext e cache de módulo): o clique que viesse
 * antes do GET abria o chat sem número. O logout limpa o cache inteiro.
 *
 * Quando a lista é revalidada:
 *  - a cada montagem de quem NÃO desliga `revalidarAoMontar` (default ligado; é o
 *    caso do Dashboard): Configurações desmonta o Dashboard, e o staleTime
 *    sozinho serviria um nome, uma cor ou um isolamento de até 5 minutos atrás;
 *  - pela invalidação de `NUMEROS_ACESSIVEIS_KEY` (`invalidarNumerosAcessiveis`:
 *    PhoneNumbersSettings e QRCodeConnect ao salvar uma linha, e o
 *    SectorIsolationSwitch sozinho, em qualquer painel que o renderize);
 *  - quando fica velha (staleTime de 5 min), na montagem ou ao voltar o foco da
 *    janela;
 *  - a cada 30 s enquanto a última busca falhou, com a janela visível: com
 *    `retry: 1` ela desiste em ~1 s, e o foco do React Query só escuta
 *    `visibilitychange`, então uma queda do banco bem na carga deixaria o chat sem
 *    número até o atendente trocar de aba.
 *
 * `revalidarAoMontar: false` é para quem monta e desmonta muito (o chat no mobile
 * monta a cada conversa aberta, e os diálogos a cada abertura): cada montagem
 * com `"always"` dispara um GET e duas notificações (buscando, parado) a TODO
 * observador do mapa, inclusive o do Dashboard, que renderiza a tela inteira.
 * O custo: uma mudança feita por outro admin (nome, cor, isolamento) chega a
 * esses consumidores com até 5 min de atraso. O isolamento é só da UI: quem
 * recorta as conversas é a RLS.
 *
 * `isLoading`: a primeira carga da sessão em voo (sem dado nenhum ainda).
 * `isReady`: a lista chegou e nenhuma busca está em voo, ou seja, vale decidir
 * coisas a partir dela. Erro na primeira carga: `phoneNumbers` vazio. Erro numa
 * revalidação (montagem, invalidação, foco): mantém a última lista boa, de
 * propósito, porque o chat aberto tira dela o id de envio e o canal
 * (`resolveChatLine`). Nos dois casos `isReady` fica falso: o sinal de falha é
 * `!isReady`, nunca a lista vazia, para ninguém tratar falha de rede como
 * "org sem número".
 * `isError`: a última busca falhou (some no próximo sucesso). Quem espera o mapa para
 * montar a tela o usa para mostrar a falha, em vez de um skeleton eterno.
 */
export function useAccessiblePhoneNumbers(
  organizationId: string | null | undefined,
  enabled = true,
  { revalidarAoMontar = true }: { revalidarAoMontar?: boolean } = {}
): { phoneNumbers: AccessiblePhoneNumber[]; isLoading: boolean; isReady: boolean; isError: boolean } {
  const { data, isLoading, isSuccess, isFetching, isError } = useQuery({
    queryKey: chaveNumerosAcessiveis(organizationId),
    enabled: enabled && !!organizationId,
    staleTime: 5 * 60 * 1000,
    // Fica na sessão: a remontagem usa o que está em cache na hora e revalida por trás.
    gcTime: Infinity,
    refetchOnMount: revalidarAoMontar ? "always" : true,
    retry: 1,
    // Erro não é terminal: sem isto o mapa desistia depois do retry e só voltava com
    // `visibilitychange`/`online` ou um observador novo. `false` fora do erro.
    refetchInterval: (query) => (query.state.status === "error" ? 30_000 : false),
    queryFn: async (): Promise<AccessiblePhoneNumber[]> => {
      const { data: rows, error } = await supabase
        .from("phone_numbers")
        .select(
          "id, display_name, theme_hue, phone_number, connection_type, phone_number_id, sector_isolation_enabled, sector_follows_owner"
        )
        .eq("organization_id", organizationId as string)
        .eq("is_active", true)
        .order("display_name");

      if (error) {
        console.error("[useAccessiblePhoneNumbers] Falha ao carregar linhas:", error);
        throw error;
      }

      return (rows ?? []).map((row) => ({
        id: row.id,
        displayName: row.display_name,
        themeHue: row.theme_hue != null ? Number(row.theme_hue) : null,
        phoneNumber: String(row.phone_number ?? "").replace(/\D/g, ""),
        connectionType: row.connection_type,
        metaPhoneNumberId: row.phone_number_id,
        sectorIsolationEnabled: Boolean(row.sector_isolation_enabled),
        sectorFollowsOwner: Boolean(row.sector_follows_owner),
      }));
    },
  });

  return {
    phoneNumbers: data ?? SEM_NUMEROS,
    isLoading,
    isReady: isSuccess && !isFetching,
    isError,
  };
}

/** O que o chat precisa saber de UM número: o nome (placeholder dos botões) e o isolamento por setor. */
export type LinhaPorId = Pick<AccessiblePhoneNumber, "displayName" | "sectorIsolationEnabled" | "sectorFollowsOwner">;

// Dentro do prefixo do mapa de propósito: quem edita uma linha invalida
// `NUMEROS_ACESSIVEIS_KEY`, e a leitura de reserva chega junto, em vez de ficar
// velha até o staleTime.
const chaveNumeroPorId = (numeroId: string | null) =>
  [...NUMEROS_ACESSIVEIS_KEY, "por-id", numeroId] as const;

/**
 * Nome e isolamento por setor do número `numeroId`: a entrada do mapa ou, quando
 * o mapa não a tem, uma leitura pela PK.
 *
 * O mapa só lista números ATIVOS. A conversa de um número desativado, aberta por
 * deep link, não está nele, e o chat perderia o `{phone_number.display_name}` dos
 * botões de ação e o "Encaminhar para setor" de uma linha com isolamento ligado.
 * `useActionButton` e `useSectors` (os dois montados pelo chat) pedem a MESMA
 * linha, então a leitura é uma query só: o React Query a deduplica entre os dois e
 * não a repete a cada revalidação do mapa (montar de novo, foco, deep link), só
 * quando ela fica velha (5 min) ou quando Configurações invalida o prefixo.
 *
 * Só lê com o mapa pronto: com ele ainda carregando, a linha pode estar nele e a
 * leitura seria gasta à toa. Falha, ou linha que nem a PK mostra (a RLS a
 * esconde), deixa `linha` indefinida: o chat cai em nome vazio e isolamento
 * desligado, que esconde o filtro e nunca abre dado (quem recorta é a RLS).
 *
 * `isLoading` é o da primeira carga do mapa, que o `useSectors` soma ao dele.
 */
export function useNumeroPorId(
  organizationId: string | null | undefined,
  numeroId: string | null,
): { linha: LinhaPorId | undefined; isLoading: boolean } {
  // Sem revalidar a cada montagem: o chat monta a cada conversa aberta no mobile, e
  // cada GET renderizaria o Dashboard de novo (ver o hook acima).
  const { phoneNumbers, isLoading, isReady } = useAccessiblePhoneNumbers(organizationId, true, {
    revalidarAoMontar: false,
  });
  const doMapa = numeroId ? phoneNumbers.find((numero) => numero.id === numeroId) : undefined;

  const { data: lidaPelaPk } = useQuery({
    queryKey: chaveNumeroPorId(numeroId),
    enabled: !!numeroId && isReady && !doMapa,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async (): Promise<LinhaPorId | null> => {
      // `enabled` já exige o id: a guarda é para o tipo.
      if (!numeroId) return null;

      const { data, error } = await supabase
        .from("phone_numbers")
        .select("display_name, sector_isolation_enabled, sector_follows_owner")
        .eq("id", numeroId)
        .maybeSingle();

      if (error) {
        console.error("[useNumeroPorId] Falha ao ler o número:", error);
        throw error;
      }

      return data
        ? {
            displayName: data.display_name,
            sectorIsolationEnabled: Boolean(data.sector_isolation_enabled),
            sectorFollowsOwner: Boolean(data.sector_follows_owner),
          }
        : null;
    },
  });

  return { linha: doMapa ?? lidaPelaPk ?? undefined, isLoading };
}

/**
 * Quantos números ATIVOS a organização tem para este usuário (a RLS recorta pelo
 * acesso). É o par do `.eq("is_active", true)` do mapa acima: o Dashboard decide
 * "org sem número" por ele, e a lista confere por esta contagem. Com recortes
 * diferentes (org só com números desativados), a lista esperaria para sempre uma
 * seleção que o Dashboard já resolveu como nula. Muda nos dois ou em nenhum.
 *
 * `null` quando a consulta falha: quem chama trata como "sem número", como antes
 * da contagem sair de dentro da lista.
 */
export async function contarNumerosAtivos(organizationId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from("phone_numbers")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("is_active", true);

  if (error) console.error("[contarNumerosAtivos] Falha ao contar números ativos:", error);
  return count;
}
