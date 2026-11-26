/**
 * Shared authentication/authorization helpers for Edge Functions.
 *
 * IMPORTANT: the caller's identity MUST be derived from the verified JWT via
 * requireUser() — never from a field in the request body. These functions run
 * with the service-role client (which bypasses RLS), so authorization is the
 * only tenant boundary and it has to key off a token the caller cannot forge.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';

/**
 * Verifies the caller's JWT (from the Authorization header) and returns the
 * authenticated user id. Throws an error mapped to HTTP 401 when the token is
 * absent or invalid. `supabase` may be the service-role client — getUser(token)
 * validates the token regardless of the client's own key.
 */
export async function requireUser(supabase: any, req: Request): Promise<string> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    throw new Error('Unauthorized: not authenticated');
  }
  const token = authHeader.replace('Bearer ', '');
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new Error('Unauthorized: not authenticated');
  }
  return data.user.id;
}

/**
 * Guarda das functions com `verify_jwt = false` que só existem para chamadas
 * servidor-a-servidor. Exige o mesmo bearer que os chamadores JÁ enviam: a
 * própria SUPABASE_SERVICE_ROLE_KEY. Não é um segredo novo a distribuir.
 *
 * Sem isto, uma function pública que aceita `userIds` no corpo é um endereço na
 * internet para disparar notificação com título e texto arbitrários a qualquer
 * usuário do sistema — phishing dentro do produto.
 *
 * A comparação é de tempo constante e checa o tamanho antes, para não vazar o
 * prefixo da chave pelo tempo de resposta.
 */
export function requireServiceRole(req: Request): void {
  const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const got = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  if (!expected || got.length !== expected.length) {
    throw new Error('Unauthorized: internal endpoint');
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) {
    throw new Error('Unauthorized: internal endpoint');
  }
}

/**
 * Ensures `userId` is allowed to act on the phone number `phoneDbId` (belonging
 * to `organizationId`): super admins pass; organization members pass; members
 * with the `agent` role must additionally be assigned to that specific number.
 * Throws an error mapped to HTTP 401/403 otherwise.
 */
export async function requirePhoneAccess(
  supabase: any,
  userId: string,
  phoneDbId: string,
  organizationId: string,
): Promise<void> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_super_admin')
    .eq('id', userId)
    .single();

  if (profile?.is_super_admin) return;

  const { data: member } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!member) {
    throw new Error('Unauthorized: You are not a member of this organization.');
  }

  if (member.role === 'agent') {
    const { data: assignment } = await supabase
      .from('user_phone_numbers')
      .select('id')
      .eq('user_id', userId)
      .eq('phone_number_id', phoneDbId)
      .maybeSingle();

    if (!assignment) {
      throw new Error('Unauthorized: You do not have access to this phone number.');
    }
  }
}

/**
 * Super admin passa; senão o usuário precisa ser membro da organização e, com
 * `minRole: 'admin'`, ter o papel `admin`. Espelha `user_is_org_admin()` /
 * `get_my_org_role()` do SQL, que dependem de auth.uid() e por isso não servem
 * a uma edge que roda com o client de service role.
 */
export async function requireOrgRole(
  supabase: SupabaseClient,
  userId: string,
  organizationId: string,
  minRole: 'member' | 'admin',
): Promise<void> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_super_admin')
    .eq('id', userId)
    .maybeSingle();

  if (profile?.is_super_admin) return;

  const { data: member } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!member) {
    throw new Error('Unauthorized: You are not a member of this organization.');
  }
  if (minRole === 'admin' && member.role !== 'admin') {
    throw new Error('Forbidden: permission denied (admin only).');
  }
}

// ============================================================================
// Chamada interna (servidor-a-servidor) com rampa
// ============================================================================
//
// `checkInternalCaller` reconhece quem chama como serviço e, por padrão, responde 401
// a quem não for (console.warn com a function e o motivo, nunca o segredo). A rampa
// existe só para migrar uma instalação que já tinha chamadores sem credencial:
// EDGE_INTERNAL_AUTH_ENFORCE=0 volta ao modo log (registra e deixa seguir). Qualquer
// outro valor, ou a variável ausente, recusa.
//
// Conta como chamada interna:
//   1. Bearer (ou header `apikey`) igual à SUPABASE_SERVICE_ROLE_KEY. É o que
//      todas as edges mandam (`Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) e o que os
//      crons mandam com o `service_role_key` do Vault enquanto ele for o JWT
//      legado.
//   2. Bearer (ou `apikey`) igual a uma chave `sb_secret_` conhecida:
//      SUPABASE_SECRET_KEYS (JSON `{nome: chave}` ou lista, como o runtime
//      injeta) ou EDGE_INTERNAL_SECRET_KEYS (lista separada por vírgula, para
//      semear à mão). Cobre o Vault depois de uma rotação para `sb_secret_`.
//   3. Só com `jwtVerifiedByGateway: true` (function com verify_jwt = true, em
//      que o gateway já conferiu a assinatura): JWT com `role = service_role`.
//      Numa function verify_jwt = false essa claim é forjável e NÃO vale.

