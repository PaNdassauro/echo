import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import MessageBubble from "./MessageBubble";

afterEach(cleanup);

const user = userEvent.setup({ pointerEventsCheck: 0 });

// O app envolve tudo em TooltipProvider (App.tsx); a bolha usa Tooltip no timestamp.
const render = (ui: ReactElement) =>
    rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

const base = {
    content: "Bom dia, tudo bem?",
    direction: "inbound" as const,
    timestamp: "2026-08-17T12:00:00.000Z",
};

describe("MessageBubble — entrada e uso da seleção", () => {
    it("fora da seleção, o botão Encaminhar dispara onForward (o gatilho do fluxo)", async () => {
        const onForward = vi.fn();
        render(<MessageBubble {...base} onForward={onForward} />);

        await user.click(screen.getByTitle("Encaminhar"));
        expect(onForward).toHaveBeenCalledTimes(1);
    });

    it("em seleção, a linha inteira vira checkbox e alterna ao clicar", async () => {
        const onToggleSelect = vi.fn();
        render(
            <MessageBubble {...base} onForward={vi.fn()} selectionMode onToggleSelect={onToggleSelect} />,
        );

        const linha = screen.getByRole("checkbox");
        expect(linha.getAttribute("aria-checked")).toBe("false");

        await user.click(screen.getByText(base.content));
        expect(onToggleSelect).toHaveBeenCalledTimes(1);
    });

    it("em seleção, as ações da bolha somem (o envio sai da barra)", () => {
        render(<MessageBubble {...base} onForward={vi.fn()} onReply={vi.fn()} selectionMode />);

        expect(screen.queryByTitle("Encaminhar")).toBeNull();
        expect(screen.queryByTitle("Responder")).toBeNull();
    });

    it("marcada reflete aria-checked", () => {
        render(<MessageBubble {...base} selectionMode isSelected onToggleSelect={vi.fn()} />);
        expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    });

    it("não encaminhável não entra na seleção nem recebe foco", async () => {
        const onToggleSelect = vi.fn();
        render(
            <MessageBubble {...base} selectionMode selectionDisabled onToggleSelect={onToggleSelect} />,
        );

        const linha = screen.getByRole("checkbox");
        expect(linha.getAttribute("aria-disabled")).toBe("true");
        expect(linha.getAttribute("tabindex")).toBe("-1");

        await user.click(screen.getByText(base.content));
        expect(onToggleSelect).not.toHaveBeenCalled();
    });
});
