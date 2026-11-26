/**
 * "Receber ligações" é preferência DO ATENDENTE, no navegador — mesmo modelo do
 * som de notificação (`notificationSoundEnabled`), só que por usuário, porque o
 * mesmo computador é usado por gente diferente e receber a ligação de outro é
 * mais invasivo do que ouvir um bipe.
 *
 * A preferência governa o AVISO (card + toque), não a conexão: o SSE continua
 * aberto para saber quando a linha está ocupada, e o botão de ligar continua
 * valendo. Quem desliga isso está dizendo "não me chame", não "desativei voz".
 */

const EVENT = "echo:voice-calls-pref";

const keyFor = (userId: string | null | undefined) => `echo_voice_calls_enabled_${userId ?? "anon"}`;

/** Default ligado: mantém o comportamento de quem já usa a ligação. */
export function readVoiceCallsEnabled(userId: string | null | undefined): boolean {
    try {
        return localStorage.getItem(keyFor(userId)) !== "false";
    } catch {
        return true; // aba privada / storage bloqueado
    }
}

export function writeVoiceCallsEnabled(userId: string | null | undefined, enabled: boolean): void {
    try {
        localStorage.setItem(keyFor(userId), String(enabled));
    } catch {
        /* sem storage: vale só para esta sessão */
    }
    // O provider e o menu vivem em árvores diferentes; `storage` não dispara na
    // aba que escreveu, então o evento próprio é o que mantém os dois em sincronia.
    window.dispatchEvent(new CustomEvent(EVENT));
}

export function subscribeVoiceCallsEnabled(listener: () => void): () => void {
    window.addEventListener(EVENT, listener);
    window.addEventListener("storage", listener);
    return () => {
        window.removeEventListener(EVENT, listener);
        window.removeEventListener("storage", listener);
    };
}
