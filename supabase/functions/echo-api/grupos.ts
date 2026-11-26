/**
 * POST /groups: cria um grupo de WhatsApp VAZIO numa linha QR e devolve o link de convite.
 *
 * O grupo nasce só com o dono da linha e as pessoas entram pelo link: pôr gente à força num grupo é o que mais derruba
 * linha QR (o qr-service registra o 401 de penalidade ao adicionar participante). Por isso esta rota não aceita
 * participantes.
 *
 * Passos, cada um no qr-service que a tela de "Criar grupo" já usa (CreateGroupDialog):
 *   1. POST /groups/:linha/create { name, participants: [] }   → groupJid (falha = nada foi criado)
 *   2. PATCH /groups/:linha/:jid/description                    (opcional; falha vira aviso, o grupo fica)
 *      PUT /groups/:linha/:jid/picture { media_url }              (opcional; falha vira aviso, o grupo fica)
 *   3. a conversa do grupo no Echo (a mesma que o webhook cria)  (falha vira aviso)
 *   4. GET /groups/:linha/:jid/invite-code                      (falha vira aviso; refazer por
 *      GET /conversations/{id}/invite-link)
 *
 * Sem idempotência aqui: duas chamadas criam dois grupos. Quem chama segura a repetição.
 */

export const GROUP_JID_SUFFIX = '@g.us';
/** Limite do WhatsApp para o nome do grupo. */
export const MAX_SUBJECT = 100;
/** Limite do WhatsApp para a descrição do grupo. */
export const MAX_DESCRIPTION = 2048;

export interface LinhaDoGrupo {
  id: string;
  organization_id: string;
  connection_type: string | null;
}

export interface DepsCriarGrupo {
  /** A linha pelo uuid do Echo ou pelo id da Meta, sem filtrar a organização (a rota confere). */
  buscarLinha(idOuMeta: string): Promise<LinhaDoGrupo | null>;
  /** fetch no qr-service, já com a autorização e prazo. `path` começa com "/groups/". */
  qr(path: string, init?: RequestInit): Promise<Response>;
  /** A conversa do grupo no Echo (acha ou cria). Nulo quando não deu. */
  conversaDoGrupo(groupJid: string, linhaId: string): Promise<string | null>;
}

export interface RespostaDaRota {
  status: number;
  body: Record<string, unknown>;
}

type Corpo = { phone_number_id?: unknown; subject?: unknown; description?: unknown; picture_url?: unknown; participants?: unknown };

const erro = (status: number, error: string, extra: Record<string, unknown> = {}): RespostaDaRota =>
  ({ status, body: { error, ...extra } });

async function lerJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const json = await res.json();
    return json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function criarGrupo(corpo: unknown, organizationId: string, deps: DepsCriarGrupo): Promise<RespostaDaRota> {
  const c: Corpo = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo as Corpo : {};

  if (c.participants !== undefined) {
    return erro(400, 'participants is not accepted: people join through the invite link', {
      note: 'Adding people to a group from a QR line gets the line penalized. Share invite_url instead.',
    });
  }
  const phoneNumberId = typeof c.phone_number_id === 'string' ? c.phone_number_id.trim() : '';
  const subject = typeof c.subject === 'string' ? c.subject.trim() : '';
  if (!phoneNumberId || !subject) {
    return erro(400, 'Missing required fields', { required: ['phone_number_id', 'subject'], optional: ['description'] });
  }
  if ([...subject].length > MAX_SUBJECT) {
    return erro(400, `subject longer than ${MAX_SUBJECT} characters`);
  }
  let description: string | null = null;
  if (c.description !== undefined && c.description !== null) {
    if (typeof c.description !== 'string') return erro(400, 'description must be a string');
    description = c.description.trim() || null;
    if (description && [...description].length > MAX_DESCRIPTION) {
      return erro(400, `description longer than ${MAX_DESCRIPTION} characters`);
    }
  }
  let pictureUrl: string | null = null;
  if (c.picture_url !== undefined && c.picture_url !== null) {
    const bruto = typeof c.picture_url === 'string' ? c.picture_url.trim() : '';
    let ok = false;
    try {
      ok = new URL(bruto).protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) return erro(400, 'picture_url must be an https URL of an image');
    pictureUrl = bruto;
  }

  const linha = await deps.buscarLinha(phoneNumberId);
  if (!linha || linha.organization_id !== organizationId) {
    return erro(404, 'Phone number not found in organization');
  }
  if (linha.connection_type !== 'qr') {
    return erro(400, 'Groups can only be created on QR (Baileys) connections');
  }

  // 1. Criar. Daqui para trás nada existe no WhatsApp; daqui para frente o grupo existe.
  let resCriar: Response;
  try {
    resCriar = await deps.qr(`/groups/${linha.id}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: subject, participants: [] }),
    });
  } catch (e) {
    return erro(502, `QR service unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const criado = await lerJson(resCriar);
  const groupJid = typeof criado.groupJid === 'string' ? criado.groupJid : '';
  if (!resCriar.ok || criado.success !== true || !groupJid.endsWith(GROUP_JID_SUFFIX)) {
    return erro(resCriar.status >= 500 ? 502 : 400, typeof criado.error === 'string' ? criado.error : 'Failed to create group');
  }

  const avisos: string[] = [];

  // 2. Descrição.
  if (description) {
    try {
      const res = await deps.qr(`/groups/${linha.id}/${encodeURIComponent(groupJid)}/description`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      const json = await lerJson(res);
      if (!res.ok || json.success === false) avisos.push('description_not_set');
    } catch {
      avisos.push('description_not_set');
    }
  }

  // 2b. Foto (o qr-service baixa a imagem do link).
  if (pictureUrl) {
    try {
      const res = await deps.qr(`/groups/${linha.id}/${encodeURIComponent(groupJid)}/picture`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_url: pictureUrl }),
      });
      const json = await lerJson(res);
      if (!res.ok || json.success === false) avisos.push('picture_not_set');
    } catch {
      avisos.push('picture_not_set');
    }
  }

  // 3. Conversa no Echo.
  let conversationId: string | null = null;
  try {
    conversationId = await deps.conversaDoGrupo(groupJid, linha.id);
  } catch {
    conversationId = null;
  }
  if (!conversationId) avisos.push('conversation_not_created');

  // 4. Link de convite.
  let inviteUrl: string | null = null;
  try {
    const res = await deps.qr(`/groups/${linha.id}/${encodeURIComponent(groupJid)}/invite-code`, { method: 'GET' });
    const json = await lerJson(res);
    if (res.ok && json.success === true && typeof json.inviteUrl === 'string' && json.inviteUrl.startsWith('https://chat.whatsapp.com/')) {
      inviteUrl = json.inviteUrl;
    }
  } catch {
    inviteUrl = null;
  }
  if (!inviteUrl) avisos.push('invite_link_not_fetched');

  return {
    status: 201,
    body: { group_jid: groupJid, conversation_id: conversationId, invite_url: inviteUrl, warnings: avisos },
  };
}
