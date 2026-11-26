/**
 * POST /groups/handover: passa um grupo de WhatsApp de uma linha nossa para outra.
 *
 * A regra que esta rota garante: a linha que sai SÓ sai depois que a linha que entra está dentro do grupo E é admin.
 * Se a que entra não é admin e a que sai não é admin para promovê-la, a que sai fica (409 entra_sem_admin).
 * Qualquer passo que falhe para tudo antes da saída: a linha que sai continua no grupo.
 *
 * Passos, todos no qr-service que a tela do grupo já usa (GroupInfoPanel):
 *   1. GET /groups/:sai/:jid?picture=0       a linha que sai está no grupo? é admin? (fora = nada a fazer)
 *   2. GET /groups/:entra/:jid?picture=0     a linha que entra já está dentro?
 *   3. se não está: GET /groups/:sai/:jid/invite-code (só admin tem o link) e POST /groups/:entra/join { code }.
 *      A linha que entra entra sozinha pelo link: pôr gente à força num grupo é o que derruba linha QR (o
 *      qr-service registra o 401 de penalidade ao adicionar).
 *      Grupo com aprovação de entrada: a que sai aprova o pedido da que entra (GET/POST join-requests).
 *      Confere relendo o grupo pela linha que entra.
 *   4. se a que sai é admin e a que entra não é: POST /groups/:sai/:jid/promote e confere relendo. Sem isso, quando
 *      a única admin nossa sai, o WhatsApp passa o admin para outro participante, que pode ser um cliente.
 *      Se a que entra não é admin e a que sai também não (não pode promover): para sem sair (409 entra_sem_admin).
 *   5. DELETE /groups/:sai/:jid/leave.
 *   6. a conversa do grupo de cada lado no Echo (a que entra: acha ou cria; a que sai: só acha), para quem chama
 *      acertar por onde o grupo recebe mensagem. Volta também quando a passagem para depois de a que entra entrar, e
 *      quando a que sai já estava fora (a chamada anterior pode ter parado antes desse acerto).
 *
 * Só o texto de erro do WhatsApp diz "fora do grupo"; status HTTP sem ele, ou grupo lido sem a própria linha na lista,
 * é falha (a que sai continua). Prazo total de 90 s: passou dele antes de entrar, promover ou sair, para (504).
 *
 * `dry_run: true` faz só as leituras 1 e 2 e diz o que faria. Sem idempotência própria: chamar de novo depois de
 * passar devolve `sai_fora_do_grupo`, sem mexer em nada.
 *
 * POST /groups/add-line (modo 'entrar', para outros números da equipe acompanharem o grupo): os passos 1 a 4 e o 6, sem o 5. A linha "from" é a nossa que já está no grupo e é admin
 * (quem tem o link); a "to" entra pelo link e vira admin (menos com make_admin: false). Ninguém sai. A "from" fora do
 * grupo é erro (409 admin_fora_do_grupo). Chamar de novo com a "to" já dentro e admin devolve `ja_estava`.
 */

import { GROUP_JID_SUFFIX, type RespostaDaRota } from './grupos.ts';
import { variantesDeTelefone } from '../_shared/aviso-quem-falou.ts';

export interface LinhaDoHandover {
  id: string;
  organization_id: string;
  connection_type: string | null;
  /** Número da linha (dígitos) quando o Echo sabe; só serve para achar o pedido de entrada em grupo com aprovação. */
  phone_number: string | null;
  display_name?: string | null;
}

