import { z } from "zod";

/**
 * Recuperação de senha: leitura do link que chega por e-mail.
 *
 * O e-mail (supabase/templates/recovery.html) aponta para
 * `/auth?token_hash=…&type=recovery`. O token NÃO é consumido ao abrir a
 * página: só quando a pessoa envia a nova senha (`verifyOtp`). Assim o
 * antivírus ou a pré-visualização do e-mail, que abrem o link antes da
 * pessoa, não gastam o token de uso único.
 *
 * O prazo citado nos textos (1 hora) é o `mailer_otp_exp` do Auth: mudou lá,
 * muda aqui e no template.
 */

export type RecoveryLink =
  /** Link novo: o token ainda precisa ser trocado por sessão. */
  | { kind: "token"; tokenHash: string }
  /** Link antigo: a sessão já vem no hash (`#access_token=…&type=recovery`). */
  | { kind: "session" }
  /** O Supabase recusou o link (vencido, já usado) ou o token veio malformado. */
  | { kind: "invalid" };

const TokenHashSchema = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);

const paramsOf = (raw: string): URLSearchParams => new URLSearchParams(raw.replace(/^[?#]/, ""));

export function readRecoveryLink(search: string, hash: string): RecoveryLink | null {
  const query = paramsOf(search);
  const fragment = paramsOf(hash);

  // Erro devolvido pelo /verify do Supabase (ex.: error_code=otp_expired). O
  // erro não diz de que link veio: com `invite` na URL é a confirmação de
  // cadastro do convite, e a tela de convite continua valendo.
  const hasError = fragment.has("error") || fragment.has("error_code") || query.has("error_code");
  if (hasError && !query.has("invite")) {
    return { kind: "invalid" };
  }

  if (query.get("type") === "recovery" && query.has("token_hash")) {
    const parsed = TokenHashSchema.safeParse(query.get("token_hash"));
    return parsed.success ? { kind: "token", tokenHash: parsed.data } : { kind: "invalid" };
  }

  if (fragment.get("type") === "recovery") return { kind: "session" };

  return null;
}

interface AuthErrorLike {
  code?: unknown;
  status?: unknown;
}

/**
 * O `verifyOtp` recusou o token em definitivo (vencido, usado ou trocado por
 * um pedido mais novo)? Falha de rede ou 5xx não entram: a pessoa pode tentar
 * de novo com o mesmo link.
 */
export function isRecoveryLinkRejected(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, status } = error as AuthErrorLike;
  if (code === "otp_expired" || code === "flow_state_expired" || code === "validation_failed") return true;
  return status === 401 || status === 403;
}
