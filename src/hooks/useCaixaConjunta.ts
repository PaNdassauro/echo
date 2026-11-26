import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

/**
 * Escolha da caixa conjunta NESTE aparelho (localStorage, por usuário e organização).
 *
 * Duas chaves, de propósito separadas de `echo_last_phone_<org>` (que segue só com o
 * UUID do último número): um bundle velho lê essa chave como uuid e nunca pode
 * receber um sentinela.
 *  - `echo_caixa_modo_<user>_<org>` = "conjunta"; ausente = modo número;
 *  - `echo_caixa_fora_<user>_<org>` = JSON com os uuids que o usuário TIROU. Guardar
 *    exclusões (e não os marcados) faz um número novo liberado entrar sozinho.
 *
 * O estado nasce SÍNCRONO do localStorage: uma montagem nova (clique numa
 * notificação push) precisa saber o modo antes do efeito de deep link decidir se
 * troca de número. Todo acesso tem try/catch (modo privado, cota): sem
 * armazenamento a escolha só vale nesta sessão.
 */

export type ModoDaCaixa = "numero" | "conjunta";

const VALOR_CONJUNTA = "conjunta";

export const chaveModoDaCaixa = (userId: string, orgId: string) => `echo_caixa_modo_${userId}_${orgId}`;
export const chaveForaDaCaixa = (userId: string, orgId: string) => `echo_caixa_fora_${userId}_${orgId}`;

const foraSchema = z.array(z.string().uuid());

const SEM_EXCLUSOES: readonly string[] = [];

/** Lê o JSON de exclusões; qualquer coisa fora do contrato vira lista vazia (tudo entra). */
export function lerForaDaCaixa(bruto: string | null): string[] {
  if (!bruto) return [];
  try {
    const parsed = foraSchema.safeParse(JSON.parse(bruto));
    return parsed.success ? Array.from(new Set(parsed.data)) : [];
  } catch {
    return [];
  }
}

interface EstadoDaCaixa {
  /** `<user>_<org>` de onde o estado foi lido; null sem usuário ou organização. */
  chave: string | null;
  modo: ModoDaCaixa;
  fora: readonly string[];
}

const chaveDoEstado = (userId: string | null | undefined, orgId: string | null | undefined) =>
  userId && orgId ? `${userId}_${orgId}` : null;

function lerEstado(userId: string | null | undefined, orgId: string | null | undefined): EstadoDaCaixa {
  const chave = chaveDoEstado(userId, orgId);
  if (!chave || !userId || !orgId) return { chave, modo: "numero", fora: SEM_EXCLUSOES };
  let modo: ModoDaCaixa = "numero";
  let bruto: string | null = null;
  try {
    modo = localStorage.getItem(chaveModoDaCaixa(userId, orgId)) === VALOR_CONJUNTA ? "conjunta" : "numero";
    bruto = localStorage.getItem(chaveForaDaCaixa(userId, orgId));
  } catch {
    // Sem armazenamento: modo número e nenhuma exclusão.
  }
  const fora = lerForaDaCaixa(bruto);
  return { chave, modo, fora: fora.length > 0 ? fora : SEM_EXCLUSOES };
}

const mesmoConteudo = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export interface CaixaConjuntaEscolhida {
  modo: ModoDaCaixa;
  /** Os uuids que o usuário tirou da caixa conjunta (referência estável enquanto não mudam). */
  fora: readonly string[];
  /** Liga a caixa conjunta. */
  escolherConjunta: () => void;
  /** Volta ao modo número (o último número fica em `echo_last_phone_<org>`, que não é daqui). */
  escolherNumero: () => void;
  /** Grava os números que ficam FORA da conjunta. */
  salvarFora: (ids: readonly string[]) => void;
}

export function useCaixaConjunta(
  orgId: string | null | undefined,
  userId: string | null | undefined,
  /**
   * Chamado quando OUTRA aba muda o modo (evento `storage`), no mesmo lote da atualização do
   * estado. Quem usa decide o que fazer com o número guardado: sem isto, sair da conjunta em
   * outra aba deixaria esta mostrando um número antigo e o regravaria por cima da escolha nova.
   */
  onModoExterno?: (modo: ModoDaCaixa) => void,
): CaixaConjuntaEscolhida {
  const chave = chaveDoEstado(userId, orgId);
  const onModoExternoRef = useRef(onModoExterno);
  onModoExternoRef.current = onModoExterno;
  const modoRef = useRef<ModoDaCaixa>("numero");
  const [estado, setEstado] = useState<EstadoDaCaixa>(() => lerEstado(userId, orgId));

  // Usuário ou organização mudou: relê no mesmo render (o React descarta o render
  // atual e refaz com o estado novo), sem um render com a escolha do outro.
  let atual = estado;
  if (estado.chave !== chave) {
    atual = lerEstado(userId, orgId);
    setEstado(atual);
  }

  modoRef.current = atual.modo;

  // Aplica só o que veio, em cima do estado MAIS NOVO (função de atualização): duas chamadas
  // no mesmo handler (salvar as exclusões e ligar a conjunta) não pisam uma na outra.
  const aplicar = useCallback(
    (novo: Partial<Pick<EstadoDaCaixa, "modo" | "fora">>) => {
      setEstado((prev) => {
        if (prev.chave !== chave) return prev;
        const modo = novo.modo ?? prev.modo;
        const fora = novo.fora && !mesmoConteudo(prev.fora, novo.fora) ? novo.fora : prev.fora;
        return prev.modo === modo && fora === prev.fora ? prev : { chave, modo, fora };
      });
    },
    [chave],
  );

  const escolherConjunta = useCallback(() => {
    if (!userId || !orgId) return;
    try {
      localStorage.setItem(chaveModoDaCaixa(userId, orgId), VALOR_CONJUNTA);
    } catch {
      // Vale só nesta sessão.
    }
    aplicar({ modo: "conjunta" });
  }, [userId, orgId, aplicar]);

  const escolherNumero = useCallback(() => {
    if (!userId || !orgId) return;
    try {
      localStorage.removeItem(chaveModoDaCaixa(userId, orgId));
    } catch {
      // Vale só nesta sessão.
    }
    aplicar({ modo: "numero" });
  }, [userId, orgId, aplicar]);

  const salvarFora = useCallback(
    (ids: readonly string[]) => {
      if (!userId || !orgId) return;
      const unicos = Array.from(new Set(ids));
      try {
        if (unicos.length > 0) localStorage.setItem(chaveForaDaCaixa(userId, orgId), JSON.stringify(unicos));
        else localStorage.removeItem(chaveForaDaCaixa(userId, orgId));
      } catch {
        // Vale só nesta sessão.
      }
      aplicar({ fora: unicos.length > 0 ? unicos : SEM_EXCLUSOES });
    },
    [userId, orgId, aplicar],
  );

  // Outra aba mexeu na escolha: acompanha. O evento `storage` só chega nas OUTRAS abas.
  useEffect(() => {
    if (!userId || !orgId) return;
    const chaves = new Set([chaveModoDaCaixa(userId, orgId), chaveForaDaCaixa(userId, orgId)]);
    const onStorage = (e: StorageEvent) => {
      // key null = localStorage.clear().
      if (e.key !== null && !chaves.has(e.key)) return;
      const lido = lerEstado(userId, orgId);
      if (lido.modo !== modoRef.current) onModoExternoRef.current?.(lido.modo);
      aplicar({ modo: lido.modo, fora: lido.fora });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [userId, orgId, aplicar]);

  return { modo: atual.modo, fora: atual.fora, escolherConjunta, escolherNumero, salvarFora };
}
