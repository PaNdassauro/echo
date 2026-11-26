
import { useState } from "react";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Building2, Plus, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useIsMobile } from "@/hooks/use-mobile";
import { BottomNavigation } from "@/components/layout/BottomNavigation";
import { toUserMessage } from "@/lib/userFacingError";

const SuperAdminDashboard = () => {
    const isMobile = useIsMobile();
    const { organizations, isSuperAdmin, refreshOrganizations, setCurrentOrganization } = useOrganization();
    const [newOrgName, setNewOrgName] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const navigate = useNavigate();

    if (!isSuperAdmin) {
        return (
            <div className="container mx-auto p-10 text-center">
                <h1 className="text-2xl font-bold text-destructive">Acesso negado</h1>
                <p>Esta página é exclusiva de Super Admins.</p>
                <Button onClick={() => navigate("/dashboard")} className="mt-4">Ir para as conversas</Button>
            </div>
        );
    }

    const handleCreateOrg = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newOrgName.trim()) return;

        setIsCreating(true);
        try {
            // A RPC gera o slug único e já cadastra quem criou como admin da
            // organização (sem isso, as policies de Storage por org não liberam upload).
            const { error } = await supabase.rpc('create_onboarding_organization', {
                p_name: newOrgName.trim(),
            });

            if (error) throw error;

            toast.success(`Organização “${newOrgName}” criada`);
            setNewOrgName("");
            await refreshOrganizations();
        } catch (error: any) {
            console.error('Error creating org:', error);
            toast.error(toUserMessage(error, "Não foi possível criar a organização. Tente novamente."));
        } finally {
            setIsCreating(false);
        }
    };

    const handleSwitchToOrg = (org: any) => {
        setCurrentOrganization(org);
        toast.info(`Agora operando em ${org.name}`);
        navigate("/dashboard");
    };

    return (
        // pt/pb separados: sm:py-10 vencia o pb-bottom-nav na cascata (640-767px)
        // e a BottomNavigation cobria o conteúdo. A nav vai no FIM do container
        // para não virar "primeiro filho" do space-y-8 (empurrava o header 32px).
        <div className={`container mx-auto px-4 pt-6 sm:pt-10 space-y-8 ${isMobile ? "pb-bottom-nav" : "pb-6 sm:pb-10"}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Painel Super Admin</h1>
                    <p className="text-muted-foreground">Gerencie organizações e configurações do sistema.</p>
                </div>
                <Button variant="outline" onClick={() => navigate("/dashboard")}>
                    Voltar ao app
                </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <Card>
                    <CardHeader>
                        <CardTitle>Criar organização</CardTitle>
                        <CardDescription>Adicione uma nova organização cliente.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleCreateOrg} className="space-y-4">
                            <div className="space-y-2">
                                <Input
                                    placeholder="Nome da organização"
                                    value={newOrgName}
                                    onChange={(e) => setNewOrgName(e.target.value)}
                                    disabled={isCreating}
                                />
                            </div>
                            <Button type="submit" className="w-full" disabled={isCreating || !newOrgName}>
                                {isCreating ? "Criando…" : (
                                    <>
                                        <Plus className="mr-2 h-4 w-4" /> Criar organização
                                    </>
                                )}
                            </Button>
                        </form>
                    </CardContent>
                </Card>

                <Card className="md:col-span-2 lg:col-span-2">
                    <CardHeader>
                        <CardTitle>Organizações ({organizations.length})</CardTitle>
                        <CardDescription>Todas as organizações cliente que você pode gerenciar.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-2 max-h-[400px] overflow-y-auto">
                            {organizations.map((org) => (
                                <div key={org.id} className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors">
                                    <div className="flex items-center gap-3">
                                        <div className="bg-primary/10 p-2 rounded-full">
                                            <Building2 className="h-4 w-4 text-primary" />
                                        </div>
                                        <div>
                                            <p className="font-medium">{org.name}</p>
                                            <p className="text-xs text-muted-foreground">{org.slug}</p>
                                        </div>
                                    </div>
                                    <Button variant="ghost" size="sm" onClick={() => handleSwitchToOrg(org)}>
                                        Gerenciar <ArrowRight className="ml-2 h-4 w-4" />
                                    </Button>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            </div>
            {isMobile && <BottomNavigation />}
        </div>
    );
};

export default SuperAdminDashboard;
