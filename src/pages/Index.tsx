import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { consultarPrecisaSetup } from "@/lib/primeiroAcesso";

type Destino = "/setup" | "/dashboard" | "/auth";

/**
 * Descobre para onde a raiz leva: instalação nova → /setup; com sessão →
 * /dashboard; senão /auth. Falha ao consultar o primeiro acesso conta como
 * "já configurada": na dúvida, a tela de login.
 */
async function resolverDestino(sinal: AbortSignal): Promise<Destino | null> {
  const precisaSetup = await consultarPrecisaSetup(sinal);
  if (sinal.aborted) return null;
  if (precisaSetup) return "/setup";

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (sinal.aborted) return null;
    return session ? "/dashboard" : "/auth";
  } catch (erro) {
    console.error("[index] não foi possível ler a sessão:", erro);
    return sinal.aborted ? null : "/auth";
  }
}

const Index = () => {
  const [destino, setDestino] = useState<Destino | null>(null);

  // O link de nova senha cai aqui quando o domínio de quem pediu não está na
  // lista de redirecionamentos do Auth (o Supabase troca pelo endereço raiz).
  const temTokenHash = new URLSearchParams(window.location.search).has("token_hash");

  useEffect(() => {
    if (temTokenHash) return;
    const controle = new AbortController();
    void resolverDestino(controle.signal).then((proximo) => {
      if (proximo) setDestino(proximo);
    });
    return () => controle.abort();
  }, [temTokenHash]);

  if (temTokenHash) {
    return <Navigate to={`/auth${window.location.search}`} replace />;
  }

  if (destino) return <Navigate to={destino} replace />;

  return (
    <div className="min-h-dvh bg-background flex items-center justify-center" role="status" aria-label="Carregando">
      <Loader2 className="w-8 h-8 animate-spin text-primary" aria-hidden="true" />
    </div>
  );
};

export default Index;