export interface DepsPassarGrupo {
  /** A linha pelo uuid do Echo ou pelo id da Meta, já restrita à organização de quem chama. */
  buscarLinha(idOuMeta: string): Promise<LinhaDoHandover | null>;
  /** fetch no qr-service, já com a autorização e prazo. `path` começa com "/groups/". */
  qr(path: string, init?: RequestInit): Promise<Response>;
  /** A conversa do grupo daquela linha no Echo (acha ou cria). Nulo quando não deu. */
  conversaDoGrupo(groupJid: string, linhaId: string): Promise<string | null>;
  /** A conversa do grupo daquela linha no Echo, só se já existir (a linha que sai não ganha conversa nova). */
  conversaExistente(groupJid: string, linhaId: string): Promise<string | null>;
  /** Espera entre uma ação no WhatsApp e a releitura que a confere. */
  esperar(ms: number): Promise<void>;
  /** Relógio em ms (Date.now): o prazo total da rota. */
  agora(): number;
}

type Participante = { id: string; phone?: string; jid?: string; isAdmin?: boolean };

export type Leitura =
  | { tipo: 'dentro'; me: { id: string; isAdmin: boolean }; aprovacao: boolean; participantes: Participante[] }
  | { tipo: 'fora' }
  | { tipo: 'desconectada'; erro: string }
  | { tipo: 'falha'; erro: string };

/**
 * Resposta do WhatsApp para quem não é do grupo, no texto de erro em JSON que o qr-service repassa (varia por motor:
 * Baileys e zapo). Só o texto conta: status HTTP sem esse texto (404 de outra rota, HTML de proxy) é falha, nunca
 * "fora", senão a régua leria "já saiu" e não tentaria de novo.
 */
const FORA_DO_GRUPO = /forbidden|not-authorized|not authorized|item-not-found|not.a.participant/i;
/**
 * Linha desconectada no qr-service. Além do "Session not found/connected" do SessionManager, o cliente da linha diz
 * "Sessão sem cliente" (zapo, e o SessionManager sem cliente) e "Sessão sem socket" (Baileys), código not_connected.
 * Uma linha desconectada responde "Sessão sem cliente" e, sem este tratamento, o erro dizia "não conseguiu
 * entrar pelo link" em vez de "um dos números está desconectado".
 */
const SESSAO_FORA = /^(Session not (found|connected)|Sessão sem (cliente|socket))$/;
/** Releituras depois de uma ação: o WhatsApp demora alguns segundos para refletir. */
const TENTATIVAS = 3;
const ESPERA_MS = 2_000;
/**
 * Prazo da rota inteira. Cada chamada ao qr-service tem 15 s; somadas, passariam do limite da função e de quem chama
 * (o chamador típico espera ~120 s). Antes de entrar, promover ou sair, se o prazo passou, para sem mexer: a próxima chamada
 * continua de onde parou (cada passo relê o grupo).
 */
const PRAZO_MS = 90_000;

const erro = (status: number, resultado: string, mensagem: string, extra: Record<string, unknown> = {}): RespostaDaRota =>
  ({ status, body: { resultado, error: mensagem, ...extra } });

async function lerJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const json = await res.json();
    return json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const enc = encodeURIComponent;
const digitos = (s: unknown) => (typeof s === 'string' ? s.replace(/\D/g, '') : '');

