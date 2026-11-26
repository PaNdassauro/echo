import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    User as UserIcon,
    Lock,
    Tag,
    FileText,
    UserCog,
    ArrowLeft,
    Smartphone,
    XCircle,
    Users,
    Shield,
    Link as LinkIcon,
    ChevronRight,
    Zap,
    Palette,
    MessageSquareText,
    Mic,
    PersonStanding,
    type LucideIcon
} from "lucide-react";
import ProfileSettings from "@/components/settings/ProfileSettings";
import PhoneNumbersSettings from "@/components/PhoneNumbersSettings";
import UserManagementSettings from "@/components/UserManagementSettings";
import TemplatesSettings from "@/components/TemplatesSettings";
import ApiKeysSettings from "@/components/ApiKeysSettings";
import CloseReasonsSettings from "@/components/CloseReasonsSettings";
import TagsSettings from "@/components/TagsSettings";
import QuickRepliesSettings from "@/components/QuickRepliesSettings";
import ContactsSettings from "@/components/ContactsSettings";
import { useOrganization } from "@/contexts/OrganizationContext";
import { IdCopyButton } from "@/components/ui/id-copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import { IntegrationSettings } from "@/components/IntegrationSettings";
import { ActionButtonSettings } from "@/components/ActionButtonSettings";
import ThemeSettings from "@/components/settings/ThemeSettings";
import AccessibilitySettings from "@/components/settings/AccessibilitySettings";
import MicrophoneSettings from "@/components/settings/MicrophoneSettings";
import { useIsMobile } from "@/hooks/use-mobile";
import { BottomNavigation } from "@/components/layout";
import { cn } from "@/lib/utils";

interface SettingsMenuItem {
    id: string;
    label: string;
    icon: LucideIcon;
    description: string;
}

interface SettingsMenuGroup {
    id: string;
    label: string;
    items: SettingsMenuItem[];
}

