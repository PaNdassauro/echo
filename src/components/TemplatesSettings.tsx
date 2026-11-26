import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Loader2, RefreshCw, Clock, CheckCircle, XCircle, Pencil, Search, Languages, AlertTriangle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { IdCopyButton } from "@/components/ui/id-copy-button";
import TemplateBuilderDialog from "@/components/templates/TemplateBuilderDialog";
import {
  CATEGORY_REJECTIONS,
  deleteTemplate,
  fetchOrgTemplates,
  isWhatsAppNotConfigured,
  rejectedReasonLabel,
  type MetaTemplate,
} from "@/lib/templatesApi";
import { TEMPLATE_LANGUAGES, editBlockedReason } from "@/lib/templateBuilder";
import { toUserMessage } from "@/lib/userFacingError";

type StatusFilter = "all" | "APPROVED" | "PENDING" | "REJECTED" | "PROBLEM";

const PENDING_STATUS = new Set(["PENDING", "IN_APPEAL"]);
// Status que derrubam envio: aparecem num filtro próprio para não sumir na lista longa.
const PROBLEM_STATUS = new Set(["PAUSED", "DISABLED", "FLAGGED", "LIMIT_EXCEEDED", "PENDING_DELETION"]);
// A Meta só aceita editar nesses status.
const EDITABLE_STATUS = new Set(["APPROVED", "REJECTED", "PAUSED"]);

const STATUS_LABEL: Record<string, string> = {
  PAUSED: "Pausado",
  DISABLED: "Desativado",
  FLAGGED: "Sinalizado",
  LIMIT_EXCEEDED: "Limite excedido",
  PENDING_DELETION: "Sendo excluído",
};

const matchesFilter = (status: string, filter: StatusFilter): boolean => {
  if (filter === "all") return true;
  if (filter === "PENDING") return PENDING_STATUS.has(status);
  if (filter === "PROBLEM") return PROBLEM_STATUS.has(status);
  return status === filter;
};

const CATEGORY_LABEL: Record<string, string> = {
  MARKETING: "Marketing",
  UTILITY: "Utilidade",
  AUTHENTICATION: "Autenticação",
};

const LANGUAGE_LABEL: Record<string, string> = {
  pt_BR: "Português",
  en_US: "Inglês",
  en: "Inglês",
  es: "Espanhol",
};

const languageLabel = (code: string) => LANGUAGE_LABEL[code] ?? code;

const getBodyText = (template: MetaTemplate): string =>
  template.components?.find((c) => c.type === "BODY")?.text || "";