export type InternalAuthReason =
  | 'sem_credencial'
  | 'jwt_anon'
  | 'jwt_de_usuario'
  | 'jwt_service_role_nao_verificado'
  | 'jwt_outro_papel'
  | 'chave_desconhecida';

export type InternalAuthResult =
  | { ok: true; via: 'service_role_key' | 'secret_key' | 'jwt_service_role' }
  | { ok: false; reason: InternalAuthReason };

export interface InternalAuthOptions {
  /** true só em function com verify_jwt = true (ver item 3 acima). */
  jwtVerifiedByGateway?: boolean;
  /** Headers extras da resposta 401 (CORS). */
  headers?: Record<string, string>;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bearerToken(req: Request): string {
  const header = req.headers.get('Authorization') ?? '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

function parseKeyList(raw: string | undefined): string[] {
  if (!raw) return [];
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      const values = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? Object.values(parsed as Record<string, unknown>)
          : [];
      return values.filter((v): v is string => typeof v === 'string' && v.length > 0);
    } catch {
      console.warn('[internal-auth] lista de chaves em formato inválido (ignorada)');
      return [];
    }
  }
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Chaves `sb_secret_` aceitas além da SUPABASE_SERVICE_ROLE_KEY. */
function knownSecretKeys(): string[] {
  return [
    ...parseKeyList(Deno.env.get('SUPABASE_SECRET_KEYS')),
    ...parseKeyList(Deno.env.get('EDGE_INTERNAL_SECRET_KEYS')),
  ].filter((k) => k.startsWith('sb_secret_'));
}

/** Claim `role` de um JWT, SEM conferir assinatura (só log ou gateway). */
function unverifiedJwtRole(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
    if (claims && typeof claims === 'object' && 'role' in claims) {
      const role = (claims as { role: unknown }).role;
      return typeof role === 'string' ? role : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Decide se a chamada vem de serviço. Não loga nem responde: ver checkInternalCaller. */
export function isInternalCaller(req: Request, opts: InternalAuthOptions = {}): InternalAuthResult {
  const bearer = bearerToken(req);
  const apikey = (req.headers.get('apikey') ?? '').trim();
  const presented = [bearer, apikey].filter(Boolean);
  if (presented.length === 0) return { ok: false, reason: 'sem_credencial' };

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (presented.some((p) => timingSafeEqual(p, serviceKey))) {
    return { ok: true, via: 'service_role_key' };
  }

  const secrets = knownSecretKeys();
  if (presented.some((p) => secrets.some((s) => timingSafeEqual(p, s)))) {
    return { ok: true, via: 'secret_key' };
  }

  const role = bearer ? unverifiedJwtRole(bearer) : null;
  if (role === 'service_role') {
    return opts.jwtVerifiedByGateway
      ? { ok: true, via: 'jwt_service_role' }
      : { ok: false, reason: 'jwt_service_role_nao_verificado' };
  }
  if (role === 'anon') return { ok: false, reason: 'jwt_anon' };
  if (role === 'authenticated') return { ok: false, reason: 'jwt_de_usuario' };
  if (role) return { ok: false, reason: 'jwt_outro_papel' };
  return { ok: false, reason: 'chave_desconhecida' };
}

export function internalAuthEnforced(): boolean {
  return (Deno.env.get('EDGE_INTERNAL_AUTH_ENFORCE') ?? '1').trim() !== '0';
}

/**
 * Credencial recusada. Por padrão: console.warn e um 401. Só com
 * EDGE_INTERNAL_AUTH_ENFORCE=0 (escape documentado, modo log): console.warn e `null`
 * (o chamador segue).
 * `reason` é um rótulo curto, nunca o token.
 */
export function rampDeny(
  fnName: string,
  reason: string,
  headers: Record<string, string> = {},
): Response | null {
  if (internalAuthEnforced()) {
    console.warn(`[internal-auth] ${fnName}: recusada (${reason})`);
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
  console.warn(`[internal-auth] ${fnName}: aceita em modo log (${reason}); sem EDGE_INTERNAL_AUTH_ENFORCE=0 seria 401`);
  return null;
}

/**
 * Guarda das functions servidor-a-servidor, com rampa. Devolve `null` para
 * seguir e uma Response 401 para responder (só `null` com EDGE_INTERNAL_AUTH_ENFORCE=0).
 */
export function checkInternalCaller(
  req: Request,
  fnName: string,
  opts: InternalAuthOptions = {},
): Response | null {
  const result = isInternalCaller(req, opts);
  if (result.ok) return null;
  return rampDeny(fnName, result.reason, opts.headers);
}
