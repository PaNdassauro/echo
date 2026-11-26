import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BUSINESS_HOURS } from "@/lib/attendanceReport";

interface AttendanceMethodologyProps {
    idleHours: number;
    unansweredHours: number;
}

/**
 * As regras da medição em linguagem de gestão. Espelha o comentário de `get_attendance_report`
 * (supabase/migrations/*_baseline.sql) — mudou lá, muda aqui.
 */
export function AttendanceMethodology({ idleHours, unansweredHours }: AttendanceMethodologyProps) {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                    <Info className="h-4 w-4" />
                    <span className="hidden sm:inline">Como medimos</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(92vw,420px)] text-sm space-y-3">
                <h3 className="font-semibold">Como medimos</h3>
                <dl className="space-y-2.5 text-muted-foreground [&_dt]:font-medium [&_dt]:text-foreground">
                    <div>
                        <dt>Atendimento</dt>
                        <dd>
                            Começa quando o cliente (ou a equipe) escreve numa conversa parada. Termina depois de{" "}
                            {idleHours}h sem mensagens após a resposta da equipe, ou quando a conversa é encerrada no Echo.
                            Uma mesma conversa pode ter vários atendimentos ao longo do tempo.
                        </dd>
                    </div>
                    <div>
                        <dt>Mesmo dia × outro dia</dt>
                        <dd>Compara a data da primeira e da última mensagem do atendimento (horário de Brasília).</dd>
                    </div>
                    <div>
                        <dt>Em aberto e sem resposta</dt>
                        <dd>
                            Em aberto: ainda dentro das {idleHours}h, esperando o cliente ou a atendente. Sem resposta: o
                            cliente escreveu e ninguém respondeu em {unansweredHours}h.
                        </dd>
                    </div>
                    <div>
                        <dt>Fora do horário</dt>
                        <dd>Atendimento que começou fora de {BUSINESS_HOURS.label} (feriados não são descontados).</dd>
                    </div>
                    <div>
                        <dt>Atendente</dt>
                        <dd>
                            Quem mais respondeu pelo Echo naquele atendimento. Resposta dada direto pelo celular chega sem
                            autor; nesse caso vale a responsável pela conversa. Sem nenhum dos dois, fica como “Não
                            identificado”.
                        </dd>
                    </div>
                    <div>
                        <dt>1ª resposta</dt>
                        <dd>
                            Do primeiro contato do cliente até a primeira resposta da equipe, só para atendimentos que
                            começaram no horário comercial. A mensagem automática de ausência não conta como resposta.
                        </dd>
                    </div>
                    <div>
                        <dt>Tempo ativo (estimado)</dt>
                        <dd>
                            Soma dos intervalos de até 10 min entre mensagens enviadas pela atendente (mais 1 min por
                            mensagem isolada). Mede o tempo em conversa no WhatsApp, não ligações nem outros sistemas.
                        </dd>
                    </div>
                </dl>
            </PopoverContent>
        </Popover>
    );
}
