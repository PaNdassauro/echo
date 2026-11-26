import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import webpush from 'npm:web-push@3.6.7';
import { requireServiceRole } from '../_shared/authz.ts';

// Sends a VAPID-signed Web Push to every device subscribed by the users
// involved in a conversation (assignee + shared-custody co-owners). Called
// fire-and-forget by whatsapp-webhook right after an inbound message is saved.
// Delivers even when the recipient's tab is fully closed. verify_jwt = false:
// invoked server-to-server with the service role key.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PushPayload {
  conversationId?: string;
  title: string;
  body: string;
  url?: string;
  tag?: string;
  // Destinatários explícitos (alertas operacionais, ex.: send-failure-alert).
  // Presente → pula a resolução por conversa e o filtro de mute.
  userIds?: string[];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // `userIds` é aceito arbitrariamente do corpo (:23) e a function é
  // verify_jwt = false: sem esta guarda, qualquer um na internet dispara uma
  // notificação de sistema, com título e texto escolhidos, para o dispositivo
  // de qualquer usuário — inclusive com a tab fechada. Não é um segredo novo:
  // os dois únicos chamadores já mandam exatamente este bearer
  // (whatsapp-webhook/index.ts:128 e send-failure-alert/index.ts:239).
  try {
    requireServiceRole(req);
  } catch {
    console.warn('[send-web-push] chamada sem service role key — recusada');
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 401,
    });
  }

  try {
    const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT');

    if (!vapidPublic || !vapidPrivate || !vapidSubject) {
      console.error('[send-web-push] VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e VAPID_SUBJECT (mailto: ou https:) são obrigatórias');
      return new Response(JSON.stringify({ error: 'vapid_not_configured' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      });
    }
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

    const payload = (await req.json()) as Partial<PushPayload>;
    const explicitUserIds = Array.isArray(payload.userIds)
      ? payload.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (!payload.title || (!payload.conversationId && explicitUserIds.length === 0)) {
      return new Response(JSON.stringify({ error: 'invalid_payload' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const recipientIds = new Set<string>(explicitUserIds);

    // Sem lista explícita: resolve pelos envolvidos na conversa (assignee +
    // co-owners) e respeita o mute. Com lista (alerta operacional), a lista é
    // a verdade — alerta de falha não tem mute por conversa.
    if (explicitUserIds.length === 0) {
      // Resolve recipients: primary assignee + shared-custody co-owners.
      const { data: conv } = await supabase
        .from('conversations')
        .select('assigned_to, conversation_assignees(user_id)')
        .eq('id', payload.conversationId)
        .maybeSingle();

      if (conv?.assigned_to) recipientIds.add(conv.assigned_to as string);
      const assignees = (conv as { conversation_assignees?: Array<{ user_id: string }> } | null)
        ?.conversation_assignees;
      if (Array.isArray(assignees)) {
        for (const a of assignees) if (a.user_id) recipientIds.add(a.user_id);
      }

      if (recipientIds.size === 0) {
        return new Response(JSON.stringify({ sent: 0, note: 'no_recipients' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        });
      }

      // Silenciadas por usuário (conversation_prefs): quem silenciou não recebe
      // push desta conversa. 'infinity' > now() é true no Postgres — cobre o
      // "sempre" sem caso especial.
      const { data: muted } = await supabase
        .from('conversation_prefs')
        .select('user_id')
        .eq('conversation_id', payload.conversationId)
        .in('user_id', Array.from(recipientIds))
        .gt('muted_until', new Date().toISOString());
      for (const row of muted ?? []) {
        recipientIds.delete(row.user_id as string);
      }
    }

    if (recipientIds.size === 0) {
      return new Response(JSON.stringify({ sent: 0, note: 'all_muted' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .in('user_id', Array.from(recipientIds));

    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ sent: 0, note: 'no_subscriptions' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    const notification = JSON.stringify({
      title: payload.title,
      body: payload.body ?? '',
      url: payload.url ?? (payload.conversationId ? `/dashboard/${payload.conversationId}` : '/'),
      tag: payload.tag ?? (payload.conversationId ? `conv-${payload.conversationId}` : 'system-alert'),
    });

    const staleIds: string[] = [];
    const results = await Promise.allSettled(
      subs.map((s) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          notification
        ).catch((err: unknown) => {
          // 404/410 => subscription expired/unsubscribed; prune it.
          const statusCode = (err as { statusCode?: number })?.statusCode;
          if (statusCode === 404 || statusCode === 410) staleIds.push(s.id);
          throw err;
        })
      )
    );

    if (staleIds.length > 0) {
      await supabase.from('push_subscriptions').delete().in('id', staleIds);
    }

    const sent = results.filter((r) => r.status === 'fulfilled').length;
    return new Response(
      JSON.stringify({ sent, failed: results.length - sent, pruned: staleIds.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );
  } catch (err) {
    console.error('[send-web-push] error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
