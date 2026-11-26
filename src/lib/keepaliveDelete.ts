import { supabase } from "@/integrations/supabase/client";
import { getRuntimeConfig, restUrl } from "@/lib/runtimeConfig";

// Cache síncrono do access token: handlers de pagehide não podem esperar
// promises, e supabase.auth.getSession() é assíncrono.
let accessToken: string | null = null;
supabase.auth.onAuthStateChange((_event, session) => {
    accessToken = session?.access_token ?? null;
});
void supabase.auth.getSession().then(({ data }) => {
    accessToken = data.session?.access_token ?? accessToken;
});

/**
 * DELETE direto no REST do PostgREST com `keepalive: true` — sobrevive a
 * pagehide/fechar aba, onde uma chamada supabase-js normal morre junto com a
 * página. Uso: descarregar operações adiadas (ex.: exclusão com Desfazer)
 * quando a página está sendo destruída. Melhor esforço: sem token em cache,
 * não faz nada (direção segura — o item apenas continua existindo).
 */
export function keepaliveDelete(table: string, id: string): void {
    if (!accessToken) return;
    void fetch(restUrl(`${table}?id=eq.${encodeURIComponent(id)}`), {
        method: "DELETE",
        keepalive: true,
        headers: {
            apikey: getRuntimeConfig().supabaseAnonKey,
            Authorization: `Bearer ${accessToken}`,
        },
    }).catch(() => {
        /* página está morrendo — nada a reportar */
    });
}
