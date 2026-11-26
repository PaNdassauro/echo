import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { textoDoEnvio, type ConviteCriado } from "./inviteResult";

interface InviteLinksPanelProps {
  email: string;
  convites: readonly ConviteCriado[];
}

/**
 * Link(s) do convite recém-criado, um por número, para copiar. A cópia só
 * acontece no clique do usuário (o navegador recusa clipboard sem gesto) e, se
 * o navegador recusar mesmo assim (contexto sem HTTPS, por exemplo), o campo
 * fica selecionado para Ctrl+C.
 */
export const InviteLinksPanel = ({ email, convites }: InviteLinksPanelProps) => {
  const [copiado, setCopiado] = useState<string | null>(null);
  const [falhaDeCopia, setFalhaDeCopia] = useState<string | null>(null);
  const campos = useRef(new Map<string, HTMLInputElement>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copiar = async (convite: ConviteCriado) => {
    setFalhaDeCopia(null);
    try {
      await navigator.clipboard.writeText(convite.url);
      setCopiado(convite.phoneNumberId);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopiado(null), 2000);
    } catch (erro) {
      console.warn("[convite] o navegador recusou a cópia:", erro);
      campos.current.get(convite.phoneNumberId)?.select();
      setFalhaDeCopia(convite.phoneNumberId);
    }
  };

  return (
    <div className="space-y-4 py-2">
      <p className="text-sm text-muted-foreground text-pretty">{textoDoEnvio(email, convites)}</p>

      <ul className="space-y-3">
        {convites.map((convite) => {
          const idCampo = `convite-link-${convite.phoneNumberId}`;
          const foiCopiado = copiado === convite.phoneNumberId;
          return (
            <li key={convite.phoneNumberId} className="space-y-1.5">
              <Label htmlFor={idCampo} className="text-xs">
                {convite.phoneNumberName}
              </Label>
              <div className="flex gap-2">
                <Input
                  id={idCampo}
                  readOnly
                  value={convite.url}
                  ref={(el) => {
                    if (el) campos.current.set(convite.phoneNumberId, el);
                    else campos.current.delete(convite.phoneNumberId);
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-9 min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  onClick={() => void copiar(convite)}
                  aria-label={`Copiar link de ${convite.phoneNumberName}`}
                >
                  {foiCopiado ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {foiCopiado ? "Copiado" : "Copiar"}
                </Button>
              </div>
              {falhaDeCopia === convite.phoneNumberId && (
                <p role="alert" className="text-xs text-destructive text-pretty">
                  O navegador não deixou copiar sozinho. O link está selecionado: use Ctrl+C.
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground text-pretty">
        O convite vale por 7 dias e só funciona uma vez. Os links ficam em Convites pendentes, na tela de equipe.
      </p>
    </div>
  );
};
