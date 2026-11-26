import type { CallUpdate } from "@/lib/voiceCall";

/**
 * O SSE `/call/:phoneNumberId/events` é por LINHA, não por usuário: todo
 * atendente conectado recebe o estado de todas as ligações daquela linha,
 * inclusive as que outro atendente iniciou ou atendeu. É daí que sai a trava —
 * a ocupação da linha é derivável do que já chega, sem canal novo nem estado
 * no serviço (que é stateless quanto a "quem está atendendo").
 *
 * `incoming_ringing` NÃO ocupa a linha: uma ligação que só está tocando ainda
 * não é ligação de ninguém, e tratá-la como ocupada faria a trava esconder o
 * aviso de todo mundo — ninguém poderia atender. Discagem de saída
 * (`initiating`/`ringing`) ocupa, porque ali um atendente já está ligando.
 */
const BUSY_STATES: ReadonlySet<CallUpdate["state"]> = new Set([
    "initiating",
    "ringing",
    "connecting",
    "active",
    "on_hold",
]);

export interface DerivedCallState {
    /** A linha está em ligação (de qualquer atendente). */
    busy: boolean;
    /** Ocupada por OUTRO cliente: aqui não se liga nem se atende. */
    busyByOther: boolean;
    /** A ligação deste cliente, se houver. */
    myCall: CallUpdate | null;
    /** Entrantes tocando que este cliente ainda não assumiu, em ordem de chegada. */
    incoming: CallUpdate[];
}

export function deriveCallState(calls: Iterable<CallUpdate>, myCallId: string | null): DerivedCallState {
    let myCall: CallUpdate | null = null;
    let busy = false;
    let busyByOther = false;
    const incoming: CallUpdate[] = [];

    for (const call of calls) {
        if (call.state === "ended") continue;
        const mine = myCallId !== null && call.callId === myCallId;
        if (mine) myCall = call;

        if (call.state === "incoming_ringing") {
            if (!mine) incoming.push(call);
            continue;
        }
        if (BUSY_STATES.has(call.state)) {
            busy = true;
            if (!mine) busyByOther = true;
        }
    }

    return { busy, busyByOther, myCall, incoming };
}
