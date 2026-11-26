/**
 * Regras da chave da API pública que valem testar fora do handler.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';

/** Intervalo mínimo entre duas escritas de `api_keys.last_used_at`. */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/**
 * true quando vale gravar `last_used_at` de novo: nunca gravado, valor
 * ilegível ou mais velho que LAST_USED_WRITE_INTERVAL_MS. Antes era uma escrita
 * por requisição, na mesma linha, o que gera contenção de lock e bloat.
 */
export function lastUsedIsStale(lastUsedAt: string | null | undefined, nowMs: number): boolean {
  if (!lastUsedAt) return true;
  const last = Date.parse(lastUsedAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= LAST_USED_WRITE_INTERVAL_MS;
}

/**
 * S2: o dono da chave ainda pode agir na organização dela? Membro da
 * organização passa; super admin passa (mesma regra de requirePhoneAccess).
 * 'error' quando o banco não respondeu: o handler devolve 503 em vez de 401,
 * para uma falha transitória não parecer chave revogada.
 */
export async function apiKeyOwnerStillAllowed(
  supabase: SupabaseClient,
  userId: string,
  organizationId: string,
): Promise<'allowed' | 'denied' | 'error'> {
  const [member, profile] = await Promise.all([
    supabase
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('profiles')
      .select('is_super_admin')
      .eq('id', userId)
      .maybeSingle(),
  ]);

  if (member.data) return 'allowed';
  if (profile.data?.is_super_admin === true) return 'allowed';
  if (member.error || profile.error) {
    console.error('[echo-api] conferência do dono da chave falhou', member.error?.code ?? profile.error?.code);
    return 'error';
  }
  return 'denied';
}

/** Quem chamou a API: a chave autenticada e, opcionalmente, o sistema que ela diz ser. */
export interface ApiCaller {
  keyId: string;
  keyName: string | null;
  /** Rótulo livre do header `x-echo-source` (ex.: `acme:ai-agent-router`). Não é prova de nada. */
  source: string | null;
}

const MAX_SOURCE_LENGTH = 80;

/**
 * Normaliza o `x-echo-source`: texto sem caractere de controle, até 80 chars.
 * Vazio ou inválido vira null. É só rótulo de diagnóstico (a identidade de
 * verdade é a chave), por isso nunca recusa a requisição.
 */
export function parseApiSource(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // deno-lint-ignore no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_SOURCE_LENGTH);
  return cleaned === '' ? null : cleaned;
}

/**
 * Metadata que TODA mensagem gravada pela API leva, para dar para dizer depois
 * "veio da API, por esta chave". Sem isso a linha era idêntica ao eco do
 * aparelho (sent_by NULL, metadata NULL) e o remetente era irrecuperável.
 */
export function apiOriginMetadata(caller: ApiCaller): Record<string, string> {
  const meta: Record<string, string> = { origin: 'api', api_key_id: caller.keyId };
  if (caller.keyName) meta.api_key_name = caller.keyName;
  if (caller.source) meta.api_source = caller.source;
  return meta;
}
