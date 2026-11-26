import { Instagram } from "lucide-react";

/** Conversa com Direct do Instagram: ícone do Instagram (no lugar do texto "Direct").
 *  Card juntado (WhatsApp + Direct do mesmo contato): o mesmo ícone com "+", o WhatsApp já é a linha. */
export function SeloDirect({ junto = false }: { junto?: boolean }) {
  const rotulo = junto ? "WhatsApp + Instagram Direct" : "Instagram Direct";
  return (
    <span
      className="inline-flex items-center gap-0.5 shrink-0 rounded-full bg-pink-500/15 px-1.5 py-0.5 text-xs font-semibold text-pink-700 dark:text-pink-400"
      title={rotulo}
      role="img"
      aria-label={rotulo}
    >
      {junto && <span aria-hidden>+</span>}
      <Instagram className="size-3" strokeWidth={1.5} aria-hidden />
    </span>
  );
}
