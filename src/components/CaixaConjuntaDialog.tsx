import { useEffect, useMemo, useState } from "react";
import { Check, Instagram } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { useInstagramConexoes } from "@/hooks/useInstagramConexoes";
import type { AccessiblePhoneNumber } from "@/hooks/useAccessiblePhoneNumbers";
import { corDoNumero, MINIMO_DA_CONJUNTA } from "@/lib/caixaConjunta";
import { mapaInstagramPorLinha, rotuloDoTipoDeLinha } from "@/lib/instagramConexoes";
import { cn } from "@/lib/utils";

interface CaixaConjuntaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Os números a que o usuário tem acesso, na ordem em que a lista os mostra. */
  numeros: readonly Pick<AccessiblePhoneNumber, "id" | "displayName" | "themeHue" | "connectionType">[];
  /** Os números que ele já tirou da caixa conjunta (as exclusões guardadas). */
  fora: readonly string[];
  /** Recebe as exclusões novas: os números desmarcados, mais as antigas de números que ele já não acessa. */
  onSalvar: (fora: string[]) => void;
}

/**
 * Escolha dos números que entram na caixa conjunta. O padrão é entrar todos; o que
 * se grava são as EXCLUSÕES, e um número novo liberado entra sozinho. Pede pelo menos
 * 2 números: com 1 a caixa conjunta seria só o modo número.
 */
export function CaixaConjuntaDialog({ open, onOpenChange, numeros, fora, onSalvar }: CaixaConjuntaDialogProps) {
  // Linha QR/API que divide a caixa com uma conta Instagram ligada: marcada como no seletor.
  const { data: instagramConexoes } = useInstagramConexoes();
  const instagramDaLinha = useMemo(() => mapaInstagramPorLinha(instagramConexoes), [instagramConexoes]);

  // O rascunho guarda as EXCLUSÕES, não os marcados: um número que chega com o diálogo aberto
  // entra marcado (não é gravado como exclusão), e um que some deixa de contar no mínimo.
  const [desmarcados, setDesmarcados] = useState<ReadonlySet<string>>(new Set());

  // Cada abertura parte do que está salvo, e não do rascunho de uma abertura cancelada.
  // Se o diálogo abre antes de o mapa de números chegar, o rascunho é refeito quando ele chega
  // (a transição vazio → cheio). Depois disso, mudar `numeros` no meio da edição não apaga o rascunho.
  const temNumeros = numeros.length > 0;
  useEffect(() => {
    if (!open) return;
    setDesmarcados(new Set(fora));
    // `fora` e `numeros` são lidos só na transição: o efeito não roda a cada mudança de conteúdo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, temNumeros]);

  const alternar = (id: string) =>
    setDesmarcados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Só conta os números que ainda são acessíveis (`numeros`): um que sumiu no meio da edição não vale.
  const marcadosValidos = numeros.filter((n) => !desmarcados.has(n.id)).length;
  const suficiente = marcadosValidos >= MINIMO_DA_CONJUNTA;

  const salvar = () => {
    if (!suficiente) return;
    const acessiveis = new Set(numeros.map((n) => n.id));
    // Exclusão de número que ele já não acessa fica como está: se o acesso voltar, a escolha vale.
    const antigas = fora.filter((id) => !acessiveis.has(id));
    const excluidos = numeros.filter((n) => desmarcados.has(n.id)).map((n) => n.id);
    onSalvar([...antigas, ...excluidos]);
    onOpenChange(false);
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Escolher números</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A caixa conjunta junta as conversas dos números marcados numa lista só. A escolha vale só neste aparelho.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {!temNumeros && (
          <p className="px-3 py-2 text-sm text-muted-foreground">Carregando números…</p>
        )}

        <div role="group" aria-label="Números da caixa conjunta" className="max-h-[50vh] space-y-1 overflow-y-auto py-1">
          {numeros.map((numero) => {
            const marcado = !desmarcados.has(numero.id);
            const instagram = instagramDaLinha.get(numero.id);
            return (
              // A linha inteira é o controle. Checkbox de verdade dentro de linha clicável seria
              // um <button> aninhado: a caixa é desenhada num span e o papel fica na linha.
              <div
                key={numero.id}
                role="checkbox"
                aria-checked={marcado}
                tabIndex={0}
                onClick={() => alternar(numero.id)}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    alternar(numero.id);
                  }
                }}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors duration-150 ease-out hover:bg-foreground/[0.04] active:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    marcado ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
                  )}
                >
                  {marcado && <Check className="size-3" strokeWidth={3} />}
                </span>
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: corDoNumero(numero.themeHue) }}
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={numero.displayName}>
                  {numero.displayName}
                </span>
                {instagram !== undefined && (
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 text-xs text-pink-700 dark:text-pink-400"
                    title={`Divide a caixa com a conta Instagram ${instagram}`}
                  >
                    + <Instagram className="size-3" strokeWidth={1.5} aria-label="Instagram" />
                  </span>
                )}
                <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                  {rotuloDoTipoDeLinha(numero.connectionType)}
                </span>
              </div>
            );
          })}
        </div>

        {temNumeros && !suficiente && (
          <p role="alert" className="text-xs text-destructive">
            Escolha pelo menos {MINIMO_DA_CONJUNTA} números
          </p>
        )}

        <ResponsiveDialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={salvar} disabled={!suficiente}>
            Salvar
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
