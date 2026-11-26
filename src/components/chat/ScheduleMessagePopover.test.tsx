import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ScheduleMessagePopover from "./ScheduleMessagePopover";
import { Button } from "@/components/ui/button";

afterEach(cleanup);

/** datetime-local daqui a `min` minutos, no fuso local (o formato que o input espera). */
const daquiA = (min: number) => {
  const d = new Date(Date.now() + min * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

describe("ScheduleMessagePopover com botão próprio (diálogo de anexo)", () => {
  it("abre pelo botão Agendar, mostra a frase dos arquivos e agenda no horário escolhido", async () => {
    const onSchedule = vi.fn().mockResolvedValue({ success: true });
    render(
      <ScheduleMessagePopover
        onSchedule={onSchedule}
        description="Os arquivos serão enviados no horário escolhido."
        trigger={<Button type="button" variant="outline">Agendar</Button>}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Agendar" }));
    expect(await screen.findByText("Os arquivos serão enviados no horário escolhido.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Data e horário"), { target: { value: daquiA(60) } });
    const confirmar = screen.getAllByRole("button", { name: "Agendar" }).at(-1)!;
    fireEvent.click(confirmar);
    await waitFor(() => expect(onSchedule).toHaveBeenCalledTimes(1));
    const quando = onSchedule.mock.calls[0][0] as Date;
    expect(quando.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("desabilitado não abre", () => {
    render(
      <ScheduleMessagePopover
        onSchedule={vi.fn()}
        disabled
        trigger={<Button type="button" variant="outline">Agendar</Button>}
      />
    );
    const botao = screen.getByRole("button", { name: "Agendar" }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    fireEvent.click(botao);
    expect(screen.queryByLabelText("Data e horário")).toBeNull();
  });
});
