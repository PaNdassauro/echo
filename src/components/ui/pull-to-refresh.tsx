import { useState, useRef, ReactNode, useCallback } from "react";
import { motion, PanInfo } from "framer-motion";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface PullToRefreshProps {
  children: ReactNode;
  onRefresh: () => Promise<void>;
  className?: string;
  threshold?: number;
  disabled?: boolean;
  /** Expõe o elemento de scroll interno (ex.: customScrollParent de listas virtualizadas). */
  scrollElementRef?: (el: HTMLDivElement | null) => void;
}

export function PullToRefresh({
  children,
  onRefresh,
  className,
  threshold = 80,
  disabled = false,
  scrollElementRef,
}: PullToRefreshProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const startY = useRef(0);
  const isPulling = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabled || isRefreshing) return;

    const scrollContainer = scrollRef.current;
    if (scrollContainer && scrollContainer.scrollTop <= 0) {
      startY.current = e.touches[0].clientY;
      isPulling.current = true;
    }
  }, [disabled, isRefreshing]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (disabled || isRefreshing || !isPulling.current) return;

    const scrollContainer = scrollRef.current;
    if (!scrollContainer || scrollContainer.scrollTop > 0) {
      setPullDistance(0);
      return;
    }

    const currentY = e.touches[0].clientY;
    const diff = currentY - startY.current;

    if (diff > 0) {
      // Apply resistance to pull
      const resistance = 0.4;
      setPullDistance(diff * resistance);
    }
  }, [disabled, isRefreshing]);

  const handleTouchEnd = useCallback(async () => {
    if (disabled || isRefreshing || !isPulling.current) return;

    isPulling.current = false;

    if (pullDistance >= threshold) {
      setIsRefreshing(true);

      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [disabled, isRefreshing, pullDistance, threshold, onRefresh]);

  if (disabled) {
    return <div className={className}>{children}</div>;
  }

  const indicatorProgress = Math.min(pullDistance / threshold, 1);
  const showIndicator = pullDistance > 10 || isRefreshing;

  return (
    <div className={cn("relative overflow-hidden", className)}>
      {/* Pull indicator */}
      <motion.div
        className="absolute top-0 left-0 right-0 flex items-center justify-center z-20 pointer-events-none"
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{
          opacity: showIndicator ? 1 : 0,
          scale: showIndicator ? 1 : 0.5,
          y: isRefreshing ? 20 : Math.max(pullDistance - 30, 0),
        }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
      >
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary shadow-lg">
          <Loader2
            className={cn(
              "w-5 h-5 text-primary-foreground",
              isRefreshing && "animate-spin"
            )}
            style={{
              transform: isRefreshing ? undefined : `rotate(${indicatorProgress * 360}deg)`,
            }}
          />
        </div>
      </motion.div>

      {/* Content */}
      <motion.div
        ref={(el: HTMLDivElement | null) => {
          scrollRef.current = el;
          scrollElementRef?.(el);
        }}
        className="h-full overflow-auto overscroll-contain"
        animate={{
          y: isRefreshing ? 50 : pullDistance > 0 ? pullDistance : 0,
        }}
        transition={pullDistance === 0 && !isRefreshing ? { type: "spring", stiffness: 400, damping: 30 } : { duration: 0 }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {children}
      </motion.div>
    </div>
  );
}
