import { MapPin, ExternalLink, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import { locationMapsUrl, type ParsedLocation } from "@/lib/locationMessage";

interface LocationBubbleProps {
  location: ParsedLocation;
  isOutbound: boolean;
}

/**
 * Card de localização (paridade WhatsApp). Sem tile de mapa externo por
 * decisão de privacidade — um <img> de tile seria uma request de terceiro por
 * mensagem; o CTA abre o Google Maps.
 */
export function LocationBubble({ location, isOutbound }: LocationBubbleProps) {
  const coords = `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
  return (
    <a
      href={locationMapsUrl(location)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-start gap-3 rounded-lg px-3 py-2.5 -mx-1 my-0.5 min-w-[200px]",
        "transition-colors",
        isOutbound
          ? "bg-chat-bubble-user-foreground/10 hover:bg-chat-bubble-user-foreground/15"
          : "bg-chat-bubble-contact-foreground/10 hover:bg-chat-bubble-contact-foreground/15"
      )}
    >
      <div
        className={cn(
          "w-10 h-10 rounded-full shrink-0 flex items-center justify-center",
          isOutbound
            ? "bg-chat-bubble-user-foreground/15"
            : "bg-chat-bubble-contact-foreground/15"
        )}
      >
        <MapPin className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-message font-medium flex items-center gap-1.5">
          {location.live && <Radio className="w-3.5 h-3.5 shrink-0 animate-pulse" />}
          {location.name || (location.live ? "Localização em tempo real" : "Localização")}
        </p>
        {location.address && (
          <p className="text-message-xs opacity-80 line-clamp-2 break-words">{location.address}</p>
        )}
        <p className="text-xs opacity-60 mt-0.5 tabular-nums">{coords}</p>
        <p className="text-xs mt-1 flex items-center gap-1 underline underline-offset-2 opacity-90">
          <ExternalLink className="w-3 h-3 shrink-0" />
          Abrir no Maps
        </p>
      </div>
    </a>
  );
}
