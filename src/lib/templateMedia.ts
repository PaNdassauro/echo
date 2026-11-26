// Helpers for WhatsApp template messages with media headers (IMAGE/VIDEO/DOCUMENT).
// Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates#media-message-templates

export type TemplateHeaderFormat = "IMAGE" | "VIDEO" | "DOCUMENT";

export interface TemplateHeaderMedia {
  format: TemplateHeaderFormat;
  link: string;
  filename?: string;
}

export const HEADER_MEDIA_LIMITS: Record<TemplateHeaderFormat, { mime: string[]; maxBytes: number; label: string; accept: string }> = {
  IMAGE: {
    mime: ["image/jpeg", "image/png"],
    maxBytes: 5 * 1024 * 1024,
    label: "Imagem (JPG ou PNG, até 5MB)",
    accept: "image/jpeg,image/png",
  },
  VIDEO: {
    mime: ["video/mp4", "video/3gpp"],
    maxBytes: 16 * 1024 * 1024,
    label: "Vídeo (MP4 ou 3GPP, até 16MB)",
    accept: "video/mp4,video/3gpp",
  },
  DOCUMENT: {
    mime: ["application/pdf"],
    maxBytes: 100 * 1024 * 1024,
    label: "Documento (PDF, até 100MB)",
    accept: "application/pdf",
  },
};

export function getTemplateHeaderFormat(template: { components?: Array<{ type?: string; format?: string }> } | null | undefined): TemplateHeaderFormat | null {
  if (!template?.components) return null;
  const header = template.components.find((c) => c?.type === "HEADER");
  const fmt = header?.format?.toUpperCase();
  if (fmt === "IMAGE" || fmt === "VIDEO" || fmt === "DOCUMENT") return fmt;
  return null;
}

export function buildHeaderComponent(media: TemplateHeaderMedia | null | undefined) {
  if (!media || !media.link) return null;
  const format = media.format.toLowerCase();
  const parameter: Record<string, unknown> = { type: format };
  if (format === "image") {
    parameter.image = { link: media.link };
  } else if (format === "video") {
    parameter.video = { link: media.link };
  } else if (format === "document") {
    const doc: Record<string, string> = { link: media.link };
    if (media.filename) doc.filename = media.filename;
    parameter.document = doc;
  }
  return { type: "header", parameters: [parameter] };
}

export function isValidPublicUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
