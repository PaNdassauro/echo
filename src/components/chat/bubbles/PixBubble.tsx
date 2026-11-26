import { useCallback, useState } from "react";
import QRCode from "react-qr-code";
import { Check, Copy, QrCode, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconSwap } from "@/components/ui/icon-swap";
import { formatPixAmount, type PixPayload } from "@/lib/pixPayload";

interface PixBubbleProps {
  pix: PixPayload;
  isOutbound: boolean;
}

/**
 * Card de chave Pix, usado no Pix NATIVO do WhatsApp (interactiveMessage).
 *
 * Ali a chave não está no texto da mensagem — vive num JSON dentro dos botões
 * de native flow, e sem este card a bolha era só "[Mensagem interativa]", sem
 * jeito de pagar. O payload cru (150-230 chars ilegíveis) fica deliberadamente
 * ESCONDIDO: o atendente precisa da ação (copiar / apontar a câmera), não do
 * texto do código.
 *
 * O QR fica sob demanda: gerá-lo de saída desenharia dezenas de <rect> em toda
 * bolha de Pix da conversa — a lista é virtualizada e remonta ao rolar.
 */
export function PixBubble({ pix, isOutbound }: PixBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const amount = formatPixAmount(pix.amount);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(pix.raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard bloqueado (sem HTTPS, permissão negada): o fallback é o
      // usuário selecionar o texto da mensagem, que segue visível acima.
      setCopied(false);
    }
  }, [pix.raw]);

  const surface = isOutbound
    ? "bg-chat-bubble-user-foreground/10"
    : "bg-chat-bubble-contact-foreground/10";
  const control = isOutbound
    ? "bg-chat-bubble-user-foreground/15 hover:bg-chat-bubble-user-foreground/25"
    : "bg-chat-bubble-contact-foreground/15 hover:bg-chat-bubble-contact-foreground/25";

  return (
    <div className={cn("rounded-lg px-3 py-2.5 -mx-1 my-0.5 min-w-[200px] max-w-[280px]", surface)}>
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "w-8 h-8 rounded-full shrink-0 flex items-center justify-center",
            isOutbound ? "bg-chat-bubble-user-foreground/15" : "bg-chat-bubble-contact-foreground/15"
          )}
        >
          <QrCode className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-tight">Pix copia e cola</p>
          {pix.merchantName && (
            <p className="text-message-xs opacity-80 truncate" title={pix.merchantName}>
              {pix.merchantName}
            </p>
          )}
        </div>
        {/* Valor só aparece quando o EMV realmente o define. O Pix nativo do
            WhatsApp chega como ORDER_WITHOUT_AMOUNT e o QR estático não carrega
            valor: exibir R$ 0,00 ali seria mentir sobre a cobrança. */}
        {amount ? (
          <p className="text-message font-semibold shrink-0 tabular-nums">{amount}</p>
        ) : (
          <p className="text-xs opacity-60 shrink-0 text-right leading-normal">
            valor no
            <br />
            app do banco
          </p>
        )}
      </div>

      {!pix.crcValid && (
        <p className="flex items-start gap-1.5 text-xs opacity-80 mt-2">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
          Código possivelmente incompleto — confira no app do banco antes de pagar.
        </p>
      )}

      <div className="flex items-center gap-1.5 mt-2">
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copiar chave Pix"
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5",
            "text-xs font-medium transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100",
            control
          )}
        >
          <IconSwap
            active={copied ? "check" : "copy"}
            durationMs={150}
            icons={{ copy: <Copy className="w-3.5 h-3.5 shrink-0" />, check: <Check className="w-3.5 h-3.5 shrink-0" /> }}
          />
          {copied ? "Copiado" : "Copiar chave"}
        </button>
        <button
          type="button"
          onClick={() => setShowQr((v) => !v)}
          aria-label={showQr ? "Ocultar QR Code" : "Mostrar QR Code"}
          aria-expanded={showQr}
          className={cn(
            "flex items-center justify-center rounded-md px-2 py-1.5 transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100",
            control
          )}
        >
          <QrCode className="w-3.5 h-3.5" />
        </button>
      </div>

      {showQr && (
        /* Fundo branco fixo e não tokenizado: leitor de QR precisa de contraste
           real, e no tema escuro um fundo transparente deixaria o código
           ilegível para a câmera. */
        <div className="mt-2 rounded-md bg-white p-2.5 flex items-center justify-center">
          <QRCode
            value={pix.raw}
            size={160}
            level="M"
            bgColor="#ffffff"
            fgColor="#000000"
            style={{ height: "auto", maxWidth: "100%", width: "100%" }}
          />
        </div>
      )}
    </div>
  );
}
