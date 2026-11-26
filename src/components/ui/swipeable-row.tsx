import { ReactNode, useRef } from "react";
import { motion, useMotionValue, useTransform, PanInfo } from "framer-motion";
import { cn } from "@/lib/utils";
import { SPRING_SNAP } from "@/lib/motion";

interface SwipeAction {
  icon: ReactNode;
  label: string;
  color: string;
  onClick: () => void;
}

interface SwipeableRowProps {
  children: ReactNode;
  /** Ação executada ao arrastar para a DIREITA além do threshold. */
  leftAction?: SwipeAction;
  /** Ação executada ao arrastar para a ESQUERDA além do threshold. */
  rightAction?: SwipeAction;
  className?: string;
  threshold?: number;
  disabled?: boolean;
}

/**
 * Swipe de lista no modelo ação-por-threshold (padrão WhatsApp/Mail): soltar
 * além do limiar — por distância OU por flick — executa a ação e a linha volta
 * sozinha com spring. Sem estado "gaveta aberta". Haptic ao cruzar o limiar.
 */
export function SwipeableRow({
  children,
  leftAction,
  rightAction,
  className,
  threshold = 80,
  disabled = false,
}: SwipeableRowProps) {
  const x = useMotionValue(0);
  const crossedRef = useRef<"left" | "right" | null>(null);
  // Maior deslocamento REAL da linha no gesto atual — para engolir o click
  // que o browser emite após um arrasto com mouse/caneta.
  const dragDistanceRef = useRef(0);

  // O ícone "nasce" com o arrasto: opacity 0→1 e scale 0.85→1 até o threshold.
  const leftOpacity = useTransform(x, [0, threshold], [0, 1]);
  const leftScale = useTransform(x, [0, threshold], [0.85, 1]);
  const rightOpacity = useTransform(x, [-threshold, 0], [1, 0]);
  const rightScale = useTransform(x, [-threshold, 0], [1, 0.85]);

  const handleDrag = () => {
    const dx = x.get();
    dragDistanceRef.current = Math.max(dragDistanceRef.current, Math.abs(dx));
    const crossed = dx > threshold ? "left" : dx < -threshold ? "right" : null;
    // Haptic uma única vez por cruzamento do limiar (padrão do swipe-to-reply)
    if (crossed && crossedRef.current !== crossed) {
      navigator.vibrate?.(10);
    }
    crossedRef.current = crossed;
  };

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    // Decide pelo deslocamento REAL da linha (x.get()), nunca pelo offset do
    // PONTEIRO: com dragDirectionLock travado em "y" o elemento não se move,
    // mas o PanInfo ainda traz o offset.x completo — decidir por ele arquivava
    // conversas num scroll diagonal, sem nenhum feedback visual.
    const dx = x.get();
    const vx = info.velocity.x;
    // Distância OU velocidade: um flick curto também comete a ação.
    if (leftAction && (dx > threshold || (vx > 500 && dx > 24))) {
      leftAction.onClick();
    } else if (rightAction && (dx < -threshold || (vx < -500 && dx < -24))) {
      rightAction.onClick();
    }
    crossedRef.current = null;
  };

  if (disabled) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div className={cn("relative overflow-hidden", className)}>
      {leftAction && (
        <motion.div
          className="absolute inset-y-0 left-0 flex w-20 items-center justify-center"
          style={{ backgroundColor: leftAction.color, opacity: leftOpacity }}
          aria-hidden="true"
        >
          <motion.div style={{ scale: leftScale }} className="flex flex-col items-center text-white">
            {leftAction.icon}
            <span className="mt-1 text-xs font-medium">{leftAction.label}</span>
          </motion.div>
        </motion.div>
      )}

      {rightAction && (
        <motion.div
          className="absolute inset-y-0 right-0 flex w-20 items-center justify-center"
          style={{ backgroundColor: rightAction.color, opacity: rightOpacity }}
          aria-hidden="true"
        >
          <motion.div style={{ scale: rightScale }} className="flex flex-col items-center text-white">
            {rightAction.icon}
            <span className="mt-1 text-xs font-medium">{rightAction.label}</span>
          </motion.div>
        </motion.div>
      )}

      <motion.div
        drag="x"
        dragConstraints={{
          left: rightAction ? -threshold * 1.5 : 0,
          right: leftAction ? threshold * 1.5 : 0,
        }}
        dragDirectionLock
        dragElastic={0.12}
        dragSnapToOrigin
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
        onPointerDownCapture={() => {
          dragDistanceRef.current = 0;
        }}
        onClickCapture={(e) => {
          // Mouse/caneta emitem click no soltar do arrasto: um swipe não pode
          // TAMBÉM abrir a conversa (o framer não suprime o click nativo).
          if (dragDistanceRef.current > 5) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        transition={SPRING_SNAP}
        style={{ x }}
        className="relative bg-background touch-pan-y"
      >
        {children}
      </motion.div>
    </div>
  );
}
