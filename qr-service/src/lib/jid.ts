/**
 * Normaliza um JID para a forma "usuário@servidor" sem device (`:N`), como o
 * `jidNormalizedUser` do Baileys — mas sem depender da lib. `c.us` (legado) vira
 * `s.whatsapp.net`. Entrada sem servidor devolve string vazia (mesmo contrato).
 */
export function normalizeJidUser(jid: string | null | undefined): string {
    if (!jid) return '';
    const at = jid.indexOf('@');
    if (at < 0) return '';
    const user = jid.slice(0, at).split(':')[0] ?? '';
    let server = jid.slice(at + 1);
    if (server === 'c.us') server = 's.whatsapp.net';
    if (!user || !server) return '';
    return `${user}@${server}`;
}
