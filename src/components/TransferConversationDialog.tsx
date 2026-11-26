import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Search, UserMinus } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface Profile {
    id: string;
    first_name: string | null;
    last_name: string | null;
    full_name?: string | null;
}

interface TransferConversationDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onTransfer: (userId: string, userName: string, keepAsCoOwner: boolean) => Promise<void>;
    /** Release the conversation back to the queue (assigned_to=null, status=waiting). */
    onRelease: () => Promise<boolean>;
    currentUserId: string;
    conversationPhoneNumberId?: string | null;
}

export const TransferConversationDialog = ({
    open,
    onOpenChange,
    onTransfer,
    onRelease,
    currentUserId,
    conversationPhoneNumberId,
}: TransferConversationDialogProps) => {
    const { currentOrganization } = useOrganization();
    const [loading, setLoading] = useState(true);
    const [agents, setAgents] = useState<Profile[]>([]);
    const [search, setSearch] = useState("");
    const [transferring, setTransferring] = useState<string | null>(null);
    const [releasing, setReleasing] = useState(false);
    const [keepAsCoOwner, setKeepAsCoOwner] = useState(false);

    useEffect(() => {
        if (open && currentOrganization) {
            fetchAgents();
        }
    }, [open, currentOrganization, conversationPhoneNumberId]);

    const fetchAgents = async () => {
        if (!currentOrganization) return;
        setLoading(true);
        try {
            // Fetch members of the current organization with their roles
            const { data: members, error: membersError } = await supabase
                .from("organization_members")
                .select(`
                    user_id,
                    role,
                    profiles:user_id (id, first_name, last_name, full_name)
                `)
                .eq("organization_id", currentOrganization.id);

            if (membersError) throw membersError;

            let eligibleAgents = (members as any[])
                .map((item) => ({ ...item.profiles, role: item.role }))
                .filter((profile) => profile && profile.id !== currentUserId);

            // If we have a phone number, filter to users with access to it
            if (conversationPhoneNumberId) {
                const { data: phoneAccess } = await supabase
                    .from("user_phone_numbers")
                    .select("user_id")
                    .eq("phone_number_id", conversationPhoneNumberId);

                const usersWithAccess = new Set(
                    (phoneAccess || []).map(pa => pa.user_id)
                );

                // Admins always have access, agents need explicit assignment
                eligibleAgents = eligibleAgents.filter(
                    agent => agent.role === 'admin' || usersWithAccess.has(agent.id)
                );
            }

            setAgents(eligibleAgents);
        } catch (error) {
            console.error("Error fetching agents:", error);
        } finally {
            setLoading(false);
        }
    };

    const filteredAgents = agents.filter((agent) => {
        const fullName = `${agent.first_name || ""} ${agent.last_name || ""} ${agent.full_name || ""}`.toLowerCase();
        return fullName.includes(search.toLowerCase());
    });

    const getInitials = (agent: Profile) => {
        if (agent.full_name) {
            return agent.full_name.split(" ").map(n => n[0]).join("").toUpperCase().substring(0, 2);
        }
        const first = agent.first_name?.[0] || "";
        const last = agent.last_name?.[0] || "";
        return (first + last).toUpperCase() || "U";
    };

    const handleTransfer = async (agent: Profile) => {
        setTransferring(agent.id);
        const userName = agent.full_name || `${agent.first_name || ""} ${agent.last_name || ""}`.trim() || "Atendente";
        try {
            await onTransfer(agent.id, userName, keepAsCoOwner);
            onOpenChange(false);
            setKeepAsCoOwner(false);
        } finally {
            setTransferring(null);
        }
    };

    const handleRelease = async () => {
        setReleasing(true);
        try {
            const success = await onRelease();
            if (success) {
                onOpenChange(false);
                setKeepAsCoOwner(false);
            }
        } finally {
            setReleasing(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Transferir conversa</DialogTitle>
                    <DialogDescription>
                        Selecione o atendente que vai assumir este atendimento.
                    </DialogDescription>
                </DialogHeader>

                {/* Release action — no transfer target, just unassign back to queue */}
                <Button
                    variant="outline"
                    onClick={handleRelease}
                    disabled={releasing || transferring !== null}
                    className="w-full justify-start gap-2 mb-3"
                >
                    {releasing ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <UserMinus className="w-4 h-4" />
                    )}
                    Liberar conversa (devolver para a fila)
                </Button>

                <div className="relative mb-2 flex items-center gap-2">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">ou transferir para</span>
                    <div className="h-px flex-1 bg-border" />
                </div>

                <div className="relative mb-4">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Buscar atendente…"
                        aria-label="Buscar atendente"
                        className="pl-9"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>

                <div className="flex items-center gap-2 mb-3 px-1">
                    <Checkbox
                        id="keep-as-co-owner"
                        checked={keepAsCoOwner}
                        onCheckedChange={(checked) => setKeepAsCoOwner(checked === true)}
                    />
                    <Label
                        htmlFor="keep-as-co-owner"
                        className="text-sm font-normal cursor-pointer text-muted-foreground"
                    >
                        Continuar acompanhando a conversa após transferir
                    </Label>
                </div>

                <ScrollArea className="h-[300px] pr-4">
                    {loading ? (
                        <div className="flex items-center justify-center h-full py-8">
                            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : filteredAgents.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
                            <p className="text-sm">
                                {search ? `Nenhum atendente com “${search}”.` : "Nenhum outro atendente disponível neste número."}
                            </p>
                            {search && (
                                <Button variant="ghost" size="sm" onClick={() => setSearch("")}>
                                    Limpar busca
                                </Button>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {filteredAgents.map((agent) => (
                                <button
                                    key={agent.id}
                                    onClick={() => handleTransfer(agent)}
                                    disabled={!!transferring}
                                    className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-muted active:bg-muted text-left disabled:opacity-50 active:scale-[0.96] motion-reduce:active:scale-100 transition-[background-color,transform] duration-150 ease-out"
                                >
                                    <Avatar className="h-9 w-9">
                                        <AvatarFallback className="bg-primary/10 text-primary text-xs">
                                            {getInitials(agent)}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className="flex-1 overflow-hidden">
                                        <p
                                            className="text-sm font-medium leading-none truncate"
                                            title={agent.full_name || `${agent.first_name || ""} ${agent.last_name || ""}`.trim() || "Atendente"}
                                        >
                                            {agent.full_name || `${agent.first_name || ""} ${agent.last_name || ""}`.trim() || "Atendente"}
                                        </p>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            Atendente
                                        </p>
                                    </div>
                                    {transferring === agent.id && (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                </ScrollArea>
            </DialogContent>
        </Dialog>
    );
};
