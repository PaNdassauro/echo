import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Trash2, Link2 } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Virtuoso } from "react-virtuoso";
import { cn } from "@/lib/utils";

interface Recipient {
    id: string;
    phone_number: string;
    contact_name: string;
    variables: string[];
}

interface RecipientTableProps {
    recipients: Recipient[];
    bodyVariableCount: number;
    buttonVariableCount: number;
    onRecipientChange: (id: string, field: keyof Recipient, value: string | string[]) => void;
    onRemove: (id: string) => void;
}

// Column widths, in px. Variable columns get a real minimum instead of a bare `1fr`:
// with 6 variables inside the wizard's max-w-4xl card, `1fr` collapsed each one to
// ~55px — never overflowing, just becoming too narrow to read. Now the grid grows past
// the container and the container scrolls.
const COL_PHONE = 190;
const COL_NAME = 150;
const COL_VAR_MIN = 130;
const COL_ACTION = 44;
const COL_GAP = 8;

// Above this many rows the list is virtualized. Below it, plain rendering keeps the
// DOM simple and avoids a scroller inside a scroller for the common small case.
const VIRTUALIZE_THRESHOLD = 40;

export default function RecipientTable({
    recipients,
    bodyVariableCount,
    buttonVariableCount,
    onRecipientChange,
    onRemove,
}: RecipientTableProps) {
    const isMobile = useIsMobile();
    const totalVariableCount = bodyVariableCount + buttonVariableCount;

    const handleVariableChange = (recipientId: string, index: number, value: string) => {
        const recipient = recipients.find((r) => r.id === recipientId);
        if (!recipient) return;

        const newVariables = [...recipient.variables];
        newVariables[index] = value;
        onRecipientChange(recipientId, "variables", newVariables);
    };

    // Column headers: body vars first, then button vars.
    const variableHeaders = [
        ...Array.from({ length: bodyVariableCount }, (_, i) => ({
            label: `{{${i + 1}}}`,
            isButton: false,
        })),
        ...Array.from({ length: buttonVariableCount }, (_, i) => ({
            label: `Botão ${i + 1}`,
            isButton: true,
        })),
    ];

    // Defined once and shared by the header and the rows. These two used to carry
    // duplicate inline template strings, which is exactly how they drift apart.
    const gridTemplateColumns = `${COL_PHONE}px ${COL_NAME}px ${totalVariableCount > 0 ? `repeat(${totalVariableCount}, minmax(${COL_VAR_MIN}px, 1fr))` : ""} ${COL_ACTION}px`;
    const minWidth =
        COL_PHONE + COL_NAME + COL_ACTION + totalVariableCount * COL_VAR_MIN + (2 + totalVariableCount) * COL_GAP;

    // Mobile: cartões empilhados com labels acima dos campos — o grid de
    // ≥390px obrigava scroll lateral por campo num passo OBRIGATÓRIO do disparo.
    if (isMobile) {
        const renderCard = (index: number, recipient: Recipient) => (
            <div className="relative rounded-md border p-3 space-y-2.5 mb-3">
                <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                        Destinatário {index + 1}
                    </span>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRemove(recipient.id)}
                        className="h-11 w-11 p-0 -mr-1 -mt-1 text-destructive hover:text-destructive"
                        aria-label={`Remover destinatário ${index + 1}`}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
                <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Telefone *</label>
                    <Input
                        type="tel"
                        inputMode="numeric"
                        placeholder="5511999990001"
                        value={recipient.phone_number}
                        onChange={(e) => onRecipientChange(recipient.id, "phone_number", e.target.value)}
                    />
                </div>
                <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Nome</label>
                    <Input
                        placeholder="Nome (opcional)"
                        value={recipient.contact_name}
                        onChange={(e) => onRecipientChange(recipient.id, "contact_name", e.target.value)}
                    />
                </div>
                {variableHeaders.map((header, i) => (
                    <div key={i} className="space-y-1">
                        <label
                            className={cn(
                                "flex items-center gap-1 text-xs",
                                header.isButton ? "text-info" : "text-muted-foreground"
                            )}
                        >
                            {header.isButton && <Link2 className="h-3 w-3" />}
                            {header.label}
                        </label>
                        <Input
                            placeholder={header.isButton ? "Parâmetro URL" : `Variável ${i + 1}…`}
                            value={recipient.variables[i] || ""}
                            onChange={(e) => handleVariableChange(recipient.id, i, e.target.value)}
                            className={header.isButton ? "border-info/40 focus:border-info" : ""}
                        />
                    </div>
                ))}
            </div>
        );

        if (recipients.length > VIRTUALIZE_THRESHOLD) {
            return (
                <Virtuoso
                    style={{ height: "60dvh" }}
                    data={recipients}
                    itemContent={renderCard}
                    className="pr-2"
                />
            );
        }

        return (
            <ScrollArea className="h-[60dvh]">
                <div className="pr-2">
                    {recipients.map((recipient, index) => (
                        <div key={recipient.id}>{renderCard(index, recipient)}</div>
                    ))}
                </div>
            </ScrollArea>
        );
    }

    const renderRow = (_index: number, recipient: Recipient) => (
        <div className="grid gap-2 items-center pb-2" style={{ gridTemplateColumns }}>
            <Input
                placeholder="5511999990001"
                value={recipient.phone_number}
                onChange={(e) => onRecipientChange(recipient.id, "phone_number", e.target.value)}
                className="h-9"
            />
            <Input
                placeholder="Nome (opcional)"
                value={recipient.contact_name}
                onChange={(e) => onRecipientChange(recipient.id, "contact_name", e.target.value)}
                className="h-9"
            />
            {variableHeaders.map((header, i) => (
                <Input
                    key={i}
                    placeholder={header.isButton ? "Parâmetro URL" : `Variável ${i + 1}…`}
                    value={recipient.variables[i] || ""}
                    onChange={(e) => handleVariableChange(recipient.id, i, e.target.value)}
                    className={cn("h-9", header.isButton && "border-info/40 focus:border-info")}
                />
            ))}
            <Button
                variant="ghost"
                size="sm"
                onClick={() => onRemove(recipient.id)}
                className="h-9 w-9 p-0 text-destructive hover:text-destructive"
                aria-label="Remover destinatário"
            >
                <Trash2 className="h-4 w-4" />
            </Button>
        </div>
    );

    return (
        // One horizontal scroller wrapping header AND rows, so the columns can keep
        // readable widths and still line up when scrolled.
        <div className="overflow-x-auto">
            <div style={{ minWidth }}>
                <div
                    className="grid gap-2 text-xs font-medium text-muted-foreground px-1 pb-2 sticky top-0 bg-card z-10"
                    style={{ gridTemplateColumns }}
                >
                    <div>Telefone *</div>
                    <div>Nome</div>
                    {variableHeaders.map((header, i) => (
                        <div
                            key={i}
                            className={cn("flex items-center gap-1", header.isButton && "text-info")}
                        >
                            {header.isButton && <Link2 className="h-3 w-3" />}
                            {header.label}
                        </div>
                    ))}
                    <div />
                </div>

                {recipients.length > VIRTUALIZE_THRESHOLD ? (
                    // A 5.000-row import would otherwise mount ~15-25k live inputs at once.
                    <Virtuoso style={{ height: 400 }} data={recipients} itemContent={renderRow} />
                ) : (
                    <ScrollArea className="h-[400px]">
                        <div className="pr-2">
                            {recipients.map((recipient, index) => (
                                <div key={recipient.id}>{renderRow(index, recipient)}</div>
                            ))}
                        </div>
                    </ScrollArea>
                )}
            </div>
        </div>
    );
}
