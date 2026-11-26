import { useCallback, useSyncExternalStore } from "react";
import { readVoiceCallsEnabled, subscribeVoiceCallsEnabled, writeVoiceCallsEnabled } from "@/lib/voiceCallPrefs";

/**
 * Preferência "receber ligações" do atendente, com as duas pontas em sincronia:
 * o menu que liga/desliga e o provider que decide se toca. `useSyncExternalStore`
 * porque a fonte é o localStorage (mais o evento próprio), não o estado do React.
 */
export function useVoiceCallsEnabled(userId: string | null | undefined): [boolean, (enabled: boolean) => void] {
    const enabled = useSyncExternalStore(
        subscribeVoiceCallsEnabled,
        useCallback(() => readVoiceCallsEnabled(userId), [userId]),
        () => true,
    );
    const setEnabled = useCallback((next: boolean) => writeVoiceCallsEnabled(userId, next), [userId]);
    return [enabled, setEnabled];
}
