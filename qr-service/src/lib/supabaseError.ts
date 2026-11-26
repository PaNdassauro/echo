/**
 * Texto de um erro do PostgREST/supabase-js com tudo que ele carrega. Um 502 sem corpo (o gateway
 * responde antes do rest subir) chega com `message` vazia: só a mensagem deixava o log sem causa.
 */
export interface SupabaseErrorLike {
    message?: string | null;
    code?: string | null;
    details?: string | null;
    hint?: string | null;
}

export function describeSupabaseError(error: SupabaseErrorLike): string {
    return `${error.message || 'sem mensagem'} (code=${error.code ?? '-'}, details=${error.details ?? '-'}, hint=${error.hint ?? '-'})`;
}
