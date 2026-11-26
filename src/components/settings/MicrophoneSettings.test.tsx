import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import MicrophoneSettings from "./MicrophoneSettings";

const getUserMedia = vi.fn();
const enumerateDevices = vi.fn();

beforeEach(() => {
    getUserMedia.mockReset();
    enumerateDevices.mockReset().mockResolvedValue([]);
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
            getUserMedia,
            enumerateDevices,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});

afterEach(() => {
    cleanup();
    localStorage.clear();
});

const domError = (name: string) => Object.assign(new Error(name), { name });

describe("MicrophoneSettings", () => {
    it("microfone ocupado por outro app mostra 'Microfone em uso', não 'bloqueado'", async () => {
        getUserMedia.mockRejectedValue(domError("NotReadableError"));
        render(<MicrophoneSettings />);

        fireEvent.click(screen.getByRole("button", { name: /Testar microfone/ }));

        expect((await screen.findByRole("alert")).textContent).toMatch("Microfone em uso");
        expect(screen.queryByText("Microfone bloqueado")).toBeNull();
        expect(screen.getByRole("button", { name: /Testar microfone/ })).toBeTruthy();
    });

    it("permissão negada aponta para o cadeado do navegador", async () => {
        getUserMedia.mockRejectedValue(domError("NotAllowedError"));
        render(<MicrophoneSettings />);

        fireEvent.click(screen.getByRole("button", { name: /Testar microfone/ }));

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toMatch("Microfone bloqueado");
        expect(alert.textContent).toMatch(/cadeado/);
    });

    it("pede o microfone com as mesmas constraints do gravador do chat", async () => {
        getUserMedia.mockRejectedValue(domError("NotFoundError"));
        render(<MicrophoneSettings />);

        fireEvent.click(screen.getByRole("button", { name: /Testar microfone/ }));
        await screen.findByRole("alert");

        expect(getUserMedia).toHaveBeenCalledWith({
            audio: { echoCancellation: true, noiseSuppression: true },
        });
    });

    it("sem mediaDevices (http ou navegador antigo) já abre explicando e trava o botão", () => {
        Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
        render(<MicrophoneSettings />);

        expect(screen.getByRole("alert").textContent).toMatch("endereço seguro");
        expect((screen.getByRole("button", { name: /Testar microfone/ }) as HTMLButtonElement).disabled).toBe(true);
    });
});
