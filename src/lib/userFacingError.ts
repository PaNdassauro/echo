/**
 * Converte um erro qualquer (Error, PostgrestError, string, ZodError, resposta
 * de edge function) na mensagem que o USUÁRIO deve ler num toast.
 *
 * Regra: só repassamos a mensagem original quando ela parece ter sido escrita
 * para gente (ex.: `RAISE EXCEPTION 'Você não tem permissão…'` numa RPC, ou o
 * corpo de erro em pt-BR de uma edge function). Mensagem técnica — JSON,
 * código do Postgres, stack, "Failed to fetch", "non-2xx status code" — vira
 * o `fallback`, que deve dizer o PRÓXIMO PASSO ("Verifique a conexão e tente
 * novamente"), nunca só "Erro".
 *
 * A causa crua continua indo para o console pelo chamador (console.error) —
 * aqui só decidimos o que aparece na tela.
 */

export const GENERIC_ERROR_FALLBACK = "Não foi possível concluir. Verifique a conexão e tente novamente.";

/** Acima disso a mensagem é log, não texto de interface. */
const MAX_USER_MESSAGE_LENGTH = 160;

const TECHNICAL_PATTERNS: readonly RegExp[] = [
  /^\s*[[{]/, // JSON (ZodError.message, corpos de resposta)
  /<!doctype|<html|<body/i, // página HTML de erro do gateway
  /\bPGRST\d+\b|\b(?:22|23|28|42|53|54|57|58|P0)\d{3}\b/, // códigos PostgREST/Postgres
  /violates|duplicate key|constraint|relation "|column "|syntax error|permission denied|row-level security|policy/i,
  /\bjwt\b|invalid token|token expired|refresh_token|invalid claim/i,
  /failed to fetch|networkerror|load failed|fetch failed|econn|etimedout|aborterror|network request failed/i,
  /typeerror|referenceerror|syntaxerror|rangeerror|cannot read propert|is not a function|is not defined|unexpected token|\bundefined\b|\bnull\b|\bNaN\b|\[object /i,
  /non-2xx|status code|statuscode|functions(?:http|fetch|relay)error|edge function|bad gateway|service unavailable|internal server error|gateway timeout/i,
  /^\s*(?:error|unknown error|erro|erro desconhecido|request failed|something went wrong)\s*\.?\s*$/i,
  /\bat\s+\S+\s+\(.*:\d+:\d+\)/, // frame de stack
  /\b(?:select|insert|update|delete)\s+(?:from|into|\w+\s+set)\b/i, // SQL vazado
];

interface MessageCarrier {
  message?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * Extrai a string de mensagem de qualquer formato de erro conhecido no app,
 * sem julgar se ela serve para o usuário. Devolve null quando não há texto.
 */
export function extractErrorMessage(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === "string") return error.trim() || null;
  if (error instanceof Error) return error.message.trim() || null;
  if (typeof error === "object") {
    const carrier = error as MessageCarrier;
    if (typeof carrier.message === "string" && carrier.message.trim()) return carrier.message.trim();
    if (typeof carrier.error_description === "string" && carrier.error_description.trim()) {
      return carrier.error_description.trim();
    }
    if (typeof carrier.error === "string" && carrier.error.trim()) return carrier.error.trim();
    if (carrier.error && typeof carrier.error === "object") return extractErrorMessage(carrier.error);
  }
  return null;
}

/** True quando a mensagem foi escrita para a interface, não para o log. */
export function isUserFacingMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_USER_MESSAGE_LENGTH) return false;
  return !TECHNICAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Mensagem a exibir no toast. `fallback` deve dizer o próximo passo do usuário.
 *
 * @example
 * toast({
 *   title: "Não foi possível criar o disparo",
 *   description: toUserMessage(error, "Nada foi enviado. Revise a lista de contatos e tente de novo."),
 *   variant: "destructive",
 * });
 */
export function toUserMessage(error: unknown, fallback: string = GENERIC_ERROR_FALLBACK): string {
  const message = extractErrorMessage(error);
  if (message && isUserFacingMessage(message)) return message;
  return fallback;
}
