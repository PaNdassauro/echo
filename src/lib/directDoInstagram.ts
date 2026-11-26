/**
 * Direct do Instagram no Echo.
 * - Fase 2: conversa só do Direct (`channel = 'instagram'`,
 *   `contact_phone = 'ig:<id>'`, nunca telefone): a tela mostra o @.
 * - Fase 3: o Direct se junta ao WhatsApp do contato
 *   num card só (`channel = 'whatsapp'` com `instagram_user_id`). Cada mensagem
 *   do Direct tem `metadata.canal = 'instagram'`; a resposta sai pelo canal
 *   onde o contato escreveu por último, e o Direct só vale nas 24h.
 */
import { inboundSentAt } from "@/lib/deliveryTiming";

type ComCanal = {
  channel?: string | null;
  instagram_username?: string | null;
  instagram_user_id?: string | null;
  contact_phone?: string | null;
};

type MensagemComCanal = {
  direction?: string | null;
  created_at: string;
  is_deleted?: boolean | null;
  metadata?: unknown;
};

const JANELA_MS = 24 * 60 * 60 * 1000;

/** Conversa só do Direct (sem telefone). */
export function ehDirect(conversa: ComCanal | null | undefined): boolean {
  return conversa?.channel === "instagram";
}

/** Conversa com Direct: só do Direct ou card juntado ao WhatsApp. */
export function temDirect(conversa: ComCanal | null | undefined): boolean {
  return ehDirect(conversa) || Boolean(conversa?.instagram_user_id);
}

export function mensagemDoDirect(mensagem: { metadata?: unknown } | null | undefined): boolean {
  const meta = mensagem?.metadata as { canal?: unknown } | null | undefined;
  return meta?.canal === "instagram";
}

/** O que a tela mostra no lugar do telefone (card juntado: telefone + @). */
export function identificacaoDoContato(conversa: ComCanal): string {
  const arroba = conversa.instagram_username ? `@${conversa.instagram_username}` : "Instagram";
  if (ehDirect(conversa)) return arroba;
  const telefone = conversa.contact_phone ?? "";
  return conversa.instagram_user_id ? `${telefone} · ${arroba}` : telefone;
}

function horaDoEnvio(m: MensagemComCanal): number {
  return inboundSentAt({ direction: m.direction ?? "", created_at: m.created_at, metadata: m.metadata }).getTime();
}

/** Última mensagem de entrada (pela hora de envio do cliente). */
function ultimaEntrada<T extends MensagemComCanal>(mensagens: readonly T[]): T | null {
  let ultima: T | null = null;
  let hora = -Infinity;
  for (const m of mensagens) {
    if (m.direction !== "inbound" || m.is_deleted) continue;
    const t = horaDoEnvio(m);
    if (!Number.isNaN(t) && t > hora) {
      hora = t;
      ultima = m;
    }
  }
  return ultima;
}

/**
 * No card juntado, a resposta vai pelo Direct? Só quando a última mensagem do
 * contato veio pelo Direct e ainda está nas 24h (mesma regra do whatsapp-send).
 */
export function respostaVaiPeloDirect(mensagens: readonly MensagemComCanal[], agora = Date.now()): boolean {
  const ultima = ultimaEntrada(mensagens);
  if (!ultima || !mensagemDoDirect(ultima)) return false;
  return agora - horaDoEnvio(ultima) < JANELA_MS;
}

/**
 * Telefone que o contato DIGITOU no Direct (mensagem que é só um número): vira
 * sugestão no "Ligar ao WhatsApp do contato". Nunca junta sozinho — pode ser o
 * número de outra pessoa ou um CPF; uma pessoa confere e confirma.
 */
export function telefoneSugerido(mensagens: readonly (MensagemComCanal & { content?: string | null })[]): string {
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i];
    if (m.direction !== "inbound" || m.is_deleted || !mensagemDoDirect(m)) continue;
    const texto = (m.content ?? "").trim();
    if (!/^\+?[\d\s().-]+$/.test(texto)) continue;
    const digitos = texto.replace(/\D/g, "");
    if (digitos.length >= 10 && digitos.length <= 13) return texto;
  }
  return "";
}

/** Filtro de canal da lista: OR entre os marcados; nada marcado = todas. */
export type CanalDoFiltro = "whatsapp" | "instagram";

export function casaFiltroDeCanal(conversa: ComCanal, canais: readonly CanalDoFiltro[]): boolean {
  if (canais.length === 0) return true;
  // "Instagram" = tem Direct (só Direct ou card juntado); "WhatsApp" = conversa de WhatsApp (inclui o card juntado).
  return canais.some((canal) => (canal === "instagram" ? temDirect(conversa) : !ehDirect(conversa)));
}
