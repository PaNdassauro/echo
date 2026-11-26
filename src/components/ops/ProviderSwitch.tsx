import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useSetLineProvider } from "@/hooks/useSetLineProvider";
import { providerChipTitle, providerLabel, providerOptions } from "@/lib/lineProvider";
import { toUserMessage } from "@/lib/userFacingError";
import { cn } from "@/lib/utils";
import { ProviderChip } from "./ProviderChip";

export interface ProviderSwitchProps {
    organizationId: string | undefined;
    phoneNumberId: string;
    lineName: string;
    /** phone_numbers.qr_provider */
    db: string;
    /** Provider da sessão viva; null = sem sessão; undefined = serviço não consultado. */
    live: string | null | undefined;
    libraryId: string | null | undefined;
    /** Status da sessão no serviço; a migração imediata só é oferecida com 'connected'. */
    serviceStatus: string | null | undefined;
    /** Lista do serviço; vazia = cai nos conhecidos. */
    registered: readonly string[];
}

/**
 * Chip clicável com menu de providers. Escolher um abre a confirmação com
 * duas ações: "Só gravar" (vale na próxima conexão, sem tráfego) e, se a
 * sessão está viva, "Gravar e migrar agora" (reconecta a linha na hora).
 *
 * Vive dentro de uma <tr> clicável: todo clique aqui para a propagação para
 * não alternar o filtro da tabela.
 */
export function ProviderSwitch({ organizationId, phoneNumberId, lineName, db, live, libraryId, serviceStatus, registered }: ProviderSwitchProps) {
    const { toast } = useToast();
    const { save, migrate } = useSetLineProvider(organizationId);
    const [target, setTarget] = useState<string | null>(null);

    const options = providerOptions(registered);
    const canMigrateNow = serviceStatus === "connected";
    const busy = save.isPending || migrate.isPending;
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();

    const close = () => {
        if (!busy) setTarget(null);
    };

    const onSave = async () => {
        if (!target) return;
        try {
            await save.mutateAsync({ phoneNumberId, to: target });
            toast({
                title: "Lib gravada",
                description: `${lineName} passa a usar ${providerLabel(target)} na próxima conexão.${canMigrateNow ? " A sessão atual continua na lib antiga até cair ou reconectar." : ""}`,
            });
            setTarget(null);
        } catch (error) {
            toast({ variant: "destructive", title: "Não foi possível gravar a lib", description: toUserMessage(error) });
        }
    };

    const onMigrate = async () => {
        if (!target) return;
        try {
            const result = await migrate.mutateAsync({ phoneNumberId, to: target });
            const losses = result.losses.length > 0 ? ` Perdas na importação: ${result.losses.join(", ")}.` : "";
            toast({
                title: result.status === "already_on_provider" ? "Linha já estava nessa lib" : "Linha migrada",
                description:
                    result.status === "already_on_provider"
                        ? `${lineName} já roda em ${providerLabel(result.to)}.`
                        : `${lineName}: ${providerLabel(result.from)} → ${providerLabel(result.to)}. Sessão: ${result.status}.${losses}`,
            });
            setTarget(null);
        } catch (error) {
            toast({ variant: "destructive", title: "Migração falhou", description: toUserMessage(error) });
        }
    };

    return (
        <div onClick={stop} onKeyDown={stop}>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={`Lib da linha ${lineName}: ${providerLabel(db)}. Trocar`}
                        title={providerChipTitle(db, live, libraryId)}
                        className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={busy}
                    >
                        <ProviderChip db={db} live={live} libraryId={libraryId} interactive />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[200px]">
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Lib do qr-service</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {options.map((opt) => {
                        const current = opt.name === db;
                        return (
                            <DropdownMenuItem
                                key={opt.name}
                                disabled={current || !opt.registered}
                                onSelect={() => setTarget(opt.name)}
                                className="flex items-center justify-between gap-3"
                                title={!opt.registered ? "Não registrado no serviço: ele cairia no baileys." : undefined}
                            >
                                <span className={cn(!opt.registered && "line-through")}>{providerLabel(opt.name)}</span>
                                {current ? <Check className="h-3.5 w-3.5" aria-hidden /> : !opt.registered ? <span className="text-[11px] text-muted-foreground">não registrado</span> : null}
                            </DropdownMenuItem>
                        );
                    })}
                </DropdownMenuContent>
            </DropdownMenu>

            <AlertDialog open={target !== null} onOpenChange={(open) => { if (!open) close(); }}>
                <AlertDialogContent onClick={stop} onKeyDown={stop}>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Trocar {lineName} de {providerLabel(db)} para {target ? providerLabel(target) : ""}?
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="space-y-2 text-sm text-muted-foreground">
                                <p>
                                    <strong className="font-medium text-foreground">Só gravar</strong> muda a coluna no banco. Vale na próxima vez que a
                                    linha conectar; a sessão atual segue como está. Não gera tráfego no WhatsApp.
                                </p>
                                {canMigrateNow ? (
                                    <p>
                                        <strong className="font-medium text-foreground">Gravar e migrar agora</strong> fecha a sessão sem sair da conta,
                                        leva as credenciais para a lib nova e reconecta na hora, sem QR novo. Fica um backup no serviço para voltar.
                                        Reconectar pesa no risco da linha: evite com disparo em curso.
                                    </p>
                                ) : (
                                    <p>A sessão não está conectada no serviço, então a migração imediata não é oferecida: a troca acontece sozinha na próxima conexão.</p>
                                )}
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
                        <Button variant="outline" onClick={close} disabled={busy}>Cancelar</Button>
                        <Button variant={canMigrateNow ? "secondary" : "default"} onClick={() => void onSave()} disabled={busy}>
                            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                            Só gravar
                        </Button>
                        {canMigrateNow && (
                            <Button onClick={() => void onMigrate()} disabled={busy}>
                                {migrate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                                Gravar e migrar agora
                            </Button>
                        )}
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
