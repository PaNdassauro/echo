/**
 * Uma ligação em curso é a única coisa no Echo que um reload destrói sem volta:
 * o serviço encerra a ligação assim que o WebSocket de áudio cai. Este sinal
 * existe para o `main.tsx` adiar o reload do service worker enquanto ela dura —
 * fora do React, porque quem decide recarregar é o listener de `controllerchange`,
 * que roda antes e fora da árvore.
 */
let active = false;

export function setCallActive(value: boolean): void {
    active = value;
}

export function isCallActive(): boolean {
    return active;
}
