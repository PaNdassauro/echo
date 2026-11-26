import { memo, type ReactNode } from "react";
import { Loader2, Plus, Search, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Template } from "@/hooks/chat";

interface TemplateSelectorProps {
  // Regular templates
  templates: Template[];
  loadingTemplates: boolean;
  templatesOpen: boolean;
  setTemplatesOpen: (open: boolean) => void;
  templateSearch: string;
  setTemplateSearch: (search: string) => void;
  selectTemplate: (template: Template) => void;
  getVariableCount: (template: Template) => number;
  /** Abre o builder para criar um template na hora. */
  onCreateTemplate?: () => void;
  /** Aviso do template criado que está em análise na Meta. */
  createNotice?: ReactNode;

  // Flow templates
  flowTemplates: Template[];
  loadingFlowTemplates: boolean;
  flowTemplatesOpen: boolean;
  setFlowTemplatesOpen: (open: boolean) => void;
  flowTemplateSearch: string;
  setFlowTemplateSearch: (search: string) => void;
  selectFlowTemplate: (template: Template) => void;

  // Flow template dialog
  selectedFlowTemplate: Template | null;
  flowTemplateDialogOpen: boolean;
  closeFlowTemplateDialog: () => void;
  flowTemplateParams: string[];
  setFlowTemplateParams: (params: string[]) => void;
  getTemplatePreview: (template: Template, params: string[]) => string;
  onSendFlowTemplate: () => Promise<void>;
}

