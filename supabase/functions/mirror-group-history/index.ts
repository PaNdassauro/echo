import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';

/**
 * Espelha o histórico de um grupo entre DUAS linhas da mesma organização.
 *
 * Contexto: cada linha conectada tem sua própria `conversations` do grupo e
 * suas próprias `messages` (o webhook resolve uma conversa por
 * phone_number_id). Uma linha que entra no grupo depois só recebe dali para
 * frente — todo o passado já capturado pelas outras linhas fica invisível para
 * ela na caixa de entrada. Isto copia esse passado.
 *
 * IMPORTANTE: é cópia INTERNA. O Baileys 7.x não expõe o flag do WhatsApp de
 * compartilhar histórico ao adicionar alguém, então só existe aqui o que já
 * passou por alguma linha conectada. A UI precisa dizer isso.
 *
 * Por que é seguro duplicar o wamid: o índice único de `messages` é composto —
 * (whatsapp_message_id, conversation_id). O mesmo wamid em duas conversas é o
 * estado NORMAL de linhas espelhadas, produzido nativamente pelo webhook.
 *
 * Por que não estender o import-history: ele fixa `message_type: 'text'` e
 * exige `content` não-vazio, o que transformaria mídia em texto vazio inválido.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'unauthorized': 'Você não tem permissão para esta ação.',
    'conversation not found': 'Conversa não encontrada.',
    'not a member': 'Você não pertence a esta organização.',
    'different organizations': 'As duas linhas pertencem a organizações diferentes.',
    'not a group': 'Esta funcionalidade só vale para conversas de grupo.',
    'different groups': 'As conversas não são do mesmo grupo.',
    'same conversation': 'A conversa de origem e a de destino são a mesma.',
    'invalid input': 'Dados inválidos.',
  };
  const lower = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lower.includes(key)) return value;
  }
  return `Erro: ${error}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lote de leitura/escrita. 200 casa com o chunk do import-history. */
const CHUNK = 200;
/**
 * Teto de mensagens por chamada. Grupos antigos passam de 50k mensagens e a
 * edge function tem limite de tempo; o cliente repete até `has_more` ser false.
 */
const MAX_PER_CALL = 5_000;
/**
 * Lote do `.in()` por wamid. Menor que CHUNK de propósito: wamid de grupo tem
 * ~70 caracteres e vai na URL de um GET — o gateway recusa URL de REST acima de
 * ~30KB com 400.
 */
const WAMID_LOOKUP_CHUNK = 100;

interface MirrorRequest {
  source_conversation_id: string;
  target_conversation_id: string;
  since: string | null;
  count_only: boolean;
  after: Cursor | null;
}

/**
 * Continuação da paginação: `next_after` da resposta anterior.
 *
 * A paginação é por (created_at, id) e NÃO por offset. Com offset, a chamada
 * seguinte releria o mesmo bloco do começo — os 5k já copiados voltariam como
 * duplicata e a cópia nunca avançaria.
 */
interface Cursor {
  created_at: string;
  id: string;
}

function validate(body: unknown): MirrorRequest {
  if (!body || typeof body !== 'object') throw new Error('Invalid input: body missing');
  const b = body as Record<string, unknown>;

  for (const key of ['source_conversation_id', 'target_conversation_id'] as const) {
    if (typeof b[key] !== 'string' || !UUID_RE.test(b[key] as string)) {
      throw new Error(`Invalid input: ${key} must be a UUID`);
    }
  }
  if (b.source_conversation_id === b.target_conversation_id) {
    throw new Error('Invalid input: same conversation');
  }

  let since: string | null = null;
  if (b.since != null) {
    if (typeof b.since !== 'string' || Number.isNaN(Date.parse(b.since))) {
      throw new Error('Invalid input: since must be an ISO timestamp');
    }
    since = new Date(b.since).toISOString();
  }

  let after: Cursor | null = null;
  if (b.after != null) {
    const a = b.after as Record<string, unknown>;
    if (
      !a || typeof a !== 'object' ||
      typeof a.created_at !== 'string' || Number.isNaN(Date.parse(a.created_at)) ||
      typeof a.id !== 'string' || !UUID_RE.test(a.id)
    ) {
      throw new Error('Invalid input: after must be { created_at, id }');
    }
    after = { created_at: a.created_at, id: a.id };
  }

  return {
    source_conversation_id: b.source_conversation_id as string,
    target_conversation_id: b.target_conversation_id as string,
    since,
    count_only: b.count_only === true,
    after,
  };
}

