import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { A11Y_CHANGE_EVENT } from "@/lib/accessibilityPrefs";
import {
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_MAX,
  clampListWidth,
  minListWidthFor,
  persistListWidth,
  readStoredListWidth,
  widthForKey,
} from "@/lib/conversationListWidth";

const readMinWidth = () => minListWidthFor(getComputedStyle(document.documentElement).fontSize);

/** Mínimo da coluna, refeito quando o "Tamanho do texto do app" muda. */
function useMinListWidth(): number {
  const [min, setMin] = useState(readMinWidth);
  useEffect(() => {
    const onChange = () => setMin(readMinWidth());
    window.addEventListener(A11Y_CHANGE_EVENT, onChange);
    onChange();
    return () => window.removeEventListener(A11Y_CHANGE_EVENT, onChange);
  }, []);
  return min;
}

/**
 * Coluna da lista de conversas (desktop) com a borda direita arrastável.
 *
 * O estado mora aqui e a lista entra como `children`: o elemento vem pronto do
 * Dashboard, então cada pointermove re-renderiza só esta casca — nem a lista
 * nem o ChatArea (irmão flex-1, que só acompanha pelo layout).
 *
 * O max-width em CSS garante espaço para o chat quando a janela estreita depois
 * de salvar uma largura grande; o arraste parte da largura renderizada, não da
 * salva, para não dar salto nesse caso.
 */
export function ResizableListColumn({ children }: { children: ReactNode }) {
  const [storedWidth, setWidth] = useState(readStoredListWidth);
  const [dragging, setDragging] = useState(false);
  const minWidth = useMinListWidth();
  // A salva pode ficar abaixo do mínimo atual (texto maior): o separador anuncia
  // e o teclado parte da que está na tela.
  const width = Math.max(storedWidth, minWidth);
  const columnRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number; last: number } | null>(null);

  const commit = useCallback((next: number) => {
    setWidth(next);
    persistListWidth(next);
  }, []);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    persistListWidth(drag.last);
  }, []);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rendered = columnRef.current?.getBoundingClientRect().width ?? width;
    dragRef.current = { startX: e.clientX, startWidth: rendered, last: clampListWidth(rendered, minWidth) };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    // No body: o cursor não pisca ao passar por cima de links e do chat.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.last = clampListWidth(drag.startWidth + e.clientX - drag.startX, minWidth);
    setWidth(drag.last);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = widthForKey(width, e.key, e.shiftKey, minWidth);
    if (next === null) return;
    e.preventDefault();
    commit(next);
  };

  return (
    <div
      ref={columnRef}
      // container "sidebar": a lista encolhe ícones e esconde rótulos e fotos
      // abaixo de 23rem pela variante sidebar-narrow: (tailwind.config.ts).
      className="relative flex shrink-0 [container:sidebar/inline-size]"
      style={{ width, maxWidth: "calc(100vw - 420px)", minWidth }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionar lista de conversas"
        aria-valuenow={width}
        aria-valuemin={minWidth}
        aria-valuemax={LIST_WIDTH_MAX}
        tabIndex={0}
        title="Arraste para redimensionar · duplo clique volta ao padrão"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => commit(LIST_WIDTH_DEFAULT)}
        onKeyDown={handleKeyDown}
        data-dragging={dragging || undefined}
        className={cn(
          // Faixa de 9px centrada na border-r da lista; a linha visível é o ::after.
          "group absolute inset-y-0 -right-1 z-20 w-[9px] cursor-col-resize touch-none outline-none",
          "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2",
          "after:bg-transparent after:transition-colors after:duration-150 after:ease-out",
          "hover:after:bg-primary/60 focus-visible:after:bg-primary data-[dragging]:after:bg-primary",
        )}
      />
    </div>
  );
}
