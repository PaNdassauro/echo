import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { supabase } from '../lib/supabase.js';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY as string;

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            userId?: string;
            isServiceRole?: boolean;
        }
    }
}

// Cache de tokens de usuário já validados: o front faz polling de status
// (1 req/s por cliente) e validar no Supabase Auth a cada request adicionaria
// ~100ms de latência por chamada. Bounded pra não repetir o leak do NodeCache.
const TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_CACHE_MAX = 500;
const validTokens = new Map<string, { userId: string; expiry: number }>();

function safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function extractToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    // EventSource (SSE do QR code) não envia headers — token vai na query
    const query = req.query.access_token;
    return typeof query === 'string' && query.length > 0 ? query : null;
}

export type AuthPrincipal = { isServiceRole: true; userId?: undefined } | { isServiceRole: false; userId: string };

/**
 * Valida um token (service-role key ou JWT de usuário). Compartilhado pelo
 * middleware HTTP e pelo upgrade de WebSocket (routes/call.ts), que não passa
 * pelo Express. null = inválido.
 */
export async function authenticateToken(token: string): Promise<AuthPrincipal | null> {
    // Server-to-server: edge functions enviam a própria service-role key
    if (safeEqual(token, SERVICE_KEY)) return { isServiceRole: true };

    const cached = validTokens.get(token);
    if (cached && cached.expiry > Date.now()) return { isServiceRole: false, userId: cached.userId };
    validTokens.delete(token);

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;

    if (validTokens.size >= TOKEN_CACHE_MAX) {
        const oldest = validTokens.keys().next().value;
        if (oldest !== undefined) validTokens.delete(oldest);
    }
    validTokens.set(token, { userId: data.user.id, expiry: Date.now() + TOKEN_CACHE_TTL_MS });
    return { isServiceRole: false, userId: data.user.id };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = extractToken(req);
    if (!token) {
        res.status(401).json({ error: 'Missing bearer token' });
        return;
    }

    let principal: AuthPrincipal | null;
    try {
        principal = await authenticateToken(token);
    } catch (err) {
        console.error('[Auth] Token validation failed:', err);
        res.status(401).json({ error: 'Token validation failed' });
        return;
    }
    if (!principal) {
        res.status(401).json({ error: 'Invalid token' });
        return;
    }
    if (principal.isServiceRole) req.isServiceRole = true;
    else req.userId = principal.userId;
    next();
}

const isUUID = (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * Authorization guard: ensures the authenticated user's organization owns the
 * phone number targeted by the request. Without this, a valid login for ANY
 * tenant could drive ANY other tenant's WhatsApp session (send/edit/delete/QR/
 * disconnect) — the request only ever carried a `:phoneNumberId` the caller
 * chose. Resolves the id (route param or body; DB UUID or Meta id) to its org,
 * then requires super-admin or org membership. Service-role callers bypass.
 *
 * Register per-router with `router.param('phoneNumberId', requirePhoneAccess)`
 * so every id-bearing route is covered automatically; add it explicitly to
 * routes that take the id in the body (e.g. POST /session/connect).
 */
/**
 * O usuário pode operar este número? Mesma regra do middleware, sem Express:
 * super admin ou membro da org dona do número. 'not_found' quando o número não existe.
 */
export async function userCanAccessPhone(userId: string, phoneRef: string): Promise<'ok' | 'forbidden' | 'not_found'> {
    let phone: { organization_id: string | null } | null = null;
    if (isUUID(phoneRef)) {
        const { data } = await supabase.from('phone_numbers').select('organization_id').eq('id', phoneRef).maybeSingle();
        phone = data;
    }
    if (!phone) {
        const { data } = await supabase.from('phone_numbers').select('organization_id').eq('phone_number_id', phoneRef).maybeSingle();
        phone = data;
    }
    if (!phone || !phone.organization_id) return 'not_found';

    const { data: profile } = await supabase.from('profiles').select('is_super_admin').eq('id', userId).maybeSingle();
    if (profile?.is_super_admin) return 'ok';

    const { data: member } = await supabase
        .from('organization_members')
        .select('id')
        .eq('organization_id', phone.organization_id)
        .eq('user_id', userId)
        .maybeSingle();
    return member ? 'ok' : 'forbidden';
}

export async function requirePhoneAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.isServiceRole) {
        next();
        return;
    }

    const userId = req.userId;
    if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }

    const phoneRef = (req.params.phoneNumberId ?? req.params.id ?? req.body?.phoneNumberId) as
        | string
        | undefined;
    if (!phoneRef) {
        res.status(400).json({ error: 'Missing phoneNumberId' });
        return;
    }

    // Resolve to a phone_numbers row (accept DB UUID or Meta phone_number_id).
    let phone: { organization_id: string | null } | null = null;
    if (isUUID(phoneRef)) {
        const { data } = await supabase
            .from('phone_numbers')
            .select('organization_id')
            .eq('id', phoneRef)
            .maybeSingle();
        phone = data;
    }
    if (!phone) {
        const { data } = await supabase
            .from('phone_numbers')
            .select('organization_id')
            .eq('phone_number_id', phoneRef)
            .maybeSingle();
        phone = data;
    }

    if (!phone || !phone.organization_id) {
        res.status(404).json({ error: 'Phone number not found' });
        return;
    }

    // Super admins may act on any number.
    const { data: profile } = await supabase
        .from('profiles')
        .select('is_super_admin')
        .eq('id', userId)
        .maybeSingle();

    if (profile?.is_super_admin) {
        next();
        return;
    }

    const { data: member } = await supabase
        .from('organization_members')
        .select('id')
        .eq('organization_id', phone.organization_id)
        .eq('user_id', userId)
        .maybeSingle();

    if (!member) {
        res.status(403).json({ error: 'You do not have access to this phone number' });
        return;
    }

    next();
}