export async function lerGrupo(deps: DepsPassarGrupo, linhaId: string, groupJid: string): Promise<Leitura> {
  let res: Response;
  try {
    res = await deps.qr(`/groups/${linhaId}/${enc(groupJid)}?picture=0`, { method: 'GET' });
  } catch (e) {
    return { tipo: 'falha', erro: `QR service unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const json = await lerJson(res);
  const grupo = json.group as Record<string, unknown> | undefined;
  if (res.ok && json.success === true && grupo && typeof grupo === 'object') {
    const me = grupo.me as { id?: unknown; isAdmin?: unknown } | null | undefined;
    // O WhatsApp entregou o grupo, mas o qr-service não achou a própria linha na lista: não é prova de que ela saiu.
    if (!me || typeof me.id !== 'string') return { tipo: 'falha', erro: 'line not found among the group participants' };
    const participantes = Array.isArray(grupo.participants) ? grupo.participants as Participante[] : [];
    return {
      tipo: 'dentro',
      me: { id: me.id, isAdmin: me.isAdmin === true },
      aprovacao: grupo.joinApprovalMode === true,
      participantes,
    };
  }
  if (typeof json.error !== 'string') return { tipo: 'falha', erro: `HTTP ${res.status}` };
  if (SESSAO_FORA.test(json.error)) return { tipo: 'desconectada', erro: json.error };
  if (FORA_DO_GRUPO.test(json.error)) return { tipo: 'fora' };
  return { tipo: 'falha', erro: json.error };
}

/** Relê até a condição valer (ou acabar as tentativas). Devolve a última leitura. */
async function lerAte(
  deps: DepsPassarGrupo, linhaId: string, groupJid: string, ok: (l: Leitura) => boolean,
): Promise<Leitura> {
  let ultima: Leitura = { tipo: 'falha', erro: 'não lido' };
  for (let i = 0; i < TENTATIVAS; i++) {
    if (i > 0) await deps.esperar(ESPERA_MS);
    ultima = await lerGrupo(deps, linhaId, groupJid);
    if (ok(ultima)) return ultima;
    if (ultima.tipo === 'desconectada') return ultima;
  }
  return ultima;
}

async function chamar(
  deps: DepsPassarGrupo, path: string, init: RequestInit,
): Promise<{ ok: boolean; json: Record<string, unknown>; erro: string }> {
  try {
    const res = await deps.qr(path, init);
    const json = await lerJson(res);
    const ok = res.ok && json.success !== false;
    return { ok, json, erro: ok ? '' : (typeof json.error === 'string' ? json.error : `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, json: {}, erro: `QR service unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

type Corpo = {
  group_jid?: unknown; from_phone_number_id?: unknown; to_phone_number_id?: unknown; dry_run?: unknown; make_admin?: unknown;
};

/** 'passar' = POST /groups/handover (a que sai sai no fim). 'entrar' = POST /groups/add-line (ninguém sai). */
export type ModoDoGrupo = 'passar' | 'entrar';

export async function passarGrupo(
  corpo: unknown, organizationId: string, deps: DepsPassarGrupo, modo: ModoDoGrupo = 'passar',
): Promise<RespostaDaRota> {
  const c: Corpo = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo as Corpo : {};
  const groupJid = typeof c.group_jid === 'string' ? c.group_jid.trim() : '';
  const deId = typeof c.from_phone_number_id === 'string' ? c.from_phone_number_id.trim() : '';
  const paraId = typeof c.to_phone_number_id === 'string' ? c.to_phone_number_id.trim() : '';
  const previa = c.dry_run === true;
  const entrar = modo === 'entrar';
  // No 'entrar' a que entra vira admin por padrão: se um dia a que criou sair, o admin fica com um número nosso.
  const promoverAoEntrar = entrar && c.make_admin !== false;

  if (!groupJid || !deId || !paraId) {
    return erro(400, 'pedido_invalido', 'Missing required fields', {
      required: ['group_jid', 'from_phone_number_id', 'to_phone_number_id'],
      optional: entrar ? ['dry_run', 'make_admin'] : ['dry_run'],
    });
  }
  if (!groupJid.endsWith(GROUP_JID_SUFFIX)) return erro(400, 'pedido_invalido', `group_jid must end with ${GROUP_JID_SUFFIX}`);

  const [sai, entra] = await Promise.all([deps.buscarLinha(deId), deps.buscarLinha(paraId)]);
  if (!sai || sai.organization_id !== organizationId) return erro(404, 'linha_nao_encontrada', 'from_phone_number_id not found in organization');
  if (!entra || entra.organization_id !== organizationId) return erro(404, 'linha_nao_encontrada', 'to_phone_number_id not found in organization');
  if (sai.id === entra.id) return erro(400, 'pedido_invalido', 'from and to are the same line');
  if (sai.connection_type !== 'qr' || entra.connection_type !== 'qr') {
    return erro(400, 'pedido_invalido', 'Groups can only be handed over between QR (Baileys) lines');
  }

  const passos: string[] = [];
  const avisos: string[] = [];
  const base = { group_jid: groupJid, from_phone_number_id: sai.id, to_phone_number_id: entra.id };
  const inicio = deps.agora();
  const semPrazo = () => deps.agora() - inicio > PRAZO_MS;
  const tempoEsgotado = (antesDe: string, extra: Record<string, unknown> = {}) =>
    erro(504, 'tempo_esgotado', `route deadline reached before ${antesDe}; the from line is still in the group`, { ...base, passos, avisos, ...extra });
  const semErro = async (f: () => Promise<string | null>) => {
    try {
      return await f();
    } catch {
      return null;
    }
  };
  // A conversa do grupo de cada lado: quem chama acerta por onde o grupo recebe mensagem (a que entrou passa a contar,
  // a que saiu deixa de contar), inclusive quando a passagem para no meio com a que entra já dentro.
  const conversaDaQueEntra = () => semErro(() => deps.conversaDoGrupo(groupJid, entra.id));
  const conversaDaQueSai = () => semErro(() => deps.conversaExistente(groupJid, sai.id));

  // 1. A linha que sai está no grupo?
  const lidaSai = await lerGrupo(deps, sai.id, groupJid);
  if (lidaSai.tipo === 'desconectada') return erro(503, 'linha_desconectada', `from line: ${lidaSai.erro}`, { ...base, linha: 'from' });
  if (lidaSai.tipo === 'falha') return erro(502, 'falha_ao_ler_grupo', `from line: ${lidaSai.erro}`, { ...base, linha: 'from' });
  if (lidaSai.tipo === 'fora' && entrar) {
    // Só quem está no grupo (e é admin) tem o link para a outra entrar.
    return erro(409, 'admin_fora_do_grupo', 'from line is not in the group: it cannot bring the to line in', { ...base, linha: 'from' });
  }
  if (lidaSai.tipo === 'fora') {
    // Já tinha saído (ou saiu numa chamada anterior que parou depois): diz se a que entra está dentro, para quem chama
    // terminar o acerto que a chamada anterior não fez.
    const lidaEntraAgora = await lerGrupo(deps, entra.id, groupJid);
    const entraDentro = lidaEntraAgora.tipo === 'dentro';
    return {
      status: 200,
      body: {
        resultado: 'sai_fora_do_grupo', ...base,
        entra_no_grupo: entraDentro,
        to_conversation_id: entraDentro ? await conversaDaQueEntra() : null,
        from_conversation_id: await conversaDaQueSai(),
        passos, avisos,
      },
    };
  }
  const saiAdmin = lidaSai.me.isAdmin;

  // 2. A linha que entra já está dentro? ('falha' aqui vira tentativa de entrar: entrar de novo não estraga nada,
  //    e a releitura depois da entrada é quem decide.)
  let lidaEntra = await lerGrupo(deps, entra.id, groupJid);
  if (lidaEntra.tipo === 'desconectada') return erro(503, 'linha_desconectada', `to line: ${lidaEntra.erro}`, { ...base, linha: 'to' });

  if (previa) {
    return {
      status: 200,
      body: {
        resultado: 'previa', ...base,
        sai_no_grupo: true, sai_admin: saiAdmin,
        entra_no_grupo: lidaEntra.tipo === 'dentro',
        entra_admin: lidaEntra.tipo === 'dentro' && lidaEntra.me.isAdmin,
        aprovacao_de_entrada: lidaSai.aprovacao,
        leitura_entra: lidaEntra.tipo === 'falha' ? lidaEntra.erro : null,
      },
    };
  }

  // 3. Entrar pelo link do grupo.
  if (lidaEntra.tipo !== 'dentro') {
    if (semPrazo()) return tempoEsgotado('joining');
    if (!saiAdmin) {
      return erro(409, 'sai_nao_e_admin', 'from line is not a group admin: it cannot get the invite link', { ...base, passos });
    }
    const convite = await chamar(deps, `/groups/${sai.id}/${enc(groupJid)}/invite-code`, { method: 'GET' });
    const code = typeof convite.json.code === 'string' ? convite.json.code
      : typeof convite.json.inviteUrl === 'string' ? convite.json.inviteUrl : '';
    if (!convite.ok && SESSAO_FORA.test(convite.erro)) {
      return erro(503, 'linha_desconectada', `from line: ${convite.erro}`, { ...base, linha: 'from', passos });
    }
    if (!convite.ok || !code) {
      return erro(502, 'convite_falhou', `invite-code: ${convite.erro || 'no code'}`, { ...base, passos });
    }
    const entrada = await chamar(deps, `/groups/${entra.id}/join`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ code }),
    });
    if (!entrada.ok) avisos.push(`join: ${entrada.erro}`);

    lidaEntra = await lerAte(deps, entra.id, groupJid, (l) => l.tipo === 'dentro');

    // Grupo com aprovação: a que entra fica pedindo; a que sai (admin) aprova.
    if (lidaEntra.tipo !== 'dentro' && lidaEntra.tipo !== 'desconectada' && lidaSai.aprovacao) {
      // O número da linha com e sem o 9º dígito: o WhatsApp de conta antiga mostra sem ele.
      const numeros = digitos(entra.phone_number).length >= 10 ? variantesDeTelefone(entra.phone_number) : [];
      const pedidos = await chamar(deps, `/groups/${sai.id}/${enc(groupJid)}/join-requests`, { method: 'GET' });
      if (!pedidos.ok && SESSAO_FORA.test(pedidos.erro)) {
        return erro(503, 'linha_desconectada', `from line: ${pedidos.erro}`, { ...base, linha: 'from', passos, avisos });
      }
      const lista = Array.isArray(pedidos.json.requests) ? pedidos.json.requests as Array<Record<string, unknown>> : [];
      const ehDaLinha = (v: unknown) => {
        const d = digitos(String(v ?? '').split('@')[0]);
        return d.length >= 10 && numeros.some((n) => d === n || d.endsWith(n) || n.endsWith(d));
      };
      const pedido = lista.find((r) => ehDaLinha(r.phone_number) || ehDaLinha(r.jid));
      if (!pedido || typeof pedido.jid !== 'string') {
        return erro(409, 'entrada_pendente', 'to line asked to join but the request could not be approved automatically', { ...base, passos, avisos });
      }
      const aprovou = await chamar(deps, `/groups/${sai.id}/${enc(groupJid)}/join-requests`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ participants: [pedido.jid], action: 'approve' }),
      });
      if (!aprovou.ok && SESSAO_FORA.test(aprovou.erro)) {
        return erro(503, 'linha_desconectada', `from line: ${aprovou.erro}`, { ...base, linha: 'from', passos, avisos });
      }
      if (!aprovou.ok) return erro(502, 'entrada_pendente', `approve: ${aprovou.erro}`, { ...base, passos, avisos });
      lidaEntra = await lerAte(deps, entra.id, groupJid, (l) => l.tipo === 'dentro');
    }

    if (lidaEntra.tipo === 'desconectada') return erro(503, 'linha_desconectada', `to line: ${lidaEntra.erro}`, { ...base, linha: 'to', passos, avisos });
    if (lidaEntra.tipo !== 'dentro') {
      return erro(502, 'entra_nao_entrou', `to line is not in the group after joining${lidaEntra.tipo === 'falha' ? `: ${lidaEntra.erro}` : ''}`, { ...base, passos, avisos });
    }
    passos.push('entrou');
  }

  // 4. Admin: a que entra recebe antes da que sai sair (no 'entrar', só com make_admin, que é o padrão).
  if (saiAdmin && !lidaEntra.me.isAdmin && (!entrar || promoverAoEntrar)) {
    if (semPrazo()) return tempoEsgotado('promoting', { to_conversation_id: await conversaDaQueEntra() });
    const promover = await chamar(deps, `/groups/${sai.id}/${enc(groupJid)}/promote`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ participants: [lidaEntra.me.id] }),
    });
    if (!promover.ok && SESSAO_FORA.test(promover.erro)) {
      return erro(503, 'linha_desconectada', `from line: ${promover.erro}`, { ...base, linha: 'from', passos, avisos, to_conversation_id: await conversaDaQueEntra() });
    }
    if (!promover.ok) avisos.push(`promote: ${promover.erro}`);
    const relida = await lerAte(deps, entra.id, groupJid, (l) => l.tipo === 'dentro' && l.me.isAdmin);
    if (relida.tipo === 'desconectada') {
      return erro(503, 'linha_desconectada', `to line: ${relida.erro}`, { ...base, linha: 'to', passos, avisos, to_conversation_id: await conversaDaQueEntra() });
    }
    if (relida.tipo !== 'dentro' || !relida.me.isAdmin) {
      return erro(502, 'promover_falhou', `to line is not admin after promote${promover.ok ? '' : `: ${promover.erro}`}`,
        { ...base, passos, avisos, to_conversation_id: await conversaDaQueEntra() });
    }
    lidaEntra = relida;
    passos.push('virou_admin');
  }

  // No 'entrar' ninguém sai: só a conversa do grupo do lado da que entrou (passo 6).
  if (entrar) {
    const conversa = await conversaDaQueEntra();
    if (!conversa) avisos.push('conversation_not_found');
    return {
      status: 200,
      body: {
        resultado: passos.length ? 'entrou' : 'ja_estava', ...base,
        entra_admin: lidaEntra.me.isAdmin,
        to_conversation_id: conversa,
        passos, avisos,
      },
    };
  }

  // A que sai só sai com a que entra como admin. Chega aqui sem admin só quando a que sai também não é
  // admin: não há quem promova. Só a que entra é conferida (outro número nosso admin não conta): erra para o lado de a
  // que sai ficar. O texto diz só o que foi conferido, porque quem chama o repassa como está e não conhece este código.
  if (!lidaEntra.me.isAdmin) {
    return erro(409, 'entra_sem_admin',
      'o número que entra não é admin do grupo, e o que sai não é admin para torná-lo admin; quem é admin do grupo precisa torná-lo admin antes de o outro sair',
      { ...base, passos, avisos, to_conversation_id: await conversaDaQueEntra() });
  }

  // 5. Sair.
  if (semPrazo()) return tempoEsgotado('leaving', { to_conversation_id: await conversaDaQueEntra() });
  const saida = await chamar(deps, `/groups/${sai.id}/${enc(groupJid)}/leave`, { method: 'DELETE' });
  if (!saida.ok && SESSAO_FORA.test(saida.erro)) {
    return erro(503, 'linha_desconectada', `from line: ${saida.erro}`, { ...base, linha: 'from', passos, avisos, to_conversation_id: await conversaDaQueEntra() });
  }
  if (!saida.ok) {
    return erro(502, 'saida_falhou', `leave: ${saida.erro}`, { ...base, passos, avisos, to_conversation_id: await conversaDaQueEntra() });
  }
  passos.push('saiu');
  const conferida = await lerAte(deps, sai.id, groupJid, (l) => l.tipo === 'fora');
  if (conferida.tipo !== 'fora') avisos.push('saida_nao_conferida');

  // 6. Conversa do grupo de cada lado.
  const conversationId = await conversaDaQueEntra();
  if (!conversationId) avisos.push('conversation_not_found');

  return {
    status: 200,
    body: {
      resultado: 'passou', ...base,
      entra_admin: lidaEntra.me.isAdmin,
      to_conversation_id: conversationId,
      from_conversation_id: await conversaDaQueSai(),
      passos, avisos,
    },
  };
}
