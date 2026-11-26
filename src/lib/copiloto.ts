import { z } from "zod";

/**
 * Copiloto de respostas: contrato da edge `copiloto` e a regra de QUANDO analisar.
 *
 * A faixa acima do composer lê a conversa aberta e sugere respostas. Ela não abre
 * canal realtime próprio: observa a lista de mensagens que o `useMessages` já
 * mantém, e esta regra decide se a última mensagem pede análise. É pura para ser
 * testada sem relógio nem rede.
 */

/** Espera depois da última inbound: o cliente costuma mandar 2–3 mensagens em rajada. */
export const COPILOTO_DEBOUNCE_MS = 1500;
/** Intervalo mínimo entre duas chamadas da mesma conversa (rajada longa não vira 5 chamadas). */
export const COPILOTO_INTERVALO_MIN_MS = 10_000;
/** Inbound mais velha que isto não dispara sozinha (abrir conversa antiga pela busca não gasta IA). */
export const COPILOTO_JANELA_AUTO_MS = 72 * 60 * 60 * 1000;

export const COPILOTO_INTENCOES = ["responder", "avancar", "fechar", "reengajar"] as const;
export type CopilotoIntencao = (typeof COPILOTO_INTENCOES)[number];

export const COPILOTO_INTENCAO_LABEL: Record<CopilotoIntencao, string> = {
  responder: "Responder",
  avancar: "Avançar",
  fechar: "Fechar",
  reengajar: "Reengajar",
};

export const copilotoSugestaoSchema = z.object({
  texto: z.string().trim().min(1),
  intencao: z.enum(COPILOTO_INTENCOES),
  porque: z.string().trim(),
});
export type CopilotoSugestao = z.infer<typeof copilotoSugestaoSchema>;

export const copilotoRespostaSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    momento: z.string().trim(),
    sugestoes: z.array(copilotoSugestaoSchema).max(3),
    /** id (uuid do Echo) da última mensagem que entrou na análise. */
    analisado_ate: z.string().nullable(),
  }),
  z.object({
    status: z.literal("indisponivel"),
    /** `desligado` (chave da linha) ou `sem_chave` (org sem chave de IA). */
    motivo: z.string(),
  }),
]);
export type CopilotoResposta = z.infer<typeof copilotoRespostaSchema>;

/** O mínimo de uma mensagem que a regra precisa (subconjunto de `Message` do useMessages). */
export interface CopilotoMensagem {
  id: string;
  direction: "inbound" | "outbound";
  created_at: string;
  is_deleted?: boolean;
  message_type?: string;
}

/** Tipos que não são fala de ninguém: não mudam de quem é a vez. */
const TIPOS_SEM_FALA = new Set(["reaction", "system", "deleted", "unsupported", "protocol"]);

/** Última mensagem que conta como fala (ignora apagadas, reações e afins). */
export function ultimaFala<T extends CopilotoMensagem>(mensagens: readonly T[]): T | null {
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i];
    if (m.is_deleted) continue;
    if (m.message_type && TIPOS_SEM_FALA.has(m.message_type)) continue;
    return m;
  }
  return null;
}

export type CopilotoDecisao =
  | { tipo: "nada"; motivo: "sem_mensagens" | "vez_do_cliente" | "ja_analisada" | "em_voo" | "antiga" }
  | { tipo: "analisar"; alvoId: string; esperarMs: number };

export interface CopilotoDecisaoEntrada {
  mensagens: readonly CopilotoMensagem[];
  /** id da inbound já analisada nesta conversa (ou null). */
  ultimaAnalisadaId: string | null;
  emVoo: boolean;
  /** Date.now() da última chamada desta conversa (ou null). */
  ultimaChamadaEm: number | null;
  agora: number;
}

/**
 * Decide se a conversa pede análise automática agora e quanto esperar.
 * Só analisa quando a vez é do atendente (última fala é do cliente), uma vez por
 * inbound, uma chamada por vez, respeitando debounce e intervalo mínimo.
 */
export function deveAnalisar(e: CopilotoDecisaoEntrada): CopilotoDecisao {
  const ultima = ultimaFala(e.mensagens);
  if (!ultima) return { tipo: "nada", motivo: "sem_mensagens" };
  if (ultima.direction !== "inbound") return { tipo: "nada", motivo: "vez_do_cliente" };
  if (ultima.id === e.ultimaAnalisadaId) return { tipo: "nada", motivo: "ja_analisada" };
  if (e.emVoo) return { tipo: "nada", motivo: "em_voo" };
  const chegada = Date.parse(ultima.created_at);
  if (Number.isFinite(chegada) && e.agora - chegada > COPILOTO_JANELA_AUTO_MS) {
    return { tipo: "nada", motivo: "antiga" };
  }
  const liberaEm = e.ultimaChamadaEm === null ? 0 : e.ultimaChamadaEm + COPILOTO_INTERVALO_MIN_MS - e.agora;
  return { tipo: "analisar", alvoId: ultima.id, esperarMs: Math.max(COPILOTO_DEBOUNCE_MS, liberaEm) };
}
