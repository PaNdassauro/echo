import { useState, useEffect, useMemo } from "react";
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
import { Loader2, Search, UserPlus, X, Crown } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface Profile {
    id: string;
    first_name: string | null;
    last_name: string | null;
    full_name?: string | null;
}

interface ShareConversationDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    currentUserId: string;
    conversationPhoneNumberId?: string | null;
    /** UUID of the current primary assignee (conversations.assigned_to). */
    primaryAssigneeId: string | null;
    /** UUIDs of users that are already co-owners. */
    coOwnerIds: string[];
    /** Called when the user picks someone to add. */
    onAddCoOwner: (userId: string, userName: string) => Promise<boolean>;
    /** Called when the user removes a co-owner. */
    onRemoveCoOwner: (userId: string, userName: string) => Promise<boolean>;
}

const getInitials = (agent: Profile): string => {
    if (agent.full_name) {
        return agent.full_name.split(" ").map((n) => n[0]).join("").toUpperCase().substring(0, 2);
    }
    const first = agent.first_name?.[0] || "";
    const last = agent.last_name?.[0] || "";
    return (first + last).toUpperCase() || "U";
};

const getDisplayName = (agent: Profile): string => {
    return (
        agent.full_name ||
        `${agent.first_name || ""} ${agent.last_name || ""}`.trim() ||
        "Atendente"
    );
};

