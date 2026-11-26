import { z } from "zod";

/**
 * Transcrição de áudio sob demanda (botão "Transcrever" da bolha).
 *
 * Contrato da edge `transcrever-audio` (par: `supabase/functions/transcrever-audio/logica.ts`,
 * `RespostaTranscricao`; muda nos dois) e a leitura de `messages.metadata.leitura`, o
 * campo que a edge `transcrever-audio` grava. Puro, para ser testado sem rede.
 */

export const transcricaoRespostaSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), texto: z.string() }),
  z.object({ status: z.literal("em_andamento") }),
  z.object({ status: z.literal("indisponivel"), motivo: z.string() }),
  z.object({ status: z.literal("falhou"), erro: z.string(), definitivo: z.boolean() }),
]);
export type TranscricaoResposta = z.infer<typeof transcricaoRespostaSchema>;

const leituraGravadaSchema = z.object({
  tipo: z.string().nullable().optional(),
  texto: z.string().nullable().optional(),
  lacuna: z.boolean().optional(),
});

/** Texto já transcrito de um áudio (`metadata.leitura.texto`), ou null. */
export function transcricaoGravada(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object") return null;
  const r = leituraGravadaSchema.safeParse((metadata as { leitura?: unknown }).leitura);
  if (!r.success) return null;
  // `tipo` ausente vale como áudio (a leitura foi gravada para esta mensagem de áudio).
  if (r.data.tipo != null && r.data.tipo !== "audio") return null;
  return typeof r.data.texto === "string" ? r.data.texto : null;
}

/** A leitura gravada já desistiu deste áudio (tamanho, formato, 3 tentativas). */
export function transcricaoImpossivel(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== "object") return false;
  const r = leituraGravadaSchema.safeParse((metadata as { leitura?: unknown }).leitura);
  return r.success && r.data.lacuna === true && r.data.texto == null;
}

const ERROS: Record<string, string> = {
  grande_demais: "Áudio longo demais para transcrever.",
  nao_suportado: "Este formato de áudio não pode ser transcrito.",
  sem_midia: "O arquivo deste áudio não está disponível.",
  chave_invalida: "A chave de IA da organização foi recusada. Fale com um admin.",
  sem_saldo: "A chave de IA da organização está sem saldo. Fale com um admin.",
};

/** Mensagem de tela para uma resposta que não trouxe texto. */
export function mensagemDaTranscricao(r: Exclude<TranscricaoResposta, { status: "ok" }>): string {
  switch (r.status) {
    case "em_andamento":
      return "A transcrição já está em andamento. Tente de novo em instantes.";
    case "indisponivel":
      return r.motivo === "chave_anthropic"
        ? "A transcrição precisa de uma chave OpenAI na organização."
        : "A organização não tem chave de IA configurada.";
    case "falhou":
      return (
        ERROS[r.erro] ??
        (r.definitivo
          ? "Não foi possível transcrever este áudio."
          : "Não deu para transcrever agora. Tente de novo em alguns minutos.")
      );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Só a linha gravada em messages (uuid) pode ser transcrita: a bolha otimista tem id temporário. */
export function podeTranscrever(messageId: string): boolean {
  return UUID_RE.test(messageId);
}

/** Teto do texto guardado. Par de `LIMITES_LEITURA.textoGuardado` (`_shared/leitura-midia.ts`). */
export const TRANSCRICAO_TEXTO_MAX = 6000;

/** O texto chegou ao teto: o fim do áudio ficou de fora da transcrição. */
export function transcricaoCortada(texto: string): boolean {
  return texto.length >= TRANSCRICAO_TEXTO_MAX;
}

/** Erros da edge (`{ error: "<código>" }`, que o checkEdgeFunctionResponseAsync lança como Error). */
const ERROS_DA_EDGE: Record<string, string> = {
  unauthorized: "Sua sessão expirou. Entre de novo para transcrever.",
  forbidden: "Você não tem acesso a esta mensagem.",
  mensagem_nao_encontrada: "Você não tem acesso a esta mensagem.",
  nao_e_audio: "Esta mensagem não é um áudio.",
};

/**
 * Mensagem de tela para um erro do invoke. Código conhecido tem frase própria; outro código
 * cru da edge (snake_case, como `erro_interno`) nunca vai para a tela: vira o fallback.
 */
export function mensagemDoErroDaEdge(erro: unknown): string | null {
  const msg = erro instanceof Error ? erro.message.trim() : "";
  if (ERROS_DA_EDGE[msg]) return ERROS_DA_EDGE[msg];
  if (/^[a-z][a-z0-9_]*$/.test(msg)) return FALLBACK_ERRO;
  return null;
}

export const FALLBACK_ERRO = "Não foi possível transcrever. Verifique a conexão e tente de novo.";

/** Org sem chave que transcreve: o botão some por este tempo em todas as bolhas dela. */
export const TRANSCRICAO_SEM_CHAVE_MS = 10 * 60 * 1000;

/**
 * Memória da página. Os textos cobrem a bolha que remonta (lista virtualizada)
 * antes de o UPDATE do realtime trazer o metadata novo.
 */
const memoria = {
  textos: new Map<string, string>(),
  /** por organização: um super admin troca de org e a outra pode ter chave. */
  semChaveEm: new Map<string, number>(),
};

export function lembrarTranscricao(messageId: string, texto: string): void {
  memoria.textos.set(messageId, texto);
}

export function transcricaoLembrada(messageId: string): string | null {
  return memoria.textos.get(messageId) ?? null;
}

export function marcarSemChave(organizacaoId: string | null, agora: number): void {
  if (organizacaoId) memoria.semChaveEm.set(organizacaoId, agora);
}

export function transcricaoSemChave(organizacaoId: string | null, agora: number): boolean {
  const em = organizacaoId ? memoria.semChaveEm.get(organizacaoId) : undefined;
  return em !== undefined && agora - em < TRANSCRICAO_SEM_CHAVE_MS;
}

/** Só em teste. */
export function limparMemoriaTranscricao(): void {
  memoria.textos.clear();
  memoria.semChaveEm.clear();
}