/**
 * Colunas transportadas para a cópia.
 *
 * `id` é lido apenas para desempatar o cursor — NÃO é copiado (cada cópia tem
 * uuid próprio). `quoted_message_id` é lido para ser REMAPEADO, ver abaixo.
 */
const COPY_COLUMNS = [
  'id',
  'quoted_message_id',
  'content',
  'message_type',
  'direction',
  'created_at',
  'whatsapp_message_id',
  'sender_phone',
  'sender_name',
  'sender_jid',
  'media_url',
  'media_mime_type',
  'media_filename',
  'media_size_bytes',
  'metadata',
  'reaction',
  'our_reaction',
  'is_deleted',
  'is_edited',
  'sent_by',
].join(', ');

/**
 * Religa as citações das mensagens copiadas.
 *
 * `quoted_message_id` é um uuid local de cada conversa, então não atravessa a
 * cópia. A tradução é feita pelo wamid, o identificador que as duas conversas
 * compartilham: id de origem → wamid → id equivalente no destino.
 *
 * Falhar aqui não desfaz a cópia — perder a citação degrada a exibição, perder
 * a mensagem não. Por isso o erro é registrado e engolido.
 */
async function relinkQuotes(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  /** wamid de quem cita → messages.id (na origem) do citado. */
  quotePairs: Map<string, string>,
  targetConversationId: string
): Promise<number> {
  if (quotePairs.size === 0) return 0;

  try {
    // 1. id de origem do citado → wamid dele.
    const quotedSourceIds = [...new Set(quotePairs.values())];
    const wamidBySourceId = new Map<string, string>();
    for (let i = 0; i < quotedSourceIds.length; i += CHUNK) {
      const { data, error } = await supabase
        .from('messages')
        .select('id, whatsapp_message_id')
        .in('id', quotedSourceIds.slice(i, i + CHUNK));
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.whatsapp_message_id) wamidBySourceId.set(row.id, row.whatsapp_message_id);
      }
    }

    // 2. wamid → id da cópia no destino. Cobre quem cita e quem é citado.
    const wanted = new Set<string>();
    for (const [citerWamid, quotedSourceId] of quotePairs) {
      const quotedWamid = wamidBySourceId.get(quotedSourceId);
      if (!quotedWamid) continue;
      wanted.add(citerWamid);
      wanted.add(quotedWamid);
    }
    if (wanted.size === 0) return 0;

    const targetIdByWamid = new Map<string, string>();
    const wantedList = [...wanted];
    for (let i = 0; i < wantedList.length; i += WAMID_LOOKUP_CHUNK) {
      const { data, error } = await supabase
        .from('messages')
        .select('id, whatsapp_message_id')
        .eq('conversation_id', targetConversationId)
        .in('whatsapp_message_id', wantedList.slice(i, i + WAMID_LOOKUP_CHUNK));
      if (error) throw error;
      for (const row of data ?? []) targetIdByWamid.set(row.whatsapp_message_id, row.id);
    }

    // 3. Um UPDATE por citação. São poucas em relação ao total
    //    e cada uma aponta para um alvo diferente, então
    //    não há como agrupá-las em um único update.
    let relinked = 0;
    for (const [citerWamid, quotedSourceId] of quotePairs) {
      const quotedWamid = wamidBySourceId.get(quotedSourceId);
      if (!quotedWamid) continue;
      const citerTargetId = targetIdByWamid.get(citerWamid);
      const quotedTargetId = targetIdByWamid.get(quotedWamid);
      if (!citerTargetId || !quotedTargetId) continue;

      const { error } = await supabase
        .from('messages')
        .update({ quoted_message_id: quotedTargetId })
        .eq('id', citerTargetId)
        .is('quoted_message_id', null);
      if (error) throw error;
      relinked++;
    }
    return relinked;
  } catch (error) {
    // A cópia já valeu; a citação é enfeite. Não derrubar o resultado por ela.
    console.error('[mirror-group-history] relink quotes failed:', error);
    return 0;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    // Mesma razão do import-history: sem timeout, uma conexão pendurada vira
    // 504 sem o cliente saber quanto entrou. O upsert DO NOTHING torna o
    // retry seguro.
    const supabase = createClient(supabaseUrl, serviceKey, {
      global: {
        fetch: (input: Request | URL | string, init?: RequestInit) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(25_000) }),
      },
    });

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Unauthorized');
    const token = authHeader.replace('Bearer ', '');
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData?.user) throw new Error('Unauthorized');
    const userId = authData.user.id;

    const input = validate(await req.json().catch(() => null));

    // Uma única consulta para as duas conversas: metade das idas ao banco e
    // impossível ler uma e falhar na outra por corrida.
    const { data: convs, error: convError } = await supabase
      .from('conversations')
      .select('id, is_group, group_jid, phone_number_id, last_message_at, phone_numbers!inner(organization_id)')
      .in('id', [input.source_conversation_id, input.target_conversation_id]);

    if (convError) throw new Error(`Conversation not found: ${convError.message}`);

    const source = convs?.find((c) => c.id === input.source_conversation_id);
    const target = convs?.find((c) => c.id === input.target_conversation_id);
    if (!source || !target) throw new Error('Conversation not found');

    if (!source.is_group || !target.is_group) throw new Error('Not a group conversation');
    // Único vínculo confiável de "mesmo grupo": o JID. Sem isto, um erro de
    // digitação no id despejaria a conversa de um contato em outro grupo.
    if (!source.group_jid || source.group_jid !== target.group_jid) {
      throw new Error('Conversations belong to different groups');
    }

    // deno-lint-ignore no-explicit-any
    const sourceOrg = (source as any).phone_numbers?.organization_id as string | undefined;
    // deno-lint-ignore no-explicit-any
    const targetOrg = (target as any).phone_numbers?.organization_id as string | undefined;
    if (!sourceOrg || !targetOrg) throw new Error('Conversation not found');
    if (sourceOrg !== targetOrg) throw new Error('Conversations belong to different organizations');

    const { data: membership, error: memberError } = await supabase
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', targetOrg)
      .eq('user_id', userId)
      .maybeSingle();

    if (memberError || !membership) {
      throw new Error('Not a member of this organization');
    }

    // Linhas sem wamid ficam de fora em TODOS os modos (inclusive na contagem
    // do preview): fora da proteção do índice único, elas duplicariam a cada
    // nova execução — e o preview tem de bater com o que será copiado.
    const baseFilter = (
      // deno-lint-ignore no-explicit-any
      q: any
    ) => {
      let query = q
        .eq('conversation_id', input.source_conversation_id)
        .not('whatsapp_message_id', 'is', null);
      if (input.since) query = query.gte('created_at', input.since);
      return query;
    };

    if (input.count_only) {
      const { count, error } = await baseFilter(
        supabase.from('messages').select('id', { count: 'exact', head: true })
      );
      if (error) throw new Error(`Failed to count: ${error.message}`);
      return new Response(
        JSON.stringify({ success: true, total: count ?? 0 }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let inserted = 0;
    let read = 0;
    let maxTs: string | null = null;
    let hasMore = false;
    let cursor: Cursor | null = input.after;
    // wamid de quem cita → messages.id (na ORIGEM) do citado.
    const quotePairs = new Map<string, string>();

    for (let page = 0; page * CHUNK < MAX_PER_CALL; page++) {
      let readQuery = baseFilter(supabase.from('messages').select(COPY_COLUMNS));
      if (cursor) {
        // Keyset em (created_at, id): mensagens do mesmo instante (comum em
        // grupo) não podem ficar presas nem repetir.
        //
        // O timestamp vai ENTRE ASPAS: um timestamptz carrega '+' e ':', que
        // sem aspas o parser do .or() do PostgREST lê como separador.
        const ts = `"${cursor.created_at}"`;
        readQuery = readQuery.or(
          `created_at.gt.${ts},and(created_at.eq.${ts},id.gt.${cursor.id})`
        );
      }

      const { data: rows, error: readError } = await readQuery
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(CHUNK);

      if (readError) throw new Error(`Failed to read source: ${readError.message}`);
      if (!rows?.length) break;
      read += rows.length;

      const insertRows = rows.map(({ id: _sourceId, ...row }: Record<string, unknown>) => ({
        ...row,
        conversation_id: input.target_conversation_id,
        // Marca a cópia e dá o rollback documentado:
        // DELETE FROM messages WHERE conversation_id = $1 AND is_imported = true
        is_imported: true,
        // Histórico espelhado não pode estourar o badge de não-lido com
        // centenas de mensagens antigas. `read_at` é o que get_unread_counts
        // consulta — `status` sozinho não é lido por ninguém nessa conta.
        status: 'read',
        read_at: row.direction === 'inbound' ? row.created_at : null,
        // quoted_message_id aponta para messages.id da conversa de ORIGEM;
        // copiado cru vira referência cruzada que a UI renderiza errado. Entra
        // nulo e é religado no passo de remapeamento, depois que todas as
        // mensagens existirem no destino (a citada pode ser copiada DEPOIS de
        // quem a cita quando o histórico vem em vários lotes).
        quoted_message_id: null,
      }));

      // Guarda o par (wamid de quem cita → wamid do citado) para o remapeamento.
      for (const row of rows) {
        if (!row.quoted_message_id || !row.whatsapp_message_id) continue;
        quotePairs.set(row.whatsapp_message_id as string, row.quoted_message_id as string);
      }

      const { data: insertedRows, error: writeError } = await supabase
        .from('messages')
        .upsert(insertRows, {
          onConflict: 'whatsapp_message_id,conversation_id',
          ignoreDuplicates: true,
        })
        .select('created_at');

      if (writeError) {
        console.error('[mirror-group-history] insert error:', writeError);
        throw new Error(`Failed to insert: ${writeError.message}`);
      }
      inserted += insertedRows?.length ?? 0;

      const last = rows[rows.length - 1];
      cursor = { created_at: last.created_at as string, id: last.id as string };
      if (!maxTs || cursor.created_at > maxTs) maxTs = cursor.created_at;

      if (rows.length < CHUNK) break;
      // Encheu o teto da chamada e ainda veio lote cheio: sobrou histórico.
      if ((page + 1) * CHUNK >= MAX_PER_CALL) hasMore = true;
    }

    // Religa as citações. Só agora: no meio da cópia a mensagem citada pode
    // ainda não existir no destino. O elo é o wamid, o único identificador que
    // as duas conversas compartilham.
    const quotesRelinked = await relinkQuotes(
      supabase,
      quotePairs,
      input.target_conversation_id
    );

    // Avança last_message_at só se a cópia estende o que o destino já tinha.
    const currentLast = target.last_message_at as string | null;
    if (maxTs && (!currentLast || maxTs > currentLast)) {
      await supabase
        .from('conversations')
        .update({ last_message_at: maxTs })
        .eq('id', input.target_conversation_id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        inserted,
        skipped: read - inserted,
        total: read,
        quotes_relinked: quotesRelinked,
        has_more: hasMore,
        // Devolvido só quando sobrou histórico: é o `after` da próxima chamada.
        next_after: hasMore ? cursor : null,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
