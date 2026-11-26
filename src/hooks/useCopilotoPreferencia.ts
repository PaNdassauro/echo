import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Preferência pessoal do copiloto (`profiles.copiloto_enabled`), ligada em
 * Configurações > Perfil. Nasce desligada.
 *
 * Leitura em consulta própria, e não no `select('*')` do perfil, de propósito:
 * enquanto a migração não estiver aplicada a coluna não existe, e a falha aqui
 * vira "desligado" sem derrubar mais nada.
 */
export const copilotoPreferenciaKey = (userId: string | null | undefined) =>
  ["copiloto-preferencia", userId ?? null] as const;

async function lerPreferencia(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("profiles")
    .select("copiloto_enabled")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.warn("[copiloto] preferência indisponível, seguindo desligado:", error.message);
    return false;
  }
  return data?.copiloto_enabled === true;
}

export function useCopilotoPreferencia(userId: string | null | undefined) {
  const queryClient = useQueryClient();
  const key = copilotoPreferenciaKey(userId);

  const query = useQuery({
    queryKey: key,
    queryFn: () => lerPreferencia(userId as string),
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
  });

  const mutation = useMutation({
    mutationFn: async (ligado: boolean) => {
      if (!userId) throw new Error("Sessão expirada. Entre de novo.");
      const { data, error } = await supabase
        .from("profiles")
        .update({ copiloto_enabled: ligado })
        .eq("id", userId)
        .select("id");
      if (error) throw error;
      // UPDATE que não casa linha não é erro no PostgREST: conferir.
      if (!data || data.length === 0) throw new Error("Perfil não encontrado.");
      return ligado;
    },
    onMutate: async (ligado) => {
      await queryClient.cancelQueries({ queryKey: key });
      const anterior = queryClient.getQueryData<boolean>(key);
      queryClient.setQueryData(key, ligado);
      return { anterior };
    },
    onError: (_erro, _ligado, ctx) => {
      queryClient.setQueryData(key, ctx?.anterior ?? false);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  return {
    ligado: query.data === true,
    carregando: query.isLoading,
    alterar: mutation.mutateAsync,
    alterando: mutation.isPending,
  };
}
