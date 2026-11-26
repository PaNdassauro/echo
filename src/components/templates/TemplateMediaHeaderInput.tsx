import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { publicAttachmentUrl } from "@/lib/runtimeConfig";
import { IconSwap } from "@/components/ui/icon-swap";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ImageIcon, Video, FileText, Upload, Loader2, X } from "lucide-react";
import {
  HEADER_MEDIA_LIMITS,
  TemplateHeaderFormat,
  TemplateHeaderMedia,
  isValidPublicUrl,
} from "@/lib/templateMedia";

interface TemplateMediaHeaderInputProps {
  format: TemplateHeaderFormat;
  value: TemplateHeaderMedia | null;
  onChange: (next: TemplateHeaderMedia | null) => void;
  organizationId?: string | null;
  storagePrefix?: string;
}

const FORMAT_ICONS: Record<TemplateHeaderFormat, typeof ImageIcon> = {
  IMAGE: ImageIcon,
  VIDEO: Video,
  DOCUMENT: FileText,
};

const FORMAT_LABELS: Record<TemplateHeaderFormat, string> = {
  IMAGE: "Imagem do cabeçalho",
  VIDEO: "Vídeo do cabeçalho",
  DOCUMENT: "Documento do cabeçalho",
};

const sanitizeFilename = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .replace(/_{2,}/g, "_");

export default function TemplateMediaHeaderInput({
  format,
  value,
  onChange,
  organizationId,
  storagePrefix = "template-headers",
}: TemplateMediaHeaderInputProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [urlDraft, setUrlDraft] = useState(value?.link ?? "");
  // Erro de campo fica sob o campo (não em toast) e some ao editar.
  const [fieldError, setFieldError] = useState<string | null>(null);
  const errorId = `template-media-error-${format.toLowerCase()}`;

  const limits = HEADER_MEDIA_LIMITS[format];
  const Icon = FORMAT_ICONS[format];

  const commitUrl = (link: string, filename?: string) => {
    if (!link) {
      onChange(null);
      return;
    }
    if (!isValidPublicUrl(link)) {
      setFieldError("Informe uma URL pública (https://…) que o WhatsApp consiga acessar.");
      return;
    }
    setFieldError(null);
    onChange({ format, link, filename: format === "DOCUMENT" ? filename : undefined });
  };

  const handleUrlBlur = () => {
    commitUrl(urlDraft.trim(), value?.filename);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!limits.mime.includes(file.type)) {
      setFieldError(`Este formato não é aceito. Use ${limits.label}.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    if (file.size > limits.maxBytes) {
      setFieldError(`Escolha um arquivo de até ${(limits.maxBytes / 1024 / 1024).toFixed(0)}MB.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setFieldError(null);
    setUploading(true);
    try {
      const cleanName = sanitizeFilename(file.name);
      const orgFolder = organizationId ? `${organizationId}/` : "";
      const path = `${storagePrefix}/${orgFolder}${Date.now()}_${cleanName}`;

      const { error: uploadError } = await supabase.storage
        .from("attachments")
        .upload(path, file, { contentType: file.type, upsert: false });

      if (uploadError) throw uploadError;

      const publicUrl = publicAttachmentUrl(path);

      setUrlDraft(publicUrl);
      onChange({
        format,
        link: publicUrl,
        filename: format === "DOCUMENT" ? file.name : undefined,
      });
    } catch (err: any) {
      console.error("[TemplateMediaHeaderInput] upload error:", err);
      toast({
        title: "Não foi possível enviar o arquivo",
        description: toUserMessage(err, "Verifique a conexão e tente de novo."),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const clear = () => {
    setUrlDraft("");
    setFieldError(null);
    onChange(null);
  };

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4" />
        {FORMAT_LABELS[format]}
      </Label>

      <div className="flex gap-2">
        <Input
          type="url"
          inputMode="url"
          placeholder="https://exemplo.com/arquivo"
          value={urlDraft}
          onChange={(e) => {
            setUrlDraft(e.target.value);
            setFieldError(null);
          }}
          onBlur={handleUrlBlur}
          disabled={uploading}
          aria-label={FORMAT_LABELS[format]}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? errorId : undefined}
          className="flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="Enviar arquivo"
          aria-label={uploading ? "Enviando…" : "Enviar arquivo"}
        >
          <IconSwap
            active={uploading ? "spinner" : "upload"}
            durationMs={150}
            icons={{
              spinner: <Loader2 className="h-4 w-4 animate-spin" />,
              upload: <Upload className="h-4 w-4" />,
            }}
          />
          {uploading && (
            <span className="sr-only" aria-live="polite">
              Enviando…
            </span>
          )}
        </Button>
        {value?.link && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={clear}
            disabled={uploading}
            title="Remover mídia"
            aria-label="Remover mídia"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {fieldError && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {fieldError}
        </p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={limits.accept}
        className="hidden"
        onChange={handleFile}
      />

      {format === "DOCUMENT" && value?.link && (
        <Input
          aria-label="Nome do arquivo exibido (opcional)"
          placeholder="Ex: Proposta_comercial.pdf"
          value={value.filename || ""}
          onChange={(e) =>
            onChange({ format, link: value.link, filename: e.target.value || undefined })
          }
          disabled={uploading}
        />
      )}

      {value?.link && format === "IMAGE" && (
        <div className="rounded-md border bg-muted/30 p-2">
          <img
            src={value.link}
            alt="Prévia do cabeçalho"
            className="max-h-32 rounded object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground">{limits.label}</p>
    </div>
  );
}
