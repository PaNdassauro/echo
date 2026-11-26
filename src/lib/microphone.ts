/**
 * Microfone: escolha do dispositivo, constraints do getUserMedia e tradução
 * dos erros do navegador em mensagem para o usuário.
 *
 * Usado pelo gravador de áudio do chat (AudioRecorder) e pelo teste de
 * microfone em Configurações > Microfone: os dois pedem o microfone do mesmo
 * jeito, então o teste mostra exatamente o que o gravador vai capturar.
 */

const PREFERRED_MIC_STORAGE_KEY = "echo:preferred-mic-id";

/** O microfone escolhido no teste fica só neste navegador (o deviceId é por origem e por aparelho). */
export function getPreferredMicId(): string | null {
    try {
        return localStorage.getItem(PREFERRED_MIC_STORAGE_KEY) || null;
    } catch {
        return null;
    }
}

export function setPreferredMicId(deviceId: string | null): void {
    try {
        if (deviceId) localStorage.setItem(PREFERRED_MIC_STORAGE_KEY, deviceId);
        else localStorage.removeItem(PREFERRED_MIC_STORAGE_KEY);
    } catch {
        // localStorage indisponível (ex.: modo privado): segue com o microfone padrão.
    }
}

/**
 * `ideal` e não `exact`: se o microfone escolhido sumiu (headset desligado),
 * o navegador cai no padrão em vez de falhar com OverconstrainedError.
 */
export function buildAudioConstraints(deviceId: string | null = getPreferredMicId()): MediaTrackConstraints {
    return {
        echoCancellation: true,
        noiseSuppression: true,
        ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
    };
}

export type MicErrorKind = "blocked" | "not-found" | "busy" | "insecure" | "unsupported" | "unknown";

export interface MicErrorInfo {
    kind: MicErrorKind;
    title: string;
    description: string;
}

const MIC_ERRORS: Record<MicErrorKind, Omit<MicErrorInfo, "kind">> = {
    blocked: {
        title: "Microfone bloqueado",
        description: "Permita o acesso ao microfone no cadeado da barra de endereço e nas configurações de privacidade do computador.",
    },
    "not-found": {
        title: "Nenhum microfone encontrado",
        description: "Conecte um microfone ou headset e tente de novo.",
    },
    busy: {
        title: "Microfone em uso",
        description: "Outro aplicativo (Teams, Meet, Zoom…) está usando o microfone. Feche-o e tente de novo.",
    },
    insecure: {
        title: "Microfone indisponível nesta página",
        description: "O navegador só libera o microfone em endereço seguro (https).",
    },
    unsupported: {
        title: "Navegador sem suporte a gravação",
        description: "Atualize o navegador ou use o Chrome, Edge ou Firefox.",
    },
    unknown: {
        title: "Não foi possível acessar o microfone",
        description: "Tente de novo. Se continuar, teste o microfone em Configurações > Microfone.",
    },
};

function errorName(error: unknown): string {
    if (error && typeof error === "object" && "name" in error && typeof error.name === "string") {
        return error.name;
    }
    return "";
}

export function classifyMicError(error: unknown): MicErrorKind {
    switch (errorName(error)) {
        case "NotAllowedError":
        case "PermissionDeniedError":
            return "blocked";
        case "NotFoundError":
        case "DevicesNotFoundError":
        case "OverconstrainedError":
            return "not-found";
        case "NotReadableError":
        case "TrackStartError":
        case "AbortError":
            return "busy";
        case "SecurityError":
            return "insecure";
        case "NotSupportedError":
        case "TypeError":
            return "unsupported";
        default:
            return "unknown";
    }
}

export function describeMicError(error: unknown): MicErrorInfo {
    const kind = classifyMicError(error);
    return { kind, ...MIC_ERRORS[kind] };
}

/** Sem `navigator.mediaDevices` não há o que pedir: página http ou navegador antigo. */
export function getMicUnavailableReason(): MicErrorInfo | null {
    if (typeof window !== "undefined" && window.isSecureContext === false) {
        return { kind: "insecure", ...MIC_ERRORS.insecure };
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        return { kind: "unsupported", ...MIC_ERRORS.unsupported };
    }
    return null;
}

/**
 * Nível RMS (0–1) de um quadro do AnalyserNode em bytes (128 = silêncio).
 * Fala normal fica em ~0,05–0,3; abaixo de SILENCE_LEVEL é microfone mudo.
 */
export function rmsLevel(samples: ArrayLike<number>): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        const centered = (samples[i] - 128) / 128;
        sum += centered * centered;
    }
    return Math.sqrt(sum / samples.length);
}

export const SILENCE_LEVEL = 0.01;
