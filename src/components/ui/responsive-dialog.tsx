import * as React from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

/**
 * Dialog no desktop, bottom sheet (vaul) no mobile — com swipe-to-dismiss.
 * Fluxos longos em celular pedem sheet, não um modal centralizado espremido.
 * API espelha os subcomponentes do Dialog para a troca ser 1:1 no call site.
 */

interface ResponsiveDialogProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const ResponsiveDialog = ({ children, ...props }: ResponsiveDialogProps) => {
  const isMobile = useIsMobile();
  const Root = isMobile ? Drawer : Dialog;
  return <Root {...props}>{children}</Root>;
};

const ResponsiveDialogContent = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <DrawerContent className="max-h-[92dvh]">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </DrawerContent>
    );
  }
  return <DialogContent className={className}>{children}</DialogContent>;
};

const ResponsiveDialogHeader = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  const isMobile = useIsMobile();
  const Header = isMobile ? DrawerHeader : DialogHeader;
  return <Header className={cn(isMobile && "px-0", className)}>{children}</Header>;
};

const ResponsiveDialogFooter = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  const isMobile = useIsMobile();
  const Footer = isMobile ? DrawerFooter : DialogFooter;
  return <Footer className={cn(isMobile && "px-0", className)}>{children}</Footer>;
};

const ResponsiveDialogTitle = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  const isMobile = useIsMobile();
  const Title = isMobile ? DrawerTitle : DialogTitle;
  return <Title className={className}>{children}</Title>;
};

const ResponsiveDialogDescription = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => {
  const isMobile = useIsMobile();
  const Description = isMobile ? DrawerDescription : DialogDescription;
  return <Description className={className}>{children}</Description>;
};

export {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogFooter,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
};