const Settings = () => {
    const navigate = useNavigate();
    const { isSuperAdmin, currentOrganization, userRole } = useOrganization();
    const isOrgAdmin = isSuperAdmin || userRole === "admin";
    const [user, setUser] = useState<User | null>(null);
    const [searchParams, setSearchParams] = useSearchParams();
    const isMobile = useIsMobile();
    // A aba ativa é DERIVADA da URL (?tab=): o back físico do Android e o
    // swipe-back do iOS voltam ao menu em vez de abandonar /settings, e cada
    // seção ganha deep link de graça. Desktop cai em "profile" por padrão.
    const activeTab = searchParams.get("tab") ?? (isMobile ? null : "profile");

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) setUser(session.user);
            else navigate("/auth");
        });
    }, [navigate]);

    // Enquanto o getSession() resolve, um shell com a geometria real da página —
    // o return null de antes dava tela 100% branca em todo load de /settings
    if (!user) {
        if (isMobile) {
            return (
                <div className="min-h-dvh flex flex-col bg-background">
                    <header className="sticky top-0 z-40 bg-background/95 border-b border-border safe-area-top">
                        <div className="flex items-center h-14 px-4">
                            <h1 className="text-xl font-semibold">Configurações</h1>
                        </div>
                    </header>
                    <main className="flex-1 overflow-auto pb-bottom-nav">
                        <div className="divide-y">
                            {Array.from({ length: 6 }, (_, i) => (
                                <div key={i} className="flex items-center gap-4 p-4">
                                    <Skeleton className="w-10 h-10 rounded-full shrink-0" />
                                    <div className="flex-1 space-y-2">
                                        <Skeleton className="h-4 w-28" />
                                        <Skeleton className="h-3 w-44" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </main>
                    <BottomNavigation />
                </div>
            );
        }
        return (
            <div className="flex h-screen bg-background">
                <div className="w-64 border-r bg-card p-6 space-y-4">
                    <Skeleton className="h-6 w-40" />
                    <div className="space-y-2 pt-4">
                        {Array.from({ length: 8 }, (_, i) => (
                            <Skeleton key={i} className="h-9 rounded-md" />
                        ))}
                    </div>
                </div>
                <div className="flex-1 p-8 space-y-4">
                    <Skeleton className="h-8 w-56" />
                    <Skeleton className="h-64 rounded-xl" />
                </div>
            </div>
        );
    }

    const menuGroups: SettingsMenuGroup[] = [
        {
            id: "account",
            label: "Minha conta",
            items: [
                { id: "profile", label: "Perfil", icon: UserIcon, description: "Informações pessoais" },
                { id: "theme", label: "Tema", icon: Palette, description: "Aparência do app" },
                { id: "accessibility", label: "Acessibilidade", icon: PersonStanding, description: "Texto, movimento e contraste" },
                { id: "microphone", label: "Microfone", icon: Mic, description: "Teste o microfone dos áudios" },
            ],
        },
        {
            id: "service",
            label: "Atendimento",
            items: [
                { id: "templates", label: "Templates", icon: FileText, description: "Templates do WhatsApp" },
                { id: "tags", label: "Tags", icon: Tag, description: "Tags para classificar conversas" },
                { id: "quick-replies", label: "Frases prontas", icon: MessageSquareText, description: "Respostas rápidas com /atalho" },
                { id: "close-reasons", label: "Encerramento", icon: XCircle, description: "Motivos de encerramento" },
                { id: "contacts", label: "Contatos", icon: Users, description: "Contatos salvos" },
            ],
        },
        {
            id: "lines",
            label: "Números e integrações",
            items: [
                { id: "appearance", label: "Números", icon: Smartphone, description: "Números conectados ao Echo" },
                { id: "action-buttons", label: "Botões de ação", icon: Zap, description: "Botões customizados no chat" },
                { id: "integration", label: "Integração", icon: LinkIcon, description: "Webhooks e integrações" },
                { id: "api", label: "API", icon: Lock, description: "Chaves de acesso" },
            ],
        },
        {
            id: "admin",
            label: "Administração",
            items: [
                // Equipe expõe o mapa de atribuições e o convite de usuários — admin only.
                ...(isOrgAdmin ? [{ id: "team", label: "Equipe", icon: UserCog, description: "Usuários e permissões" }] : []),
                ...(isSuperAdmin ? [{ id: "super-admin", label: "Super Admin", icon: Shield, description: "Painel administrativo" }] : []),
            ],
        },
    ].filter((group) => group.items.length > 0);
    const menuItems = menuGroups.flatMap((group) => group.items);

    const handleSelectTab = (tabId: string) => {
        // Mobile: push (o back nativo volta ao menu). Desktop: replace (trocar
        // de seção não polui o histórico).
        setSearchParams({ tab: tabId }, { replace: !isMobile });
    };

    const handleMobileBack = () => {
        const historyIndex = (window.history.state as { idx?: number } | null)?.idx ?? 0;
        if (historyIndex > 0) {
            navigate(-1);
        } else {
            // Deep link direto na seção: não há entrada anterior — vai ao menu.
            navigate("/settings", { replace: true });
        }
    };

    const renderContent = () => {
        switch (activeTab) {
            case "action-buttons":
                return <ActionButtonSettings />;
            case "integration":
                return <IntegrationSettings />;
            case "profile":
                return <ProfileSettings user={user} />;
            case "theme":
                return <ThemeSettings userId={user.id} />;
            case "accessibility":
                return <AccessibilitySettings userId={user.id} />;
            case "microphone":
                return <MicrophoneSettings />;
            case "appearance":
                return (
                    <div className="space-y-6">
                        <div>
                            <h2 className="text-lg font-semibold">Números</h2>
                            <p className="text-sm text-muted-foreground">Gerencie os números conectados</p>
                        </div>
                        <PhoneNumbersSettings />
                    </div>
                );
            case "team":
                // Deep link (?tab=team) de não-admin cai no perfil.
                if (!isOrgAdmin) {
                    return <ProfileSettings user={user} />;
                }
                return (
                    <div className="space-y-6">
                        <div>
                            <h2 className="text-lg font-semibold">Equipe</h2>
                            <p className="text-sm text-muted-foreground">Gerencie os usuários e permissões</p>
                        </div>
                        <UserManagementSettings userId={user.id} />
                    </div>
                );
            case "templates":
                return (
                    <div className="space-y-6">
                        <div>
                            <h2 className="text-lg font-semibold">Templates</h2>
                            <p className="text-sm text-muted-foreground">Gerencie seus templates do WhatsApp</p>
                        </div>
                        <TemplatesSettings />
                    </div>
                );
            case "tags":
                return (
                    <div className="space-y-6">
                        <div>
                            <h2 className="text-lg font-semibold">Tags</h2>
                            <p className="text-sm text-muted-foreground">Gerencie as etiquetas de conversas</p>
                        </div>
                        <TagsSettings userId={user.id} />
                    </div>
                );
            case "quick-replies":
                return (
                    <div className="space-y-6">
                        <div>
                            <h2 className="text-lg font-semibold">Frases prontas</h2>
                            <p className="text-sm text-muted-foreground">Cadastre respostas rápidas e use-as no chat digitando /</p>
                        </div>
                        <QuickRepliesSettings userId={user.id} />
                    </div>
                );
            case "close-reasons":
                return (
                    <div className="space-y-6">
                        <div>
                            <h2 className="text-lg font-semibold">Motivos de encerramento</h2>
                            <p className="text-sm text-muted-foreground">Configure os motivos para encerrar atendimentos</p>
                        </div>
                        <CloseReasonsSettings userId={user.id} />
                    </div>
                );
            case "contacts":
                return (
                    <div className="space-y-6">
                        <div>
                            <h2 className="text-lg font-semibold">Contatos</h2>
                            <p className="text-sm text-muted-foreground">Visualize e filtre seus contatos</p>
                        </div>
                        <ContactsSettings />
                    </div>
                );
            case "api":
                return (
                    <div className="space-y-6">
                        <div>
                            <h2 className="text-lg font-semibold">API</h2>
                            <p className="text-sm text-muted-foreground">Chaves de acesso à API</p>
                        </div>
                        <ApiKeysSettings userId={user.id} organizationId={currentOrganization?.id} />
                    </div>
                );
            case "super-admin":
                return isSuperAdmin ? (
                    <div className="space-y-6">
                        <div>
                            <h2 className="text-lg font-semibold">Painel Super Admin</h2>
                            <p className="text-sm text-muted-foreground">Gerencie organizações e configurações globais</p>
                        </div>
                        <div className="flex flex-col items-center justify-center p-12 border-2 border-dashed rounded-lg text-center bg-card">
                            <div className="bg-primary/10 p-4 rounded-full mb-4">
                                <Shield className="w-12 h-12 text-primary" />
                            </div>
                            <h3 className="text-lg font-semibold mb-2">Acesso Restrito</h3>
                            <p className="text-muted-foreground max-w-sm mb-6">
                                Acesse o painel completo para gerenciar todas as organizações, usuários e configurações do sistema.
                            </p>
                            <Link to="/super-admin">
                                <Button className="gap-2" size="lg">
                                    Acessar Dashboard
                                    <Shield className="w-4 h-4" />
                                </Button>
                            </Link>
                        </div>
                    </div>
                ) : null;
            default:
                return null;
        }
    };

    // Mobile Layout
    if (isMobile) {
        // Show content if tab selected
        if (activeTab) {
            const currentItem = menuItems.find(item => item.id === activeTab);
            return (
                <div className="min-h-dvh flex flex-col bg-background">
                    {/* Mobile Header */}
                    <header className="sticky top-0 z-40 bg-background/95 backdrop-blur border-b border-border safe-area-top">
                        <div className="flex items-center h-14 px-2 gap-2">
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={handleMobileBack}
                                className="shrink-0 touch-manipulation"
                            >
                                <ArrowLeft className="h-5 w-5" />
                            </Button>
                            <div className="flex-1 min-w-0">
                                <h1 className="text-base font-semibold truncate">
                                    {currentItem?.label || "Configurações"}
                                </h1>
                            </div>
                        </div>
                    </header>

                    {/* Content */}
                    <main className="flex-1 overflow-auto p-4 pb-bottom-nav">
                        {renderContent()}
                    </main>

                    <BottomNavigation />
                </div>
            );
        }

        // Show menu list
        return (
            <div className="min-h-dvh flex flex-col bg-background">
                {/* Mobile Header */}
                <header className="sticky top-0 z-40 bg-background/95 backdrop-blur border-b border-border safe-area-top">
                    <div className="flex items-center h-14 px-4">
                        <h1 className="text-lg font-semibold">Configurações</h1>
                    </div>
                </header>

                {/* Menu List */}
                <main className="flex-1 overflow-auto pb-bottom-nav">
                    {menuGroups.map((group) => (
                        <section key={group.id} aria-labelledby={`settings-group-m-${group.id}`}>
                            <h2
                                id={`settings-group-m-${group.id}`}
                                className="px-4 pt-5 pb-2 text-xs font-medium text-muted-foreground"
                            >
                                {group.label}
                            </h2>
                            <div className="divide-y border-y">
                                {group.items.map((item) => (
                                    <button
                                        key={item.id}
                                        onClick={() => handleSelectTab(item.id)}
                                        className="w-full flex items-center gap-4 p-4 hover:bg-accent/50 active:bg-accent transition-colors touch-manipulation"
                                    >
                                        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10">
                                            <item.icon className="w-5 h-5 text-primary" />
                                        </div>
                                        <div className="flex-1 text-left min-w-0">
                                            <p className="font-medium text-sm">{item.label}</p>
                                            <p className="text-xs text-muted-foreground truncate">
                                                {item.description}
                                            </p>
                                        </div>
                                        <ChevronRight className="w-5 h-5 text-muted-foreground" />
                                    </button>
                                ))}
                            </div>
                        </section>
                    ))}
                </main>

                <BottomNavigation />
            </div>
        );
    }

    // Desktop Layout
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            {/* Sidebar */}
            <div className="w-64 border-r bg-card flex flex-col">
                <div className="p-6 pb-2">
                    <Button
                        variant="ghost"
                        className="w-full justify-start pl-0 -ml-2 text-muted-foreground hover:text-primary mb-4"
                        onClick={() => navigate("/dashboard")}
                    >
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Voltar para conversas
                    </Button>
                    <h1 className="text-2xl font-bold tracking-tight">Configurações</h1>
                    <div className="flex items-center gap-2 mt-1">
                        <p className="text-xs text-muted-foreground">ID da organização</p>
                        {currentOrganization?.id && (
                            <IdCopyButton
                                id={currentOrganization.id}
                                label="Organization ID"
                                className="h-4 w-4 ml-1"
                            />
                        )}
                    </div>
                </div>

                <ScrollArea className="flex-1 px-4">
                    <nav aria-label="Seções das configurações" className="space-y-5 py-4">
                        {menuGroups.map((group) => (
                            <div key={group.id} role="group" aria-labelledby={`settings-group-${group.id}`} className="space-y-1">
                                <p
                                    id={`settings-group-${group.id}`}
                                    className="px-3 pb-1 text-xs font-medium text-muted-foreground"
                                >
                                    {group.label}
                                </p>
                                {group.items.map((item) => (
                                    <Button
                                        key={item.id}
                                        variant={activeTab === item.id ? "secondary" : "ghost"}
                                        aria-current={activeTab === item.id ? "page" : undefined}
                                        className={cn(
                                            "w-full justify-start",
                                            activeTab === item.id
                                                ? "bg-primary/10 text-primary hover:bg-primary/20"
                                                : "text-muted-foreground"
                                        )}
                                        onClick={() => handleSelectTab(item.id)}
                                    >
                                        <item.icon className="w-4 h-4 mr-3" />
                                        {item.label}
                                    </Button>
                                ))}
                            </div>
                        ))}
                    </nav>
                </ScrollArea>
            </div>

            {/* Content */}
            <div className="flex-1 bg-muted/20 overflow-auto">
                <div className="container max-w-5xl py-8 px-8">
                    {renderContent()}
                </div>
            </div>
        </div>
    );
};

export default Settings;
