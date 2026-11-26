import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, LogOut } from "lucide-react";
import { useOrganization } from "@/contexts/OrganizationContext";
import { toUserMessage } from "@/lib/userFacingError";
import { CopilotoPreferencia } from "./CopilotoPreferencia";
import { ChangePasswordCard } from "./ChangePasswordCard";

interface ProfileSettingsProps {
    user: User;
}

const ProfileSettings = ({ user }: ProfileSettingsProps) => {
    const navigate = useNavigate();
    const { toast } = useToast();
    const { currentOrganization } = useOrganization();
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [profile, setProfile] = useState<any>(null);

    // Form states
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [phone, setPhone] = useState("");
    const [sectorName, setSectorName] = useState("");

    const queryClient = useQueryClient();

    const handleLogout = async () => {
        try {
            await supabase.auth.signOut();
            queryClient.clear();
            navigate("/auth");
        } catch (error) {
            console.error("Error signing out:", error);
            navigate("/auth");
        }
    };

    useEffect(() => {
        fetchProfile();
        fetchSector();
    }, [user.id, currentOrganization?.id]);

    const fetchSector = async () => {
        if (!currentOrganization) return;

        const { data } = await supabase
            .from("organization_members")
            .select(`
                sector_id,
                sectors (
                    name
                )
            `)
            .eq("user_id", user.id)
            .eq("organization_id", currentOrganization.id)
            .single();

        if (data?.sectors) {
            // @ts-ignore
            setSectorName(data.sectors.name);
        } else {
            setSectorName("");
        }
    };

    const fetchProfile = async () => {
        setLoading(true);
        const { data, error } = await supabase
            .from("profiles")
            .select("*")
            .eq("id", user.id)
            .single();

        if (error) {
            console.error("Error fetching profile:", error);
        } else if (data) {
            const profileData = data as any;
            setProfile(profileData);
            setFirstName(profileData.first_name || "");
            setLastName(profileData.last_name || "");
            setPhone(profileData.phone || "");
        }
        setLoading(false);
    };

    const handleSave = async () => {
        setSaving(true);
        const updates: any = {
            first_name: firstName,
            last_name: lastName,
            phone: phone,
        };

        const { error } = await supabase
            .from("profiles")
            .update(updates)
            .eq("id", user.id);

        if (error) {
            toast({
                title: "Não foi possível salvar perfil",
                description: toUserMessage(error),
                variant: "destructive",
            });
        } else {
            toast({
                title: "Perfil atualizado",
                description: "Suas informações foram salvas.",
            });
            fetchProfile();
        }
        setSaving(false);
    };

    if (loading) {
        return <div className="flex justify-center p-8"><Loader2 className="animate-spin" /></div>;
    }

    return (
        <div className="max-w-3xl space-y-8">
            <div>
                <h2 className="text-2xl font-semibold tracking-tight">Perfil</h2>
                <p className="text-sm text-muted-foreground">
                    Informações pessoais
                </p>
            </div>

            <div className="bg-card border rounded-xl p-6 space-y-8">
                {/* Form Fields */}
                <div className="grid gap-6">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="firstName">Nome</Label>
                            <Input
                                id="firstName"
                                placeholder="Ex: Ana"
                                value={firstName}
                                onChange={(e) => setFirstName(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="lastName">Sobrenome</Label>
                            <Input
                                id="lastName"
                                placeholder="Ex: Souza"
                                value={lastName}
                                onChange={(e) => setLastName(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="email">Email</Label>
                            <Input
                                id="email"
                                value={user.email || ""}
                                disabled
                                className="bg-muted"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="sector">Setor</Label>
                            <Input
                                id="sector"
                                value={sectorName || "Sem setor definido"}
                                disabled
                                className="bg-muted"
                            />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="phone">Telefone</Label>
                        <Input
                            id="phone"
                            placeholder="+55 85 99999-9999"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="role">Cargo</Label>
                        <Input
                            id="role"
                            value={profile?.role === 'admin' ? 'Administrador' : 'Atendente'}
                            disabled
                            className="bg-muted"
                        />
                    </div>
                </div>

                <div className="flex justify-end">
                    <Button
                        className="bg-primary hover:bg-primary/90 text-primary-foreground"
                        onClick={handleSave}
                        disabled={saving}
                    >
                        {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                        Salvar alterações
                    </Button>
                </div>
            </div>

            <ChangePasswordCard />

            <CopilotoPreferencia userId={user.id} />

            {/* Logout Section */}
            <div className="bg-card border rounded-xl p-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="font-medium">Sair da conta</h3>
                        <p className="text-sm text-muted-foreground">
                            Encerrar sua sessão neste dispositivo
                        </p>
                    </div>
                    <Button
                        variant="destructive"
                        onClick={handleLogout}
                        className="gap-2"
                    >
                        <LogOut className="w-4 h-4" />
                        Sair
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default ProfileSettings;
