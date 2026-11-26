/**
 * Preview de última mensagem por tipo (lista de conversas, toasts, push).
 *
 * A mesma tabela emoji→tipo existia duplicada em ConversationsList e
 * NotificationContext e já tinha divergido: só a lista tratava mensagem
 * apagada, então o toast mostrava o conteúdo que o contato apagou. Semântica
 * canônica: apagada tem precedência (o soft-delete preserva o content no
 * banco), depois o tipo, depois o texto cru.
 */

export interface PreviewableMessage {
  message_type?: string | null;
  content?: string | null;
  is_deleted?: boolean | null;
}

export function getMessagePreview(msg: PreviewableMessage): string {
  if (msg.is_deleted || msg.message_type === "deleted") return "🗑️ Mensagem apagada";
  switch (msg.message_type) {
    case "image":
      return "📷 Imagem";
    case "video":
      return "🎥 Vídeo";
    case "audio":
    case "ptt":
      return "🎵 Áudio";
    case "document":
      return "📄 Documento";
    case "sticker":
      return "🏷️ Figurinha";
    case "location":
      return "📍 Localização";
    case "contact":
    case "contacts":
      return "👤 Contato";
    // O serviço grava o resumo em content ("Chamada não atendida", "Chamada de
    // voz · 38s"); aqui só o ícone, para a prévia não perder o desfecho.
    case "call":
      return `📞 ${msg.content?.trim() || "Chamada de voz"}`;
    default:
      return msg.content ?? "";
  }
}
