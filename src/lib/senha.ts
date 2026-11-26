import { z } from "zod";
import { toUserMessage } from "@/lib/userFacingError";

/**
 * Regras de senha do front. O mínimo é o `GOTRUE_PASSWORD_MIN_LENGTH` do Auth:
 * o cadastro por convite, a nova senha da recuperação, o primeiro acesso e o
 * "Alterar senha" do perfil exigem o mesmo número. O máximo de 72 é o limite
 * do bcrypt (bytes além dele seriam ignorados em silêncio).
 */
export const SENHA_MINIMA = 8;
export const SENHA_MAXIMA = 72;

export const NovaSenhaSchema = z
  .object({
    senha: z
      .string()
      .min(SENHA_MINIMA, `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`)
      .max(SENHA_MAXIMA, `A senha tem no máximo ${SENHA_MAXIMA} caracteres.`),
    confirmacao: z.string(),
  })
  .refine((v) => v.senha === v.confirmacao, { path: ["confirmacao"], message: "As senhas não coincidem." });

export type NovaSenhaInput = z.infer<typeof NovaSenhaSchema>;

interface ErroDoAuth {
  code?: unknown;
  message?: unknown;
}

/** Erro do Auth ao trocar a senha, em português e com o próximo passo. */
export function mensagemDeErroDeSenha(error: unknown): string {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as ErroDoAuth;
  if (code === "same_password") return "A nova senha precisa ser diferente da atual.";
  if (code === "weak_password") return `Senha fraca demais. Use pelo menos ${SENHA_MINIMA} caracteres e evite senhas comuns.`;
  if (typeof message === "string" && /should be different from the old password/i.test(message)) {
    return "A nova senha precisa ser diferente da atual.";
  }
  if (code === "over_request_rate_limit" || (typeof message === "string" && /rate limit|too many requests|for security purposes/i.test(message))) {
    return "Muitas tentativas. Aguarde um instante e tente novamente.";
  }
  return toUserMessage(error, "Verifique a conexão e tente novamente.");
}
