import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A selectable option card for the broadcast wizard.
 *
 * The wizard's pickers (número, template, agendamento) were all `<div onClick>`:
 * no keyboard path, no focus ring, no pressed state, and invisible to assistive
 * tech — which meant the broadcast flow could not be completed without a mouse.
 *
 * Implemented as a visually-hidden radio inside a `<label>` rather than a
 * `<button aria-pressed>`, for two reasons:
 *   1. Native radiogroup semantics — arrow keys move between options and the
 *      group announces "2 of 5", which is what these cards actually are.
 *   2. The template cards contain `Badge` (a `<div>`), and a `<div>` inside a
 *      `<button>` is invalid content model. A `<label>` accepts flow content.
 *
 * Interaction styling follows ThemeSettings.tsx:100-126, the most polished
 * selection-card pattern in the repo.
 */
interface SelectableCardProps {
    /** Shared radio group name — must be identical for all cards in one group. */
    name: string;
    selected: boolean;
    onSelect: () => void;
    /** Accessible name, since the visible content can be structural markup. */
    label: string;
    disabled?: boolean;
    className?: string;
    children: React.ReactNode;
}

export function SelectableCard({
    name,
    selected,
    onSelect,
    label,
    disabled,
    className,
    children,
}: SelectableCardProps) {
    return (
        <label
            className={cn(
                "relative block rounded-lg border-2 p-4 pr-11",
                "transition-[border-color,background-color,box-shadow,transform] duration-150 ease-out",
                // The ring lives on the label because the real focus target is the
                // hidden radio inside it.
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                disabled
                    ? "opacity-50 cursor-not-allowed border-muted"
                    : [
                        "cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100",
                        selected
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-muted hover:border-primary/50",
                    ],
                className
            )}
        >
            <input
                type="radio"
                name={name}
                checked={selected}
                onChange={onSelect}
                disabled={disabled}
                aria-label={label}
                className="sr-only"
            />

            {children}

            {/* Check disc: scales in rather than popping, so selecting reads as a
                transition instead of a repaint. */}
            <span
                aria-hidden="true"
                className={cn(
                    "absolute right-3 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground",
                    "transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
                    selected ? "opacity-100 scale-100" : "opacity-0 scale-75"
                )}
            >
                <Check className="h-3 w-3" />
            </span>
        </label>
    );
}
