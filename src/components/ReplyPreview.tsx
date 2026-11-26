import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ReplyPreviewMessage {
    id: string;
    content: string;
    direction: "inbound" | "outbound";
}

interface ReplyPreviewProps {
    message: ReplyPreviewMessage;
    onCancel: () => void;
}

const ReplyPreview = ({ message, onCancel }: ReplyPreviewProps) => {
    // Truncate long content for preview
    const truncatedContent = message.content.length > 120
        ? message.content.slice(0, 120) + '…'
        : message.content;

    // Remove button markers from preview
    const cleanContent = truncatedContent.split('\n\n---BUTTONS---')[0];

    return (
        // Tokens do design system (bg-slate-* hardcoded ficava ilegível nos
        // presets escuros — faixa clara com texto muted claro por cima).
        <div className="flex items-center gap-3 px-4 py-2 bg-muted border-l-4 border-primary animate-in fade-in-0 duration-100 ease-out">
            <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-primary">
                    {message.direction === 'inbound' ? 'Respondendo ao contato' : 'Respondendo a você'}
                </p>
                <p className="text-sm text-foreground/70 truncate">
                    {cleanContent}
                </p>
            </div>
            <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-8 w-8 hover:bg-muted-foreground/10"
                onClick={onCancel}
                aria-label="Cancelar resposta"
            >
                <X className="w-4 h-4" />
            </Button>
        </div>
    );
};

export default ReplyPreview;
