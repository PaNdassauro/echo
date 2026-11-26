import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Clock, Loader2 } from "lucide-react";
import { Template } from "@/hooks/chat/useTemplates";
import TemplateMediaHeaderInput from "@/components/templates/TemplateMediaHeaderInput";
import { getTemplateHeaderFormat, TemplateHeaderMedia } from "@/lib/templateMedia";
import { extractVariables, variableContext } from "@/lib/templateBuilder";
import { useOrganization } from "@/contexts/OrganizationContext";

interface TemplateDialogProps {
  template: Template | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (template: Template, parameters: string[], buttonParameters: string[], headerMedia: TemplateHeaderMedia | null) => void;
  onSchedule?: (template: Template, parameters: string[], buttonParameters: string[], scheduledAt: Date, headerMedia: TemplateHeaderMedia | null) => Promise<{ success: boolean; error?: string }>;
}

const TemplateDialog = ({ template, open, onOpenChange, onSend, onSchedule }: TemplateDialogProps) => {
  const { currentOrganization } = useOrganization();
  const [parameters, setParameters] = useState<string[]>([]);
  const [buttonParameters, setButtonParameters] = useState<string[]>([]);
  const [headerMedia, setHeaderMedia] = useState<TemplateHeaderMedia | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);
  const [isScheduling, setIsScheduling] = useState(false);

  // Extract variable count from template body
  const getVariableCount = (template: Template): number => {
    const bodyComponent = template.components.find(c => c.type === 'BODY');
    if (!bodyComponent?.text) return 0;

    // Variável repetida ({{1}} duas vezes) é um parâmetro só.
    return extractVariables(bodyComponent.text).length;
  };

  // Get the body text with placeholders
  const getBodyText = (template: Template): string => {
    const bodyComponent = template.components.find(c => c.type === 'BODY');
    return bodyComponent?.text || '';
  };

  // Get example values if available
  const getExamples = (template: Template): string[] => {
    const bodyComponent = template.components.find(c => c.type === 'BODY');
    return bodyComponent?.example?.body_text?.[0] || [];
  };

  // Get URL buttons that have dynamic parameters
  const getUrlButtonsWithParams = (template: Template) => {
    const buttonsComponent = template.components.find(c => c.type === 'BUTTONS');
    if (!buttonsComponent?.buttons) return [];

    return buttonsComponent.buttons
      .map((btn, index) => ({ ...btn, index }))
      .filter(btn => btn.type === 'URL' && btn.url?.includes('{{'));
  };

  useEffect(() => {
    if (template) {
      const count = getVariableCount(template);
      setParameters(Array(count).fill(''));

      // Initialize button parameters
      const urlButtons = getUrlButtonsWithParams(template);
      setButtonParameters(Array(urlButtons.length).fill(''));

      // Reset media header when template changes
      setHeaderMedia(null);
    }
  }, [template]);

  if (!template) return null;

  const variableCount = getVariableCount(template);
  const bodyText = getBodyText(template);
  const examples = getExamples(template);
  const headerFormat = getTemplateHeaderFormat(template);
  const needsHeaderMedia = headerFormat !== null;
  const headerMediaMissing = needsHeaderMedia && !headerMedia?.link;

  // Preview with parameters filled in
  const getPreview = () => {
    let preview = bodyText;
    parameters.forEach((param, index) => {
      preview = preview.split(`{{${index + 1}}}`).join(param || `[Variável ${index + 1}]`);
    });
    return preview;
  };

  // Get buttons from template
  const getButtons = (template: Template) => {
    const buttonsComponent = template.components.find(c => c.type === 'BUTTONS');
    return buttonsComponent?.buttons || [];
  };

  const buttons = getButtons(template);
  const urlButtonsWithParams = getUrlButtonsWithParams(template);

  // Format date for datetime-local input
  const formatDateTimeLocal = (date: Date | null): string => {
    if (!date) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  // Get minimum date (now + 5 minutes)
  const getMinDate = (): string => {
    const min = new Date();
    min.setMinutes(min.getMinutes() + 5);
    return formatDateTimeLocal(min);
  };

  const handleDateTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value) {
      setScheduledDate(new Date(value));
    } else {
      setScheduledDate(null);
    }
  };

  const isValidDate = scheduledDate && scheduledDate > new Date(Date.now() + 5 * 60 * 1000);

  const handleSend = () => {
    if (variableCount > 0 && parameters.some(p => !p.trim())) {
      return; // Don't send if body parameters are missing
    }
    if (urlButtonsWithParams.length > 0 && buttonParameters.some(p => !p.trim())) {
      return; // Don't send if button parameters are missing
    }
    if (headerMediaMissing) {
      return;
    }
    onSend(template, parameters, buttonParameters, headerMedia);
    onOpenChange(false);
  };

  const handleSchedule = async () => {
    if (!scheduledDate || !onSchedule) return;
    if (variableCount > 0 && parameters.some(p => !p.trim())) {
      return;
    }
    if (urlButtonsWithParams.length > 0 && buttonParameters.some(p => !p.trim())) {
      return;
    }
    if (headerMediaMissing) {
      return;
    }

    setIsScheduling(true);
    const result = await onSchedule(template, parameters, buttonParameters, scheduledDate, headerMedia);
    setIsScheduling(false);

    if (result.success) {
      setScheduleOpen(false);
      setScheduledDate(null);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{template.name}</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-4 p-1">
            {/* Preview */}
            <div className="bg-muted p-3 rounded-lg">
              <Label className="text-xs text-muted-foreground mb-2 block">Prévia da mensagem</Label>
              <p className="text-sm whitespace-pre-wrap">{getPreview()}</p>
              {buttons.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-border/50">
                  {buttons.map((btn, idx) => (
                    <span
                      key={idx}
                      className="text-xs bg-background px-3 py-1.5 rounded-full border"
                    >
                      {btn.text}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Header media */}
            {headerFormat && (
              <TemplateMediaHeaderInput
                format={headerFormat}
                value={headerMedia}
                onChange={setHeaderMedia}
                organizationId={currentOrganization?.id}
              />
            )}

            {/* Body Parameters */}
            {variableCount > 0 && (
              <div className="space-y-3">
                <Label className="text-sm font-medium">Variáveis do texto</Label>
                {Array.from({ length: variableCount }).map((_, index) => (
                  <div key={index}>
                    {/* O trecho em volta diz o que vai ali ("Olá ___, sua reserva"). */}
                    <Label htmlFor={`tpl-var-${index}`} className="text-xs text-muted-foreground">
                      Variável {index + 1}
                      {variableContext(bodyText, index + 1) && (
                        <span className="ml-1 text-foreground/70">· {variableContext(bodyText, index + 1)}</span>
                      )}
                    </Label>
                    <Input
                      id={`tpl-var-${index}`}
                      value={parameters[index] || ''}
                      onChange={(e) => {
                        const newParams = [...parameters];
                        newParams[index] = e.target.value;
                        setParameters(newParams);
                      }}
                      placeholder={examples[index] ? `Ex.: ${examples[index]}` : `Valor de {{${index + 1}}}`}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* URL Button Parameters */}
            {urlButtonsWithParams.length > 0 && (
              <div className="space-y-3">
                <Label className="text-sm font-medium">Parâmetros dos botões</Label>
                {urlButtonsWithParams.map((btn, index) => (
                  <div key={index}>
                    <Label className="text-xs text-muted-foreground">
                      Botão "{btn.text}" - URL dinâmica
                    </Label>
                    <Input
                      value={buttonParameters[index] || ''}
                      onChange={(e) => {
                        const newParams = [...buttonParameters];
                        newParams[index] = e.target.value;
                        setButtonParameters(newParams);
                      }}
                      placeholder="Digite o valor dinâmico da URL"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="flex gap-2 justify-end mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          {onSchedule && (
            <Popover open={scheduleOpen} onOpenChange={setScheduleOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  disabled={
                    (variableCount > 0 && parameters.some(p => !p.trim())) ||
                    (urlButtonsWithParams.length > 0 && buttonParameters.some(p => !p.trim())) ||
                    headerMediaMissing
                  }
                >
                  <Clock className="w-4 h-4 mr-2" />
                  Agendar
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" align="end">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <h4 className="font-medium">Agendar template</h4>
                    <p className="text-sm text-muted-foreground">
                      O template será enviado automaticamente no horário escolhido.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="template-schedule-datetime" className="flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      Data e Horário
                    </Label>
                    <Input
                      id="template-schedule-datetime"
                      type="datetime-local"
                      value={formatDateTimeLocal(scheduledDate)}
                      onChange={handleDateTimeChange}
                      min={getMinDate()}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground">
                      Mínimo de 5 minutos no futuro
                    </p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setScheduleOpen(false)}
                      disabled={isScheduling}
                    >
                      Cancelar
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSchedule}
                      disabled={!isValidDate || isScheduling}
                    >
                      {isScheduling ? (
                        <Loader2 className="w-4 h-4 animate-spin mr-1" />
                      ) : (
                        <Clock className="w-4 h-4 mr-1" />
                      )}
                      Agendar
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}
          <Button
            onClick={handleSend}
            disabled={
              (variableCount > 0 && parameters.some(p => !p.trim())) ||
              (urlButtonsWithParams.length > 0 && buttonParameters.some(p => !p.trim())) ||
              headerMediaMissing
            }
          >
            Enviar template
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default TemplateDialog;
