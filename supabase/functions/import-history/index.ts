import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { createErrorResponse } from '../_shared/error-utils.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'unauthorized': 'Você não tem permissão para esta ação.',
    'conversation not found': 'Conversa não encontrada.',
    'not a member': 'Você não pertence a esta organização.',
    'invalid input': 'Dados inválidos.',
  };
  const lower = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lower.includes(key)) return value;
  }
  return `Erro: ${error}`;
}

interface ImportRow {
  ts: string;
  direction: 'inbound' | 'outbound';
  content: string;
  whatsapp_message_id: string;
  sender_phone: string;
  sender_name: string;
}

interface ImportRequest {
  conversation_id: string;
  rows: ImportRow[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/;
const MAX_ROWS = 500;
const INSERT_CHUNK = 200;

function validate(body: unknown): ImportRequest {
  if (!body || typeof body !== 'object') throw new Error('Invalid input: body missing');
  const b = body as Record<string, unknown>;

  if (typeof b.conversation_id !== 'string' || !UUID_RE.test(b.conversation_id)) {
    throw new Error('Invalid input: conversation_id must be a UUID');
  }
  if (!Array.isArray(b.rows)) throw new Error('Invalid input: rows must be an array');
  if (b.rows.length === 0) throw new Error('Invalid input: rows is empty');
  if (b.rows.length > MAX_ROWS) throw new Error(`Invalid input: máximo ${MAX_ROWS} linhas por requisição`);

  const rows: ImportRow[] = b.rows.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Invalid input: row ${i} is not an object`);
    const r = raw as Record<string, unknown>;
    if (typeof r.ts !== 'string' || !ISO_RE.test(r.ts)) {
      throw new Error(`Invalid input: row ${i} has invalid ts`);
    }
    if (r.direction !== 'inbound' && r.direction !== 'outbound') {
      throw new Error(`Invalid input: row ${i} direction must be inbound or outbound`);
    }
    if (typeof r.content !== 'string' || r.content.length === 0) {
      throw new Error(`Invalid input: row ${i} content is empty`);
    }
    if (typeof r.whatsapp_message_id !== 'string' || r.whatsapp_message_id.length === 0) {
      throw new Error(`Invalid input: row ${i} whatsapp_message_id is empty`);
    }
    return {
      ts: r.ts,
      direction: r.direction,
      content: r.content,
      whatsapp_message_id: r.whatsapp_message_id,
      sender_phone: typeof r.sender_phone === 'string' ? r.sender_phone : '',
      sender_name: typeof r.sender_name === 'string' ? r.sender_name : '',
    };
  });

  return { conversation_id: b.conversation_id, rows };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    // Without a fetch timeout, one hung PostgREST connection stalls the whole
    // request until the platform kills it with 504 — and the client can't tell
    // how much was inserted. Fail fast instead; the caller retries chunks
    // safely because dedup (upsert DO NOTHING) makes imports idempotent.
    const supabase = createClient(supabaseUrl, serviceKey, {
      global: {
        fetch: (input: Request | URL | string, init?: RequestInit) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(25_000) }),
      },
    });

    // Auth: identify the caller
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Unauthorized');
    const token = authHeader.replace('Bearer ', '');
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData?.user) throw new Error('Unauthorized');
    const userId = authData.user.id;

    // Validate input
    const body = await req.json().catch(() => null);
    const input = validate(body);

    // Resolve conversation → phone_number.organization_id
    const { data: conv, error: convError } = await supabase
      .from('conversations')
      .select('id, phone_number_id, last_message_at, phone_numbers!inner(organization_id)')
      .eq('id', input.conversation_id)
      .maybeSingle();

    if (convError || !conv) throw new Error('Conversation not found');

    const conversationOrgId = (conv as any).phone_numbers?.organization_id as string | undefined;
    if (!conversationOrgId) throw new Error('Conversation not found');

    // Verify the caller is a member of that organization
    const { data: membership, error: memberError } = await supabase
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', conversationOrgId)
      .eq('user_id', userId)
      .maybeSingle();

    if (memberError || !membership) {
      return createErrorResponse(new Error('Not a member of this organization'), corsHeaders, friendlyError);
    }

    // Build insert rows
    const insertRows = input.rows.map((r) => ({
      conversation_id: input.conversation_id,
      whatsapp_message_id: r.whatsapp_message_id,
      content: r.content,
      message_type: 'text',
      direction: r.direction,
      created_at: r.ts,
      status: 'read',
      // read_at é o que o badge de não-lido consulta (get_unread_counts mantém
      // `read_at IS NULL` como filtro legado). Sem estampar aqui, todo import
      // histórico virava não-lido para a organização inteira — `status: 'read'`
      // não é lido por ninguém nessa conta. Também precisa ser aqui e não só
      // depender da marca d'água do usuário: created_at é a data ORIGINAL da
      // mensagem e pode ser posterior à marca (import de conversa recente).
      read_at: r.direction === 'inbound' ? r.ts : null,
      sender_phone: r.sender_phone || null,
      sender_name: r.sender_name || null,
      is_imported: true,
    }));

    // The unique constraint on messages is composite: (whatsapp_message_id,
    // conversation_id) — verified via pg_index. Dedup via upsert DO NOTHING
    // instead of a pre-filter SELECT: group wamids are ~70 chars, so 500 ids
    // in a GET `.in()` produce a >30KB URL that the gateway rejects with 400.
    // The upsert ships ids in the POST body and returns only inserted rows.
    let inserted = 0;
    for (let i = 0; i < insertRows.length; i += INSERT_CHUNK) {
      const chunk = insertRows.slice(i, i + INSERT_CHUNK);
      const { data, error } = await supabase
        .from('messages')
        .upsert(chunk, {
          onConflict: 'whatsapp_message_id,conversation_id',
          ignoreDuplicates: true,
        })
        .select('whatsapp_message_id');
      if (error) {
        console.error('[import-history] insert error:', error);
        throw new Error(`Failed to insert: ${error.message}`);
      }
      inserted += data?.length ?? 0;
    }
    const skipped = insertRows.length - inserted;

    // Move last_message_at forward only if the import extends past it.
    const maxTs = input.rows.reduce((acc, r) => (r.ts > acc ? r.ts : acc), input.rows[0].ts);
    const currentLast = (conv as any).last_message_at as string | null;
    if (!currentLast || maxTs > currentLast) {
      await supabase
        .from('conversations')
        .update({ last_message_at: maxTs })
        .eq('id', input.conversation_id);
    }

    return new Response(
      JSON.stringify({ success: true, inserted, skipped }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    return createErrorResponse(error, corsHeaders, friendlyError);
  }
});
