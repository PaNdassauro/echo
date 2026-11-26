import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { parseCoordinateInput } from "@/lib/locationMessage";
import { Loader2, MapPin, LocateFixed, ExternalLink } from "lucide-react";
import { toUserMessage } from "@/lib/userFacingError";

interface LocationPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phoneNumberId: string;
  targetPhone: string;
  conversationId: string;
  quotedMessageId?: string | null;
  onSent?: () => void;
}

/**
 * Envio de localização (paridade WhatsApp, adaptado a desktop): cola-se um
 * link do Google Maps ou "lat, lng", ou usa a localização atual do navegador.
 */
export function LocationPickerDialog({
  open,
  onOpenChange,
  phoneNumberId,
  targetPhone,
  conversationId,
  quotedMessageId,
  onSent,
}: LocationPickerDialogProps) {
  const [coordInput, setCoordInput] = useState("");
  const [name, setName] = useState("");
  const [isLocating, setIsLocating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const { toast } = useToast();

  const parsed = parseCoordinateInput(coordInput);

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      toast({ title: "Geolocalização indisponível neste navegador", variant: "destructive" });
      return;
    }
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoordInput(`${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`);
        setIsLocating(false);
      },
      (err) => {
        setIsLocating(false);
        toast({
          title: "Não foi possível obter sua localização",
          description: toUserMessage(err),
          variant: "destructive",
        });
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleSend = async () => {
    if (!parsed) return;
    setIsSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-send-location", {
        body: {
          to: targetPhone,
          conversationId,
          phoneNumberId,
          latitude: parsed.lat,
          longitude: parsed.lng,
          name: name.trim() || null,
          quotedMessageId: quotedMessageId ?? null,
        },
      });

      if (error || !data?.success) {
        // invoke() não devolve o corpo no erro — a mensagem real vem em error.context
        let message = data?.error || error?.message || "Falha ao enviar localização";
        const ctx = (error as { context?: Response } | null)?.context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const body = await ctx.json();
            if (body?.error) message = body.error;
          } catch { /* corpo não-JSON */ }
        }
        throw new Error(message);
      }

      toast({ title: "Localização enviada" });
      setCoordInput("");
      setName("");
      onOpenChange(false);
      onSent?.();
    } catch (error: unknown) {
      toast({
        title: "Não foi possível enviar localização",
        description: toUserMessage(error),
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !isSending && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="w-5 h-5" />
            Enviar localização
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Coordenadas ou link do Maps</Label>
            <Input
              value={coordInput}
              onChange={(e) => setCoordInput(e.target.value)}
              placeholder="-23.5505, -46.6333 ou link do Google Maps"
              autoComplete="off"
            />
            {coordInput.trim() && !parsed && (
              <p role="alert" className="text-xs text-destructive">
                Coordenadas não reconhecidas. Cole um link do Maps ou “lat, lng”.
              </p>
            )}
            {parsed && (
              <a
                href={`https://maps.google.com/?q=${parsed.lat},${parsed.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground inline-flex items-center gap-1 underline underline-offset-2"
              >
                <ExternalLink className="w-3 h-3" />
                Conferir no Maps: {parsed.lat.toFixed(5)}, {parsed.lng.toFixed(5)}
              </a>
            )}
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={useCurrentLocation}
            disabled={isLocating || isSending}
          >
            {isLocating ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <LocateFixed className="w-4 h-4 mr-2" />
            )}
            Usar minha localização atual
          </Button>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Nome do lugar (opcional)</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Escritório, Praça da Sé…"
              maxLength={512}
            />
          </div>

          <Button className="w-full" onClick={handleSend} disabled={!parsed || isSending}>
            {isSending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Enviando…
              </>
            ) : (
              "Enviar localização"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
