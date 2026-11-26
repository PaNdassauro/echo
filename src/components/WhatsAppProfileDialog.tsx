import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { qrFetch } from "@/lib/qrService";
import { Camera, Loader2, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";

interface WhatsAppProfile {
    name?: string;
    pictureUrl: string | null;
}

interface WhatsAppProfileDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    phoneNumberId: string;
    displayName: string;
}

// Edita o perfil do WhatsApp do número conectado via QR (foto + nome públicos)
const WhatsAppProfileDialog = ({
    open,
    onOpenChange,
    phoneNumberId,
    displayName,
}: WhatsAppProfileDialogProps) => {
    const { toast } = useToast();
    const [loading, setLoading] = useState(true);
    const [profile, setProfile] = useState<WhatsAppProfile | null>(null);
    const [name, setName] = useState("");
    const [savingName, setSavingName] = useState(false);
    const [uploadingPhoto, setUploadingPhoto] = useState(false);

    const fetchProfile = useCallback(async () => {
        if (!open || !phoneNumberId) return;

        setLoading(true);
        try {
            const response = await qrFetch(`/profile/${phoneNumberId}`);
            const data = await response.json();

            if (data.success && data.profile) {
                setProfile(data.profile);
                setName(data.profile.name ?? "");
            } else {
                toast({
                    title: "Não foi possível carregar perfil",
                    description: toUserMessage(data.error),
                    variant: "destructive",
                });
            }
        } catch (error) {
            console.error("Error fetching WhatsApp profile:", error);
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            setLoading(false);
        }
    }, [open, phoneNumberId, toast]);

    useEffect(() => {
        fetchProfile();
    }, [fetchProfile]);

    const handleUpdatePicture = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ""; // permite reselecionar o mesmo arquivo
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            toast({
                title: "Arquivo inválido",
                description: "Selecione uma imagem",
                variant: "destructive",
            });
            return;
        }

        setUploadingPhoto(true);
        try {
            const formData = new FormData();
            formData.append("file", file);

            const response = await qrFetch(`/profile/${phoneNumberId}/picture`, {
                method: "PUT",
                body: formData,
            });
            const data = await response.json();

            if (data.success) {
                toast({ title: "Foto do perfil atualizada" });
                fetchProfile();
            } else {
                toast({
                    title: "Não foi possível atualizar foto",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            setUploadingPhoto(false);
        }
    };

    const handleSaveName = async () => {
        const next = name.trim();
        if (!next || next === (profile?.name ?? "")) return;

        setSavingName(true);
        try {
            const response = await qrFetch(`/profile/${phoneNumberId}/name`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: next }),
            });
            const data = await response.json();

            if (data.success) {
                toast({ title: "Nome do perfil atualizado" });
                setProfile((prev) => (prev ? { ...prev, name: next } : prev));
            } else {
                toast({
                    title: "Não foi possível atualizar nome",
                    description: data.error,
                    variant: "destructive",
                });
            }
        } catch (error) {
            toast({
                title: "Sem resposta do serviço",
                description: "Verifique a conexão e tente novamente.",
                variant: "destructive",
            });
        } finally {
            setSavingName(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <User className="w-5 h-5" />
                        <span className="truncate">Perfil do WhatsApp — {displayName}</span>
                    </DialogTitle>
                </DialogHeader>

                {loading ? (
                    <div className="flex items-center justify-center py-10">
                        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                    </div>
                ) : profile ? (
                    <div className="space-y-6 py-2">
                        {/* Profile picture */}
                        <div className="flex justify-center">
                            <div className="relative">
                                <Avatar className="w-24 h-24">
                                    <AvatarImage src={profile.pictureUrl ?? undefined} alt="Foto do perfil" />
                                    <AvatarFallback>
                                        <User className="w-10 h-10 text-muted-foreground" />
                                    </AvatarFallback>
                                </Avatar>
                                <label
                                    className={`absolute bottom-0 right-0 rounded-full bg-primary text-primary-foreground p-2 shadow ${uploadingPhoto ? "opacity-70" : "cursor-pointer hover:opacity-90"}`}
                                    aria-label="Alterar foto do perfil"
                                >
                                    {uploadingPhoto ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <Camera className="w-4 h-4" />
                                    )}
                                    <input
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={handleUpdatePicture}
                                        disabled={uploadingPhoto}
                                    />
                                </label>
                            </div>
                        </div>

                        {/* Profile name */}
                        <div className="space-y-2">
                            <Label htmlFor="whatsapp-profile-name">Nome do perfil</Label>
                            <div className="flex gap-2">
                                <Input
                                    id="whatsapp-profile-name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="Nome exibido no WhatsApp"
                                />
                                <Button
                                    onClick={handleSaveName}
                                    disabled={
                                        savingName ||
                                        !name.trim() ||
                                        name.trim() === (profile.name ?? "")
                                    }
                                >
                                    {savingName ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        "Salvar"
                                    )}
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Nome e foto públicos, visíveis para seus contatos no WhatsApp.
                            </p>
                        </div>
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground py-6 text-center">
                        Não foi possível carregar o perfil. O número precisa estar conectado.
                    </p>
                )}
            </DialogContent>
        </Dialog>
    );
};

export default WhatsAppProfileDialog;
