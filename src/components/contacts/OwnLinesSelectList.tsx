import { useEffect, useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useAccessiblePhoneNumbers } from "@/hooks/useAccessiblePhoneNumbers";
import { getLookupVariations, formatParticipantPhone } from "@/lib/phone";
import { Loader2, Check, Phone } from "lucide-react";

/** Linha da própria organização, pronta para virar participante do grupo. */
export interface SelectableLine {
  id: string;
  displayName: string;
  phone: string;
  themeHue: number | null;
}

interface OwnLinesSelectListProps {
  /** Linha dona do grupo — não faz sentido adicioná-la a si mesma. */
  phoneNumberId: string;
  enabled: boolean;
  /** Telefones já no grupo (ou já escolhidos): marcados e não clicáveis. */
  excludedPhones?: string[];
  /** Rótulo do botão de confirmação, ex.: "Adicionar ao grupo". */
  actionLabel?: string;
  /** Recebe as linhas escolhidas; a lista limpa a seleção depois. */
  onConfirm: (lines: SelectableLine[]) => void | Promise<void>;
  /** Trava a UI enquanto a adição está em voo. */
  busy?: boolean;
  /** Texto de progresso mostrado no lugar do rótulo do botão. */
  busyLabel?: string;
  className?: string;
  listHeightClassName?: string;
}

/** Chaves de comparação tolerantes ao 55 e ao 9º dígito. */
const keysOf = (phone: string): string[] => {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits ? getLookupVariations(digits) : [];
};

/**
 * Lista as OUTRAS linhas da organização para colocá-las no grupo de uma vez.
 *
 * Existe porque é rotina ter 3 ou 4 linhas próprias no mesmo grupo, e nenhuma
 * delas aparece no `ContactSelectList`: aquele picker vem de conversas 1:1, e
 * uma linha não tem conversa consigo mesma. Sem isto, adicionar a linha Suporte
 * ao grupo da linha Vendas exige saber o número de cor e digitar na aba "Novo".
 *
 * O gate de acesso é a RLS (`phone_numbers_select` / `user_has_phone_access`),
 * igual ao `useAccessiblePhoneNumbers` — não se filtra acesso no cliente.
 */
const OwnLinesSelectList = ({
  phoneNumberId,
  enabled,
  excludedPhones = [],
  actionLabel = "Adicionar",
  onConfirm,
  busy = false,
  busyLabel,
  className,
  listHeightClassName = "h-[260px]",
}: OwnLinesSelectListProps) => {
  const { currentOrganization } = useOrganization();
  // Sem revalidar a cada abertura do diálogo: o mapa é compartilhado com o
  // Dashboard, e cada GET o faria renderizar de novo (ver o hook).
  const { phoneNumbers, isLoading } = useAccessiblePhoneNumbers(
    currentOrganization?.id,
    enabled,
    { revalidarAoMontar: false }
  );
  const [selected, setSelected] = useState<string[]>([]);

  // Trocar de grupo (outra linha em foco) invalida a seleção anterior.
  useEffect(() => {
    setSelected([]);
  }, [phoneNumberId]);

  const excludedKeys = useMemo(
    () => new Set(excludedPhones.flatMap(keysOf)),
    [excludedPhones]
  );

  const lines = useMemo<Array<SelectableLine & { inGroup: boolean }>>(
    () =>
      phoneNumbers
        // A linha dona do grupo já está lá por definição.
        .filter((line) => line.id !== phoneNumberId && line.phoneNumber)
        // Só linha QR entra em grupo: a Cloud API da Meta não tem grupos, então
        // oferecer um número business_api aqui só produziria erro no WhatsApp.
        .filter((line) => line.connectionType === "qr")
        .map((line) => ({
          id: line.id,
          displayName: line.displayName,
          phone: line.phoneNumber,
          themeHue: line.themeHue,
          inGroup: keysOf(line.phoneNumber).some((k) => excludedKeys.has(k)),
        })),
    [phoneNumbers, phoneNumberId, excludedKeys]
  );

  // Uma linha que entrou no grupo enquanto o diálogo estava aberto some da
  // seleção: confirmar com ela dentro só produziria um erro do WhatsApp.
  useEffect(() => {
    setSelected((prev) => {
      const addable = new Set(lines.filter((l) => !l.inGroup).map((l) => l.id));
      const next = prev.filter((id) => addable.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [lines]);

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const handleConfirm = async () => {
    const chosen = lines.filter((line) => selected.includes(line.id));
    if (!chosen.length) return;
    await onConfirm(chosen);
    setSelected([]);
  };

  const availableCount = lines.filter((l) => !l.inGroup).length;

  return (
    <div className={className}>
      <ScrollArea className={listHeightClassName}>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : lines.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            Nenhum outro número conectado nesta organização
          </div>
        ) : availableCount === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            Todos os números conectados já estão neste grupo
          </div>
        ) : (
          <div className="space-y-2 pr-3">
            {lines.map((line) => {
              const isSelected = selected.includes(line.id);
              return (
                <button
                  key={line.id}
                  type="button"
                  onClick={() => !line.inGroup && !busy && toggle(line.id)}
                  disabled={line.inGroup || busy}
                  aria-pressed={line.inGroup ? undefined : isSelected}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 ${
                    line.inGroup
                      ? "border-border opacity-50 cursor-not-allowed"
                      : isSelected
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50 hover:bg-muted/50"
                  }`}
                >
                  {/* Caixa desenhada à mão, não o <Checkbox> do Radix: aquele
                      renderiza um <button> e aninhar botão em botão é HTML
                      inválido. O estado real vai em aria-pressed no pai. */}
                  {line.inGroup ? (
                    <span className="w-4 h-4 shrink-0" />
                  ) : (
                    <span
                      aria-hidden
                      className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center transition-colors ${
                        isSelected
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-input"
                      }`}
                    >
                      {isSelected && <Check className="w-3 h-3" />}
                    </span>
                  )}
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: `hsl(${line.themeHue ?? 176}, 65%, 55%)` }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{line.displayName}</p>
                    <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                      <Phone className="w-3 h-3 shrink-0" />
                      {formatParticipantPhone(line.phone)}
                    </p>
                  </div>
                  {line.inGroup && (
                    <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" />
                      no grupo
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>

      <Button
        type="button"
        className="w-full mt-3"
        disabled={selected.length === 0 || busy}
        onClick={() => void handleConfirm()}
      >
        {busy ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            {busyLabel ?? "Adicionando…"}
          </>
        ) : (
          `${actionLabel}${selected.length ? ` (${selected.length})` : ""}`
        )}
      </Button>
    </div>
  );
};

export default OwnLinesSelectList;
