import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import MessageBubble from "./MessageBubble";

afterEach(cleanup);

const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

const base = {
  content: "",
  direction: "inbound" as const,
  timestamp: "2026-11-03T17:17:05.000Z",
};

const STORAGE = "https://p.supabase.co/storage/v1/object/public/attachments/inbound";

const downloadParam = (el: Element | null) => new URL((el as HTMLAnchorElement).href).searchParams.get("download");

describe("MessageBubble — tudo baixável", () => {
  it("documento de qualquer tipo baixa com o nome original", () => {
    render(
      <MessageBubble
        {...base}
        message_type="document"
        media_url={`${STORAGE}/x1/7f3e9c.zip`}
        media_filename="LogoDoEvento.zip"
        media_mime_type="application/x-zip-compressed"
      />,
    );
    const link = screen.getByTitle("Baixar LogoDoEvento.zip");
    expect(downloadParam(link)).toBe("LogoDoEvento.zip");
    expect(link.getAttribute("download")).toBe("LogoDoEvento.zip");
  });

  it("imagem, vídeo e figurinha ganham o botão Baixar na barra", () => {
    for (const [message_type, file] of [["image", "a.jpg"], ["video", "b.mp4"], ["sticker", "c.webp"]] as const) {
      render(<MessageBubble {...base} message_type={message_type} media_url={`${STORAGE}/${file}`} />);
      expect(downloadParam(screen.getByLabelText("Baixar"))).toBe(file);
      cleanup();
    }
  });

  it("mensagem sem mídia e mensagem apagada não mostram Baixar", () => {
    render(<MessageBubble {...base} content="oi" message_type="text" />);
    expect(screen.queryByLabelText("Baixar")).toBeNull();
    cleanup();
    render(<MessageBubble {...base} message_type="image" media_url={`${STORAGE}/a.jpg`} is_deleted />);
    expect(screen.queryByLabelText("Baixar")).toBeNull();
  });
});
