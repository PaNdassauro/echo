import { useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";

export interface TagData {
    id: string;
    name: string;
    color: string;
    phone_number_id: string | null;
}

type TagEventHandler = (tagId: string, e: React.MouseEvent) => void;

/** Quantas pílulas cabem na linha compacta antes de colapsar no "+N". */
const MAX_VISIBLE_COMPACT = 2;

// Tag Selector Popover with search and scroll
export const TagSelectorPopover = ({
    tags,
    onSelectTag,
    size = "default",
}: {
    tags: TagData[];
    onSelectTag: TagEventHandler;
    /** "sm" é a variante da linha compacta: trigger menor e revelado no hover da row. */
    size?: "default" | "sm";
}) => {
    const [searchQuery, setSearchQuery] = useState("");
    const [open, setOpen] = useState(false);

    const filteredTags = tags.filter((tag) =>
        tag.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const isSmall = size === "sm";

    return (
        <Popover open={open} onOpenChange={(isOpen) => {
            setOpen(isOpen);
            if (!isOpen) setSearchQuery("");
        }}>
            <PopoverTrigger asChild>
                <button
                    onClick={(e) => e.stopPropagation()}
                    className={
                        isSmall
                            // Em ponteiro fino o "+" só aparece no hover da row: um ícone
                            // cinza em TODA linha derrotaria o propósito da visão enxuta.
                            // Em touch (sem hover:hover) fica sempre visível.
                            ? "inline-flex items-center justify-center w-4 h-4 shrink-0 rounded-full bg-muted hover:bg-muted-foreground/20 active:scale-[0.96] motion-reduce:active:scale-100 transition-[background-color,opacity,transform] duration-150 ease-out [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                            : "inline-flex items-center justify-center w-5 h-5 rounded-full bg-muted hover:bg-muted-foreground/20 active:scale-[0.96] motion-reduce:active:scale-100 transition-[background-color,transform] duration-150 ease-out"
                    }
                    aria-label="Adicionar tag"
                >
                    <Plus className={isSmall ? "w-2.5 h-2.5" : "w-3 h-3"} />
                </button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-2" align="start">
                <div className="space-y-2">
                    <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                        <Input
                            placeholder="Buscar tag…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-7 pl-7 text-xs"
                            autoFocus
                        />
                    </div>
                    <div className="h-48 overflow-y-scroll space-y-1 pr-1">
                        {filteredTags.length === 0 ? (
                            <p className="text-xs text-muted-foreground text-center py-2">
                                Nenhuma tag encontrada
                            </p>
                        ) : (
                            filteredTags.map((tag) => (
                                <button
                                    key={tag.id}
                                    onClick={(e) => {
                                        onSelectTag(tag.id, e);
                                        setOpen(false);
                                        setSearchQuery("");
                                    }}
                                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-accent active:bg-accent"
                                >
                                    <div
                                        className="w-3 h-3 rounded-full shrink-0"
                                        style={{ backgroundColor: tag.color }}
                                    />
                                    <span className="truncate" title={tag.name}>{tag.name}</span>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
};

/**
 * "+N" da linha compacta. Abre a lista COMPLETA de tags da conversa — e não só
 * as escondidas — porque quem clica quer ver o conjunto, não o resto dele.
 */
const TagOverflowPopover = ({
    tags,
    hiddenCount,
    onRemove,
}: {
    tags: TagData[];
    hiddenCount: number;
    onRemove: TagEventHandler;
}) => (
    <Popover>
        <PopoverTrigger asChild>
            <button
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center shrink-0 text-xs leading-4 px-1.5 rounded-full bg-muted text-muted-foreground tabular-nums hover:bg-muted-foreground/20 active:scale-[0.96] motion-reduce:active:scale-100 transition-[background-color,transform] duration-150 ease-out"
                aria-label={`Mais ${hiddenCount} ${hiddenCount === 1 ? "tag" : "tags"}`}
            >
                +{hiddenCount}
            </button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-2" align="start" onClick={(e) => e.stopPropagation()}>
            <div className="space-y-1">
                {tags.map((tag) => (
                    <div
                        key={tag.id}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded"
                    >
                        <div
                            className="w-3 h-3 rounded-full shrink-0"
                            style={{ backgroundColor: tag.color }}
                        />
                        <span className="truncate flex-1 min-w-0" title={tag.name}>{tag.name}</span>
                        <button
                            onClick={(e) => onRemove(tag.id, e)}
                            className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-muted active:bg-muted active:scale-[0.96] motion-reduce:active:scale-100 transition-[background-color,transform] duration-150 ease-out"
                            aria-label={`Remover tag ${tag.name}`}
                        >
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                ))}
            </div>
        </PopoverContent>
    </Popover>
);

/**
 * Tags de uma conversa na lista. `compact` é a mesma informação em densidade
 * menor (mesmo contrato do `compact` de AssigneeAvatarStack): pílula menor,
 * excedente colapsado no "+N" e altura de linha idêntica à do preview, para a
 * row compacta não crescer.
 *
 * Sem animação de entrada/saída de propósito: é conteúdo de linha de lista,
 * visto dezenas de vezes por dia — animar aqui só atrasaria a leitura.
 */
export const ConversationTagPills = ({
    tags,
    availableTags,
    onAdd,
    onRemove,
    compact = false,
}: {
    tags: TagData[];
    availableTags: TagData[];
    onAdd: TagEventHandler;
    onRemove: TagEventHandler;
    compact?: boolean;
}) => {
    // Nada a mostrar nem a adicionar: não deixa um nó vazio por linha na lista
    // virtualizada (a row compacta chega a centenas de instâncias).
    if (tags.length === 0 && availableTags.length === 0) return null;

    if (compact) {
        const visible = tags.slice(0, MAX_VISIBLE_COMPACT);
        const hiddenCount = tags.length - visible.length;

        return (
            <div className="flex items-center gap-1 shrink-0">
                {visible.map((tag) => (
                    <span
                        key={tag.id}
                        className="inline-flex items-center gap-0.5 shrink-0 text-xs leading-4 px-1.5 rounded-full text-white"
                        style={{ backgroundColor: tag.color }}
                        onClick={(e) => e.stopPropagation()}
                        title={tag.name}
                    >
                        <span className="max-w-[72px] truncate">{tag.name}</span>
                        <button
                            onClick={(e) => onRemove(tag.id, e)}
                            className="hover:bg-white/20 active:bg-white/20 rounded-full p-px active:scale-[0.96] motion-reduce:active:scale-100 transition-[background-color,transform] duration-150 ease-out"
                            aria-label={`Remover tag ${tag.name}`}
                        >
                            <X className="w-2 h-2" />
                        </button>
                    </span>
                ))}

                {hiddenCount > 0 && (
                    <TagOverflowPopover
                        tags={tags}
                        hiddenCount={hiddenCount}
                        onRemove={onRemove}
                    />
                )}

                {availableTags.length > 0 && (
                    <TagSelectorPopover tags={availableTags} onSelectTag={onAdd} size="sm" />
                )}
            </div>
        );
    }

    return (
        <>
            {tags.map((tag) => (
                <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full text-white"
                    style={{ backgroundColor: tag.color }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {tag.name}
                    <button
                        onClick={(e) => onRemove(tag.id, e)}
                        className="hover:bg-white/20 active:bg-white/20 rounded-full p-0.5"
                        aria-label={`Remover tag ${tag.name}`}
                    >
                        <X className="w-2.5 h-2.5" />
                    </button>
                </span>
            ))}

            {availableTags.length > 0 && (
                <TagSelectorPopover tags={availableTags} onSelectTag={onAdd} />
            )}
        </>
    );
};
