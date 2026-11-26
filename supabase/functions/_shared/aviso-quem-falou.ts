// Aviso único, passo 1: o aviso de mensagem ao webhook da organização passa a dizer quem falou e quais linhas nossas
// estão no grupo, em campos NOVOS. Nenhum campo antigo muda: o receptor usa `whatsapp_message_id || message_id` como
// chave de aviso repetido, e o código do WhatsApp lá dentro faria a cópia da 2ª linha do grupo ser descartada.
//
// Cada linha nossa que está num grupo avisa a sua cópia; sem estes campos o receptor teria de adivinhar qual é cópia
// e quem falou, e a fala de uma linha nossa chegaria também por outra como se fosse do cliente. Os campos dizem isso
// explicitamente.

export interface LinhaNoGrupo {
  phone_number_id: string;
  linha_nome: string | null;
  conversation_id: string;
  ultima_mensagem_em: string | null;
}

export interface QuemFalou {
  tipo: 'equipe' | 'cliente' | 'desconhecido';
  linha_id?: string | null;
  linha_nome?: string | null;
  pessoa?: string | null;
  origem?: string | null;
  nome?: string | null;
  telefone?: string | null;
  jid?: string | null;
}

export interface AvisoQuemFalou {
  aviso_id: string;
  codigo_whatsapp: string | null;
  falou: QuemFalou;
  linhas_no_grupo?: LinhaNoGrupo[];
}

const soDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** O telefone como o WhatsApp mostra, com e sem o 9º dígito do celular brasileiro. */
export function variantesDeTelefone(valor: unknown): string[] {
  const d = soDigitos(valor);
  if (!d) return [];
  const out = new Set([d]);
  if (/^55\d{2}9\d{8}$/.test(d)) out.add(d.slice(0, 4) + d.slice(5));
  if (/^55\d{2}[6-9]\d{7}$/.test(d)) out.add(d.slice(0, 4) + '9' + d.slice(4));
  return [...out];
}

/** Identidades do remetente: o telefone (com e sem o 9) e o código antes do "@" (o @lid vem só nele). */
export function identidadesDoRemetente(telefone: unknown, jid: unknown): string[] {
  const out = new Set(variantesDeTelefone(telefone));
  const local = soDigitos(String(jid ?? '').split('@')[0]);
  if (local) for (const v of variantesDeTelefone(local)) out.add(v);
  return [...out];
}

/**
 * Quem falou, sem banco. `linhaDaIdentidade` é a linha nossa dona do remetente, se for uma.
 * Saída da própria linha é sempre equipe; a pessoa só vem quando o Echo sabe quem digitou (painel, API, automação).
 */
export function decidirQuemFalou(args: {
  saida: boolean;
  linhaDoAviso: { id: string | null; nome: string | null };
  pessoa?: string | null;
  origem?: string | null;
  grupo: boolean;
  remetente: { telefone?: string | null; nome?: string | null; jid?: string | null };
  linhaDaIdentidade: { id: string; nome: string | null } | null;
}): QuemFalou {
  if (args.saida) {
    return {
      tipo: 'equipe',
      linha_id: args.linhaDoAviso.id,
      linha_nome: args.linhaDoAviso.nome,
      pessoa: args.pessoa ?? null,
      origem: args.origem ?? null,
    };
  }
  if (args.linhaDaIdentidade) {
    return { tipo: 'equipe', linha_id: args.linhaDaIdentidade.id, linha_nome: args.linhaDaIdentidade.nome };
  }
  const telefone = soDigitos(args.remetente.telefone) || null;
  const nome = (args.remetente.nome ?? '').trim() || null;
  const jid = (args.remetente.jid ?? '').trim() || null;
  if (args.grupo && !telefone && !nome && !soDigitos(jid)) return { tipo: 'desconhecido' };
  return { tipo: 'cliente', nome, telefone, jid };
}

/**
 * Monta os campos novos do aviso de mensagem. Nunca lança: sem eles o aviso sai como sempre saiu.
 * Em grupo, a saída da linha também ensina como ela aparece como remetente (o @lid), para as próximas falas.
 */
