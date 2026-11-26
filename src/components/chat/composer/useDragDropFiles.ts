import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drag & drop de arquivos na área do chat (paridade WhatsApp).
 *
 * Contador de dragenter/dragleave em ref: os eventos disparam em cada filho
 * atravessado e um boolean simples "pisca" o overlay a cada borda interna.
 * O overlay aparece só para drags que carregam arquivos (types inclui Files).
 */
export function useDragDropFiles(options: {
  enabled: boolean;
  onDropFiles: (files: File[]) => void;
}) {
  const { enabled, onDropFiles } = options;
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const depthRef = useRef(0);

  const onDropFilesRef = useRef(onDropFiles);
  onDropFilesRef.current = onDropFiles;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) {
      depthRef.current = 0;
      setIsDraggingOver(false);
    }
  }, [enabled]);

  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!enabledRef.current || !hasFiles(e)) return;
    e.preventDefault();
    depthRef.current += 1;
    setIsDraggingOver(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!enabledRef.current || !hasFiles(e)) return;
    e.preventDefault();
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!enabledRef.current || !hasFiles(e)) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setIsDraggingOver(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!enabledRef.current) return;
    e.preventDefault();
    depthRef.current = 0;
    setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onDropFilesRef.current(files);
  }, []);

  return {
    isDraggingOver,
    dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
