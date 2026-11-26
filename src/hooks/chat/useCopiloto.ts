import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { checkEdgeFunctionResponseAsync } from "@/lib/utils";
import { toUserMessage } from "@/lib/userFacingError";
import {
  copilotoRespostaSchema,
  deveAnalisar,
  ultimaFala,
  type CopilotoMensagem,
  type CopilotoSugestao,
} from "@/lib/copiloto";

/**
 * O que a faixa mostra:
 * - `oculto`: copiloto desligado para o usuário, ou a org sem chave de IA;
 * - `ocioso`: ligado, sem nada a sugerir agora (a vez é do cliente, ou a inbound é antiga);
 * - `lendo`: análise em voo;
 * - `pronto`: sugestões para a última fala do cliente;
 * - `erro`: a análise falhou (tem "tentar de novo").
 */
export type CopilotoEstado =
  | { fase: "oculto" }
  | { fase: "ocioso" }
  | { fase: "lendo" }
  | { fase: "pronto"; momento: string; sugestoes: CopilotoSugestao[] }
  | { fase: "erro"; mensagem: string };

interface Resultado {
  momento: string;
  sugestoes: CopilotoSugestao[];
  /** id da mensagem que era a última fala quando a análise começou. */
  alvoId: string | null;
}

type PorConversa =
  | { fase: "lendo"; geracao: number }
  | { fase: "pronto"; resultado: Resultado }
  | { fase: "erro"; mensagem: string };

/** "Sem chave de IA" vale por um tempo: admin que cadastra a chave não precisa recarregar. */
const SEM_CHAVE_VALE_MS = 10 * 60_000;

/**
 * Memória da sessão, fora do componente: voltar a uma conversa mostra as
 * sugestões que já vieram sem chamar a IA de novo, e "sem chave" (por org) não
 * é perguntado a cada conversa. Toda faixa montada assina `ouvintes`: a resposta
 * de uma análise redesenha quem estiver na tela, mesmo que a faixa que pediu
 * tenha desmontado no meio.
 */
const memoria = {
  porConversa: new Map<string, PorConversa>(),
  analisadas: new Map<string, string>(),
  chamadas: new Map<string, number>(),
  /** org → Date.now() de quando a edge disse `sem_chave`. */
  semChave: new Map<string, number>(),
  geracao: 0,
  ouvintes: new Set<() => void>(),
};

const avisar = () => memoria.ouvintes.forEach((ouvinte) => ouvinte());

function orgSemChave(organizacaoId: string | null): boolean {
  if (!organizacaoId) return false;
  const desde = memoria.semChave.get(organizacaoId);
  if (desde === undefined) return false;
  if (Date.now() - desde > SEM_CHAVE_VALE_MS) {
    memoria.semChave.delete(organizacaoId);
    return false;
  }
  return true;
}

/** Só para teste: zera a memória da sessão. */
export function __zerarMemoriaDoCopiloto() {
  memoria.porConversa.clear();
  memoria.analisadas.clear();
  memoria.chamadas.clear();
  memoria.semChave.clear();
  memoria.geracao = 0;
  memoria.ouvintes.clear();
}

interface UseCopilotoOpcoes {
  conversationId: string | null;
  messages: readonly CopilotoMensagem[];
  /** Preferência do usuário (Configurações > Perfil). */
  ligado: boolean;
  /** Org da conversa: "sem chave de IA" é guardado por org. */
  organizacaoId?: string | null;
}

