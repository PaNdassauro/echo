import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Layers, Palette } from "lucide-react";
import FeatureAnnouncementDialog from "./FeatureAnnouncementDialog";

const CHAVE = "echo_whatsnew_2026-11_seen_user-1";

const NOVIDADES = [
    { icon: Layers, title: "Novidade de exemplo", description: "Descrição da primeira novidade." },
    { icon: Palette, title: "Outra novidade de exemplo", description: "Descrição da segunda novidade." },
];

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
});

beforeEach(() => localStorage.clear());

/** O diálogo só abre 600ms depois de montar, para não brigar com o load do painel. */
async function montarEEsperar() {
    vi.useFakeTimers();
    render(<FeatureAnnouncementDialog userId="user-1" features={NOVIDADES} />);
    await act(async () => {
        vi.advanceTimersByTime(600);
    });
    vi.useRealTimers();
}

describe("FeatureAnnouncementDialog", () => {
    it("o lote padrão está vazio e o aviso não aparece numa instalação nova", async () => {
        vi.useFakeTimers();
        render(<FeatureAnnouncementDialog userId="user-1" />);
        await act(async () => {
            vi.advanceTimersByTime(600);
        });
        vi.useRealTimers();

        expect(screen.queryByText("Novidades no Echo")).toBeNull();
    });

    it("aparece depois do delay, com as duas novidades", async () => {
        await montarEEsperar();

        expect(screen.getByText("Novidades no Echo")).toBeTruthy();
        for (const titulo of ["Novidade de exemplo", "Outra novidade de exemplo"]) {
            expect(screen.getByText(titulo)).toBeTruthy();
        }
    });

    it("não aparece para quem já deu Entendi nesta versão", async () => {
        localStorage.setItem(CHAVE, new Date().toISOString());
        await montarEEsperar();

        expect(screen.queryByText("Novidades no Echo")).toBeNull();
    });

    it("Entendi grava e não volta mais", async () => {
        const user = userEvent.setup({ pointerEventsCheck: 0 });
        await montarEEsperar();

        await user.click(screen.getByRole("button", { name: /entendi/i }));

        expect(localStorage.getItem(CHAVE)).toBeTruthy();
        expect(screen.queryByText("Novidades no Echo")).toBeNull();
    });

    it("Depois fecha sem gravar, então reaparece no próximo acesso", async () => {
        const user = userEvent.setup({ pointerEventsCheck: 0 });
        await montarEEsperar();

        await user.click(screen.getByRole("button", { name: /^depois$/i }));

        expect(localStorage.getItem(CHAVE)).toBeNull();
        expect(screen.queryByText("Novidades no Echo")).toBeNull();

        // Próximo acesso: monta de novo e o aviso volta.
        cleanup();
        await montarEEsperar();
        expect(screen.getByText("Novidades no Echo")).toBeTruthy();
    });

    it("versão nova reabre para quem já tinha fechado a anterior", async () => {
        localStorage.setItem("echo_whatsnew_2026-10_seen_user-1", new Date().toISOString());
        await montarEEsperar();

        expect(screen.getByText("Novidades no Echo")).toBeTruthy();
    });
});