const TemplateSelector = memo(({
  // Regular templates
  templates,
  loadingTemplates,
  templatesOpen,
  setTemplatesOpen,
  templateSearch,
  setTemplateSearch,
  selectTemplate,
  getVariableCount,
  onCreateTemplate,
  createNotice,

  // Flow templates
  flowTemplates,
  loadingFlowTemplates,
  flowTemplatesOpen,
  setFlowTemplatesOpen,
  flowTemplateSearch,
  setFlowTemplateSearch,
  selectFlowTemplate,

  // Flow template dialog
  selectedFlowTemplate,
  flowTemplateDialogOpen,
  closeFlowTemplateDialog,
  flowTemplateParams,
  setFlowTemplateParams,
  getTemplatePreview,
  onSendFlowTemplate,
}: TemplateSelectorProps) => {
  const flowVarCount = selectedFlowTemplate ? getVariableCount(selectedFlowTemplate) : 0;
  const hasEmptyParams = flowVarCount > 0 && flowTemplateParams.some(p => !p.trim());

  return (
    <>
      {/* Templates Sheet */}
      <Sheet open={templatesOpen} onOpenChange={setTemplatesOpen}>
        <SheetContent side="bottom" className="h-[60dvh] flex flex-col pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <SheetHeader className="pb-4 space-y-4">
            <div className="flex items-center justify-between gap-2 pr-8">
              <SheetTitle>Templates</SheetTitle>
              {onCreateTemplate && (
                <Button type="button" variant="outline" size="sm" onClick={onCreateTemplate}>
                  <Plus className="mr-1 h-4 w-4" aria-hidden />
                  Criar template
                </Button>
              )}
            </div>
            {createNotice}
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar template…"
                aria-label="Buscar templates"
                className="pl-9"
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
              />
            </div>
          </SheetHeader>
          {/* !block: o Radix põe display:table no conteúdo, que alarga até o texto mais longo e corta a lista na lateral. */}
          <ScrollArea className="[&_[data-radix-scroll-area-viewport]>div]:!block flex-1 min-h-0">
            {loadingTemplates ? (
              <div className="flex items-center justify-center p-6">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : templates.length === 0 ? (
              <div className="flex flex-col items-center gap-3 p-6 text-center">
                <p className="text-sm text-muted-foreground">Nenhum template aprovado ainda.</p>
                {onCreateTemplate && (
                  <Button type="button" size="sm" onClick={onCreateTemplate}>
                    <Plus className="mr-1 h-4 w-4" aria-hidden />
                    Criar template
                  </Button>
                )}
              </div>
            ) : (
              <div className="divide-y border rounded-lg">
                {templates
                  .filter(t =>
                    t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
                    t.components.some(c => c.type === 'BODY' && c.text?.toLowerCase().includes(templateSearch.toLowerCase()))
                  )
                  .map((template) => {
                    const varCount = getVariableCount(template);
                    return (
                      <button
                        key={template.id}
                        type="button"
                        className="w-full p-4 text-left hover:bg-accent transition-colors"
                        onClick={() => selectTemplate(template)}
                      >
                        <div className="flex items-center justify-between">
                          <p className="font-medium text-sm">{template.name}</p>
                          {varCount > 0 && (
                            <span className="text-xs bg-muted px-2 py-0.5 rounded">
                              {varCount === 1 ? "1 variável" : `${varCount} variáveis`}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {template.components.find(c => c.type === 'BODY')?.text || 'Sem preview'}
                        </p>
                        <p className="text-xs text-muted-foreground/70 mt-1">
                          Idioma: {template.language}
                        </p>
                      </button>
                    );
                  })}
              </div>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* Flow Templates Sheet */}
      <Sheet open={flowTemplatesOpen} onOpenChange={setFlowTemplatesOpen}>
        <SheetContent side="bottom" className="h-[60dvh] flex flex-col pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <SheetHeader className="pb-4 space-y-4">
            <SheetTitle>Templates com formulário</SheetTitle>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar template…"
                aria-label="Buscar templates com formulário"
                className="pl-9"
                value={flowTemplateSearch}
                onChange={(e) => setFlowTemplateSearch(e.target.value)}
              />
            </div>
          </SheetHeader>
          <ScrollArea className="[&_[data-radix-scroll-area-viewport]>div]:!block flex-1 min-h-0">
            {loadingFlowTemplates ? (
              <div className="flex items-center justify-center p-6">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : flowTemplates.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                Nenhum template com flow encontrado
              </div>
            ) : (
              <div className="divide-y border rounded-lg">
                {flowTemplates
                  .filter(t =>
                    t.name.toLowerCase().includes(flowTemplateSearch.toLowerCase())
                  )
                  .map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="w-full p-4 text-left hover:bg-accent transition-colors"
                      onClick={() => selectFlowTemplate(template)}
                    >
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">{template.name}</p>
                        <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                          {template.language}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {template.components.find(c => c.type === 'BODY')?.text || 'Sem texto'}
                      </p>
                    </button>
                  ))}
              </div>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* Flow Template Dialog */}
      <Dialog open={flowTemplateDialogOpen} onOpenChange={(open) => !open && closeFlowTemplateDialog()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Enviar formulário: {selectedFlowTemplate?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Preview */}
            <div className="p-4 bg-muted rounded-lg">
              <p className="text-xs text-muted-foreground mb-2">Prévia da mensagem</p>
              <p className="text-sm whitespace-pre-wrap">
                {selectedFlowTemplate && getTemplatePreview(selectedFlowTemplate, flowTemplateParams)}
              </p>
            </div>

            {/* Variable inputs */}
            {selectedFlowTemplate && flowVarCount > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium">Variáveis do texto</p>
                {Array.from({ length: flowVarCount }).map((_, index) => (
                  <div key={index}>
                    <label className="text-xs text-muted-foreground">
                      Variável {index + 1}
                    </label>
                    <Input
                      value={flowTemplateParams[index] || ''}
                      onChange={(e) => {
                        const newParams = [...flowTemplateParams];
                        newParams[index] = e.target.value;
                        setFlowTemplateParams(newParams);
                      }}
                      placeholder={`Variável ${index + 1}…`}
                    />
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Este template será enviado com o flow anexado. O destinatário poderá abrir o flow através do botão.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={closeFlowTemplateDialog}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                onClick={onSendFlowTemplate}
                disabled={hasEmptyParams}
              >
                <Send className="w-4 h-4 mr-2" />
                Enviar formulário
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
});

TemplateSelector.displayName = "TemplateSelector";

export default TemplateSelector;