export function useCopiloto({
  conversationId,
  messages,
  ligado,
  organizacaoId = null,
}: UseCopilotoOpcoes) {
  // A memória vive fora do React; assinar só pede um novo render quando ela muda.
  const [, setVersao] = useState(0);
  useEffect(() => {
    const ouvinte = () => setVersao((v) => v + 1);
    memoria.ouvintes.add(ouvinte);
    return () => {
      memoria.ouvintes.delete(ouvinte);
    };
  }, []);

  const analisar = useCallback(
    async (conversa: string, alvoId: string | null) => {
      const geracao = ++memoria.geracao;
      memoria.porConversa.set(conversa, { fase: "lendo", geracao });
      memoria.chamadas.set(conversa, Date.now());
      // Marcada ANTES da chamada: falha não vira laço; "tentar de novo" é manual.
      if (alvoId) memoria.analisadas.set(conversa, alvoId);
      avisar();

      let proximo: PorConversa | null;
      try {
        const resultado = await supabase.functions.invoke("copiloto", {
          body: { conversationId: conversa },
        });
        const dados = await checkEdgeFunctionResponseAsync(resultado);
        const resposta = copilotoRespostaSchema.safeParse(dados);
        if (!resposta.success) {
          console.error(
            "[copiloto] resposta fora do contrato:",
            resposta.error.issues,
          );
          proximo = {
            fase: "erro",
            mensagem:
              "O copiloto respondeu num formato inesperado. Tente de novo.",
          };
        } else if (resposta.data.status === "indisponivel") {
          if (resposta.data.motivo === "sem_chave" && organizacaoId)
            memoria.semChave.set(organizacaoId, Date.now());
          proximo = null;
        } else {
          proximo = {
            fase: "pronto",
            resultado: {
              momento: resposta.data.momento,
              sugestoes: resposta.data.sugestoes,
              alvoId,
            },
          };
        }
      } catch (erro) {
        console.error("[copiloto] análise falhou:", erro);
        proximo = {
          fase: "erro",
          mensagem: toUserMessage(erro, "Tente de novo em instantes."),
        };
      }

      // Geração: outra análise da mesma conversa começou depois desta? A mais nova manda.
      const atual = memoria.porConversa.get(conversa);
      if (atual?.fase !== "lendo" || atual.geracao !== geracao) return;
      if (proximo) memoria.porConversa.set(conversa, proximo);
      else memoria.porConversa.delete(conversa);
      avisar();
    },
    [organizacaoId],
  );

  // Gatilho automático: cada mudança na lista de mensagens reavalia (e reinicia o debounce).
  const emVoo = conversationId
    ? memoria.porConversa.get(conversationId)?.fase === "lendo"
    : false;
  useEffect(() => {
    if (!ligado || !conversationId || orgSemChave(organizacaoId)) return;
    const decisao = deveAnalisar({
      mensagens: messages,
      ultimaAnalisadaId: memoria.analisadas.get(conversationId) ?? null,
      emVoo,
      ultimaChamadaEm: memoria.chamadas.get(conversationId) ?? null,
      agora: Date.now(),
    });
    if (decisao.tipo !== "analisar") return;
    const timer = setTimeout(
      () => void analisar(conversationId, decisao.alvoId),
      decisao.esperarMs,
    );
    return () => clearTimeout(timer);
  }, [ligado, conversationId, organizacaoId, messages, emVoo, analisar]);

  const atualizar = useCallback(() => {
    if (!conversationId) return;
    if (memoria.porConversa.get(conversationId)?.fase === "lendo") return;
    void analisar(conversationId, ultimaFala(messages)?.id ?? null);
  }, [conversationId, messages, analisar]);

  return {
    estado: estadoVisivel(
      conversationId,
      messages,
      ligado && !orgSemChave(organizacaoId),
    ),
    atualizar,
  };
}

function estadoVisivel(
  conversationId: string | null,
  messages: readonly CopilotoMensagem[],
  ligado: boolean,
): CopilotoEstado {
  if (!ligado || !conversationId) return { fase: "oculto" };
  const atual = memoria.porConversa.get(conversationId);
  if (!atual) return { fase: "ocioso" };
  if (atual.fase === "lendo") return { fase: "lendo" };
  if (atual.fase === "erro") return { fase: "erro", mensagem: atual.mensagem };
  if (!sugestoesValem(messages, atual.resultado.alvoId))
    return { fase: "ocioso" };
  return {
    fase: "pronto",
    momento: atual.resultado.momento,
    sugestoes: atual.resultado.sugestoes,
  };
}

/**
 * Sugestões valem até o atendente falar depois delas (resposta enviada = consumidas).
 * Inbound nova depois do alvo não as derruba: elas ficam até a próxima análise.
 */
function sugestoesValem(
  messages: readonly CopilotoMensagem[],
  alvoId: string | null,
): boolean {
  if (!alvoId) return true;
  const indice = messages.findIndex((m) => m.id === alvoId);
  if (indice < 0) return ultimaFala(messages)?.id === alvoId;
  for (let i = indice + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.direction === "outbound" && !m.is_deleted && ultimaFala([m]))
      return false;
  }
  return true;
}
