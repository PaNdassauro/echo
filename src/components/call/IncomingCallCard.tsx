import { Phone, X } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatParticipantPhone } from "@/lib/phone";
import { useVoiceCalls, type IncomingRing } from "@/contexts/VoiceCallContext";

/**
 * Aviso de ligação recebida — um card, não um diálogo.
 *
 * O modal anterior tomava a tela inteira com overlay opaco, prendia o foco e
 * tratava fechar (ou Esc) como RECUSAR. Aqui o Echo continua utilizável.
 *
 * E não existe recusar: a ligação é da LINHA, não de uma pessoa. Recusar
 * encerrava a ligação no WhatsApp, tirando-a dos outros atendentes e do celular
 * de quem ligou. Sobram as duas coisas que um atendente pode legitimamente fazer
 * sozinho — atender ou deixar tocar. "Ignorar" só tira o aviso desta tela.
 */
export default function IncomingCallCard({ ringing, pendingCount }: { ringing: IncomingRing; pendingCount: number }) {
    // Os dados vêm por prop porque o card continua na tela durante a animação de
    // saída, quando a ligação já não existe mais no contexto. As ações seguem
    // vindo do contexto: depois que ela some, são no-ops — que é o correto.
    const { answerCall, ignoreCall } = useVoiceCalls();

    const phone = formatParticipantPhone(ringing.digits);
    const label = ringing.name ?? phone;
    const initial = label.trim().charAt(0).toUpperCase() || "?";

    return (
        <Card className="shadow-lg" role="alert" aria-live="polite">
            <div className="flex items-center gap-3 px-4 pb-3 pt-4">
                <Avatar className="h-11 w-11 shrink-0 ring-2 ring-emerald-500/40">
                    <AvatarFallback>{initial}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                    <p className="truncate font-medium leading-tight">{label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                        Ligação recebida no WhatsApp
                        {pendingCount > 0 ? ` · mais ${pendingCount} na espera` : ""}
                    </p>
                    {ringing.name && <p className="truncate text-xs text-muted-foreground tabular-nums">{phone}</p>}
                </div>
            </div>

            <div className="flex items-center gap-2 border-t bg-muted/40 px-4 py-3">
                <Button className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700" onClick={answerCall}>
                    <Phone className="mr-2 h-4 w-4" />
                    Atender
                </Button>
                <Button
                    variant="outline"
                    onClick={ignoreCall}
                    aria-label="Ignorar"
                    title="Tira o aviso daqui. A ligação continua tocando, e outro atendente ainda pode atender."
                >
                    <X className="mr-2 h-4 w-4" />
                    Ignorar
                </Button>
            </div>
        </Card>
    );
}
