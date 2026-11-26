/**
 * Escolher um setor. Serve dois fluxos com a mesma peça:
 *
 *   - ASSUMIR uma conversa da triagem quando o atendente tem dois ou mais
 *     setores na linha e nenhum deles é o padrão dele (ver `resolveAssumeSector`
 *     em src/lib/sectors.ts). Aqui a lista são os setores DELE.
 *   - ENCAMINHAR para outro setor. Aqui a lista são TODOS os setores da linha,
 *     inclusive os que quem encaminha não atende — encaminhar errado é o
 *     conserto de assumir errado, e ele precisa alcançar o setor certo.
 *
 * Sem seleção prévia: quem abre o diálogo ainda não decidiu, e pré-selecionar
 * faria o Enter mandar para um setor que ninguém escolheu.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
    ResponsiveDialog,
    ResponsiveDialogContent,
    ResponsiveDialogDescription,
    ResponsiveDialogFooter,
    ResponsiveDialogHeader,
    ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { cn } from "@/lib/utils";
import { SECTOR_FALLBACK_COLOR, type Sector } from "@/lib/sectors";

interface SectorPickerDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    sectors: Sector[];
    /** Marcado como "atual" e não selecionável (o setor em que a conversa já está). */
    currentSectorId?: string | null;
    confirmLabel: string;
    pending?: boolean;
    onConfirm: (sectorId: string) => void;
    /** Extra acima dos botões — ex.: "continuar acompanhando". */
    footer?: ReactNode;
}

const SectorPickerDialog = ({
    open,
    onOpenChange,
    title,
    description,
    sectors,
    currentSectorId,
    confirmLabel,
    pending,
    onConfirm,
    footer,
}: SectorPickerDialogProps) => {
    const [selected, setSelected] = useState<string | null>(null);

    // Reabrir o diálogo não herda a escolha da vez anterior.
    useEffect(() => {
        if (open) setSelected(null);
    }, [open]);

    const options = sectors.filter((sector) => sector.id !== currentSectorId);

    return (
        <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
            <ResponsiveDialogContent className="sm:max-w-md">
                <ResponsiveDialogHeader>
                    <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
                    {description && (
                        <ResponsiveDialogDescription>{description}</ResponsiveDialogDescription>
                    )}
                </ResponsiveDialogHeader>

                <div
                    role="radiogroup"
                    aria-label="Setores"
                    className="max-h-64 space-y-1 overflow-y-auto py-1"
                >
                    {options.length === 0 ? (
                        <p className="py-4 text-center text-sm text-muted-foreground">
                            Nenhum outro setor nesta linha.
                        </p>
                    ) : (
                        options.map((sector) => (
                            <button
                                key={sector.id}
                                type="button"
                                role="radio"
                                aria-checked={selected === sector.id}
                                onClick={() => setSelected(sector.id)}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded px-2 py-2 text-sm transition-colors hover:bg-accent active:bg-accent",
                                    selected === sector.id && "bg-accent",
                                )}
                            >
                                <span
                                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                                    style={{ backgroundColor: sector.color ?? SECTOR_FALLBACK_COLOR }}
                                />
                                <span className="truncate">{sector.name}</span>
                            </button>
                        ))
                    )}
                </div>

                {footer}

                <ResponsiveDialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        Cancelar
                    </Button>
                    <Button
                        onClick={() => selected && onConfirm(selected)}
                        disabled={!selected || pending}
                    >
                        {confirmLabel}
                    </Button>
                </ResponsiveDialogFooter>
            </ResponsiveDialogContent>
        </ResponsiveDialog>
    );
};

export default SectorPickerDialog;