export const ShareConversationDialog = ({
    open,
    onOpenChange,
    currentUserId,
    conversationPhoneNumberId,
    primaryAssigneeId,
    coOwnerIds,
    onAddCoOwner,
    onRemoveCoOwner,
}: ShareConversationDialogProps) => {
    const { currentOrganization } = useOrganization();
    const [loading, setLoading] = useState(true);
    const [allMembers, setAllMembers] = useState<Profile[]>([]);
    const [search, setSearch] = useState("");
    const [pendingUserId, setPendingUserId] = useState<string | null>(null);

    useEffect(() => {
        if (open && currentOrganization) {
            void fetchMembers();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, currentOrganization, conversationPhoneNumberId]);

    const fetchMembers = async () => {
        if (!currentOrganization) return;
        setLoading(true);
        try {
            const { data: members, error: membersError } = await supabase
                .from("organization_members")
                .select(`
                    user_id,
                    role,
                    profiles:user_id (id, first_name, last_name, full_name)
                `)
                .eq("organization_id", currentOrganization.id);

            if (membersError) throw membersError;

            let eligible = (members as unknown as Array<{ profiles: Profile | null; role: string }>)
                .map((item) => ({ ...(item.profiles as Profile), role: item.role }))
                .filter((profile): profile is Profile & { role: string } => profile !== null && profile.id !== undefined);

            // Same phone scoping logic as TransferConversationDialog
            if (conversationPhoneNumberId) {
                const { data: phoneAccess } = await supabase
                    .from("user_phone_numbers")
                    .select("user_id")
                    .eq("phone_number_id", conversationPhoneNumberId);

                const usersWithAccess = new Set((phoneAccess || []).map((pa) => pa.user_id));

                // A própria pessoa fica sempre: ela já enxerga a conversa, e é
                // o perfil dela que aparece como dona, co-dona ou no "Acompanhar".
                eligible = eligible.filter(
                    (agent) =>
                        agent.id === currentUserId ||
                        agent.role === "admin" ||
                        usersWithAccess.has(agent.id),
                );
            }

            setAllMembers(eligible);
        } catch (error) {
            console.error("Error fetching members for share dialog:", error);
        } finally {
            setLoading(false);
        }
    };

    // Partition: current co-owners, primary, available to add, and me
    const { primaryProfile, coOwnerProfiles, availableProfiles, meProfile } = useMemo(() => {
        const byId = new Map(allMembers.map((m) => [m.id, m]));
        const primary = primaryAssigneeId ? byId.get(primaryAssigneeId) ?? null : null;
        const me = byId.get(currentUserId) ?? null;
        const coOwners = coOwnerIds
            .map((id) => byId.get(id))
            .filter((p): p is Profile => !!p);
        const coOwnerSet = new Set(coOwnerIds);
        const available = allMembers.filter(
            (m) => m.id !== primaryAssigneeId && !coOwnerSet.has(m.id) && m.id !== currentUserId,
        );
        return { primaryProfile: primary, coOwnerProfiles: coOwners, availableProfiles: available, meProfile: me };
    }, [allMembers, coOwnerIds, primaryAssigneeId, currentUserId]);

    // Quem já é dona ou co-dona não se adiciona de novo.
    const jaAcompanho = currentUserId === primaryAssigneeId || coOwnerIds.includes(currentUserId);

    const filteredAvailable = availableProfiles.filter((agent) => {
        const q = search.toLowerCase();
        if (!q) return true;
        return getDisplayName(agent).toLowerCase().includes(q);
    });

    const handleAdd = async (agent: Profile) => {
        setPendingUserId(agent.id);
        const success = await onAddCoOwner(agent.id, getDisplayName(agent));
        setPendingUserId(null);
        if (success) {
            setSearch("");
        }
    };

    const handleAcompanhar = async () => {
        if (!meProfile) return;
        await handleAdd(meProfile);
    };

    const handleRemove = async (agent: Profile) => {
        setPendingUserId(agent.id);
        await onRemoveCoOwner(agent.id, getDisplayName(agent));
        setPendingUserId(null);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                    <DialogTitle>Compartilhar conversa</DialogTitle>
                    <DialogDescription>
                        Adicione atendentes que podem ver e responder esta conversa junto com o responsável principal.
                    </DialogDescription>
                </DialogHeader>

                {/* Primary owner (read-only) */}
                {primaryProfile && (
                    <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Dono principal
                        </p>
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/40">
                            <Avatar className="h-9 w-9">
                                <AvatarFallback className="bg-primary/10 text-primary text-xs">
                                    {getInitials(primaryProfile)}
                                </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 overflow-hidden">
                                <p className="text-sm font-medium leading-none truncate">
                                    {getDisplayName(primaryProfile)}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">Atendente principal</p>
                            </div>
                            <Crown className="w-4 h-4 text-amber-500" />
                        </div>
                    </div>
                )}

                {/* Current co-owners */}
                <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Co-proprietários ({coOwnerProfiles.length})
                    </p>
                    {coOwnerProfiles.length === 0 ? (
                        <p className="text-sm text-muted-foreground italic px-3 py-2">
                            Ninguém compartilha esta conversa ainda.
                        </p>
                    ) : (
                        <div className="space-y-1">
                            {coOwnerProfiles.map((agent) => (
                                <div
                                    key={agent.id}
                                    className="flex items-center gap-3 p-2 rounded-lg bg-blue-500/5 border border-blue-500/20"
                                >
                                    <Avatar className="h-8 w-8">
                                        <AvatarFallback className="bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs">
                                            {getInitials(agent)}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className="flex-1 overflow-hidden">
                                        <p className="text-sm font-medium leading-none truncate">
                                            {getDisplayName(agent)}
                                        </p>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                        onClick={() => handleRemove(agent)}
                                        disabled={pendingUserId !== null}
                                        title="Remover atendente"
                                    >
                                        {pendingUserId === agent.id ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                        ) : (
                                            <X className="w-4 h-4" />
                                        )}
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Eu mesma: entrar como co-dona (a lista "Adicionar" nunca oferece a própria pessoa) */}
                {!loading && !jaAcompanho && meProfile && (
                    <Button
                        variant="outline"
                        className="w-full justify-start gap-3"
                        onClick={handleAcompanhar}
                        disabled={pendingUserId !== null}
                    >
                        {pendingUserId === meProfile.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <UserPlus className="w-4 h-4" />
                        )}
                        Acompanhar esta conversa
                    </Button>
                )}

                {/* Add new */}
                <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Adicionar
                    </p>
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Buscar atendente…"
                            aria-label="Buscar atendente"
                            className="pl-9"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                    <ScrollArea className="h-[220px] pr-4">
                        {loading ? (
                            <div className="flex items-center justify-center h-full py-8">
                                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                            </div>
                        ) : filteredAvailable.length === 0 ? (
                            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                                <p>{search ? `Nenhum atendente com “${search}”.` : "Todos os atendentes elegíveis já estão nesta conversa."}</p>
                                {search && (
                                    <Button variant="ghost" size="sm" onClick={() => setSearch("")}>
                                        Limpar busca
                                    </Button>
                                )}
                            </div>
                        ) : (
                            <div className="space-y-1">
                                {filteredAvailable.map((agent) => (
                                    <button
                                        key={agent.id}
                                        onClick={() => handleAdd(agent)}
                                        disabled={pendingUserId !== null}
                                        className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-muted active:bg-muted text-left disabled:opacity-50 active:scale-[0.96] motion-reduce:active:scale-100 transition-[background-color,transform] duration-150 ease-out"
                                    >
                                        <Avatar className="h-8 w-8">
                                            <AvatarFallback className="bg-primary/10 text-primary text-xs">
                                                {getInitials(agent)}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div className="flex-1 overflow-hidden">
                                            <p className="text-sm font-medium leading-none truncate" title={getDisplayName(agent)}>
                                                {getDisplayName(agent)}
                                            </p>
                                        </div>
                                        {pendingUserId === agent.id ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                        ) : (
                                            <UserPlus className="w-4 h-4 text-muted-foreground" />
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}
                    </ScrollArea>
                </div>
            </DialogContent>
        </Dialog>
    );
};
