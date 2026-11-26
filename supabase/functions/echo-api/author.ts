/**
 * Autor de um envio pela API: quem escreveu a mensagem no sistema que chamou.
 *
 * O painel (whatsapp-send) cola "*Nome*\n\n" no texto quando a linha tem
 * `append_agent_name` e grava `sent_by`. Antes, a API só gravava o `user_id`
 * cru, sem conferir nada, e nunca colava o nome: a mensagem do CRM chegava
 * anônima no WhatsApp do cliente e, no Echo, igual ao eco do aparelho.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';

interface AuthorProfile {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export interface ApiAuthor {
  id: string;
  name: string;
}

export type AuthorResolution =
  | { ok: true; author: ApiAuthor | null; unresolved: boolean }
  | { ok: false; error: 'mismatch' };

/** Mesma regra do painel (whatsapp-send): nome e sobrenome; sem nome, o começo do e-mail. */
export function agentDisplayName(p: Omit<AuthorProfile, 'id'> | null | undefined): string {
  return p?.first_name
    ? `${p.first_name} ${p.last_name || ''}`.trim()
    : (p?.email?.split('@')[0] || 'Agente');
}

export function withAgentHeader(text: string, name: string): string {
  return `*${name}*\n\n${text}`;
}

// Sem espaço, sem "*" (curinga do PostgREST no ilike) e com um "@" só.
const EMAIL_SHAPE = /^[^\s@*]+@[^\s@*]+$/;

/** E-mail como chave de busca: aparado e minúsculo. Vazio ou fora do formato vira null. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return EMAIL_SHAPE.test(email) ? email : null;
}

/**
 * Acha o autor entre os MEMBROS da organização da chave, por `user_email` ou
 * `user_id`. Pessoa que não é membro (ou e-mail que não existe no Echo) não
 * derruba o envio: sai sem autor e `unresolved` avisa quem chamou. Com os dois
 * campos, eles precisam apontar para o mesmo membro, senão é erro de quem
 * chamou. A resposta nunca depende de quem existe em OUTRA organização.
 */
export async function resolveApiAuthor(
  supabase: SupabaseClient,
  organizationId: string,
  input: { userId?: unknown; userEmail?: unknown },
): Promise<AuthorResolution> {
  const userId = typeof input.userId === 'string' && input.userId.trim() !== '' ? input.userId.trim() : null;
  const emailGiven = typeof input.userEmail === 'string' && input.userEmail.trim() !== '';
  const email = normalizeEmail(input.userEmail);
  if (!userId && !emailGiven) return { ok: true, author: null, unresolved: false };

  const author = email
    ? await memberBy(supabase, organizationId, 'email', email)
    : emailGiven ? null : await memberBy(supabase, organizationId, 'id', userId as string);
  if (userId && emailGiven && author?.id !== userId) return { ok: false, error: 'mismatch' };
  return author ? { ok: true, author, unresolved: false } : { ok: true, author: null, unresolved: true };
}

async function memberBy(
  supabase: SupabaseClient,
  organizationId: string,
  field: 'email' | 'id',
  value: string,
): Promise<ApiAuthor | null> {
  let query = supabase.from('profiles').select('id, first_name, last_name, email');
  // ilike sem curinga: "_" é comum em e-mail e casaria qualquer caractere.
  query = field === 'email'
    ? query.ilike('email', value.replace(/[\\%_]/g, (c) => `\\${c}`))
    : query.eq('id', value);
  const { data: perfis, error: perfisErr } = await query.limit(5);
  if (perfisErr) {
    console.error('[echo-api] autor: leitura de profiles falhou', perfisErr.code);
    return null;
  }
  const candidatos = ((perfis ?? []) as AuthorProfile[])
    .filter((p) => field === 'id' || p.email?.toLowerCase() === value);
  if (candidatos.length === 0) return null;

  const { data: membros, error: membrosErr } = await supabase
    .from('organization_members')
    .select('user_id')
    .eq('organization_id', organizationId)
    .in('user_id', candidatos.map((p) => p.id))
    .limit(1);
  if (membrosErr) {
    console.error('[echo-api] autor: leitura de organization_members falhou', membrosErr.code);
    return null;
  }
  const membroId = (membros?.[0] as { user_id: string } | undefined)?.user_id;
  const perfil = candidatos.find((p) => p.id === membroId);
  return perfil ? { id: perfil.id, name: agentDisplayName(perfil) } : null;
}
