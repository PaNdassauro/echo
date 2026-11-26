import { ReactNode } from "react";
import { BottomNavigation } from "./BottomNavigation";
import { MobileHeader } from "./MobileHeader";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

interface MobileLayoutProps {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
  backTo?: string;
  showBottomNav?: boolean;
  showHeader?: boolean;
  headerActions?: React.ReactNode;
  headerMenuItems?: Array<{
    label: string;
    onClick: () => void;
    icon?: React.ReactNode;
    destructive?: boolean;
  }>;
  className?: string;
  contentClassName?: string;
  fullHeight?: boolean;
}

export function MobileLayout({
  children,
  title = "",
  subtitle,
  showBack = false,
  onBack,
  backTo,
  showBottomNav = true,
  showHeader = true,
  headerActions,
  headerMenuItems,
  className,
  contentClassName,
  fullHeight = true,
}: MobileLayoutProps) {
  const isMobile = useIsMobile();

  // Desktop: render children directly without mobile wrapper
  if (!isMobile) {
    return <>{children}</>;
  }

  return (
    <div
      className={cn(
        "flex flex-col bg-background",
        fullHeight && "min-h-screen",
        className
      )}
    >
      {showHeader && title && (
        <MobileHeader
          title={title}
          subtitle={subtitle}
          showBack={showBack}
          onBack={onBack}
          backTo={backTo}
          actions={headerActions}
          menuItems={headerMenuItems}
        />
      )}

      <main
        className={cn(
          "flex-1 overflow-auto",
          showBottomNav && "pb-bottom-nav",
          contentClassName
        )}
      >
        {children}
      </main>

      {showBottomNav && <BottomNavigation />}
    </div>
  );
}

interface MobileOnlyProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export function MobileOnly({ children, fallback = null }: MobileOnlyProps) {
  const isMobile = useIsMobile();
  return isMobile ? <>{children}</> : <>{fallback}</>;
}

export function DesktopOnly({ children, fallback = null }: MobileOnlyProps) {
  const isMobile = useIsMobile();
  return !isMobile ? <>{children}</> : <>{fallback}</>;
}