export async function montarAvisoQuemFalou(
  supabase: any,
  organizationId: string,
  event: string,
  payload: any,
  linhaNome: string | null,
): Promise<AvisoQuemFalou | null> {
  // Passo 3: o complemento (message.author) é a voz da linha que falou, como o message.sent.
  if (event !== 'message.received' && event !== 'message.sent' && event !== 'message.author') return null;
  try {
    const mensagem = payload.message ?? {};
    const linhaId: string | null = payload.phone_number_internal_id ?? null;
    const grupo = payload.is_group === true;
    const jidDoGrupo: string | null = grupo ? (payload.group_jid ?? payload.contact?.phone ?? null) : null;
    const saida = event === 'message.sent' || event === 'message.author';
    const codigoBruto = mensagem.codigo ?? mensagem.whatsapp_id ?? null;
    const codigo = codigoBruto && !String(codigoBruto).startsWith('qr_') ? String(codigoBruto) : null;

    // Linhas da organização: dão o nome de cada uma e limitam a busca de identidade às nossas.
    const { data: linhas, error: erroLinhas } = await supabase
      .from('phone_numbers')
      .select('id, display_name')
      .eq('organization_id', organizationId);
    const nomeDaLinha = new Map<string, string | null>(
      ((linhas ?? []) as Array<{ id: string; display_name: string | null }>).map((l) => [l.id, l.display_name]),
    );

    const remetente = grupo
      ? { telefone: payload.sender_phone, nome: payload.sender_name, jid: payload.sender_jid }
      : { telefone: payload.contact?.phone, nome: payload.contact?.name, jid: null };
    const identidades = identidadesDoRemetente(remetente.telefone, remetente.jid);

    // Aprende só o @lid: o telefone de cada linha já vem da semente, e o campo de telefone da própria saída já veio
    // com número estranho.
    const lidDaSaida = String(payload.sender_jid ?? '').endsWith('@lid') ? soDigitos(String(payload.sender_jid).split('@')[0]) : '';
    if (saida && grupo && linhaId && lidDaSaida) {
      await supabase.from('linha_identidade').upsert(
        [{ identidade: lidDaSaida, phone_number_id: linhaId, origem: 'remetente', visto_em: new Date().toISOString() }],
        { onConflict: 'identidade', ignoreDuplicates: true },
      );
    }

    let linhaDaIdentidade: { id: string; nome: string | null } | null = null;
    let identidadeIndisponivel = !saida && !!erroLinhas;
    if (!saida && identidades.length > 0 && nomeDaLinha.size > 0) {
      const { data: achadas, error: erroIdentidade } = await supabase
        .from('linha_identidade')
        .select('phone_number_id')
        .in('identidade', identidades)
        .in('phone_number_id', [...nomeDaLinha.keys()])
        .limit(1);
      identidadeIndisponivel = !!erroIdentidade;
      const id = achadas?.[0]?.phone_number_id;
      if (id) linhaDaIdentidade = { id, nome: nomeDaLinha.get(id) ?? null };
    }

    const aviso: AvisoQuemFalou = {
      // Passo 3: um aviso por mensagem, com a chave reservada (aviso-unico.ts). Sem reserva (sem código do WhatsApp,
      // linha oficial), fica a do passo 1: uma por cópia.
      aviso_id: payload.aviso_unico?.chave ?? `${mensagem.id}:${event}`,
      codigo_whatsapp: codigo,
      // Sem a lista de identidades não dá para separar fala nossa de fala do cliente: fica "não sabemos".
      falou: identidadeIndisponivel ? { tipo: 'desconhecido' } : decidirQuemFalou({
        saida,
        linhaDoAviso: { id: linhaId, nome: linhaNome },
        pessoa: mensagem.sent_by_name ?? null,
        origem: mensagem.origin ?? null,
        grupo,
        remetente,
        linhaDaIdentidade,
      }),
    };

    // O complemento não leva a lista: o aviso que ele completa já levou.
    if (jidDoGrupo && nomeDaLinha.size > 0 && event !== 'message.author') {
      const { data: conversas } = await supabase
        .from('conversations')
        .select('id, phone_number_id')
        .eq('is_group', true)
        .or(`group_jid.eq."${jidDoGrupo}",contact_phone.eq."${jidDoGrupo}"`)
        .in('phone_number_id', [...nomeDaLinha.keys()]);
      // A última mensagem de verdade de cada conversa: o `last_message_at` da conversa conta também o aviso de
      // sistema do grupo ("fulano removeu…") e o histórico copiado de outra linha ("espelhar histórico", is_imported),
      // e o CRM decide por esta hora se a linha ainda ouve o grupo. Linha que já saiu do grupo tem só cópia espelhada.
      const comHora = await Promise.all(
        ((conversas ?? []) as Array<{ id: string; phone_number_id: string }>).map(async (c) => {
          const { data: ultima } = await supabase
            .from('messages')
            .select('created_at')
            .eq('conversation_id', c.id)
            .neq('message_type', 'group_action')
            .eq('is_imported', false)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          return { ...c, ultima: (ultima?.created_at as string | undefined) ?? null };
        }),
      );
      // Uma conversa por linha: a mais recente, se o Echo tiver duas para o mesmo grupo.
      const porLinha = new Map<string, LinhaNoGrupo>();
      for (const c of comHora) {
        const atual = porLinha.get(c.phone_number_id);
        if (!atual || (c.ultima ?? '') > (atual.ultima_mensagem_em ?? '')) {
          porLinha.set(c.phone_number_id, {
            phone_number_id: c.phone_number_id,
            linha_nome: nomeDaLinha.get(c.phone_number_id) ?? null,
            conversation_id: c.id,
            ultima_mensagem_em: c.ultima,
          });
        }
      }
      aviso.linhas_no_grupo = [...porLinha.values()];
    }

    return aviso;
  } catch (error) {
    console.error('[aviso-quem-falou] campos novos ficaram de fora:', error);
    return null;
  }
}
