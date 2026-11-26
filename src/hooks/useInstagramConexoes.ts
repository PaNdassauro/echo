import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { checkEdgeFunctionResponseAsync } from "@/lib/utils";
import {
  instagramConexoesSchema,
  linkDeConexaoSchema,
  mensagemDoInstagram,
  type InstagramConexao,
} from "@/lib/instagramConexoes";

const CHAVE = ["instagram-conexoes"] as const;

/** Linhas Instagram das organizações do usuário (sem token). */
export function useInstagramConexoes() {
  return useQuery({
    queryKey: CHAVE,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<InstagramConexao[]> => {
      const { data, error } = await supabase.rpc("instagram_listar_conexoes");
      if (error) {
        console.error("[Instagram] instagram_listar_conexoes:", error);
        throw new Error("Não deu para carregar as linhas Instagram.");
      }
      const parsed = instagramConexoesSchema.safeParse(data ?? []);
      if (!parsed.success) {
        console.error("[Instagram] Resposta fora do contrato:", parsed.error.issues);
        throw new Error("Resposta inesperada ao carregar as linhas Instagram.");
      }
      return parsed.data;
    },
  });
}

/** Linha QR/API → linha Instagram que divide a caixa com ela. */
export function useInstagramDaLinha(linhaId: string | null | undefined): InstagramConexao | null {
  const { data } = useInstagramConexoes();
  if (!linhaId) return null;
  return data?.find((c) => c.linha_id === linhaId) ?? null;
}

export type ConfigurarConexao = { id: string; ligada?: boolean; nome?: string; linha?: string };

export function useConfigurarInstagram() {
  const queryClient = useQueryClient();
  return useMutation({
    // Ligar/desligar responde na hora: o switch muda antes da RPC e volta se ela falhar.
    onMutate: async ({ id, ligada }: ConfigurarConexao) => {
      if (ligada === undefined) return { anterior: undefined };
      await queryClient.cancelQueries({ queryKey: CHAVE });
      const anterior = queryClient.getQueryData<InstagramConexao[]>(CHAVE);
      queryClient.setQueryData<InstagramConexao[]>(CHAVE, (lista) =>
        lista?.map((c) => (c.id === id ? { ...c, ligada, modo: ligada ? "on" : "off" } : c)),
      );
      return { anterior };
    },
    onError: (_erro, _pedido, contexto) => {
      if (contexto?.anterior) queryClient.setQueryData(CHAVE, contexto.anterior);
    },
    mutationFn: async ({ id, ligada, nome, linha }: ConfigurarConexao): Promise<void> => {
      const { error } = await supabase.rpc("instagram_configurar_conexao", {
        p_conexao: id,
        ...(ligada !== undefined ? { p_ligada: ligada } : {}),
        ...(nome !== undefined ? { p_nome: nome } : {}),
        ...(linha !== undefined ? { p_linha: linha } : {}),
      });
      if (error) {
        console.error("[Instagram] instagram_configurar_conexao:", error);
        throw new Error(mensagemDoInstagram(error, "Não deu para salvar. Tente de novo."));
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CHAVE }),
  });
}

export function useDesconectarInstagram() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.rpc("instagram_desconectar", { p_conexao: id });
      if (error) {
        console.error("[Instagram] instagram_desconectar:", error);
        throw new Error(mensagemDoInstagram(error, "Não deu para desconectar. Tente de novo."));
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CHAVE }),
  });
}

/** Pede o link do login do Instagram para a linha QR/API escolhida e vai para ele. */
export function useIniciarConexaoInstagram() {
  return useMutation({
    mutationFn: async (linhaId: string): Promise<string> => {
      const result = await supabase.functions.invoke("instagram-conexao", {
        body: { acao: "iniciar", linha: linhaId },
      });
      const corpo = await checkEdgeFunctionResponseAsync<unknown>(result);
      const parsed = linkDeConexaoSchema.safeParse(corpo);
      if (!parsed.success) {
        console.error("[Instagram] instagram-conexao fora do contrato:", parsed.error.issues);
        throw new Error("Resposta inesperada ao pedir o link do Instagram.");
      }
      return parsed.data.url;
    },
    onSuccess: (url) => {
      window.location.assign(url);
    },
  });
}
