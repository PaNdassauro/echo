import { afterEach, describe, expect, it } from "vitest";

import {
    buildAudioConstraints,
    classifyMicError,
    describeMicError,
    getPreferredMicId,
    rmsLevel,
    setPreferredMicId,
    SILENCE_LEVEL,
} from "./microphone";

afterEach(() => {
    localStorage.clear();
});

const domError = (name: string) => Object.assign(new Error(name), { name });

describe("classifyMicError", () => {
    it.each([
        ["NotAllowedError", "blocked"],
        ["PermissionDeniedError", "blocked"],
        ["NotFoundError", "not-found"],
        ["OverconstrainedError", "not-found"],
        ["NotReadableError", "busy"],
        ["TrackStartError", "busy"],
        ["SecurityError", "insecure"],
        ["NotSupportedError", "unsupported"],
        ["QualquerOutra", "unknown"],
    ])("%s vira %s", (name, kind) => {
        expect(classifyMicError(domError(name))).toBe(kind);
    });

    it("aguenta erro que não é objeto", () => {
        expect(classifyMicError("falhou")).toBe("unknown");
        expect(classifyMicError(null)).toBe("unknown");
    });
});

describe("describeMicError", () => {
    it("microfone em uso não manda a pessoa liberar permissão", () => {
        const info = describeMicError(domError("NotReadableError"));
        expect(info.title).toBe("Microfone em uso");
        expect(info.description).not.toMatch(/permit/i);
    });

    it("permissão negada continua dizendo 'Microfone bloqueado'", () => {
        expect(describeMicError(domError("NotAllowedError")).title).toBe("Microfone bloqueado");
    });
});

describe("microfone preferido", () => {
    it("sem escolha, pede o microfone padrão com cancelamento de eco", () => {
        expect(buildAudioConstraints()).toEqual({ echoCancellation: true, noiseSuppression: true });
    });

    it("guarda a escolha e pede como ideal (cai no padrão se o aparelho sumir)", () => {
        setPreferredMicId("abc");
        expect(getPreferredMicId()).toBe("abc");
        expect(buildAudioConstraints()).toEqual({
            echoCancellation: true,
            noiseSuppression: true,
            deviceId: { ideal: "abc" },
        });
    });

    it("voltar ao padrão apaga a escolha", () => {
        setPreferredMicId("abc");
        setPreferredMicId(null);
        expect(getPreferredMicId()).toBeNull();
        expect(buildAudioConstraints()).not.toHaveProperty("deviceId");
    });
});

describe("rmsLevel", () => {
    it("silêncio (128) é zero", () => {
        expect(rmsLevel(new Uint8Array(512).fill(128))).toBe(0);
        expect(rmsLevel(new Uint8Array(0))).toBe(0);
    });

    it("onda cheia fica perto de 1 e passa do limiar de silêncio", () => {
        const wave = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 === 0 ? 0 : 255));
        expect(rmsLevel(wave)).toBeGreaterThan(0.95);
        expect(rmsLevel(wave)).toBeGreaterThan(SILENCE_LEVEL);
    });

    it("chiado de 1 bit fica abaixo do limiar", () => {
        const hiss = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 === 0 ? 128 : 129));
        expect(rmsLevel(hiss)).toBeLessThan(SILENCE_LEVEL);
    });
});
