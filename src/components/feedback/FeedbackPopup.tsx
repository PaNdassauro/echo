import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SPRING_SHEET } from "@/lib/motion";
import { getRuntimeFeatures } from "@/lib/runtimeConfig";
import FeedbackForm from "./FeedbackForm";

const POSITION_STORAGE_KEY = "feedback-popup-position";

interface PanelPosition {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  originX: number;
  originY: number;
}

interface SavedPosition {
  x: number;
  y: number;
}

function loadSavedPosition(): SavedPosition | null {
  try {
    const saved = localStorage.getItem(POSITION_STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved) as SavedPosition;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function savePosition(x: number, y: number) {
  try {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {
    // Ignore storage errors
  }
}

export function FeedbackPopup() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);
  const [initialPosition, setInitialPosition] = useState<SavedPosition | null>(null);
  const constraintsRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);

  // Carregar posição salva na inicialização
  useEffect(() => {
    const saved = loadSavedPosition();
    if (saved) {
      setInitialPosition(saved);
    }
  }, []);

  const calculatePanelPosition = useCallback(() => {
    if (!buttonRef.current) return null;

    const buttonRect = buttonRef.current.getBoundingClientRect();
    const panelWidth = 320; // sm:w-80 = 320px
    const panelHeight = 450; // altura estimada do form
    const padding = 16;
    const buttonSize = buttonRect.width;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Centro do botão
    const buttonCenterX = buttonRect.left + buttonSize / 2;
    const buttonCenterY = buttonRect.top + buttonSize / 2;

    // Espaço disponível em cada direção
    const spaceRight = viewportWidth - buttonRect.right - padding;
    const spaceLeft = buttonRect.left - padding;
    const spaceBottom = viewportHeight - buttonRect.bottom - padding;
    const spaceTop = buttonRect.top - padding;

    let position: PanelPosition = { originX: 0, originY: 0.5 };

    // Horizontal: preferir direita, senão esquerda
    if (spaceRight >= panelWidth) {
      position.left = buttonSize + 8;
      position.originX = 0;
    } else if (spaceLeft >= panelWidth) {
      position.right = buttonSize + 8;
      position.originX = 1;
    } else {
      // Centralizar horizontalmente na tela
      const centeredLeft = (viewportWidth - panelWidth) / 2 - buttonRect.left;
      position.left = centeredLeft;
      position.originX = 0.5;
    }

    // Vertical: centralizar com o botão, mas ajustar se sair da tela
    const idealTop = -panelHeight / 2 + buttonSize / 2;
    const panelTopInViewport = buttonRect.top + idealTop;
    const panelBottomInViewport = panelTopInViewport + panelHeight;

    if (panelTopInViewport < padding) {
      // Painel sairia por cima, alinhar com topo
      position.top = -buttonRect.top + padding;
      position.originY = 0;
    } else if (panelBottomInViewport > viewportHeight - padding) {
      // Painel sairia por baixo, alinhar com fundo
      position.bottom = -(viewportHeight - buttonRect.bottom - padding);
      position.originY = 1;
    } else {
      // Centralizar verticalmente
      position.top = idealTop;
      position.originY = 0.5;
    }

    return position;
  }, []);

  const handleButtonClick = () => {
    if (!isDragging) {
      if (!isExpanded) {
        setPanelPosition(calculatePanelPosition());
      }
      setIsExpanded(!isExpanded);
    }
  };

  // Recalcular posição ao arrastar e salvar no localStorage
  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, _info: { point: { x: number; y: number } }) => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      savePosition(rect.left, rect.top);
    }
    setTimeout(() => {
      setIsDragging(false);
      if (isExpanded) {
        setPanelPosition(calculatePanelPosition());
      }
    }, 100);
  };

  // Recalcular posição ao redimensionar janela
  useEffect(() => {
    if (!isExpanded) return;

    const handleResize = () => {
      setPanelPosition(calculatePanelPosition());
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isExpanded, calculatePanelPosition]);

  // Sem webhook nem e-mail para receber o feedback, o botão não aparece.
  if (!isVisible || !getRuntimeFeatures().feedback) return null;

  return (
    <>
      {/* Constraints container - full screen */}
      <div ref={constraintsRef} className="fixed inset-0 pointer-events-none z-40" />

      <motion.div
        drag
        dragMomentum={false}
        dragElastic={0.1}
        dragConstraints={constraintsRef}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={handleDragEnd}
        onDrag={() => {
          if (isExpanded) {
            setPanelPosition(calculatePanelPosition());
          }
        }}
        initial={initialPosition ? { x: initialPosition.x - 16, y: initialPosition.y - (window.innerHeight / 2) } : undefined}
        className={cn(
          "fixed z-50",
          "left-4 bottom-20 sm:bottom-auto sm:top-1/2"
        )}
        style={{ touchAction: "none" }}
      >
        {/* Close Button — small red dot with an enlarged transparent tap area for touch */}
        <button
          onClick={() => setIsVisible(false)}
          className={cn(
            "absolute -top-2.5 -right-2.5 z-10",
            "w-8 h-8 rounded-full",
            "flex items-center justify-center",
            "touch-manipulation"
          )}
          aria-label="Fechar"
        >
          <span className="w-5 h-5 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors shadow-sm">
            <X className="w-3 h-3 text-white" />
          </span>
        </button>

        {/* Trigger Button */}
        <motion.div
          ref={buttonRef}
          onTap={handleButtonClick}
          className={cn(
            "w-12 h-12 sm:w-14 sm:h-14 rounded-full",
            "bg-card shadow-lg shadow-black/20 border",
            "flex items-center justify-center",
            "hover:bg-muted transition-colors",
            "cursor-grab active:cursor-grabbing"
          )}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          role="button"
          aria-label={isExpanded ? "Fechar feedback" : "Enviar feedback"}
          aria-expanded={isExpanded}
        >
          <img
            src="/echo-icon.png"
            alt="Echo"
            className="w-8 h-8 sm:w-10 sm:h-10 object-contain pointer-events-none select-none"
            draggable={false}
          />
        </motion.div>

        {/* Expanded Panel */}
        <AnimatePresence>
          {isExpanded && panelPosition && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={SPRING_SHEET}
              onPointerDownCapture={(e) => e.stopPropagation()}
              className="absolute w-80 max-w-[calc(100vw-2rem)]"
              style={{
                top: panelPosition.top,
                bottom: panelPosition.bottom,
                left: panelPosition.left,
                right: panelPosition.right,
                transformOrigin: `${panelPosition.originX * 100}% ${panelPosition.originY * 100}%`,
              }}
            >
              <FeedbackForm onClose={() => setIsExpanded(false)} />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </>
  );
}
