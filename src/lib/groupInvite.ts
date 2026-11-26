import { toUserMessage } from "@/lib/userFacingError";

/**
 * Convite de grupo do WhatsApp: tirar o código do que o atendente colou.
 *
 * O app copia o link com query string (`?s=cl&p=i&ilr=4&iam=2`, `?mode=ems_copy_t`;
 * boa parte dos links recebidos em produção vem assim). O antigo
 * `split("/").pop()` mandava o sufixo junto, o WhatsApp respondia bad-request e o
 * toast mostrava "Erro 400". Todo código visto em produção tem 22 caracteres.
 *
 * Par em `qr-service/src/services/SessionManager.ts`: `SessionManager.acceptGroupInvite`/`getGroupInviteInfo` ainda
 * fazem o split antigo, que é inofensivo com o código já limpo vindo daqui.
 */
const INVITE_CODE = "[A-Za-z0-9]{20,24}";
const INVITE_LINK_RE = new RegExp(`chat\\.whatsapp\\.com/(?:invite/)?(${INVITE_CODE})(?![A-Za-z0-9])`, "i");
const BARE_CODE_RE = new RegExp(`^${INVITE_CODE}$`);

/** Código do convite, ou null quando o texto não tem link nem código válido. */
export function extractInviteCode(input: string): string | null {
    const link = INVITE_LINK_RE.exec(input);
    if (link) return link[1];
    const trimmed = input.trim();
    return BARE_CODE_RE.test(trimmed) ? trimmed : null;
}

export const INVALID_INVITE_HINT = "Cole o link do WhatsApp (chat.whatsapp.com/…) ou só o código.";

// O qr-service devolve o status do IQ como "Erro <n>" (getBaileysStatusMessage).
const INVITE_STATUS_MESSAGES: Record<string, string> = {
    "400": "Link de convite inválido. Copie o link de novo no WhatsApp.",
    "406": "Link de convite inválido. Copie o link de novo no WhatsApp.",
    "404": "Este convite expirou ou foi revogado. Peça um link novo.",
    "410": "Este convite expirou ou foi revogado. Peça um link novo.",
    "401": "Este número não tem permissão para entrar neste grupo.",
    "403": "Este número não tem permissão para entrar neste grupo.",
};

/** Texto do toast para a falha de prévia ou de entrada por convite. */
export function inviteErrorMessage(raw: unknown, fallback: string): string {
    if (typeof raw === "string") {
        const status = /^\s*erro (\d{3})\s*$/i.exec(raw)?.[1];
        if (status) return INVITE_STATUS_MESSAGES[status] ?? fallback;
        if (/^session not (connected|found)$/i.test(raw.trim())) {
            return "O número está desconectado. Reconecte antes de usar o convite.";
        }
    }
    return toUserMessage(raw, fallback);
}
