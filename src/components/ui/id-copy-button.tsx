
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";
import { IconSwap } from "@/components/ui/icon-swap";
import { useToast } from "@/hooks/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface IdCopyButtonProps {
  id: string;
  label?: string;
  className?: string;
  variant?: "default" | "outline" | "ghost" | "secondary" | "link";
  size?: "default" | "sm" | "lg" | "icon";
}

export const IdCopyButton = ({ 
  id, 
  label = "ID", 
  className,
  variant = "ghost",
  size = "icon" 
}: IdCopyButtonProps) => {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    setCopied(true);
    
    toast({
      title: "Copiado!",
      description: `${label} copiado para a área de transferência.`,
      duration: 2000,
    });

    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={variant}
            size={size}
            className={`h-6 w-6 text-muted-foreground hover:text-primary ${className}`}
            onClick={handleCopy}
            title={`Copiar ${label}`}
          >
            <IconSwap
              active={copied ? "check" : "copy"}
              durationMs={150}
              icons={{
                copy: <Copy className="h-3 w-3" />,
                check: <Check className="h-3 w-3 text-success" />,
              }}
            />
            <span className="sr-only">Copiar {label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">Copiar {label}: {id}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
