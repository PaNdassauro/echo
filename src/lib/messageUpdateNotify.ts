// Classificador puro do UPDATE de `messages` que chega no Realtime (GlobalNotificationListener).
//
// Por que existe: com RLS, o `old` do Realtime traz só a PK (a tabela não tem REPLICA IDENTITY
// FULL), então `old.status` e `old.reaction` são `undefined`. A comparação antiga
// (`status === 'failed' && old.status !== 'failed'`, `reaction && reaction !== old.reaction`)
// virava "sempre mudou": todo UPDATE de metadata (leitura/transcrição, link preview,
// edição) numa mensagem `failed` ou com `reaction` preenchida soaria como falha/reação nova.
//
// Regras:
// - Reação NUNCA sai do UPDATE: ela vem do INSERT em `message_reactions` (mesmo canal).
// - Falha: se o `old` trouxer `status`, vale a comparação; senão, deduplica por id com um Set por
//   sessão (a primeira vez notifica; UPDATE só de metadata em mensagem já vista não).
// - Falha só é "nova" se a FALHA é recente: a idade vem de `metadata.failed_at` (carimbo do trigger
//   `messages_failed_at`, hora em que o status virou failed) e, sem carimbo (linha antiga), de `created_at`. Medir só
//   pela chegada descartava a falha que vem tarde (replay do qr-service, reentrega da Meta) numa linha velha. Sem isso, a aba que abre de manhã tem o Set
//   vazio e qualquer UPDATE de metadata (transcrição, link preview) numa outbound `failed` de ontem tocaria som e somaria no badge para todos da linha. Limite conhecido: um
//   reenvio antigo que falha de novo, sem a aba ter visto a saída de `failed`, não toca (o badge se reconstrói pela RPC).
// - Sair de `failed` (reenvio) esquece o id: uma nova falha depois notifica de novo.

export interface UpdateRow {
  id: string;
  conversation_id: string;
  status: string | null;
  /** hora de chegada da linha; ausente = não filtra por idade */
  created_at?: string | null;
  /** `metadata` da linha (o carimbo `failed_at` é lido daqui) */
  metadata?: { failed_at?: string | null } | Record<string, unknown> | null;
}

/** Falha mais velha que isto, vista pela primeira vez em UPDATE só com a PK, é falha antiga, não nova. */
export const FALHA_NOVA_MAX_MS = 10 * 60_000;

/** `old` do Realtime: com RLS, normalmente só a PK. `status` só aparece com replica identity full. */
export type UpdateOld = { id?: string; status?: string | null } | null | undefined;

export type NotificacaoDeUpdate = 'falha' | null;

/** Teto do Set por sessão: o mais antigo sai primeiro (falha repetida de id muito antigo é aceitável). */
export const FALHAS_VISTAS_MAX = 1000;

function lembrar(falhasVistas: Set<string>, id: string): void {
  falhasVistas.delete(id); // reinsere no fim (ordem de inserção do Set)
  falhasVistas.add(id);
  if (falhasVistas.size > FALHAS_VISTAS_MAX) {
    const maisAntigo = falhasVistas.values().next().value;
    if (maisAntigo !== undefined) falhasVistas.delete(maisAntigo);
  }
}

/**
 * Decide se um UPDATE de `messages` merece notificação. Muta `falhasVistas` (estado da sessão).
 * Devolve `'falha'` quando é a primeira vez que esta mensagem aparece como `failed`; senão `null`.
 */
export function classificarUpdate(
  old: UpdateOld,
  novo: UpdateRow,
  falhasVistas: Set<string>,
  agora: number = Date.now(),
): NotificacaoDeUpdate {
  if (novo.status !== 'failed') {
    // Saiu de failed (ou nunca foi): esquece, para uma falha futura notificar de novo.
    if (novo.id) falhasVistas.delete(novo.id);
    return null;
  }

  const jaVista = falhasVistas.has(novo.id);
  lembrar(falhasVistas, novo.id);

  // `old` com status: a comparação decide (UPDATE que não mexe no status não notifica).
  if (old && old.status !== undefined) {
    return old.status !== 'failed' ? 'falha' : null;
  }
  // `old` só com a PK: o Set decide, e só falha recente conta como nova.
  if (jaVista) return null;
  const carimbo = (novo.metadata as { failed_at?: unknown } | null | undefined)?.failed_at;
  const instante = typeof carimbo === "string" ? Date.parse(carimbo) : NaN;
  const desde = Number.isFinite(instante) ? instante : novo.created_at ? Date.parse(novo.created_at) : NaN;
  if (Number.isFinite(desde) && agora - desde > FALHA_NOVA_MAX_MS) return null;
  return 'falha';
}