const TemplatesSettings = () => {
  const { toast } = useToast();
  const { currentOrganization, isLoading: isOrgLoading, userRole } = useOrganization();
  // Editar e excluir mexem em template que pode estar em uso: só admin. Criar fica para todos.
  const canManage = userRole === "admin";
  const [templates, setTemplates] = useState<MetaTemplate[]>([]);
  // true inicial: deep-link em ?tab=templates mostrava "Nenhum template" falso
  const [loading, setLoading] = useState(true);
  const [semCloudApi, setSemCloudApi] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<MetaTemplate | null>(null);
  const [copyFrom, setCopyFrom] = useState<MetaTemplate | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<MetaTemplate | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Deps na org: entrar direto em ?tab=templates montava o painel antes do
  // contexto resolver e o fetch estourava "Nenhuma organização selecionada"
  useEffect(() => {
    fetchTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrganization?.id, isOrgLoading]);

  const fetchTemplates = async () => {
    // Org ainda carregando: aguarda em silêncio; o effect refaz quando resolver.
    // Contexto resolvido sem org: sai do loading para o vazio real.
    if (!currentOrganization?.id) {
      if (!isOrgLoading) setLoading(false);
      return;
    }

    setLoading(true);
    try {
      setTemplates(await fetchOrgTemplates(currentOrganization.id));
      setSemCloudApi(false);
    } catch (error) {
      if (isWhatsAppNotConfigured(error)) {
        setTemplates([]);
        setSemCloudApi(true);
        return;
      }
      console.error("Error fetching templates:", error);
      toast({
        title: "Não foi possível carregar os templates",
        description: toUserMessage(error, "Confira a conexão do WhatsApp oficial em Integrações e tente de novo."),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTemplate = async (template: MetaTemplate) => {
    if (!currentOrganization?.id) return;
    setDeleting(template.id);
    try {
      // Só este idioma: as outras versões com o mesmo nome continuam no ar.
      await deleteTemplate({ organizationId: currentOrganization.id, template });
      toast({ title: "Template excluído", description: `"${template.name}" (${languageLabel(template.language)}) foi removido.` });
      setTemplates((prev) => prev.filter((t) => t.id !== template.id));
    } catch (error) {
      console.error("Error deleting template:", error);
      toast({
        title: "Não foi possível excluir o template",
        description: toUserMessage(error, "Nada foi excluído. Atualize a lista e tente de novo."),
        variant: "destructive",
      });
    } finally {
      setDeleting(null);
      setDeleteConfirm(null);
    }
  };

  const openCreate = () => {
    setEditingTemplate(null);
    setCopyFrom(null);
    setBuilderOpen(true);
  };

  const openEdit = (template: MetaTemplate) => {
    const blocked = editBlockedReason(template);
    if (blocked) {
      toast({ title: "Não dá para editar aqui", description: blocked });
      return;
    }
    setEditingTemplate(template);
    setCopyFrom(null);
    setBuilderOpen(true);
  };

  const openCopy = (template: MetaTemplate) => {
    // A cópia passa pelo mesmo builder: botão que ele não conhece sumiria na versão nova.
    const blocked = editBlockedReason(template);
    if (blocked) {
      toast({ title: "Não dá para copiar aqui", description: blocked });
      return;
    }
    setEditingTemplate(null);
    setCopyFrom(template);
    setBuilderOpen(true);
  };

  const languagesOf = (name: string) => templates.filter((t) => t.name === name).map((t) => t.language);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "APPROVED":
        return <Badge className="bg-success/10 text-success hover:bg-success/15"><CheckCircle className="w-3 h-3 mr-1" aria-hidden />Aprovado</Badge>;
      case "PENDING":
        return <Badge className="bg-warning/10 text-warning hover:bg-warning/15"><Clock className="w-3 h-3 mr-1" aria-hidden />Em análise</Badge>;
      case "IN_APPEAL":
        return <Badge className="bg-warning/10 text-warning hover:bg-warning/15"><Clock className="w-3 h-3 mr-1" aria-hidden />Em recurso</Badge>;
      case "REJECTED":
        return <Badge className="bg-destructive/10 text-destructive hover:bg-destructive/15"><XCircle className="w-3 h-3 mr-1" aria-hidden />Recusado</Badge>;
      default:
        if (PROBLEM_STATUS.has(status)) {
          return <Badge className="bg-destructive/10 text-destructive hover:bg-destructive/15"><AlertTriangle className="w-3 h-3 mr-1" aria-hidden />{STATUS_LABEL[status]}</Badge>;
        }
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const term = searchTerm.toLowerCase();
  const count = (f: StatusFilter) => templates.filter((t) => matchesFilter(t.status, f)).length;
  const filteredTemplates = templates.filter((template) => {
    if (!matchesFilter(template.status, statusFilter)) return false;
    return (
      template.name.toLowerCase().includes(term) ||
      getBodyText(template).toLowerCase().includes(term)
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <Label className="text-base font-medium">Templates do WhatsApp</Label>
          <p className="text-xs text-muted-foreground">
            Mensagens aprovadas pela Meta para iniciar conversa ou falar fora da janela de 24h.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchTemplates} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1 ${loading ? "animate-spin" : ""}`} aria-hidden />
            Atualizar
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="w-4 h-4 mr-1" aria-hidden />
            Novo template
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden />
          <Input
            placeholder="Buscar por nome ou texto…"
            aria-label="Buscar templates"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={statusFilter}
          onValueChange={(v) => v && setStatusFilter(v as StatusFilter)}
          aria-label="Filtrar por status"
          className="justify-start"
        >
          <ToggleGroupItem value="all">Todos</ToggleGroupItem>
          <ToggleGroupItem value="APPROVED">Aprovados <span className="ml-1 tabular-nums text-muted-foreground">{count("APPROVED")}</span></ToggleGroupItem>
          <ToggleGroupItem value="PENDING">Em análise <span className="ml-1 tabular-nums text-muted-foreground">{count("PENDING")}</span></ToggleGroupItem>
          <ToggleGroupItem value="REJECTED">Recusados <span className="ml-1 tabular-nums text-muted-foreground">{count("REJECTED")}</span></ToggleGroupItem>
          {(count("PROBLEM") > 0 || statusFilter === "PROBLEM") && (
            <ToggleGroupItem value="PROBLEM">Com problema <span className="ml-1 tabular-nums text-destructive">{count("PROBLEM")}</span></ToggleGroupItem>
          )}
        </ToggleGroup>
      </div>

      {/* Div em vez do ScrollArea do Radix: o viewport dele envolve o conteúdo em display:table,
          que alarga até a linha mais longa do texto e empurra editar/excluir para fora da tela. */}
      <div className="h-[calc(100vh-260px)] overflow-y-auto overflow-x-hidden overscroll-contain border rounded-md p-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" aria-label="Carregando templates" />
          </div>
        ) : semCloudApi ? (
          <div className="flex flex-col items-center gap-1 py-12 text-center">
            <p className="text-sm text-foreground">A Cloud API do WhatsApp não está conectada.</p>
            <p className="text-sm text-muted-foreground">
              Os templates vêm da conta oficial da Meta. Conecte-a em Configurações &gt; Integração para listar e criar templates.
            </p>
          </div>
        ) : templates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">Nenhum template ainda.</p>
            <Button size="sm" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-1" aria-hidden />
              Criar o primeiro
            </Button>
          </div>
        ) : filteredTemplates.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">Nenhum template com esse filtro.</p>
        ) : (
          <div className="space-y-2">
            {filteredTemplates.map((template) => {
              const reason = template.status === "REJECTED" ? rejectedReasonLabel(template.rejected_reason) : null;
              return (
                <div key={template.id} className="p-3 rounded-lg bg-muted space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm truncate">{template.name}</p>
                        <IdCopyButton id={template.id} label="Template ID" className="h-4 w-4 flex-shrink-0" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {languageLabel(template.language)} · {CATEGORY_LABEL[template.category] ?? template.category}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {getStatusBadge(template.status)}
                      {canManage && TEMPLATE_LANGUAGES.some((l) => !languagesOf(template.name).includes(l.value)) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openCopy(template)}
                              className="h-8 w-8"
                              aria-label={`Nova versão de ${template.name} em outro idioma`}
                            >
                              <Languages className="w-4 h-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Nova versão em outro idioma</TooltipContent>
                        </Tooltip>
                      )}
                      {canManage && EDITABLE_STATUS.has(template.status) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(template)}
                          className="h-8 w-8"
                          aria-label={`Editar ${template.name}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                      )}
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleteConfirm(template)}
                          disabled={deleting === template.id}
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          aria-label={`Excluir ${template.name}`}
                        >
                          {deleting === template.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2 break-words">{getBodyText(template)}</p>
                  {template.status === "REJECTED" && (
                    <p className="text-xs text-destructive">
                      {reason ? `Motivo da Meta: ${reason}. ` : ""}
                      {CATEGORY_REJECTIONS.has(template.rejected_reason ?? "")
                        ? "Edite e troque a categoria."
                        : "Edite o texto e envie de novo."}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <TemplateBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        editing={editingTemplate}
        copyFrom={copyFrom}
        usedLanguages={copyFrom ? languagesOf(copyFrom.name) : undefined}
        onSaved={() => {
          // A Meta leva um instante para listar o template novo.
          setTimeout(fetchTemplates, 2000);
        }}
      />

      <AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir template?</AlertDialogTitle>
            <AlertDialogDescription>
              Sai a versão em {deleteConfirm ? languageLabel(deleteConfirm.language) : ""} de "{deleteConfirm?.name}"
              (as outras versões continuam). Envios que usam este template param de funcionar e a Meta pode bloquear
              reusar o nome por até 4 semanas. Não dá para desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteConfirm && handleDeleteTemplate(deleteConfirm)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default TemplatesSettings;
