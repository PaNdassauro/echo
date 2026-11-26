-- Baseline do banco do Echo (schema public).
-- Aplica do zero num `supabase start` (Postgres 17 com as extensões e os papéis do Supabase).
-- Ordem: extensões, tipos, funções, tabelas, constraints, índices, triggers, policies, RLS, publication, ACLs.
-- Os complementos (Auth, Storage, dados de referência, cron) estão nas migrações seguintes.
--
-- Segredos do Vault que as funções leem (ver public._segredo_obrigatorio): project_url, service_role_key,
-- qr_service_url e ai_key_secret. Nenhum valor é gravado aqui; supabase/seed.sql cria os do ambiente local.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";

CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";

CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE TYPE "public"."org_role" AS ENUM (
    'admin',
    'agent'
);

CREATE OR REPLACE FUNCTION "public"."_segredo_obrigatorio"("p_nome" "text") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v text;
BEGIN
    SELECT decrypted_secret INTO v FROM vault.decrypted_secrets WHERE name = p_nome;
    IF v IS NULL OR btrim(v) = '' THEN
        RAISE EXCEPTION 'Segredo "%" ausente no Vault', p_nome
            USING ERRCODE = '55000',
                  HINT = format('select vault.create_secret(''<valor>'', %L);', p_nome);
    END IF;
    IF p_nome = 'service_role_key' AND v NOT LIKE 'eyJ%' THEN
        RAISE EXCEPTION 'Segredo "service_role_key" não é um JWT'
            USING ERRCODE = '55000',
                  HINT = 'use o JWT legado de service_role (Settings > API > Legacy API keys), não uma chave sb_secret_: as edge functions chamadas pelo cron validam JWT';
    END IF;
    RETURN v;
END;
$$;


COMMENT ON FUNCTION "public"."_segredo_obrigatorio"("p_nome" "text") IS 'Lê um segredo do Vault (project_url, service_role_key, qr_service_url, ai_key_secret). Sem fallback: se faltar, falha com erro 55000 e a dica de como criar. project_url é https://<ref>.supabase.co; service_role_key é o JWT LEGADO de service_role (eyJ..., Settings > API > Legacy API keys), não uma chave sb_secret_: as edge functions chamadas pelo cron (verify_jwt) respondem 401 a qualquer outra coisa, e o pg_net é assíncrono, então o cron grava succeeded e o erro só aparece em net._http_response (select status_code, content from net._http_response order by created desc). Só postgres e service_role.';

CREATE OR REPLACE FUNCTION "public"."dispatch_fetch_analytics"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_service_key text;
    v_project_url text;
BEGIN
    v_service_key := public._segredo_obrigatorio('service_role_key');
    v_project_url := public._segredo_obrigatorio('project_url');

    PERFORM net.http_post(
        url     := v_project_url || '/functions/v1/fetch-analytics-data',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
        body    := '{}'::jsonb
    );
END;
$$;


COMMENT ON FUNCTION "public"."dispatch_fetch_analytics"() IS 'Chamada pelo cron fetch-analytics-daily: aciona a edge fetch-analytics-data com o segredo service_role_key do Vault.';

CREATE OR REPLACE FUNCTION "public"."get_org_whatsapp_config"("p_org_id" "uuid") RETURNS TABLE("whatsapp_waba_id" "text", "whatsapp_app_id" "text", "tem_token" boolean)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
#variable_conflict use_column
BEGIN
    IF NOT ((SELECT public.auth_is_super_admin()) OR public.user_is_org_admin(p_org_id)) THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT o.whatsapp_waba_id, o.whatsapp_app_id, (o.whatsapp_access_token IS NOT NULL AND o.whatsapp_access_token <> '')
      FROM public.organizations o
     WHERE o.id = p_org_id;
END;
$$;


COMMENT ON FUNCTION "public"."get_org_whatsapp_config"("p_org_id" "uuid") IS 'Configuração do WhatsApp da organização sem expor o segredo: ids da WABA e do app e um boolean dizendo se há token. Admin da organização ou super admin. O token em si só é lido pelas edge functions (service role) e é gravado por UPDATE na coluna.';

CREATE OR REPLACE FUNCTION "public"."get_org_ai_config"("p_org_id" "uuid") RETURNS TABLE("tem_chave" boolean, "ai_insights_prompt" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
#variable_conflict use_column
BEGIN
    IF NOT ((SELECT public.auth_is_super_admin()) OR public.user_is_org_admin(p_org_id)) THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT (o.ai_api_key_encrypted IS NOT NULL OR o.ai_api_key IS NOT NULL), o.ai_insights_prompt
      FROM public.organizations o
     WHERE o.id = p_org_id;
END;
$$;


COMMENT ON FUNCTION "public"."get_org_ai_config"("p_org_id" "uuid") IS 'Configuração de IA da organização sem expor a chave: um boolean dizendo se há chave e o prompt dos insights. Admin da organização ou super admin. A chave é gravada por set_ai_api_key e lida só pelas edge functions (service role).';

CREATE OR REPLACE FUNCTION "public"."_messages_metadata_guarda"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'metadata.leitura não pode ser gravado por este papel'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "public"."accept_invitation"("token_input" "text", "user_id_input" "uuid") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invitation record;
  v_org_id uuid;
BEGIN
  -- Get invitation
  SELECT * INTO v_invitation
  FROM public.user_invitations
  WHERE token = token_input
  AND accepted_at IS NULL;

  IF v_invitation IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Convite inválido ou já utilizado');
  END IF;

  -- O convite só pode ser aceito pelo usuário dono do e-mail convidado.
  -- Mensagem idêntica à de token inválido, de propósito: não confirmar a
  -- terceiros que um token existe.
  IF lower(coalesce((SELECT email FROM auth.users WHERE id = user_id_input), ''))
     <> lower(trim(v_invitation.email)) THEN
    RETURN json_build_object('success', false, 'error', 'Convite inválido ou já utilizado');
  END IF;

  -- Get Organization ID from phone number
  SELECT organization_id INTO v_org_id
  FROM public.phone_numbers
  WHERE id = v_invitation.phone_number_id;

  IF v_org_id IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Organização não encontrada para este número');
  END IF;

  -- 1. Insert into organization_members
  INSERT INTO public.organization_members (organization_id, user_id, role)
  VALUES (v_org_id, user_id_input, 'agent')
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- 2. Insert into user_phone_numbers
  INSERT INTO public.user_phone_numbers (user_id, phone_number_id)
  VALUES (user_id_input, v_invitation.phone_number_id)
  ON CONFLICT DO NOTHING;

  -- 3. Update invitation
  UPDATE public.user_invitations
  SET accepted_at = now()
  WHERE id = v_invitation.id;

  RETURN json_build_object('success', true, 'organization_id', v_org_id);
END;
$$;

CREATE OR REPLACE FUNCTION "public"."assert_org_analytics_access"("p_org_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    -- service_role/cron: sem JWT de usuário não há o que checar aqui; anon é
    -- barrado pelos REVOKEs das próprias RPCs.
    IF auth.uid() IS NULL THEN
        RETURN;
    END IF;
    IF public.auth_is_super_admin() OR public.user_is_org_admin(p_org_id) THEN
        RETURN;
    END IF;
    RAISE EXCEPTION 'Access denied to organization analytics' USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION "public"."auth_is_super_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT COALESCE(
        (SELECT is_super_admin FROM public.profiles WHERE id = auth.uid()),
        false
    );
$$;

CREATE OR REPLACE FUNCTION "public"."auth_user_org_ids"() RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT COALESCE(
        ARRAY(SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()),
        '{}'::UUID[]
    );
$$;

CREATE TABLE IF NOT EXISTS "public"."aviso_de_mensagem" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "chave" "text" NOT NULL,
    "message_id" "uuid" NOT NULL,
    "evento" "text" NOT NULL,
    "tem_autor" boolean DEFAULT false NOT NULL,
    "estado" "text" DEFAULT 'enviando'::"text" NOT NULL,
    "tentativas" integer DEFAULT 0 NOT NULL,
    "proxima_em" timestamp with time zone,
    "corpo" "jsonb",
    "falou" "jsonb",
    "ultimo_erro" "text",
    "criado_em" timestamp with time zone DEFAULT "now"() NOT NULL,
    "entregue_em" timestamp with time zone,
    CONSTRAINT "aviso_de_mensagem_estado_check" CHECK (("estado" = ANY (ARRAY['enviando'::"text", 'repetir'::"text", 'entregue'::"text", 'falhou'::"text"]))),
    CONSTRAINT "aviso_de_mensagem_evento_check" CHECK (("evento" = ANY (ARRAY['message.received'::"text", 'message.sent'::"text", 'message.author'::"text"])))
);

COMMENT ON TABLE "public"."aviso_de_mensagem" IS 'Aviso único: um aviso de webhook da organização por mensagem. A primeira cópia reserva a chave; entrega com até 10 repetições. Só edge (service role). Ver _shared/aviso-unico.ts.';

CREATE OR REPLACE FUNCTION "public"."aviso_de_mensagem_pegar_lote"("p_limite" integer DEFAULT 30) RETURNS SETOF "public"."aviso_de_mensagem"
    LANGUAGE "sql"
    SET "search_path" TO 'public'
    AS $$
    UPDATE aviso_de_mensagem a
       SET proxima_em = now() + interval '10 minutes'
     WHERE a.id IN (
           SELECT p.id FROM aviso_de_mensagem p
            WHERE p.estado IN ('enviando', 'repetir')
              AND p.proxima_em <= now()
            ORDER BY p.proxima_em
            LIMIT LEAST(GREATEST(COALESCE(p_limite, 30), 1), 100)
              FOR UPDATE SKIP LOCKED)
    RETURNING a.*;
$$;

CREATE OR REPLACE FUNCTION "public"."aviso_de_mensagem_repetir"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_service_key text;
    v_project_url text;
    v_parados     integer;
BEGIN
    -- A repetição parou (a edge recusa a chave, não sobe, cai antes de gravar): o alerta da última tentativa nasce
    -- dentro da edge e não sairia. Aviso vencido há mais de 15 minutos alerta daqui, no máximo um a cada 15 minutos.
    SELECT count(*) INTO v_parados FROM aviso_de_mensagem
     WHERE estado IN ('enviando', 'repetir')
       AND proxima_em < now() - interval '15 minutes';
    IF v_parados > 0 AND NOT EXISTS (
        SELECT 1 FROM qr_message_log
         WHERE action = 'webhook_dead'
           AND baileys_result->>'route' = 'aviso-webhook-parado'
           AND created_at > now() - interval '15 minutes'
    ) THEN
        INSERT INTO qr_message_log (to_jid, action, success, error, baileys_result)
        VALUES ('aviso-webhook', 'webhook_dead', false,
                format('%s aviso(s) de webhook vencidos há mais de 15 min: a repetição (edge aviso-repetir) não está rodando', v_parados),
                jsonb_build_object('route', 'aviso-webhook-parado'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM aviso_de_mensagem
         WHERE estado IN ('enviando', 'repetir')
           AND proxima_em <= now()
    ) THEN
        RETURN;
    END IF;

    BEGIN
        v_service_key := public._segredo_obrigatorio('service_role_key');
        v_project_url := public._segredo_obrigatorio('project_url');
    EXCEPTION WHEN SQLSTATE '55000' THEN
        RAISE WARNING 'aviso_de_mensagem_repetir: % (repetição não disparada)', SQLERRM;
        RETURN;
    END;

    PERFORM net.http_post(
        url     := v_project_url || '/functions/v1/aviso-repetir',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
        body    := '{}'::jsonb
    );
END;
$$;

CREATE OR REPLACE FUNCTION "public"."backfill_conversations_last_message"("p_batch" integer DEFAULT 1000) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT c.id
      FROM public.conversations c
     WHERE c.last_message_direction IS NULL
       AND EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = c.id)
     ORDER BY c.id
     LIMIT p_batch
  LOOP
    PERFORM public.conversation_refresh_last_message(r.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."br_phone_key"("phone" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE STRICT PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
    SELECT CASE
             WHEN phone LIKE 'ig:%' THEN NULL
             -- 55 + DDD + 9 + 8 dígitos: a guarda do 5º dígito é a do getLookupVariations.
             WHEN length(d) = 13 AND left(d, 2) = '55' AND substring(d, 5, 1) = '9'
               THEN '55' || substring(d, 3, 2) || substring(d, 6)
             -- 55 + DDD + 8 dígitos.
             WHEN length(d) = 12 AND left(d, 2) = '55'
               THEN '55' || substring(d, 3, 2) || substring(d, 5)
           END
    FROM (SELECT pg_catalog.regexp_replace(phone, '\D', '', 'g') AS d) AS s
$$;

COMMENT ON FUNCTION "public"."br_phone_key"("phone" "text") IS 'Chave 55+DDD+8 dígitos de celular BR (12 ou 13 dígitos; 13 só com 9 no 5º dígito), NULL fora disso e para ig:. Par de extract_br_phone_parts + guarda de getLookupVariations (src/lib/phone.ts). Usada por conversations.br_phone_key.';

CREATE OR REPLACE FUNCTION "public"."broadcast_counts_on_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    IF (TG_OP = 'UPDATE') THEN
        UPDATE public.broadcasts
        SET sent_count = sent_count
                - CASE WHEN OLD.status = 'sent' THEN 1 ELSE 0 END
                + CASE WHEN NEW.status = 'sent' THEN 1 ELSE 0 END,
            failed_count = failed_count
                - CASE WHEN OLD.status = 'failed' THEN 1 ELSE 0 END
                + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
            updated_at = now()
        WHERE id = NEW.broadcast_id;

    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE public.broadcasts
        SET total_recipients = GREATEST(0, total_recipients - 1),
            sent_count       = GREATEST(0, sent_count - CASE WHEN OLD.status = 'sent' THEN 1 ELSE 0 END),
            failed_count     = GREATEST(0, failed_count - CASE WHEN OLD.status = 'failed' THEN 1 ELSE 0 END),
            updated_at       = now()
        WHERE id = OLD.broadcast_id;
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."broadcast_counts_on_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    UPDATE public.broadcasts b
    SET total_recipients = b.total_recipients + agg.n,
        sent_count       = b.sent_count + agg.n_sent,
        failed_count     = b.failed_count + agg.n_failed,
        updated_at       = now()
    FROM (
        SELECT broadcast_id,
               count(*)                                        AS n,
               count(*) FILTER (WHERE status = 'sent')          AS n_sent,
               count(*) FILTER (WHERE status = 'failed')        AS n_failed
        FROM new_rows
        GROUP BY broadcast_id
    ) agg
    WHERE b.id = agg.broadcast_id;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."can_manage_phone_number"("p_phone_number_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        -- User has direct access via user_phone_numbers
        SELECT 1 FROM public.user_phone_numbers upn
        WHERE upn.user_id = auth.uid() AND upn.phone_number_id = p_phone_number_id
    ) OR EXISTS (
        -- User is member of the organization that owns this phone number (admin, agent, or member)
        SELECT 1 FROM public.phone_numbers pn
        JOIN public.organization_members om ON om.organization_id = pn.organization_id
        WHERE pn.id = p_phone_number_id
          AND om.user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION "public"."cancel_broadcast"("p_broadcast_id" "uuid", "p_organization_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    c_chunk         constant integer := 500;
    v_status        text;
    v_drained       integer := 0;
    v_chunk_drained integer;
BEGIN
    -- FOR UPDATE serializa contra o worker: enquanto esta transação corre, a
    -- entrada de broadcast-execute (que escreve 'processing') fica bloqueada,
    -- então ela lê o 'cancelled' já gravado e o `.neq('status','cancelled')`
    -- dela transforma o write em no-op.
    SELECT status INTO v_status
    FROM public.broadcasts
    WHERE id = p_broadcast_id
      AND organization_id = p_organization_id
    FOR UPDATE;

    IF v_status IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;

    IF v_status NOT IN ('draft', 'scheduled', 'processing') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'not_cancellable',
            'status', v_status
        );
    END IF;

    -- Drena a fila em lotes. 'failed' porque o CHECK não tem 'cancelled' e
    -- inventar o estado aqui exigiria drop+add do constraint mais uma revisão
    -- de todo consumidor de status de recipient; error_message carrega a
    -- distinção. coalesce preserva o erro real de quem já tinha falhado antes.
    LOOP
        WITH batch AS (
            SELECT id
            FROM public.broadcast_recipients
            WHERE broadcast_id = p_broadcast_id
              AND status IN ('pending', 'sending')
            LIMIT c_chunk
        )
        UPDATE public.broadcast_recipients r
        SET status        = 'failed',
            claimed_at    = NULL,
            error_message = coalesce(r.error_message, 'Disparo cancelado')
        FROM batch
        WHERE r.id = batch.id;

        GET DIAGNOSTICS v_chunk_drained = ROW_COUNT;
        v_drained := v_drained + v_chunk_drained;
        EXIT WHEN v_chunk_drained < c_chunk;
    END LOOP;

    UPDATE public.broadcasts
    SET status       = 'cancelled',
        completed_at = coalesce(completed_at, now()),
        updated_at   = now()
    WHERE id = p_broadcast_id;

    RETURN jsonb_build_object(
        'ok', true,
        'drained', v_drained,
        'previous_status', v_status
    );
END;
$$;

COMMENT ON FUNCTION "public"."cancel_broadcast"("p_broadcast_id" "uuid", "p_organization_id" "uuid") IS 'Cancela um disparo DRENANDO a fila (pending/sending -> failed) na mesma transação. Só a drenagem para o motor: com zero linhas claimáveis o worker sai do loop. Escopo de tenant por parâmetro, para uso com client service-role.';

CREATE OR REPLACE FUNCTION "public"."check_and_update_auto_reply_cooldown"("p_conversation_id" "uuid", "p_cooldown_minutes" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_updated_id UUID;
BEGIN
  -- Attempt to update the conversation ONLY if cooldown has passed
  UPDATE public.conversations
  SET last_auto_reply_at = NOW()
  WHERE id = p_conversation_id
  AND (
    last_auto_reply_at IS NULL 
    OR 
    last_auto_reply_at < (NOW() - (p_cooldown_minutes || ' minutes')::INTERVAL)
  )
  RETURNING id INTO v_updated_id;

  -- If an update happened, it means we should send the reply
  IF v_updated_id IS NOT NULL THEN
    RETURN TRUE;
  ELSE
    RETURN FALSE;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."check_message_failure_alerts"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_window   constant interval := interval '5 minutes';
    v_cooldown constant interval := interval '30 minutes';
    -- Rotas cujo payload aponta para uma mensagem anterior: 404 é rotina.
    v_derived_routes constant text[] := ARRAY[
        'qr-delivery-update', 'qr-message-receipt', 'qr-message-deleted', 'qr-message-edited',
        'qr-reaction', 'qr-poll-vote'];
    v_derived_floor constant integer := 15;
    v_undec_floor   constant integer := 5;
    v_hard    integer;
    v_undec   integer;
    v_derived integer;
    v_count   integer;
    v_state system_alert_state;
    v_key text;
    v_url text;
BEGIN
    SELECT count(*) INTO v_hard
    FROM qr_message_log
    WHERE created_at > now() - v_window
      AND (
        action IN ('msg_write_failed', 'msg_write_degraded', 'msg_payload_invalid',
                   'msg_handler_throw', 'msg_drop_unhandled', 'webhook_spilled')
        OR action LIKE 'handler_throw%'
        -- Rota de ingestão, desconhecida ou ausente: falha alto, a partir de 1.
        OR (action = 'webhook_dead'
            AND coalesce(baileys_result->>'route', '') <> ALL (v_derived_routes))
      );

    SELECT count(*) INTO v_derived
    FROM qr_message_log
    WHERE created_at > now() - v_window
      AND action = 'webhook_dead'
      AND baileys_result->>'route' = ANY (v_derived_routes);

    -- DISTINCT: o mesmo wamid reaparece por retry do Baileys e por sessão
    -- espelhada. O que importa é quantas MENSAGENS não decifraram.
    SELECT count(DISTINCT message_id) INTO v_undec
    FROM qr_message_log
    WHERE created_at > now() - v_window
      AND action = 'msg_drop_undecrypted'
      AND coalesce(to_jid, '') NOT LIKE '%@newsletter';

    v_count := v_hard
             + CASE WHEN v_undec   >= v_undec_floor   THEN v_undec   ELSE 0 END
             + CASE WHEN v_derived >= v_derived_floor THEN v_derived ELSE 0 END;

    SELECT * INTO v_state FROM system_alert_state WHERE alert_key = 'message_pipeline_failure';

    IF v_count = 0 THEN
        IF v_state.active_since IS NOT NULL
           AND v_state.last_seen_at IS NOT NULL
           AND v_state.last_seen_at < now() - v_cooldown THEN
            UPDATE system_alert_state SET active_since = NULL, updated_at = now()
             WHERE alert_key = 'message_pipeline_failure';
        END IF;
        RETURN;
    END IF;

    IF v_state.snoozed_until IS NOT NULL AND v_state.snoozed_until > now() THEN
        RETURN;
    END IF;

    INSERT INTO system_alert_state AS s
        (alert_key, active_since, last_seen_at, last_window_count)
    VALUES ('message_pipeline_failure', now(), now(), v_count)
    ON CONFLICT (alert_key) DO UPDATE
       SET last_seen_at      = now(),
           last_window_count = EXCLUDED.last_window_count,
           active_since      = COALESCE(s.active_since, now()),
           updated_at        = now();

    IF v_state.last_notified_at IS NULL OR v_state.last_notified_at < now() - v_cooldown THEN
        BEGIN
            v_key := public._segredo_obrigatorio('service_role_key');
            v_url := public._segredo_obrigatorio('project_url');
        EXCEPTION WHEN SQLSTATE '55000' THEN
            RAISE WARNING 'check_message_failure_alerts: % (notificação não enviada)', SQLERRM;
            RETURN;
        END;

        PERFORM net.http_post(
            url     := v_url || '/functions/v1/send-failure-alert',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || v_key),
            body    := jsonb_build_object(
                'alert_key', 'message_pipeline_failure',
                'count', v_count,
                'window_minutes', 5));

        UPDATE system_alert_state SET last_notified_at = now(), updated_at = now()
         WHERE alert_key = 'message_pipeline_failure';
    END IF;
END;
$$;

COMMENT ON FUNCTION "public"."check_message_failure_alerts"() IS 'Detector de falha do pipeline de mensagens (cron 1 min, janela 5 min). Notifica por e-mail (FAILURE_ALERT_EMAILS) + push, cooldown 30 min, snooze via snooze_system_alert(). Não escreve em system_alerts. webhook_dead em rota derivada (delivery-update, message-receipt, message-deleted, message-edited, reaction, poll-vote) só conta acima de 15 na janela — 404 nessas rotas é mensagem que o Echo nunca gravou, não perda; em qr-message/qr-group-event e em rota desconhecida conta a partir de 1. msg_drop_undecrypted conta wamids DISTINTOS (o mesmo wamid reaparece por retry do Baileys e por sessão espelhada) e ignora @newsletter (canal não decifra por PDO).';

CREATE OR REPLACE FUNCTION "public"."check_qr_service_health"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    -- Tolera um deploy/restart (o serviço leva ~40s para responder de novo).
    c_unreachable_floor constant integer := 3;
    -- Uma drenagem normal nunca fica 5 ciclos sem entregar nada; um stall, sim.
    c_stalled_floor     constant integer := 5;
    -- O normal é 0 em disco; acima do piso é acúmulo real.
    c_disk_floor        constant integer := 100;
    c_cooldown          constant interval := interval '30 minutes';
    c_probe_timeout     constant interval := interval '90 seconds';

    v_probe        public.qr_health_probe;
    v_resp         record;
    v_health       jsonb;
    v_verdict      boolean := false;  -- houve veredito neste tick?
    v_reachable    boolean := false;
    v_unreachable  integer;
    v_stalled      integer;
    v_disk         integer := 0;
    v_oldest       integer;
    v_new_request  bigint;

    v_url          text;
    v_key          text;
    v_qr_url       text;
    v_title        text;
    v_summary      text;
    v_details      jsonb;
    v_hint         text;
    v_last_notified timestamptz;
    v_snoozed      timestamptz;
begin
    select * into v_probe from public.qr_health_probe where id;
    if not found then
        insert into public.qr_health_probe (id) values (true)
        on conflict (id) do nothing;
        select * into v_probe from public.qr_health_probe where id;
    end if;

    -- ----- Fase 1: colher a resposta do tick anterior -----
    if v_probe.request_id is not null then
        select status_code, content, timed_out into v_resp
          from net._http_response where id = v_probe.request_id;

        if found then
            v_verdict := true;
            if v_resp.status_code = 200 and coalesce(v_resp.timed_out, false) = false then
                begin
                    v_health := v_resp.content::jsonb;
                    v_reachable := true;
                exception when others then
                    v_reachable := false;  -- 200 com corpo que não é JSON
                end;
            end if;
            delete from net._http_response where id = v_probe.request_id;
        elsif v_probe.requested_at < now() - c_probe_timeout then
            -- A resposta nunca chegou: conta como inacessível.
            v_verdict := true;
        else
            -- Ainda em voo. Não dispara outro probe: perderia o request_id.
            return;
        end if;
    end if;

    v_unreachable := v_probe.consecutive_unreachable;
    v_stalled     := v_probe.consecutive_stalled;

    if v_verdict then
        if v_reachable then
            v_unreachable := 0;
            v_disk   := coalesce((v_health->>'outbox_disk')::integer, 0);
            v_oldest := (v_health->>'outbox_oldest_disk_age_s')::integer;
            -- outbox_stalled só existe em versões recentes do serviço; em versão anterior o
            -- campo vem nulo e o detector cai para os outros dois sinais.
            if coalesce((v_health->>'outbox_stalled')::boolean, false) then
                v_stalled := v_stalled + 1;
            else
                v_stalled := 0;
            end if;
        else
            v_unreachable := v_unreachable + 1;
        end if;
    end if;

    -- ----- Fase 2: disparar o próximo probe -----
    v_qr_url := public._segredo_obrigatorio('qr_service_url');

    select net.http_get(url := v_qr_url || '/health', timeout_milliseconds := 8000)
      into v_new_request;

    update public.qr_health_probe
       set request_id = v_new_request,
           requested_at = now(),
           last_ok_at = case when v_reachable then now() else last_ok_at end,
           last_health = coalesce(v_health, last_health),
           consecutive_unreachable = v_unreachable,
           consecutive_stalled = v_stalled,
           updated_at = now()
     where id;

    -- ----- Fase 3: decidir se alerta -----
    if v_unreachable >= c_unreachable_floor then
        v_title := 'qr-service inacessível';
        v_summary := format(
            'O /health do qr-service não responde há %s tentativa(s) seguida(s), ~%s minuto(s). '
            || 'Enquanto isso nenhuma mensagem do WhatsApp entra ou sai do Echo.',
            v_unreachable, v_unreachable);
        v_details := jsonb_build_array(
            jsonb_build_object('label', 'Tentativas sem resposta', 'value', v_unreachable::text),
            jsonb_build_object('label', 'Última resposta boa',
                'value', coalesce(to_char(v_probe.last_ok_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nenhuma registrada')));
        v_hint := 'curl -s ' || v_qr_url || '/health';

    elsif v_stalled >= c_stalled_floor then
        v_title := 'Fila do qr-service represada';
        v_summary := format(
            'A fila de disco do outbox parou de andar há %s ciclos (~%s min): a edge recusa o arquivo '
            || 'da frente e nada atrás dele passa. Eventos de mensagem estão ficando fora do Echo.',
            v_stalled, v_stalled);
        v_details := jsonb_build_array(
            jsonb_build_object('label', 'Arquivos em disco', 'value', v_disk::text),
            jsonb_build_object('label', 'Mais antigo (h)', 'value', coalesce(round(v_oldest / 3600.0, 1)::text, '—')),
            jsonb_build_object('label', 'Ciclos represados', 'value', v_stalled::text));
        v_hint := 'curl -s ' || v_qr_url || '/health  # outbox_stalled, outbox_disk';

    elsif v_disk > c_disk_floor then
        v_title := 'Fila do qr-service acumulando';
        v_summary := format(
            'O outbox tem %s arquivo(s) em disco (normal é 0). A fila ainda anda, mas está entrando '
            || 'evento mais rápido do que sai — ou a edge está lenta.', v_disk);
        v_details := jsonb_build_array(
            jsonb_build_object('label', 'Arquivos em disco', 'value', v_disk::text),
            jsonb_build_object('label', 'Mais antigo (h)', 'value', coalesce(round(v_oldest / 3600.0, 1)::text, '—')));
        v_hint := 'curl -s ' || v_qr_url || '/health';

    else
        -- Saudável: solta o alerta para que a próxima ocorrência notifique na hora.
        update public.system_alert_state
           set active_since = null, last_window_count = 0, updated_at = now()
         where alert_key = 'qr_service_health' and active_since is not null;
        return;
    end if;

    -- ----- Fase 4: cooldown e envio -----
    select last_notified_at, snoozed_until into v_last_notified, v_snoozed
      from public.system_alert_state where alert_key = 'qr_service_health';

    insert into public.system_alert_state (alert_key, active_since, last_seen_at, last_window_count, updated_at)
    values ('qr_service_health', now(), now(), greatest(v_unreachable, v_stalled), now())
    on conflict (alert_key) do update
        set active_since = coalesce(public.system_alert_state.active_since, now()),
            last_seen_at = now(),
            last_window_count = greatest(v_unreachable, v_stalled),
            updated_at = now();

    if coalesce(v_snoozed, '-infinity'::timestamptz) > now() then
        return;
    end if;
    if v_last_notified is not null and v_last_notified > now() - c_cooldown then
        return;
    end if;

    BEGIN
        v_key := public._segredo_obrigatorio('service_role_key');
        v_url := public._segredo_obrigatorio('project_url');
    EXCEPTION WHEN SQLSTATE '55000' THEN
        RAISE WARNING 'check_qr_service_health: % (notificação não enviada)', SQLERRM;
        RETURN;
    END;

    perform net.http_post(
        url     := v_url || '/functions/v1/send-failure-alert',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key),
        body    := jsonb_build_object(
            'alert_key', 'qr_service_health',
            'count', greatest(v_unreachable, v_stalled, v_disk),
            'window_minutes', 5,
            'title', v_title,
            'summary', v_summary,
            'details', v_details,
            'hint', v_hint));

    update public.system_alert_state
       set last_notified_at = now(), updated_at = now()
     where alert_key = 'qr_service_health';
end;
$$;

COMMENT ON FUNCTION "public"."check_qr_service_health"() IS 'Health-check outside-in do qr-service: alerta quando o serviço não responde, quando a fila de disco do outbox trava e quando ela acumula. Roda a cada minuto pelo cron qr-service-health.';

CREATE TABLE IF NOT EXISTS "public"."broadcast_recipients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "broadcast_id" "uuid" NOT NULL,
    "phone_number" "text" NOT NULL,
    "contact_name" "text",
    "variables" "jsonb" DEFAULT '[]'::"jsonb",
    "status" "text" DEFAULT 'pending'::"text",
    "whatsapp_message_id" "text",
    "error_message" "text",
    "sent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "attempts" integer DEFAULT 0 NOT NULL,
    "claimed_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "broadcast_recipients_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sending'::"text", 'sent'::"text", 'failed'::"text"])))
);

COMMENT ON COLUMN "public"."broadcast_recipients"."attempts" IS 'Number of times this row has been claimed by a worker. Used to stop retrying a row forever.';

COMMENT ON COLUMN "public"."broadcast_recipients"."claimed_at" IS 'When a worker claimed this row. The watchdog uses THIS (never broadcasts.updated_at, which late Meta status callbacks keep touching) to detect abandoned work.';

CREATE OR REPLACE FUNCTION "public"."claim_broadcast_batch"("p_broadcast_id" "uuid", "p_limit" integer DEFAULT 25) RETURNS SETOF "public"."broadcast_recipients"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    RETURN QUERY
    UPDATE public.broadcast_recipients r
    SET status     = 'sending',
        claimed_at = now(),
        attempts   = r.attempts + 1
    WHERE r.id IN (
        SELECT c.id
        FROM public.broadcast_recipients c
        WHERE c.broadcast_id = p_broadcast_id
          AND c.status = 'pending'
        ORDER BY c.created_at, c.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    )
    RETURNING r.*;
END;
$$;

COMMENT ON FUNCTION "public"."claim_broadcast_batch"("p_broadcast_id" "uuid", "p_limit" integer) IS 'Atomically claim up to p_limit pending recipients, flipping them to sending. Safe under concurrency via FOR UPDATE SKIP LOCKED.';

CREATE OR REPLACE FUNCTION "public"."close_inactive_conversations"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_idle_ttl     CONSTANT interval := interval '30 days';
    healed         integer;
    closed         integer;
    skipped_tagged integer;
BEGIN
    -- 0. Autocura do relógio das candidatas (só avança).
    UPDATE conversations c
       SET last_message_at = lm.real_last
      FROM (
          SELECT c2.id,
                 (SELECT max(m.created_at)
                    FROM messages m
                   WHERE m.conversation_id = c2.id
                     AND m.message_type IS DISTINCT FROM 'group_action') AS real_last
            FROM conversations c2
           WHERE c2.status = 'active'
             AND c2.last_message_at < now() - v_idle_ttl
      ) lm
     WHERE c.id = lm.id
       AND lm.real_last > c.last_message_at;
    GET DIAGNOSTICS healed = ROW_COUNT;

    -- Só para acompanhamento: quantas a tag poupou nesta rodada.
    SELECT count(*) INTO skipped_tagged
      FROM conversations c
     WHERE c.status = 'active'
       AND c.last_message_at < now() - v_idle_ttl
       AND EXISTS (SELECT 1 FROM conversation_tags t WHERE t.conversation_id = c.id);

    -- 1. Encerra as inativas sem tag. closed_by fica NULL = fechada pelo sistema.
    UPDATE conversations c
       SET status       = 'closed',
           close_reason = 'Conversa Inativa',
           closed_at    = now(),
           updated_at   = now()
     WHERE c.status = 'active'
       AND c.last_message_at < now() - v_idle_ttl
       AND NOT EXISTS (SELECT 1 FROM conversation_tags t WHERE t.conversation_id = c.id);
    GET DIAGNOSTICS closed = ROW_COUNT;

    RAISE NOTICE 'close_inactive_conversations: relógio corrigido=% | encerradas=% | poupadas por tag=%',
        healed, closed, skipped_tagged;
END;
$$;

COMMENT ON FUNCTION "public"."close_inactive_conversations"() IS 'Cron diário (00:00 UTC). Corrige last_message_at das candidatas pela última mensagem real (sem group_action) e encerra as active ociosas há 30 dias, qualquer source, exceto conversas com tag.';

CREATE OR REPLACE FUNCTION "public"."conversa_do_telefone_na_linha"("p_phone_number_id" "uuid", "p_telefone" "text") RETURNS TABLE("conversation_id" "uuid", "visivel" boolean, "dono" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  WITH v AS (
    SELECT public.phone_lookup_variations(p_telefone) AS variacoes
  ),
  achada AS (
    SELECT c.id,
           (SELECT public.auth_is_super_admin()) OR public.user_can_access_conversation(c.id) AS visivel,
           NULLIF(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') AS dono
      FROM v
      JOIN public.conversations c
        ON c.phone_number_id = p_phone_number_id
       AND c.is_group = false
       AND c.contact_phone = ANY (v.variacoes)
      LEFT JOIN public.profiles p ON p.id = c.assigned_to
     WHERE (SELECT public.auth_is_super_admin())
        OR p_phone_number_id = ANY ((SELECT public.get_my_conversation_phone_ids())::uuid[])
     ORDER BY array_position(v.variacoes, c.contact_phone), c.created_at
     LIMIT 1
  )
  SELECT CASE WHEN achada.visivel THEN achada.id END, achada.visivel, achada.dono
    FROM achada;
$$;

CREATE OR REPLACE FUNCTION "public"."conversation_refresh_last_message"("p_conversation_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_content    text;
  v_type       text;
  v_direction  text;
  v_is_deleted boolean;
  v_changed    integer;
BEGIN
  -- Lock da conversa ANTES do probe. É o mesmo row lock que o UPDATE abaixo
  -- tomaria; antecipá-lo serializa dois inserts concorrentes na mesma
  -- conversa: sem isso, o segundo faz o probe antes do commit do primeiro,
  -- espera no lock e depois grava a prévia da mensagem ERRADA (READ COMMITTED
  -- reavalia o WHERE, não os valores já calculados).
  PERFORM 1 FROM public.conversations WHERE id = p_conversation_id FOR UPDATE;

  SELECT left(m.content, 200), m.message_type, m.direction, m.is_deleted
    INTO v_content, v_type, v_direction, v_is_deleted
    FROM public.messages m
   WHERE m.conversation_id = p_conversation_id
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1;
  -- Sem mensagem: as variáveis ficam NULL e a conversa é limpa.

  UPDATE public.conversations c
     SET last_message_content    = v_content,
         last_message_type       = v_type,
         last_message_direction  = v_direction,
         last_message_is_deleted = v_is_deleted
   WHERE c.id = p_conversation_id
     AND (c.last_message_content, c.last_message_type, c.last_message_direction, c.last_message_is_deleted)
         IS DISTINCT FROM (v_content, v_type, v_direction, v_is_deleted);
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed > 0;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."create_onboarding_organization"("p_name" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id UUID;
  v_org_id UUID;
  v_slug TEXT;
BEGIN
  -- Get current user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Cadastro é fechado: organização nova só por super admin (a tela de super admin é a única que chama).
  IF NOT (SELECT public.auth_is_super_admin()) THEN
    RAISE EXCEPTION 'Only super admins can create organizations' USING ERRCODE = '42501';
  END IF;

  -- Validate name
  IF p_name IS NULL OR length(trim(p_name)) < 2 THEN
    RAISE EXCEPTION 'Organization name must be at least 2 characters';
  END IF;

  IF length(p_name) > 100 THEN
    RAISE EXCEPTION 'Organization name must be at most 100 characters';
  END IF;

  -- Generate unique slug
  v_slug := generate_org_slug(p_name);

  -- Create organization
  INSERT INTO public.organizations (name, slug)
  VALUES (trim(p_name), v_slug)
  RETURNING id INTO v_org_id;

  -- Add user as admin
  INSERT INTO public.organization_members (organization_id, user_id, role)
  VALUES (v_org_id, v_user_id, 'admin');

  RETURN v_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."dispatch_broadcast_work"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    -- Must match MAX_ATTEMPTS in the broadcast-execute worker.
    c_max_attempts  constant integer  := 2;
    -- A claim older than this means the worker that took it is gone. The worker's
    -- own budget is 40s, so 5 minutes is far past any healthy run.
    c_claim_ttl     constant interval := interval '5 minutes';
    -- Worker budget is 40s; don't re-dispatch inside that window.
    c_dispatch_gap  constant interval := interval '45 seconds';
    -- Ceiling on parallel workers per broadcast. Deliberately small: the worker
    -- also adapts its own internal concurrency, so this multiplies an already
    -- self-tuning rate. Raise only with evidence from the provider's throughput tier.
    c_max_workers   constant integer  := 2;

    v_service_key   text;
    v_project_url   text;
    v_rec           record;
    v_workers       integer;
    v_reclaimed     integer;
    v_abandoned     integer;
    i               integer;
BEGIN
    v_service_key := public._segredo_obrigatorio('service_role_key');
    v_project_url := public._segredo_obrigatorio('project_url');

    -- ---------------------------------------------------------------------
    -- 1. WATCHDOG
    --
    -- Staleness is judged on broadcast_recipients.claimed_at, NEVER on
    -- broadcasts.updated_at: late Meta delivery callbacks keep touching the
    -- parent row for hours after the engine has died, so updated_at cannot tell
    -- "alive" from "dead since yesterday".
    -- ---------------------------------------------------------------------
    UPDATE public.broadcast_recipients
    SET status = 'pending', claimed_at = NULL
    WHERE status = 'sending'
      AND claimed_at < now() - c_claim_ttl
      AND attempts < c_max_attempts;
    GET DIAGNOSTICS v_reclaimed = ROW_COUNT;

    -- Out of attempts. Fail explicitly instead of retrying: the message may well
    -- have been delivered (and charged) before the worker vanished, and sending
    -- it again is worse than reporting it.
    UPDATE public.broadcast_recipients
    SET status        = 'failed',
        claimed_at    = NULL,
        error_message = coalesce(error_message, 'Envio abandonado após ' || c_max_attempts || ' tentativas: status de entrega desconhecido')
    WHERE status = 'sending'
      AND claimed_at < now() - c_claim_ttl
      AND attempts >= c_max_attempts;
    GET DIAGNOSTICS v_abandoned = ROW_COUNT;

    IF v_reclaimed > 0 OR v_abandoned > 0 THEN
        RAISE LOG 'dispatch_broadcast_work: reclaimed % abandoned claim(s), gave up on %.', v_reclaimed, v_abandoned;
    END IF;

    -- ---------------------------------------------------------------------
    -- 2. FINALIZER
    --
    -- A broadcast with nothing pending and nothing in flight is finished. This
    -- is the safety net that makes the terminal state independent of any single
    -- invocation surviving to write it -- the failure mode where a finished
    -- broadcast stayed in 'processing' forever.
    --
    -- 'sending' is included in the NOT EXISTS so an actively-running batch is
    -- never mistaken for a finished campaign.
    -- ---------------------------------------------------------------------
    UPDATE public.broadcasts b
    SET status = CASE
                     WHEN b.sent_count = 0 AND b.failed_count > 0 THEN 'failed'
                     ELSE 'completed'
                 END,
        completed_at = coalesce(b.completed_at, now()),
        updated_at   = now()
    WHERE b.status = 'processing'
      AND NOT EXISTS (
          SELECT 1 FROM public.broadcast_recipients r
          WHERE r.broadcast_id = b.id
            AND r.status IN ('pending', 'sending')
      );

    -- ---------------------------------------------------------------------
    -- 3. DRIVER
    -- ---------------------------------------------------------------------
    FOR v_rec IN
        SELECT b.id,
               b.throttled_at,
               count(r.id) AS pending
        FROM public.broadcasts b
        JOIN public.broadcast_recipients r
          ON r.broadcast_id = b.id AND r.status = 'pending'
        WHERE b.status = 'processing'
          AND (b.last_dispatch_at IS NULL OR b.last_dispatch_at < now() - c_dispatch_gap)
        GROUP BY b.id, b.throttled_at
        ORDER BY b.started_at NULLS FIRST
        LIMIT 10
    LOOP
        -- Adaptive, capped. Recent throttling pins us to a single worker; otherwise
        -- scale with the size of the backlog, never past the ceiling.
        IF v_rec.throttled_at IS NOT NULL AND v_rec.throttled_at > now() - interval '2 minutes' THEN
            v_workers := 1;
        ELSE
            v_workers := LEAST(c_max_workers, GREATEST(1, ceil(v_rec.pending / 1000.0)::integer));
        END IF;

        FOR i IN 1..v_workers LOOP
            PERFORM net.http_post(
                url     := v_project_url || '/functions/v1/broadcast-execute',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'Authorization', 'Bearer ' || v_service_key
                ),
                body    := jsonb_build_object('broadcastId', v_rec.id)
            );
        END LOOP;

        UPDATE public.broadcasts
        SET last_dispatch_at = now()
        WHERE id = v_rec.id;

        RAISE LOG 'dispatch_broadcast_work: dispatched % worker(s) for broadcast % (% pending).',
                  v_workers, v_rec.id, v_rec.pending;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION "public"."dispatch_broadcast_work"() IS 'Runs every minute. Reclaims abandoned recipient claims, finalizes broadcasts with no work left, and dispatches broadcast-execute workers for those that still have pending recipients. This is what makes a broadcast survive a closed browser tab.';

CREATE OR REPLACE FUNCTION "public"."enforce_user_stickers_cap"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if (select count(*) from public.user_stickers where user_id = new.user_id) >= 200 then
    raise exception 'sticker collection limit reached (200)'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

COMMENT ON FUNCTION "public"."enforce_user_stickers_cap"() IS 'Limita a coleção a 200 stickers por usuário (BEFORE INSERT em user_stickers)';

CREATE OR REPLACE FUNCTION "public"."extract_br_phone_parts"("phone" "text") RETURNS TABLE("country" "text", "ddd" "text", "local_number" "text", "has_nine" boolean)
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
DECLARE
  digits text;
  len int;
BEGIN
  digits := regexp_replace(phone, '\D', '', 'g');
  len := length(digits);

  -- 55 + DDD + 9 + 8 digits = 13 chars (e.g., 5511999990001)
  IF len = 13 AND digits LIKE '55%' THEN
    country := '55';
    ddd := substring(digits, 3, 2);
    local_number := substring(digits, 6); -- 8 digits after the 9
    has_nine := true;
    RETURN NEXT;
  -- 55 + DDD + 8 digits = 12 chars (e.g., 551199990001)
  ELSIF len = 12 AND digits LIKE '55%' THEN
    country := '55';
    ddd := substring(digits, 3, 2);
    local_number := substring(digits, 5); -- 8 digits
    has_nine := false;
    RETURN NEXT;
  -- DDD + 9 + 8 digits = 11 chars (e.g., 11999990001)
  ELSIF len = 11 AND digits NOT LIKE '55%' THEN
    country := NULL;
    ddd := substring(digits, 1, 2);
    local_number := substring(digits, 4); -- 8 digits after the 9
    has_nine := true;
    RETURN NEXT;
  -- DDD + 8 digits = 10 chars (e.g., 1199990001)
  ELSIF len = 10 AND digits NOT LIKE '55%' THEN
    country := NULL;
    ddd := substring(digits, 1, 2);
    local_number := substring(digits, 3); -- 8 digits
    has_nine := false;
    RETURN NEXT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."generate_org_slug"("p_name" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  base_slug TEXT;
  final_slug TEXT;
  counter INT := 0;
BEGIN
  -- Convert to lowercase, replace spaces with hyphens, remove special chars
  base_slug := lower(regexp_replace(p_name, '[^a-zA-Z0-9\s]', '', 'g'));
  base_slug := regexp_replace(base_slug, '\s+', '-', 'g');
  base_slug := substring(base_slug from 1 for 50);

  -- Try base slug first
  final_slug := base_slug;

  -- Add counter if slug exists
  WHILE EXISTS (SELECT 1 FROM public.organizations WHERE slug = final_slug) LOOP
    counter := counter + 1;
    final_slug := base_slug || '-' || counter;
  END LOOP;

  RETURN final_slug;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_advanced_analytics_stats"("p_org_id" "uuid", "p_start_date" timestamp with time zone DEFAULT (("now"() AT TIME ZONE 'America/Sao_Paulo'::"text") - '30 days'::interval), "p_end_date" timestamp with time zone DEFAULT ("now"() AT TIME ZONE 'America/Sao_Paulo'::"text"), "p_phone_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_sector_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_agent_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("total_sent" bigint, "total_delivered" bigint, "total_read" bigint, "total_failed" bigint, "unique_responses" bigint, "total_cost" numeric, "avg_cost_per_msg" numeric, "total_template_messages" bigint, "total_api_messages" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
    v_total_cost NUMERIC;
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);
    -- Org/WABA-level cost from Meta (not attributable per agent/sector).
    SELECT COALESCE(SUM(adm.total_cost), 0)
    INTO v_total_cost
    FROM analytics_daily_metrics adm
    WHERE adm.organization_id = p_org_id
      AND adm.date BETWEEN p_start_date::DATE AND p_end_date::DATE;

    RETURN QUERY
    WITH filtered_conversations AS (
        SELECT c.id AS conv_id, pn.connection_type AS conn_type
        FROM conversations c
        JOIN phone_numbers pn ON c.phone_number_id = pn.id
        WHERE pn.organization_id = p_org_id
          AND (p_phone_ids IS NULL OR pn.id = ANY(p_phone_ids))
    ),
    filtered_agents AS (
        SELECT om.user_id
        FROM organization_members om
        WHERE om.organization_id = p_org_id
          AND (p_sector_ids IS NULL OR om.sector_id = ANY(p_sector_ids))
          AND (p_agent_ids IS NULL OR om.user_id = ANY(p_agent_ids))
    ),
    filtered_messages AS (
        SELECT m.*, fc.conn_type
        FROM messages m
        JOIN filtered_conversations fc ON m.conversation_id = fc.conv_id
        WHERE m.created_at BETWEEN p_start_date AND p_end_date
          AND (
            (p_agent_ids IS NULL AND p_sector_ids IS NULL)
            OR m.sent_by IN (SELECT user_id FROM filtered_agents)
            OR m.direction = 'inbound'
          )
    )
    SELECT
        COALESCE(COUNT(*) FILTER (WHERE direction = 'outbound'), 0)::BIGINT AS total_sent,

        COALESCE(COUNT(*) FILTER (WHERE direction = 'outbound' AND (status = 'delivered' OR status = 'read')), 0)::BIGINT AS total_delivered,

        COALESCE(COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'read'), 0)::BIGINT AS total_read,

        COALESCE(COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'failed'), 0)::BIGINT AS total_failed,

        COALESCE(COUNT(DISTINCT conversation_id) FILTER (WHERE direction = 'inbound'), 0)::BIGINT AS unique_responses,

        v_total_cost AS total_cost,

        CASE
            WHEN COUNT(*) FILTER (WHERE direction = 'outbound' AND (status = 'delivered' OR status = 'read')) > 0
            THEN (v_total_cost / COUNT(*) FILTER (WHERE direction = 'outbound' AND (status = 'delivered' OR status = 'read')))::NUMERIC
            ELSE 0
        END AS avg_cost_per_msg,

        -- Template messages (delivered/read)
        COALESCE(COUNT(*) FILTER (WHERE direction = 'outbound' AND message_type = 'template' AND (status = 'delivered' OR status = 'read')), 0)::BIGINT AS total_template_messages,

        -- Billable API messages: outbound, non-template, sent ONLY from official Cloud API numbers.
        -- Direct do Instagram numa linha API não passa pela API do WhatsApp.
        COALESCE(COUNT(*) FILTER (WHERE direction = 'outbound' AND message_type <> 'template' AND conn_type = 'business_api'
                                   AND coalesce(metadata->>'canal', 'whatsapp') <> 'instagram'), 0)::BIGINT AS total_api_messages

    FROM filtered_messages;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_agent_detailed_stats"("p_org_id" "uuid", "p_start_date" timestamp with time zone DEFAULT (("now"() AT TIME ZONE 'America/Sao_Paulo'::"text") - '30 days'::interval), "p_end_date" timestamp with time zone DEFAULT ("now"() AT TIME ZONE 'America/Sao_Paulo'::"text"), "p_phone_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_sector_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_agent_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("agent_id" "uuid", "agent_name" "text", "agent_email" "text", "sector_name" "text", "messages_sent" bigint, "conversations_handled" bigint, "avg_response_time_seconds" numeric, "current_open_conversations" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);
  RETURN QUERY
  WITH filtered_conversations AS (
    SELECT c.id AS conv_id, c.assigned_to, c.status
    FROM conversations c
    JOIN phone_numbers pn ON c.phone_number_id = pn.id
    WHERE pn.organization_id = p_org_id
      AND (p_phone_ids IS NULL OR pn.id = ANY(p_phone_ids))
  ),
  filtered_agents AS (
    SELECT om.user_id, om.sector_id
    FROM organization_members om
    WHERE om.organization_id = p_org_id
      AND (p_sector_ids IS NULL OR om.sector_id = ANY(p_sector_ids))
      AND (p_agent_ids IS NULL OR om.user_id = ANY(p_agent_ids))
  ),
  agent_messages AS (
    SELECT
      m.sent_by,
      m.conversation_id,
      m.created_at
    FROM messages m
    JOIN filtered_conversations fc ON m.conversation_id = fc.conv_id
    WHERE m.direction = 'outbound'
      AND m.sent_by IS NOT NULL
      AND m.created_at BETWEEN p_start_date AND p_end_date
      AND m.sent_by IN (SELECT user_id FROM filtered_agents)
  ),
  response_times_per_agent AS (
    SELECT
      am.sent_by,
      AVG(EXTRACT(EPOCH FROM (am.created_at - prev_inbound.created_at))) AS avg_response
    FROM agent_messages am
    LEFT JOIN LATERAL (
      SELECT m2.created_at
      FROM messages m2
      WHERE m2.conversation_id = am.conversation_id
        AND m2.direction = 'inbound'
        AND m2.created_at < am.created_at
      ORDER BY m2.created_at DESC
      LIMIT 1
    ) prev_inbound ON true
    WHERE prev_inbound.created_at IS NOT NULL
    GROUP BY am.sent_by
  ),
  current_load AS (
    SELECT
      fc.assigned_to,
      COUNT(*) AS open_count
    FROM filtered_conversations fc
    WHERE fc.status IS DISTINCT FROM 'closed'
      AND fc.assigned_to IN (SELECT user_id FROM filtered_agents)
    GROUP BY fc.assigned_to
  )
  SELECT
    p.id AS agent_id,
    p.full_name AS agent_name,
    p.email AS agent_email,
    s.name AS sector_name,
    COALESCE(COUNT(am.sent_by), 0)::BIGINT AS messages_sent,
    COALESCE(COUNT(DISTINCT am.conversation_id), 0)::BIGINT AS conversations_handled,
    COALESCE(rta.avg_response, 0)::NUMERIC AS avg_response_time_seconds,
    COALESCE(cl.open_count, 0)::BIGINT AS current_open_conversations
  FROM filtered_agents fa
  JOIN profiles p ON fa.user_id = p.id
  LEFT JOIN sectors s ON fa.sector_id = s.id
  LEFT JOIN agent_messages am ON am.sent_by = fa.user_id
  LEFT JOIN response_times_per_agent rta ON rta.sent_by = fa.user_id
  LEFT JOIN current_load cl ON cl.assigned_to = fa.user_id
  GROUP BY p.id, p.full_name, p.email, s.name, rta.avg_response, cl.open_count
  ORDER BY messages_sent DESC;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_analytics_daily_volume"("p_org_id" "uuid", "p_days" integer DEFAULT 30, "p_start_date" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_end_date" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_phone_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_sector_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_agent_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("date" "date", "inbound" bigint, "outbound" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_start_date TIMESTAMPTZ;
  v_end_date TIMESTAMPTZ;
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);
  -- Use provided dates or calculate from days
  v_end_date := COALESCE(p_end_date, NOW() AT TIME ZONE 'America/Sao_Paulo');
  v_start_date := COALESCE(p_start_date, v_end_date - (p_days || ' days')::INTERVAL);

  RETURN QUERY
  WITH filtered_conversations AS (
    SELECT c.id AS conv_id
    FROM conversations c
    JOIN phone_numbers pn ON c.phone_number_id = pn.id
    WHERE pn.organization_id = p_org_id
      AND (p_phone_ids IS NULL OR pn.id = ANY(p_phone_ids))
  ),
  filtered_agents AS (
    SELECT om.user_id
    FROM organization_members om
    WHERE om.organization_id = p_org_id
      AND (p_sector_ids IS NULL OR om.sector_id = ANY(p_sector_ids))
      AND (p_agent_ids IS NULL OR om.user_id = ANY(p_agent_ids))
  ),
  date_series AS (
    SELECT generate_series(
      v_start_date::date,
      v_end_date::date,
      '1 day'::interval
    )::date AS date
  ),
  daily_messages AS (
    SELECT 
      DATE(m.created_at AT TIME ZONE 'America/Sao_Paulo') AS msg_date,
      m.direction,
      m.sent_by
    FROM messages m
    JOIN filtered_conversations fc ON m.conversation_id = fc.conv_id
    WHERE m.created_at BETWEEN v_start_date AND v_end_date
  )
  SELECT 
    ds.date,
    COALESCE(COUNT(*) FILTER (
      WHERE dm.direction = 'inbound'
    ), 0)::BIGINT AS inbound,
    COALESCE(COUNT(*) FILTER (
      WHERE dm.direction = 'outbound'
        AND (p_agent_ids IS NULL AND p_sector_ids IS NULL OR dm.sent_by IN (SELECT user_id FROM filtered_agents))
    ), 0)::BIGINT AS outbound
  FROM date_series ds
  LEFT JOIN daily_messages dm ON dm.msg_date = ds.date
  GROUP BY ds.date
  ORDER BY ds.date ASC;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_analytics_stats"("p_org_id" "uuid", "p_start_date" timestamp with time zone DEFAULT (("now"() AT TIME ZONE 'America/Sao_Paulo'::"text") - '30 days'::interval), "p_end_date" timestamp with time zone DEFAULT ("now"() AT TIME ZONE 'America/Sao_Paulo'::"text"), "p_phone_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_sector_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_agent_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("total_inbound" bigint, "total_outbound" bigint, "total_conversations" bigint, "avg_response_time_seconds" numeric, "active_agents" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
  WITH filtered_conversations AS (
    SELECT c.id AS conv_id, c.assigned_to
    FROM conversations c
    JOIN phone_numbers pn ON c.phone_number_id = pn.id
    WHERE pn.organization_id = p_org_id
      AND (p_phone_ids IS NULL OR pn.id = ANY(p_phone_ids))
  ),
  filtered_agents AS (
    SELECT om.user_id
    FROM organization_members om
    WHERE om.organization_id = p_org_id
      AND (p_sector_ids IS NULL OR om.sector_id = ANY(p_sector_ids))
      AND (p_agent_ids IS NULL OR om.user_id = ANY(p_agent_ids))
  ),
  filtered_messages AS (
    SELECT m.*
    FROM messages m
    JOIN filtered_conversations fc ON m.conversation_id = fc.conv_id
    WHERE m.created_at BETWEEN p_start_date AND p_end_date
      AND (
        p_agent_ids IS NULL AND p_sector_ids IS NULL
        OR m.sent_by IN (SELECT user_id FROM filtered_agents)
        OR m.direction = 'inbound'
      )
  ),
  message_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE direction = 'inbound') AS inbound_count,
      COUNT(*) FILTER (WHERE direction = 'outbound') AS outbound_count
    FROM filtered_messages
  ),
  conversation_stats AS (
    SELECT COUNT(DISTINCT conv_id) AS conv_count
    FROM filtered_conversations fc
    WHERE EXISTS (
      SELECT 1 FROM filtered_messages fm WHERE fm.conversation_id = fc.conv_id
    )
  ),
  response_times AS (
    SELECT
      AVG(EXTRACT(EPOCH FROM (first_response.created_at - inbound.created_at))) AS avg_response
    FROM filtered_messages inbound
    LEFT JOIN LATERAL (
      SELECT m2.created_at
      FROM messages m2
      WHERE m2.conversation_id = inbound.conversation_id
        AND m2.direction = 'outbound'
        AND m2.created_at > inbound.created_at
      ORDER BY m2.created_at ASC
      LIMIT 1
    ) first_response ON true
    WHERE inbound.direction = 'inbound'
      AND first_response.created_at IS NOT NULL
      AND EXTRACT(EPOCH FROM (first_response.created_at - inbound.created_at)) <= 28800
  ),
  active_agent_count AS (
    SELECT COUNT(DISTINCT sent_by) AS agent_count
    FROM filtered_messages
    WHERE direction = 'outbound' AND sent_by IS NOT NULL
  )
  SELECT
    COALESCE(ms.inbound_count, 0)::BIGINT,
    COALESCE(ms.outbound_count, 0)::BIGINT,
    COALESCE(cs.conv_count, 0)::BIGINT,
    COALESCE(rt.avg_response, 0)::NUMERIC,
    COALESCE(aac.agent_count, 0)::BIGINT
  FROM message_stats ms, conversation_stats cs, response_times rt, active_agent_count aac;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_attendance_report"("p_org_id" "uuid", "p_phone_ids" "uuid"[], "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_agent_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_conversation_kind" "text" DEFAULT 'all'::"text", "p_idle_hours" integer DEFAULT 24, "p_unanswered_hours" integer DEFAULT 72, "p_business_start" time without time zone DEFAULT '08:00:00'::time without time zone, "p_business_end" time without time zone DEFAULT '18:00:00'::time without time zone, "p_business_days" integer[] DEFAULT ARRAY[1, 2, 3, 4, 5]) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_tz        CONSTANT text := 'America/Sao_Paulo';
    v_lookback  CONSTANT interval := interval '30 days';
    v_work_gap  CONSTANT interval := interval '10 minutes';
    v_msg_cost  CONSTANT interval := interval '1 minute';
    v_auto_gap  CONSTANT interval := interval '15 seconds';
    v_idle      interval;
    v_cap       interval;
    v_result    jsonb;
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);

    IF p_phone_ids IS NULL OR cardinality(p_phone_ids) = 0 THEN
        RAISE EXCEPTION 'p_phone_ids é obrigatório' USING ERRCODE = '22023';
    END IF;
    IF p_conversation_kind NOT IN ('all', 'individual', 'group') THEN
        RAISE EXCEPTION 'p_conversation_kind inválido: %', p_conversation_kind USING ERRCODE = '22023';
    END IF;
    IF p_idle_hours < 1 OR p_unanswered_hours < p_idle_hours THEN
        RAISE EXCEPTION 'janelas inválidas (idle %h, sem resposta %h)', p_idle_hours, p_unanswered_hours
            USING ERRCODE = '22023';
    END IF;

    v_idle := make_interval(hours => p_idle_hours);
    v_cap  := make_interval(hours => p_unanswered_hours);

    WITH
    lines AS (
        SELECT pn.id
        FROM phone_numbers pn
        WHERE pn.organization_id = p_org_id
          AND pn.id = ANY(p_phone_ids)
    ),
    base AS (
        SELECT
            m.id, m.conversation_id, m.created_at, m.direction, m.sent_by, m.content, m.message_type,
            lag(m.created_at) OVER w AS prev_at,
            lag(m.direction)  OVER w AS prev_dir
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        JOIN lines l ON l.id = c.phone_number_id
        WHERE m.created_at >= p_start_date - v_lookback
          AND COALESCE(m.message_type, 'text') NOT IN ('group_action', 'reaction')
          AND (
              p_conversation_kind = 'all'
              OR (p_conversation_kind = 'group' AND COALESCE(c.is_group, false))
              OR (p_conversation_kind = 'individual' AND NOT COALESCE(c.is_group, false))
          )
        WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id)
    ),
    -- Mensagem de ausência do app (ver cabeçalho, item 4)
    auto_texts AS (
        SELECT b.content
        FROM base b
        WHERE b.direction = 'outbound'
          AND b.sent_by IS NULL
          AND b.message_type = 'text'
          AND length(b.content) >= 40
          AND b.prev_dir = 'inbound'
          AND b.created_at - b.prev_at <= v_auto_gap
        GROUP BY b.content
        HAVING count(DISTINCT b.conversation_id) >= 5
    ),
    human AS (
        SELECT b.id, b.conversation_id, b.created_at, b.direction, b.sent_by,
               lag(b.created_at) OVER (PARTITION BY b.conversation_id ORDER BY b.created_at, b.id) AS prev_at
        FROM base b
        WHERE NOT (
            b.direction = 'outbound'
            AND b.sent_by IS NULL
            AND b.message_type = 'text'
            AND b.content IN (SELECT a.content FROM auto_texts a)
        )
    ),
    -- 1. blocos por silêncio
    in_block AS (
        SELECT h.*,
               sum(CASE WHEN h.prev_at IS NULL OR h.created_at - h.prev_at >= v_idle THEN 1 ELSE 0 END)
                   OVER (PARTITION BY h.conversation_id ORDER BY h.created_at, h.id) AS block_no
        FROM human h
    ),
    blocks AS (
        SELECT ib.conversation_id, ib.block_no,
               min(ib.created_at) AS block_start,
               max(ib.created_at) AS block_end,
               bool_or(ib.direction = 'outbound') AS has_out
        FROM in_block ib
        GROUP BY ib.conversation_id, ib.block_no
    ),
    -- 2. bloco só do cliente se junta ao seguinte (até o teto de espera)
    blocks_lagged AS (
        SELECT bl.*,
               lag(bl.has_out)   OVER w AS prev_has_out,
               lag(bl.block_end) OVER w AS prev_end
        FROM blocks bl
        WINDOW w AS (PARTITION BY bl.conversation_id ORDER BY bl.block_no)
    ),
    blocks_numbered AS (
        SELECT bl.conversation_id, bl.block_no,
               sum(CASE
                       WHEN bl.prev_has_out IS NULL OR bl.prev_has_out
                            OR bl.block_start - bl.prev_end >= v_cap THEN 1
                       ELSE 0
                   END) OVER (PARTITION BY bl.conversation_id ORDER BY bl.block_no) AS session_no
        FROM blocks_lagged bl
    ),
    msg_session AS (
        SELECT ib.id, ib.conversation_id, ib.created_at, ib.direction, ib.sent_by, bn.session_no
        FROM in_block ib
        JOIN blocks_numbered bn
          ON bn.conversation_id = ib.conversation_id AND bn.block_no = ib.block_no
    ),
    sessions_raw AS (
        SELECT
            ms.conversation_id, ms.session_no,
            min(ms.created_at) AS started_at,
            max(ms.created_at) AS ended_at,
            (array_agg(ms.direction ORDER BY ms.created_at, ms.id))[1] AS first_dir,
            (array_agg(ms.direction ORDER BY ms.created_at DESC, ms.id DESC))[1] AS last_dir,
            count(*) FILTER (WHERE ms.direction = 'inbound')  AS msgs_in,
            count(*) FILTER (WHERE ms.direction = 'outbound') AS msgs_out,
            min(ms.created_at) FILTER (WHERE ms.direction = 'outbound') AS first_out_at,
            mode() WITHIN GROUP (ORDER BY ms.sent_by) FILTER (WHERE ms.sent_by IS NOT NULL) AS echo_agent
        FROM msg_session ms
        GROUP BY ms.conversation_id, ms.session_no
    ),
    sessions_all AS (
        SELECT
            sr.*,
            c.contact_name,
            COALESCE(c.is_group, false) AS is_group,
            COALESCE(sr.echo_agent, c.assigned_to) AS agent_id,
            (c.status = 'closed' AND c.closed_by IS NOT NULL AND c.closed_at >= sr.ended_at) AS human_closed,
            (
                extract(isodow FROM sr.started_at AT TIME ZONE v_tz)::int = ANY(p_business_days)
                AND (sr.started_at AT TIME ZONE v_tz)::time >= p_business_start
                AND (sr.started_at AT TIME ZONE v_tz)::time <  p_business_end
            ) AS in_business_hours
        FROM sessions_raw sr
        JOIN conversations c ON c.id = sr.conversation_id
        -- 3. em grupo, sem ninguém da equipe não é atendimento
        WHERE NOT (COALESCE(c.is_group, false) AND sr.msgs_out = 0)
    ),
    sessions AS (
        SELECT
            sa.*,
            CASE
                WHEN sa.msgs_out = 0 THEN
                    CASE
                        WHEN sa.human_closed THEN 'concluded'
                        WHEN now() - sa.ended_at >= v_cap THEN 'unanswered'
                        ELSE 'waiting_agent'
                    END
                WHEN sa.human_closed OR now() - sa.ended_at >= v_idle THEN 'concluded'
                WHEN sa.last_dir = 'inbound' THEN 'waiting_agent'
                ELSE 'waiting_client'
            END AS state,
            ((sa.started_at AT TIME ZONE v_tz)::date = (sa.ended_at AT TIME ZONE v_tz)::date) AS ends_same_day,
            CASE
                WHEN sa.first_dir = 'inbound' AND sa.first_out_at IS NOT NULL
                THEN extract(epoch FROM sa.first_out_at - sa.started_at)
            END AS first_response_seconds
        FROM sessions_all sa
    ),
    -- Atendimentos do período (filtro de atendente aplicado aqui)
    period AS (
        SELECT s.*,
               (s.state = 'concluded' AND s.ends_same_day)     AS is_same_day,
               (s.state = 'concluded' AND NOT s.ends_same_day) AS is_other_day,
               (s.state IN ('waiting_agent', 'waiting_client')) AS is_open
        FROM sessions s
        WHERE s.started_at >= p_start_date
          AND s.started_at <= p_end_date
          AND (p_agent_ids IS NULL OR s.agent_id = ANY(p_agent_ids))
    ),
    -- Mensagens enviadas no período, com a atendente atribuída
    out_msgs AS (
        SELECT ms.created_at,
               ms.sent_by,
               COALESCE(ms.sent_by, s.agent_id) AS agent_id,
               NOT (
                   extract(isodow FROM ms.created_at AT TIME ZONE v_tz)::int = ANY(p_business_days)
                   AND (ms.created_at AT TIME ZONE v_tz)::time >= p_business_start
                   AND (ms.created_at AT TIME ZONE v_tz)::time <  p_business_end
               ) AS off_hours
        FROM msg_session ms
        JOIN sessions s
          ON s.conversation_id = ms.conversation_id AND s.session_no = ms.session_no
        WHERE ms.direction = 'outbound'
          AND ms.created_at >= p_start_date
          AND ms.created_at <= p_end_date
    ),
    out_filtered AS (
        SELECT o.*,
               lag(o.created_at) OVER (PARTITION BY o.agent_id ORDER BY o.created_at) AS prev_at
        FROM out_msgs o
        WHERE p_agent_ids IS NULL OR o.agent_id = ANY(p_agent_ids)
    ),
    in_msgs AS (
        SELECT count(*) AS n
        FROM msg_session ms
        JOIN sessions s
          ON s.conversation_id = ms.conversation_id AND s.session_no = ms.session_no
        WHERE ms.direction = 'inbound'
          AND ms.created_at >= p_start_date
          AND ms.created_at <= p_end_date
          AND (p_agent_ids IS NULL OR s.agent_id = ANY(p_agent_ids))
    ),
    work AS (
        SELECT
            o.agent_id,
            count(*) AS messages_out,
            count(*) FILTER (WHERE o.off_hours) AS messages_out_off_hours,
            -- enviadas pelo celular (sem sent_by): atribuídas pela conversa, não pelo autor
            count(*) FILTER (WHERE o.sent_by IS NULL) AS messages_out_phone,
            count(DISTINCT (o.created_at AT TIME ZONE v_tz)::date) AS active_days,
            sum(extract(epoch FROM
                CASE
                    WHEN o.prev_at IS NOT NULL AND o.created_at - o.prev_at <= v_work_gap
                    THEN o.created_at - o.prev_at
                    ELSE v_msg_cost
                END)) AS active_seconds
        FROM out_filtered o
        GROUP BY o.agent_id
    ),
    agent_sessions AS (
        SELECT
            p.agent_id,
            count(*) AS total,
            count(*) FILTER (WHERE p.is_same_day)  AS same_day,
            count(*) FILTER (WHERE p.is_other_day) AS other_day,
            count(*) FILTER (WHERE p.is_open)      AS open,
            count(*) FILTER (WHERE p.state = 'unanswered') AS unanswered,
            count(*) FILTER (WHERE NOT p.in_business_hours) AS off_hours,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY p.first_response_seconds)
                FILTER (WHERE p.in_business_hours AND p.first_response_seconds IS NOT NULL)
                AS first_response_median_seconds,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p.ended_at - p.started_at))
                FILTER (WHERE p.state = 'concluded') AS duration_median_seconds
        FROM period p
        GROUP BY p.agent_id
    ),
    by_agent AS (
        SELECT
            COALESCE(a.agent_id, w.agent_id) AS agent_id,
            pr.full_name AS agent_name,
            COALESCE(a.total, 0) AS total,
            COALESCE(a.same_day, 0) AS same_day,
            COALESCE(a.other_day, 0) AS other_day,
            COALESCE(a.open, 0) AS open,
            COALESCE(a.unanswered, 0) AS unanswered,
            COALESCE(a.off_hours, 0) AS off_hours,
            a.first_response_median_seconds,
            a.duration_median_seconds,
            COALESCE(w.messages_out, 0) AS messages_out,
            COALESCE(w.messages_out_off_hours, 0) AS messages_out_off_hours,
            COALESCE(w.messages_out_phone, 0) AS messages_out_phone,
            COALESCE(w.active_seconds, 0) AS active_seconds,
            COALESCE(w.active_days, 0) AS active_days
        FROM agent_sessions a
        -- FULL JOIN não aceita IS NOT DISTINCT FROM; a sentinela casa o "não identificado" (NULL)
        FULL JOIN work w
          ON COALESCE(w.agent_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(a.agent_id, '00000000-0000-0000-0000-000000000000'::uuid)
        LEFT JOIN profiles pr ON pr.id = COALESCE(a.agent_id, w.agent_id)
    )
    SELECT jsonb_build_object(
        'summary', (
            SELECT jsonb_build_object(
                'total',          count(*),
                'same_day',       count(*) FILTER (WHERE p.is_same_day),
                'other_day',      count(*) FILTER (WHERE p.is_other_day),
                'open',           count(*) FILTER (WHERE p.is_open),
                'waiting_agent',  count(*) FILTER (WHERE p.state = 'waiting_agent'),
                'waiting_client', count(*) FILTER (WHERE p.state = 'waiting_client'),
                'unanswered',     count(*) FILTER (WHERE p.state = 'unanswered'),
                'off_hours',      count(*) FILTER (WHERE NOT p.in_business_hours),
                'started_by_client', count(*) FILTER (WHERE p.first_dir = 'inbound'),
                -- mensagens pela data da mensagem (batem com a soma da tabela por atendente)
                'messages_in',    (SELECT i.n FROM in_msgs i),
                'messages_out',   (SELECT COALESCE(sum(w.messages_out), 0) FROM work w),
                'messages_out_phone', (SELECT COALESCE(sum(w.messages_out_phone), 0) FROM work w),
                'messages_per_attendance_avg', avg(p.msgs_in + p.msgs_out),
                'first_response_median_seconds',
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY p.first_response_seconds)
                        FILTER (WHERE p.in_business_hours AND p.first_response_seconds IS NOT NULL),
                'first_response_p90_seconds',
                    percentile_cont(0.9) WITHIN GROUP (ORDER BY p.first_response_seconds)
                        FILTER (WHERE p.in_business_hours AND p.first_response_seconds IS NOT NULL),
                'duration_median_seconds',
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p.ended_at - p.started_at))
                        FILTER (WHERE p.state = 'concluded'),
                'active_seconds', (SELECT COALESCE(sum(w.active_seconds), 0) FROM work w)
            )
            FROM period p
        ),
        'by_agent', (
            SELECT COALESCE(jsonb_agg(to_jsonb(ba) ORDER BY ba.total DESC, ba.messages_out DESC), '[]'::jsonb)
            FROM by_agent ba
        ),
        'by_day', (
            SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.day), '[]'::jsonb)
            FROM (
                SELECT
                    (p.started_at AT TIME ZONE v_tz)::date AS day,
                    count(*) AS total,
                    count(*) FILTER (WHERE p.is_same_day)  AS same_day,
                    count(*) FILTER (WHERE p.is_other_day) AS other_day,
                    count(*) FILTER (WHERE p.is_open)      AS open,
                    count(*) FILTER (WHERE p.state = 'unanswered') AS unanswered,
                    count(*) FILTER (WHERE NOT p.in_business_hours) AS off_hours
                FROM period p
                GROUP BY 1
            ) d
        ),
        'by_hour', (
            SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.hour), '[]'::jsonb)
            FROM (
                SELECT
                    extract(hour FROM p.started_at AT TIME ZONE v_tz)::int AS hour,
                    count(*) FILTER (WHERE p.in_business_hours)     AS business_hours,
                    count(*) FILTER (WHERE NOT p.in_business_hours) AS off_hours
                FROM period p
                GROUP BY 1
            ) h
        ),
        'pending', (
            SELECT COALESCE(jsonb_agg(to_jsonb(o) - 'priority' ORDER BY o.priority, o.last_message_at), '[]'::jsonb)
            FROM (
                SELECT
                    p.conversation_id,
                    p.contact_name,
                    p.is_group,
                    p.agent_id,
                    pr.full_name AS agent_name,
                    p.state,
                    p.started_at,
                    p.ended_at AS last_message_at,
                    CASE p.state WHEN 'waiting_agent' THEN 1 WHEN 'unanswered' THEN 2 ELSE 3 END AS priority
                FROM period p
                LEFT JOIN profiles pr ON pr.id = p.agent_id
                WHERE p.state IN ('waiting_agent', 'waiting_client', 'unanswered')
                ORDER BY 9, p.ended_at
                LIMIT 100
            ) o
        ),
        'meta', jsonb_build_object(
            'generated_at', now(),
            'idle_hours', p_idle_hours,
            'unanswered_hours', p_unanswered_hours,
            'business_start', p_business_start,
            'business_end', p_business_end,
            'business_days', to_jsonb(p_business_days),
            'first_message_at', (
                SELECT min(m.created_at)
                FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                JOIN lines l ON l.id = c.phone_number_id
            )
        )
    )
    INTO v_result;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION "public"."get_attendance_report"("p_org_id" "uuid", "p_phone_ids" "uuid"[], "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_agent_ids" "uuid"[], "p_conversation_kind" "text", "p_idle_hours" integer, "p_unanswered_hours" integer, "p_business_start" time without time zone, "p_business_end" time without time zone, "p_business_days" integer[]) IS 'Painel de atendimentos: divide as conversas das linhas em atendimentos (silêncio >= p_idle_hours encerra; cliente sem resposta espera até p_unanswered_hours), atribui atendente, mede desfecho, fora do horário, 1ª resposta e tempo ativo.';

CREATE OR REPLACE FUNCTION "public"."get_button_click_stats"("p_org_id" "uuid", "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_phone_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_sector_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_agent_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("label" "text", "type" "text", "count" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);
    RETURN QUERY
    WITH filtered_conversations AS (
        SELECT c.id AS conv_id
        FROM conversations c
        JOIN phone_numbers pn ON c.phone_number_id = pn.id
        WHERE pn.organization_id = p_org_id
          AND (p_phone_ids IS NULL OR pn.id = ANY(p_phone_ids))
    ),
    target_messages AS (
        SELECT m.content, m.message_type
        FROM messages m
        JOIN filtered_conversations fc ON m.conversation_id = fc.conv_id
        WHERE m.created_at BETWEEN p_start_date AND p_end_date
          AND m.direction = 'inbound'
          AND m.message_type IN ('button_reply', 'list_reply')
          -- Note: Inbound messages don't have 'sent_by' agent, so we filter by conversation assignment if needed?
          -- For now, we return all inbound clicks for the organization/phones.
    )
    SELECT 
        tm.content AS label,
        CASE 
            WHEN tm.message_type = 'button_reply' THEN 'Botão'
            WHEN tm.message_type = 'list_reply' THEN 'Lista'
            ELSE tm.message_type
        END AS type,
        COUNT(*)::BIGINT AS count
    FROM target_messages tm
    GROUP BY tm.content, tm.message_type
    ORDER BY count DESC;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_channel_volume"("p_org_id" "uuid", "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_phone_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_sector_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_agent_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("connection_type" "text", "inbound" bigint, "outbound" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);
  RETURN QUERY
  WITH filtered_agents AS (
    SELECT om.user_id
    FROM organization_members om
    WHERE om.organization_id = p_org_id
      AND (p_sector_ids IS NULL OR om.sector_id = ANY(p_sector_ids))
      AND (p_agent_ids IS NULL OR om.user_id = ANY(p_agent_ids))
  ),
  filtered_messages AS (
    SELECT COALESCE(pn.connection_type, 'business_api') AS ctype, m.direction, m.sent_by
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    JOIN phone_numbers pn ON c.phone_number_id = pn.id
    WHERE pn.organization_id = p_org_id
      AND m.created_at BETWEEN p_start_date AND p_end_date
      AND (p_phone_ids IS NULL OR pn.id = ANY(p_phone_ids))
  )
  SELECT
    fm.ctype::TEXT AS connection_type,
    COALESCE(COUNT(*) FILTER (WHERE fm.direction = 'inbound'), 0)::BIGINT AS inbound,
    COALESCE(COUNT(*) FILTER (
      WHERE fm.direction = 'outbound'
        AND (p_agent_ids IS NULL AND p_sector_ids IS NULL OR fm.sent_by IN (SELECT user_id FROM filtered_agents))
    ), 0)::BIGINT AS outbound
  FROM filtered_messages fm
  GROUP BY fm.ctype
  ORDER BY inbound DESC;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_close_reason_stats"("p_org_id" "uuid", "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_phone_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_sector_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_agent_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("reason" "text", "count" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);
  RETURN QUERY
  WITH filtered_agents AS (
    SELECT om.user_id
    FROM organization_members om
    WHERE om.organization_id = p_org_id
      AND (p_sector_ids IS NULL OR om.sector_id = ANY(p_sector_ids))
      AND (p_agent_ids IS NULL OR om.user_id = ANY(p_agent_ids))
  )
  SELECT
    COALESCE(NULLIF(TRIM(c.close_reason), ''), 'Sem motivo')::TEXT AS reason,
    COUNT(*)::BIGINT AS count
  FROM conversations c
  JOIN phone_numbers pn ON c.phone_number_id = pn.id
  WHERE pn.organization_id = p_org_id
    AND c.status = 'closed'
    AND c.closed_at BETWEEN p_start_date AND p_end_date
    AND (p_phone_ids IS NULL OR pn.id = ANY(p_phone_ids))
    AND (
      (p_agent_ids IS NULL AND p_sector_ids IS NULL)
      OR c.assigned_to IN (SELECT user_id FROM filtered_agents)
    )
  GROUP BY COALESCE(NULLIF(TRIM(c.close_reason), ''), 'Sem motivo')
  ORDER BY COUNT(*) DESC;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_connection_health"("p_org_id" "uuid", "p_days" integer DEFAULT 30) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
    v_since timestamptz := now() - make_interval(days => GREATEST(1, LEAST(p_days, 90)));
    v_lines jsonb;
    v_daily jsonb;
    v_events jsonb;
    v_prospecting jsonb;
    v_restricted jsonb;
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);

    -- 1. Uma linha por número QR: estado atual + contadores da janela
    WITH pn AS (
        SELECT id, display_name, phone_number, qr_session_status, is_active, qr_provider
        FROM public.phone_numbers
        WHERE organization_id = p_org_id AND connection_type = 'qr'
    ),
    last_ev AS (
        SELECT DISTINCT ON (l.phone_number_id)
               l.phone_number_id, l.event, l.status_code, l.reason, l.created_at
        FROM public.session_connection_log l
        JOIN pn ON pn.id = l.phone_number_id
        ORDER BY l.phone_number_id, l.created_at DESC
    ),
    last_open AS (
        SELECT l.phone_number_id, max(l.created_at) AS at
        FROM public.session_connection_log l JOIN pn ON pn.id = l.phone_number_id
        WHERE l.event = 'open' GROUP BY 1
    ),
    win AS (
        SELECT l.phone_number_id,
               count(*) FILTER (WHERE l.event = 'close') AS closes,
               count(*) FILTER (WHERE l.event = 'close' AND l.created_at > now() - interval '24 hours') AS closes_24h,
               count(*) FILTER (WHERE l.reason = 'conflict') AS conflicts,
               count(*) FILTER (WHERE l.reason = 'conflict' AND l.created_at > now() - interval '7 days') AS conflicts_7d,
               count(*) FILTER (WHERE l.status_code = 403) AS forbidden,
               max(l.created_at) FILTER (WHERE l.status_code = 403) AS last_forbidden_at,
               max(l.created_at) FILTER (WHERE l.reason = 'conflict') AS last_conflict_at
        FROM public.session_connection_log l JOIN pn ON pn.id = l.phone_number_id
        WHERE l.created_at > v_since
        GROUP BY 1
    ),
    adds AS (
        SELECT c.phone_number_id,
               count(*) AS adds,
               count(*) FILTER (WHERE m.created_at > now() - interval '7 days') AS adds_7d
        FROM public.messages m
        JOIN public.conversations c ON c.id = m.conversation_id
        JOIN pn ON pn.id = c.phone_number_id
        WHERE c.is_group AND m.message_type = 'group_action'
          AND m.content ILIKE '%adicionou%' AND m.created_at > v_since
        GROUP BY 1
    ),
    inbound AS (
        SELECT c.phone_number_id, max(m.created_at) AS last_inbound_at
        FROM public.messages m
        JOIN public.conversations c ON c.id = m.conversation_id
        JOIN pn ON pn.id = c.phone_number_id
        WHERE m.direction = 'inbound' AND m.created_at > now() - interval '7 days'
        GROUP BY 1
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', pn.id,
        'display_name', pn.display_name,
        'phone_number', pn.phone_number,
        'is_active', pn.is_active,
        'qr_session_status', pn.qr_session_status,
        'qr_provider', pn.qr_provider,
        'last_event', le.event,
        'last_status_code', le.status_code,
        'last_reason', le.reason,
        'last_event_at', le.created_at,
        'last_open_at', lo.at,
        'last_inbound_at', ib.last_inbound_at,
        'closes', COALESCE(w.closes, 0),
        'closes_24h', COALESCE(w.closes_24h, 0),
        'conflicts', COALESCE(w.conflicts, 0),
        'conflicts_7d', COALESCE(w.conflicts_7d, 0),
        'last_conflict_at', w.last_conflict_at,
        'forbidden', COALESCE(w.forbidden, 0),
        'last_forbidden_at', w.last_forbidden_at,
        'group_adds', COALESCE(a.adds, 0),
        'group_adds_7d', COALESCE(a.adds_7d, 0)
    ) ORDER BY pn.display_name), '[]'::jsonb)
    INTO v_lines
    FROM pn
    LEFT JOIN last_ev le ON le.phone_number_id = pn.id
    LEFT JOIN last_open lo ON lo.phone_number_id = pn.id
    LEFT JOIN win w ON w.phone_number_id = pn.id
    LEFT JOIN adds a ON a.phone_number_id = pn.id
    LEFT JOIN inbound ib ON ib.phone_number_id = pn.id;

    -- 2. Série diária por linha (closes por classe)
    SELECT COALESCE(jsonb_agg(row_to_json(d)::jsonb ORDER BY d.day, d.phone_number_id), '[]'::jsonb)
    INTO v_daily
    FROM (
        SELECT l.phone_number_id,
               (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS day,
               count(*) FILTER (WHERE l.event = 'close') AS closes,
               count(*) FILTER (WHERE l.reason = 'conflict') AS conflicts,
               count(*) FILTER (WHERE l.status_code = 403) AS forbidden,
               count(*) FILTER (WHERE l.event = 'close' AND l.reason = 'pairing_pending' AND l.status_code IS DISTINCT FROM 403) AS flaps
        FROM public.session_connection_log l
        JOIN public.phone_numbers pn ON pn.id = l.phone_number_id
        WHERE pn.organization_id = p_org_id AND l.created_at > v_since
        GROUP BY 1, 2
    ) d;

    -- 3. Eventos relevantes (conflict, 403, fatal, reconnect) com o add de grupo
    --    mais próximo nos 10 min anteriores — é a assinatura da penalidade.
    SELECT COALESCE(jsonb_agg(row_to_json(e)::jsonb ORDER BY e.created_at DESC), '[]'::jsonb)
    INTO v_events
    FROM (
        SELECT l.id, l.phone_number_id, l.event, l.status_code, l.reason, l.error_message,
               l.reconnect_attempts, l.created_at,
               ga.group_name, ga.content AS group_action, ga.created_at AS group_action_at
        FROM public.session_connection_log l
        JOIN public.phone_numbers pn ON pn.id = l.phone_number_id
        LEFT JOIN LATERAL (
            SELECT c.contact_name AS group_name, m.content, m.created_at
            FROM public.messages m
            JOIN public.conversations c ON c.id = m.conversation_id
            WHERE c.phone_number_id = l.phone_number_id AND c.is_group
              AND m.message_type = 'group_action' AND m.content ILIKE '%adicionou%'
              AND m.created_at BETWEEN l.created_at - interval '10 minutes' AND l.created_at + interval '5 seconds'
            ORDER BY m.created_at DESC
            LIMIT 1
        ) ga ON l.reason = 'conflict'
        WHERE pn.organization_id = p_org_id
          AND l.created_at > v_since
          AND l.event = 'close'
          AND (l.reason IN ('conflict', 'fatal', 'reconnect') OR l.status_code IN (401, 403, 440))
        ORDER BY l.created_at DESC
        LIMIT 300
    ) e;

    -- 4. Sinais de ban por linha, últimos 7 dias: prospecção 1:1 iniciada por nós
    --    e quantas ficaram sem resposta (sinal conhecido que antecede o 403 por excesso de prospecção)
    SELECT COALESCE(jsonb_agg(row_to_json(p)::jsonb), '[]'::jsonb)
    INTO v_prospecting
    FROM (
        WITH c7 AS (
            SELECT c.id, c.phone_number_id, c.created_at
            FROM public.conversations c
            JOIN public.phone_numbers pn ON pn.id = c.phone_number_id
            WHERE pn.organization_id = p_org_id AND pn.connection_type = 'qr'
              AND NOT c.is_group AND c.created_at > now() - interval '7 days'
        ),
        agg AS (
            SELECT c7.phone_number_id, c7.id,
                   min(m.created_at) FILTER (WHERE m.direction = 'inbound') AS first_in,
                   min(m.created_at) FILTER (WHERE m.direction = 'outbound') AS first_out
            FROM c7 JOIN public.messages m ON m.conversation_id = c7.id
            GROUP BY 1, 2
        )
        SELECT phone_number_id,
               count(*) AS new_conversations_7d,
               count(*) FILTER (WHERE first_out < COALESCE(first_in, 'infinity'::timestamptz)) AS started_by_us_7d,
               count(*) FILTER (WHERE first_out IS NOT NULL AND first_in IS NULL) AS unanswered_7d
        FROM agg GROUP BY 1
    ) p;

    -- 5. Grupos restritos pelo WhatsApp (suspensão / trava de crescimento), como o
    --    qr-service os viu ao carregar metadados (qr_message_log, action group_restricted).
    --    Última observação por grupo dentro da janela. Sinal ANTES do 401/403 da sessão.
    SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.seen_at DESC), '[]'::jsonb)
    INTO v_restricted
    FROM (
        SELECT DISTINCT ON (l.phone_number_id, l.to_jid)
               l.phone_number_id,
               l.to_jid AS group_jid,
               l.baileys_result->>'subject' AS subject,
               (l.baileys_result->>'suspended')::boolean AS suspended,
               l.baileys_result->>'appeal_status' AS appeal_status,
               (l.baileys_result->>'growth_locked_until')::timestamptz AS growth_locked_until,
               l.created_at AS seen_at
        FROM public.qr_message_log l
        JOIN public.phone_numbers pn ON pn.id = l.phone_number_id
        WHERE pn.organization_id = p_org_id
          AND l.action = 'group_restricted'
          AND l.created_at > v_since
        ORDER BY l.phone_number_id, l.to_jid, l.created_at DESC
    ) r;

    RETURN jsonb_build_object(
        'generated_at', now(),
        'since', v_since,
        'lines', v_lines,
        'daily', v_daily,
        'events', v_events,
        'prospecting', v_prospecting,
        'restricted_groups', v_restricted
    );
END;
$$;

COMMENT ON FUNCTION "public"."get_connection_health"("p_org_id" "uuid", "p_days" integer) IS 'Painel /ops: estado de conexão por linha QR, série diária de closes, eventos 401/403/440 correlacionados com adds de grupo e sinais de ban. Admin da org.';

CREATE OR REPLACE FUNCTION "public"."get_conversation_reactions"("p_conversation_id" "uuid") RETURNS TABLE("id" "uuid", "message_id" "uuid", "reactor_jid" "text", "reactor_name" "text", "is_from_me" boolean, "emoji" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT r.id, r.message_id, r.reactor_jid, r.reactor_name, r.is_from_me, r.emoji
    FROM public.message_reactions r
    JOIN public.messages m ON m.id = r.message_id
    WHERE m.conversation_id = p_conversation_id
      AND (
          (SELECT public.auth_is_super_admin())
          OR (SELECT public.user_can_access_conversation(p_conversation_id))
      )
    ORDER BY r.id
$$;

COMMENT ON FUNCTION "public"."get_conversation_reactions"("p_conversation_id" "uuid") IS 'Reações das mensagens de uma conversa, com o acesso (super admin ou user_can_access_conversation) conferido uma vez. Usada por src/hooks/chat/useMessageReactions.ts.';

CREATE OR REPLACE FUNCTION "public"."get_conversation_tags_for_user"("p_phone_number_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("conversation_id" "uuid", "tag_id" "uuid", "tag_name" "text", "tag_color" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT
        ct.conversation_id,
        t.id as tag_id,
        t.name as tag_name,
        t.color as tag_color
    FROM conversation_tags ct
    JOIN tags t ON t.id = ct.tag_id
    JOIN conversations c ON c.id = ct.conversation_id
    WHERE (p_phone_number_id IS NULL OR c.phone_number_id = p_phone_number_id)
    AND (
        (SELECT public.auth_is_super_admin())
        OR c.phone_number_id = ANY ((SELECT public.get_my_conversation_phone_ids())::uuid[])
    )
    -- Isolamento por setor: super admin e org admin também
    -- passam por aqui, via open_ids.
    AND (
        (SELECT public.auth_is_super_admin())
        OR c.phone_number_id = ANY ((SELECT public.get_my_open_phone_ids())::uuid[])
        OR c.sector_id IS NULL
        OR c.sector_id = ANY ((SELECT public.get_my_sector_ids())::uuid[])
        OR c.assigned_to = (SELECT auth.uid())
        OR c.id = ANY ((SELECT public.get_my_co_owned_conversation_ids())::uuid[])
    )
    ORDER BY ct.conversation_id, t.name;
$$;

COMMENT ON FUNCTION "public"."get_conversation_tags_for_user"("p_phone_number_id" "uuid") IS 'Tags das conversas visíveis ao usuário. p_phone_number_id escopa por linha — a inbox sempre passa a linha selecionada, porque sem escopo o resultado estoura o db_max_rows=1000 do PostgREST e as tags somem sem erro. ORDER BY para que, se uma linha um dia passar de 1000, o corte seja determinístico.';

CREATE OR REPLACE FUNCTION "public"."get_decrypted_ai_key"("p_org_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
    v_encrypted TEXT;
BEGIN
    -- Permission check: Admin or Service Role
    IF (auth.role() = 'service_role') THEN
       -- Service role (Edge Function) - Allow
       NULL;
    ELSIF EXISTS (
        SELECT 1 FROM public.organization_members 
        WHERE organization_id = p_org_id 
        AND user_id = auth.uid() 
        AND role = 'admin'
    ) THEN
       -- Org Admin - Allow (e.g. for testing, though normally we wouldn't return it to UI)
       NULL;
    ELSE
       RAISE EXCEPTION 'Unauthorized';
    END IF;

    SELECT ai_api_key_encrypted INTO v_encrypted
    FROM public.organizations
    WHERE id = p_org_id;

    IF v_encrypted IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN pgp_sym_decrypt(v_encrypted::bytea, public._segredo_obrigatorio('ai_key_secret'));
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_hourly_heatmap"("p_org_id" "uuid", "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone, "p_phone_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_sector_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_agent_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("dow" smallint, "hour" smallint, "count" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);
  RETURN QUERY
  WITH filtered_conversations AS (
    SELECT c.id AS conv_id
    FROM conversations c
    JOIN phone_numbers pn ON c.phone_number_id = pn.id
    WHERE pn.organization_id = p_org_id
      AND (p_phone_ids IS NULL OR pn.id = ANY(p_phone_ids))
  )
  SELECT
    EXTRACT(DOW FROM (m.created_at AT TIME ZONE 'America/Sao_Paulo'))::SMALLINT AS dow,
    EXTRACT(HOUR FROM (m.created_at AT TIME ZONE 'America/Sao_Paulo'))::SMALLINT AS hour,
    COUNT(*)::BIGINT AS count
  FROM messages m
  JOIN filtered_conversations fc ON m.conversation_id = fc.conv_id
  WHERE m.direction = 'inbound'
    AND m.created_at BETWEEN p_start_date AND p_end_date
  GROUP BY 1, 2;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_invitation_by_token"("token_input" "text") RETURNS TABLE("id" "uuid", "email" "text", "phone_number_id" "uuid", "organization_id" "uuid", "expires_at" timestamp with time zone, "phone_display_name" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ui.id,
    ui.email,
    ui.phone_number_id,
    pn.organization_id,
    ui.expires_at,
    pn.display_name as phone_display_name
  FROM public.user_invitations ui
  JOIN public.phone_numbers pn ON ui.phone_number_id = pn.id
  WHERE ui.token = token_input
  AND ui.accepted_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_last_messages"("conversation_ids" "uuid"[]) RETURNS TABLE("conversation_id" "uuid", "content" "text", "direction" "text", "message_type" "text", "is_deleted" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT DISTINCT ON (m.conversation_id)
        m.conversation_id,
        m.content,
        m.direction,
        m.message_type,
        m.is_deleted
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ANY(conversation_ids)
      AND (
          (SELECT public.auth_is_super_admin())
          OR c.assigned_to = (SELECT auth.uid())
          OR c.id = ANY ((SELECT public.get_my_co_owned_conversation_ids())::uuid[])
          OR (
              c.phone_number_id = ANY ((SELECT public.get_my_conversation_phone_ids())::uuid[])
              AND (
                  c.phone_number_id = ANY ((SELECT public.get_my_open_phone_ids())::uuid[])
                  OR c.sector_id IS NULL
                  OR c.sector_id = ANY ((SELECT public.get_my_sector_ids())::uuid[])
              )
          )
      )
    ORDER BY m.conversation_id, m.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION "public"."get_my_co_owned_conversation_ids"() RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT COALESCE(array_agg(conversation_id), '{}'::uuid[])
    FROM public.conversation_assignees
    WHERE user_id = auth.uid();
$$;

COMMENT ON FUNCTION "public"."get_my_co_owned_conversation_ids"() IS 'Conversas onde o usuário atual é coproprietário (conversation_assignees), como array. Par de assigned_to = auth.uid(): juntos equivalem a user_is_assignee(id, auth.uid()) em forma InitPlan-ável. Array vazio quando não há nenhuma (fail-closed em `= ANY`).';

CREATE OR REPLACE FUNCTION "public"."get_my_conversation_phone_ids"() RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT COALESCE(
        array_agg(DISTINCT pn.id),
        '{}'::UUID[]
    )
    FROM public.phone_numbers pn
    WHERE EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.organization_id = pn.organization_id
              AND om.user_id = auth.uid()
              AND om.role = 'admin'
          )
       OR pn.id = ANY(public.get_my_phone_ids());
$$;

CREATE OR REPLACE FUNCTION "public"."get_my_open_phone_ids"() RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT COALESCE(array_agg(pn.id), '{}'::uuid[])
    FROM public.phone_numbers pn
    WHERE public.user_can_access_phone_line(pn.id)
      AND (
            NOT COALESCE(pn.sector_isolation_enabled, false)
            OR public.user_is_org_admin(pn.organization_id)
          );
$$;

COMMENT ON FUNCTION "public"."get_my_open_phone_ids"() IS 'Linhas acessíveis ao usuário atual onde o isolamento por setor não se aplica a ele: sector_isolation_enabled = false, ou ele é admin da organização. Subconjunto de user_can_access_phone_line — usar sempre em OR com ela, nunca em lugar dela.';

CREATE OR REPLACE FUNCTION "public"."get_my_org_ids"() RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT COALESCE(
        array_agg(organization_id),
        '{}'::UUID[]
    )
    FROM public.organization_members 
    WHERE user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION "public"."get_my_org_role"("_organization_id" "uuid") RETURNS "public"."org_role"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    _role public.org_role;
BEGIN
    SELECT role INTO _role
    FROM public.organization_members
    WHERE organization_id = _organization_id
    AND user_id = auth.uid();
    
    RETURN _role;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_my_phone_ids"() RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT COALESCE(
        array_agg(phone_number_id),
        '{}'::UUID[]
    )
    FROM public.user_phone_numbers 
    WHERE user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION "public"."get_my_sector_ids"() RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT COALESCE(array_agg(DISTINCT s.id), '{}'::uuid[])
    FROM public.sectors s
    WHERE EXISTS (
            SELECT 1 FROM public.sector_members sm
            WHERE sm.sector_id = s.id
              AND sm.user_id = auth.uid()
          )
       OR public.user_is_org_admin(s.organization_id);
$$;

COMMENT ON FUNCTION "public"."get_my_sector_ids"() IS 'Setores visíveis ao usuário atual: onde é membro (sector_members) mais todos os das organizações onde é admin. Array vazio quando não há nenhum (fail-closed em `= ANY`).';

CREATE OR REPLACE FUNCTION "public"."get_org_agent_stats"("org_id" "uuid", "start_date" timestamp with time zone DEFAULT ("now"() - '30 days'::interval), "end_date" timestamp with time zone DEFAULT "now"(), "phone_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("agent_id" "uuid", "agent_name" "text", "agent_email" "text", "messages_sent" bigint, "conversations_handled" bigint, "avg_response_time_seconds" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
  WITH org_conversations AS (
    SELECT c.id as conv_id
    FROM conversations c
    JOIN phone_numbers pn ON c.phone_number_id = pn.id
    WHERE pn.organization_id = org_id
      AND (phone_ids IS NULL OR pn.id = ANY(phone_ids))
  )
  SELECT 
    p.id as agent_id,
    p.full_name as agent_name,
    p.email as agent_email,
    COUNT(m.id)::BIGINT as messages_sent,
    COUNT(DISTINCT m.conversation_id)::BIGINT as conversations_handled,
    0::NUMERIC as avg_response_time_seconds
  FROM messages m
  JOIN org_conversations oc ON m.conversation_id = oc.conv_id
  JOIN profiles p ON m.sent_by = p.id
  WHERE m.direction = 'outbound'
    AND m.sent_by IS NOT NULL
    AND m.created_at BETWEEN start_date AND end_date
  GROUP BY p.id, p.full_name, p.email
  ORDER BY messages_sent DESC;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_org_daily_volume"("org_id" "uuid", "days" integer DEFAULT 30, "phone_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("date" "date", "inbound" bigint, "outbound" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
  WITH org_conversations AS (
    SELECT c.id as conv_id
    FROM conversations c
    JOIN phone_numbers pn ON c.phone_number_id = pn.id
    WHERE pn.organization_id = org_id
      AND (phone_ids IS NULL OR pn.id = ANY(phone_ids))
  ),
  date_series AS (
    SELECT generate_series(
      CURRENT_DATE - (days - 1),
      CURRENT_DATE,
      '1 day'::interval
    )::date as date
  )
  SELECT 
    ds.date,
    COALESCE(COUNT(*) FILTER (WHERE m.direction = 'inbound'), 0)::BIGINT as inbound,
    COALESCE(COUNT(*) FILTER (WHERE m.direction = 'outbound'), 0)::BIGINT as outbound
  FROM date_series ds
  LEFT JOIN messages m ON DATE(m.created_at) = ds.date
    AND m.conversation_id IN (SELECT conv_id FROM org_conversations)
  GROUP BY ds.date
  ORDER BY ds.date ASC;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_org_message_stats"("org_id" "uuid", "start_date" timestamp with time zone DEFAULT ("now"() - '30 days'::interval), "end_date" timestamp with time zone DEFAULT "now"(), "phone_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS TABLE("total_inbound" bigint, "total_outbound" bigint, "total_conversations" bigint, "avg_response_time_seconds" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
  WITH org_conversations AS (
    SELECT c.id as conv_id
    FROM conversations c
    JOIN phone_numbers pn ON c.phone_number_id = pn.id
    WHERE pn.organization_id = org_id
      AND (phone_ids IS NULL OR pn.id = ANY(phone_ids))
  ),
  message_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE m.direction = 'inbound') as inbound_count,
      COUNT(*) FILTER (WHERE m.direction = 'outbound') as outbound_count
    FROM messages m
    JOIN org_conversations oc ON m.conversation_id = oc.conv_id
    WHERE m.created_at BETWEEN start_date AND end_date
  ),
  response_times AS (
    SELECT 
      AVG(EXTRACT(EPOCH FROM (first_response.created_at - inbound.created_at))) as avg_response
    FROM messages inbound
    JOIN org_conversations oc ON inbound.conversation_id = oc.conv_id
    LEFT JOIN LATERAL (
      SELECT m2.created_at
      FROM messages m2
      WHERE m2.conversation_id = inbound.conversation_id
        AND m2.direction = 'outbound'
        AND m2.created_at > inbound.created_at
      ORDER BY m2.created_at ASC
      LIMIT 1
    ) first_response ON true
    WHERE inbound.direction = 'inbound'
      AND inbound.created_at BETWEEN start_date AND end_date
      AND first_response.created_at IS NOT NULL
  )
  SELECT 
    COALESCE(ms.inbound_count, 0)::BIGINT,
    COALESCE(ms.outbound_count, 0)::BIGINT,
    (SELECT COUNT(DISTINCT conv_id) FROM org_conversations)::BIGINT,
    COALESCE(rt.avg_response, 0)::NUMERIC
  FROM message_stats ms, response_times rt;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_phone_org_id"("_phone_number_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT organization_id FROM public.phone_numbers WHERE id = _phone_number_id
$$;

COMMENT ON FUNCTION "public"."get_phone_org_id"("_phone_number_id" "uuid") IS 'org_id da linha. a policy user_phone_numbers_manage a chama, então authenticated precisa de EXECUTE.';

CREATE OR REPLACE FUNCTION "public"."get_service_metrics"("p_org_id" "uuid", "p_start_date" timestamp with time zone DEFAULT (("now"() AT TIME ZONE 'America/Sao_Paulo'::"text") - '30 days'::interval), "p_end_date" timestamp with time zone DEFAULT ("now"() AT TIME ZONE 'America/Sao_Paulo'::"text"), "p_phone_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_sector_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_agent_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_sla_seconds" integer DEFAULT 300) RETURNS TABLE("first_response_p50_seconds" numeric, "first_response_p90_seconds" numeric, "pct_within_sla" numeric, "conversations_opened" bigint, "conversations_closed" bigint, "resolution_rate" numeric, "avg_resolution_seconds" numeric, "open_backlog" bigint, "unanswered_count" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);
  RETURN QUERY
  WITH filtered_agents AS (
    SELECT om.user_id
    FROM organization_members om
    WHERE om.organization_id = p_org_id
      AND (p_sector_ids IS NULL OR om.sector_id = ANY(p_sector_ids))
      AND (p_agent_ids IS NULL OR om.user_id = ANY(p_agent_ids))
  ),
  filtered_conversations AS (
    SELECT c.id AS conv_id, c.created_at, c.closed_at, c.status
    FROM conversations c
    JOIN phone_numbers pn ON c.phone_number_id = pn.id
    WHERE pn.organization_id = p_org_id
      AND (p_phone_ids IS NULL OR pn.id = ANY(p_phone_ids))
      AND (
        (p_agent_ids IS NULL AND p_sector_ids IS NULL)
        OR c.assigned_to IN (SELECT user_id FROM filtered_agents)
      )
  ),
  -- First inbound per conversation inside the period
  first_inbounds AS (
    SELECT m.conversation_id, MIN(m.created_at) AS first_in
    FROM messages m
    JOIN filtered_conversations fc ON m.conversation_id = fc.conv_id
    WHERE m.direction = 'inbound'
      AND m.created_at BETWEEN p_start_date AND p_end_date
    GROUP BY m.conversation_id
  ),
  -- First outbound after that first inbound (NULL = never answered)
  first_response AS (
    SELECT
      fi.conversation_id,
      EXTRACT(EPOCH FROM (fr.created_at - fi.first_in)) AS resp_seconds
    FROM first_inbounds fi
    LEFT JOIN LATERAL (
      SELECT m2.created_at
      FROM messages m2
      WHERE m2.conversation_id = fi.conversation_id
        AND m2.direction = 'outbound'
        AND m2.created_at > fi.first_in
      ORDER BY m2.created_at ASC
      LIMIT 1
    ) fr ON true
  ),
  resp_agg AS (
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY resp_seconds) AS p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY resp_seconds) AS p90,
      COUNT(*) FILTER (WHERE resp_seconds IS NOT NULL) AS answered,
      COUNT(*) FILTER (WHERE resp_seconds IS NOT NULL AND resp_seconds <= p_sla_seconds) AS within_sla,
      COUNT(*) FILTER (WHERE resp_seconds IS NULL) AS unanswered
    FROM first_response
  ),
  conv_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE created_at BETWEEN p_start_date AND p_end_date) AS opened,
      COUNT(*) FILTER (WHERE status = 'closed' AND closed_at BETWEEN p_start_date AND p_end_date) AS closed,
      COUNT(*) FILTER (WHERE status <> 'closed') AS backlog,
      AVG(EXTRACT(EPOCH FROM (closed_at - created_at)))
        FILTER (WHERE status = 'closed' AND closed_at BETWEEN p_start_date AND p_end_date) AS avg_resolution
    FROM filtered_conversations
  )
  SELECT
    COALESCE(ra.p50, 0)::NUMERIC,
    COALESCE(ra.p90, 0)::NUMERIC,
    CASE WHEN ra.answered > 0 THEN (100.0 * ra.within_sla / ra.answered)::NUMERIC ELSE 0 END,
    COALESCE(ca.opened, 0)::BIGINT,
    COALESCE(ca.closed, 0)::BIGINT,
    CASE WHEN ca.opened > 0 THEN (100.0 * ca.closed / ca.opened)::NUMERIC ELSE 0 END,
    COALESCE(ca.avg_resolution, 0)::NUMERIC,
    COALESCE(ca.backlog, 0)::BIGINT,
    COALESCE(ra.unanswered, 0)::BIGINT
  FROM resp_agg ra, conv_agg ca;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_template_stats"("p_org_id" "uuid", "p_start_date" timestamp with time zone, "p_end_date" timestamp with time zone) RETURNS TABLE("template_name" "text", "category" "text", "sent" bigint, "delivered" bigint, "read" bigint, "clicked" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    PERFORM public.assert_org_analytics_access(p_org_id);
    RETURN QUERY
    SELECT 
        adt.template_name::TEXT,
        COALESCE(adt.category, 'UNKNOWN')::TEXT,
        SUM(adt.sent)::BIGINT,
        SUM(adt.delivered)::BIGINT,
        SUM(adt.read)::BIGINT,
        SUM(adt.clicked)::BIGINT
    FROM analytics_daily_templates adt
    WHERE adt.organization_id = p_org_id
      AND adt.date BETWEEN p_start_date::DATE AND p_end_date::DATE
    GROUP BY adt.template_name, adt.category
    ORDER BY SUM(adt.sent) DESC;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_unread_counts"("p_phone_number_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("conversation_id" "uuid", "count" bigint, "total_conversations" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT s.conversation_id, s.count, s.total_conversations
    FROM (
        SELECT c.id AS conversation_id,
               u.cnt AS count,
               -- Total antes do LIMIT de fora, numa passada só.
               count(*) OVER () AS total_conversations,
               c.last_message_at AS atividade
        FROM conversations c
        LEFT JOIN conversation_reads cr
               ON cr.conversation_id = c.id
              AND cr.user_id = (SELECT auth.uid())
        LEFT JOIN phone_numbers pn
               ON pn.id = c.phone_number_id
        LEFT JOIN organization_members om
               ON om.organization_id = pn.organization_id
              AND om.user_id = (SELECT auth.uid())
        LEFT JOIN user_phone_numbers upn
               ON upn.phone_number_id = c.phone_number_id
              AND upn.user_id = (SELECT auth.uid())
        CROSS JOIN LATERAL (
            -- GREATEST/LEAST ignoram NULL, então cada parcela é opcional.
            -- A constante é só um piso; a janela de 30 dias a ultrapassa e o
            -- GREATEST se resolve sozinho.
            SELECT GREATEST(
                       cr.last_read_at,
                       TIMESTAMPTZ '2026-07-29 13:00:00+00',
                       LEAST(om.created_at, upn.created_at),
                       now() - INTERVAL '30 days'
                   ) AS threshold
        ) th
        CROSS JOIN LATERAL (
            SELECT count(*)::bigint AS cnt
            FROM (
                SELECT 1
                FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.direction = 'inbound'
                  AND m.read_at IS NULL
                  AND m.message_type IS DISTINCT FROM 'group_action'
                  AND m.created_at > th.threshold
                LIMIT 100
            ) capped
        ) u
        WHERE c.phone_number_id = ANY ((SELECT public.get_my_conversation_phone_ids())::uuid[])
          AND (
              c.phone_number_id = ANY ((SELECT public.get_my_open_phone_ids())::uuid[])
              OR c.sector_id IS NULL
              OR c.sector_id = ANY ((SELECT public.get_my_sector_ids())::uuid[])
              OR c.assigned_to = (SELECT auth.uid())
              OR c.id = ANY ((SELECT public.get_my_co_owned_conversation_ids())::uuid[])
          )
          AND (p_phone_number_id IS NULL OR c.phone_number_id = p_phone_number_id)
          AND COALESCE(c.last_message_at, 'infinity'::timestamptz) > th.threshold
          -- Predicado redundante (equivalente ao de cima) que deixa o índice ser usado.
          AND c.last_message_at > now() - INTERVAL '30 days'
          AND u.cnt > 0
    ) s
    ORDER BY s.atividade DESC NULLS LAST, s.conversation_id
    LIMIT 999;
$$;

CREATE OR REPLACE FUNCTION "public"."get_user_organization_ids"("uid" "uuid") RETURNS SETOF "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    RETURN QUERY SELECT organization_id FROM public.organization_members WHERE user_id = uid;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  _full_name text;
  _first_name text;
  _last_name text;
  _email text;
BEGIN
  -- Get full_name from user metadata
  _full_name := new.raw_user_meta_data->>'full_name';
  _email := new.email;
  
  -- Split full_name into first_name and last_name
  IF _full_name IS NOT NULL AND _full_name != '' THEN
    -- Get the first word as first_name
    _first_name := split_part(_full_name, ' ', 1);
    -- Get everything after the first space as last_name
    IF position(' ' in _full_name) > 0 THEN
      _last_name := substring(_full_name from position(' ' in _full_name) + 1);
    ELSE
      _last_name := NULL;
    END IF;
  END IF;

  -- Insert the profile with all name fields populated
  INSERT INTO public.profiles (id, full_name, first_name, last_name, email)
  VALUES (
    new.id, 
    _full_name, 
    _first_name, 
    _last_name,
    _email
  );
  
  RETURN new;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."hook_before_user_created"("event" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_email text := lower(btrim(coalesce(event -> 'user' ->> 'email', '')));
BEGIN
    IF v_email <> '' AND EXISTS (
        SELECT 1
        FROM public.user_invitations ui
        WHERE lower(btrim(ui.email)) = v_email
          AND ui.accepted_at IS NULL
          AND (ui.expires_at IS NULL OR ui.expires_at > now())
    ) THEN
        RETURN '{}'::jsonb;
    END IF;

    RETURN jsonb_build_object(
        'error', jsonb_build_object(
            'http_code', 403,
            'message', 'O cadastro no Echo é só por convite. Peça um convite ao administrador da sua equipe.'
        )
    );
END;
$$;

COMMENT ON FUNCTION "public"."hook_before_user_created"("event" "jsonb") IS 'Auth Hook "Before User Created": só cria usuário com convite pendente e válido em user_invitations. Desligado por padrão: ligue em supabase/config.toml ([auth.hook.before_user_created]) ou em Authentication > Hooks, depois de criar o primeiro administrador.';

CREATE OR REPLACE FUNCTION "public"."instagram_configurar_conexao"("p_conexao" "uuid", "p_ligada" boolean DEFAULT NULL::boolean, "p_nome" "text" DEFAULT NULL::"text", "p_linha" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    ic        instagram_connections;
    nova      phone_numbers;
    juntados  bigint;
BEGIN
    SELECT * INTO ic FROM instagram_connections WHERE id = p_conexao FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Instagram: conexão não encontrada' USING ERRCODE = 'P0002';
    END IF;
    IF NOT (public.auth_is_super_admin() OR public.user_is_org_admin(ic.organization_id)) THEN
        RAISE EXCEPTION 'Instagram: só administradores mexem na conexão' USING ERRCODE = '42501';
    END IF;

    IF p_ligada IS TRUE AND ic.status <> 'connected' THEN
        RAISE EXCEPTION 'Instagram: reconecte a conta antes de ligar' USING ERRCODE = '22023';
    END IF;

    IF p_linha IS NOT NULL AND p_linha <> ic.phone_number_id THEN
        SELECT * INTO nova FROM phone_numbers WHERE id = p_linha;
        IF NOT FOUND OR nova.organization_id IS DISTINCT FROM ic.organization_id THEN
            RAISE EXCEPTION 'Instagram: linha não encontrada nesta organização' USING ERRCODE = 'P0002';
        END IF;
        IF NOT public.instagram_linha_pode_hospedar(nova.connection_type) THEN
            RAISE EXCEPTION 'Instagram: essa linha não pode receber o Direct' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM instagram_connections x WHERE x.phone_number_id = p_linha) THEN
            RAISE EXCEPTION 'Instagram: essa linha já tem uma conta do Instagram' USING ERRCODE = '23505';
        END IF;

        SELECT count(*) INTO juntados FROM conversations c
         WHERE c.phone_number_id = ic.phone_number_id
           AND c.instagram_account_id = ic.ig_user_id
           AND c.channel = 'whatsapp';
        IF juntados > 0 THEN
            RAISE EXCEPTION 'Instagram: % conversa(s) desta linha já juntaram Direct e WhatsApp; a troca de linha as deixaria sem resposta pelo Direct', juntados
                USING ERRCODE = '55000';
        END IF;

        -- A mesma pessoa já tem conversa do Direct desta conta na linha nova (de uma
        -- ligação antiga): mover daria duas. Recusa em vez de escolher uma.
        IF EXISTS (
            SELECT 1 FROM conversations velha
              JOIN conversations c ON c.contact_phone = velha.contact_phone AND c.is_group = velha.is_group
             WHERE velha.phone_number_id = ic.phone_number_id
               AND velha.instagram_account_id = ic.ig_user_id
               AND velha.channel = 'instagram'
               AND c.phone_number_id = p_linha
        ) THEN
            RAISE EXCEPTION 'Instagram: a linha nova já tem conversas desta conta do Instagram' USING ERRCODE = '23505';
        END IF;

        UPDATE conversations
           SET phone_number_id = p_linha
         WHERE phone_number_id = ic.phone_number_id
           AND instagram_account_id = ic.ig_user_id
           AND channel = 'instagram';

        UPDATE instagram_connections SET phone_number_id = p_linha WHERE id = ic.id;
    END IF;

    UPDATE instagram_connections
       SET inbox_mode   = CASE WHEN p_ligada IS NULL THEN inbox_mode WHEN p_ligada THEN 'on' ELSE 'off' END,
           display_name = CASE WHEN p_nome IS NULL THEN display_name ELSE nullif(btrim(p_nome), '') END,
           updated_at   = now()
     WHERE id = ic.id;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."instagram_desconectar"("p_conexao" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_org uuid;
BEGIN
    SELECT organization_id INTO v_org FROM instagram_connections WHERE id = p_conexao FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Instagram: conexão não encontrada' USING ERRCODE = 'P0002';
    END IF;
    IF NOT (public.auth_is_super_admin() OR public.user_is_org_admin(v_org)) THEN
        RAISE EXCEPTION 'Instagram: só administradores mexem na conexão' USING ERRCODE = '42501';
    END IF;

    UPDATE instagram_connections
       SET status       = 'disconnected',
           inbox_mode   = 'off',
           access_token = '',
           last_error   = NULL,
           updated_at   = now()
     WHERE id = p_conexao;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."instagram_juntar_conversa"("p_conversa" "uuid", "p_telefone" "text", "p_so_ver" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    c        conversations;
    alvo     conversations;
    digitos  text;
    partes   record;
    opcoes   text[];
BEGIN
    SELECT * INTO c FROM conversations WHERE id = p_conversa FOR UPDATE;
    IF NOT FOUND OR c.channel <> 'instagram' OR c.instagram_user_id IS NULL OR c.instagram_account_id IS NULL THEN
        RAISE EXCEPTION 'Direct: conversa do Direct não encontrada' USING ERRCODE = 'P0002';
    END IF;
    IF coalesce(auth.role(), '') <> 'service_role' AND NOT public.user_can_access_conversation(p_conversa) THEN
        RAISE EXCEPTION 'Direct: sem acesso a esta conversa' USING ERRCODE = '42501';
    END IF;

    digitos := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
    -- Número brasileiro sem o 55 (DDD + número). Com '+' na frente é internacional
    -- e já traz o país (um +1 dos EUA também tem 11 dígitos).
    IF length(digitos) IN (10, 11) AND left(btrim(coalesce(p_telefone, '')), 1) <> '+' THEN
        digitos := '55' || digitos;
    END IF;
    IF length(digitos) < 12 OR length(digitos) > 15 THEN
        RAISE EXCEPTION 'Direct: telefone inválido' USING ERRCODE = '22023';
    END IF;

    -- Mesmo telefone com e sem o 9 e com e sem o 55 (as formas que o webhook e
    -- a "Nova conversa" gravam).
    opcoes := ARRAY[digitos];
    SELECT * INTO partes FROM extract_br_phone_parts(digitos);
    IF partes.country = '55' AND partes.ddd IS NOT NULL THEN
        opcoes := opcoes
            || ('55' || partes.ddd || '9' || partes.local_number) || ('55' || partes.ddd || partes.local_number)
            || (partes.ddd || '9' || partes.local_number) || (partes.ddd || partes.local_number);
    END IF;

    -- A mais antiga: é a que o merge de duplicadas mantém.
    SELECT * INTO alvo
      FROM conversations x
     WHERE x.phone_number_id = c.phone_number_id
       AND x.channel = 'whatsapp'
       AND x.is_group = false
       AND x.contact_phone = ANY(opcoes)
     ORDER BY x.created_at ASC
     LIMIT 1
     FOR UPDATE;

    IF alvo.id IS NOT NULL
       AND coalesce(auth.role(), '') <> 'service_role'
       AND NOT public.user_can_access_conversation(alvo.id) THEN
        RAISE EXCEPTION 'Direct: você não tem acesso à conversa de WhatsApp desse telefone' USING ERRCODE = '42501';
    END IF;

    IF alvo.instagram_user_id IS NOT NULL
       AND (alvo.instagram_user_id IS DISTINCT FROM c.instagram_user_id
            OR alvo.instagram_account_id IS DISTINCT FROM c.instagram_account_id) THEN
        RAISE EXCEPTION 'Direct: esse WhatsApp já está ligado a outro Direct' USING ERRCODE = '23505';
    END IF;

    IF p_so_ver THEN
        RETURN coalesce(alvo.id, c.id);
    END IF;

    IF alvo.id IS NULL THEN
        -- Não há WhatsApp com esse telefone: a conversa vira WhatsApp e continua
        -- guardando a pessoa do Instagram.
        UPDATE conversations
           SET channel = 'whatsapp', contact_phone = digitos
         WHERE id = c.id;
        RETURN c.id;
    END IF;

    -- Bolha que já está no destino (mesmo id do Meta) não duplica.
    DELETE FROM messages m
     WHERE m.conversation_id = c.id
       AND m.whatsapp_message_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM messages m2
                    WHERE m2.conversation_id = alvo.id
                      AND m2.whatsapp_message_id = m.whatsapp_message_id);

    UPDATE messages SET conversation_id = alvo.id WHERE conversation_id = c.id;
    UPDATE conversation_notes SET conversation_id = alvo.id WHERE conversation_id = c.id;

    INSERT INTO conversation_tags (conversation_id, tag_id, created_at)
    SELECT alvo.id, tag_id, created_at FROM conversation_tags WHERE conversation_id = c.id
    ON CONFLICT (conversation_id, tag_id) DO NOTHING;

    DELETE FROM conversations WHERE id = c.id;

    UPDATE conversations
       SET instagram_account_id = c.instagram_account_id,
           instagram_user_id    = c.instagram_user_id,
           instagram_username   = coalesce(c.instagram_username, instagram_username),
           last_message_at      = GREATEST(last_message_at, c.last_message_at),
           assigned_to          = coalesce(assigned_to, c.assigned_to),
           sector_id            = coalesce(sector_id, c.sector_id),
           status               = CASE WHEN status = 'closed' AND c.status <> 'closed' THEN c.status ELSE status END
     WHERE id = alvo.id;

    RETURN alvo.id;
END;
$$;

COMMENT ON FUNCTION "public"."instagram_juntar_conversa"("p_conversa" "uuid", "p_telefone" "text", "p_so_ver" boolean) IS 'Junta a conversa do Direct (sem telefone) ao WhatsApp do contato na mesma linha, ou a transforma em WhatsApp com esse telefone. Devolve o id da conversa que fica.';

CREATE OR REPLACE FUNCTION "public"."instagram_linha_pode_hospedar"("p_tipo" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
    SELECT coalesce(p_tipo, 'business_api') IN ('qr', 'business_api', 'business', 'official');
$$;

CREATE OR REPLACE FUNCTION "public"."instagram_listar_conexoes"() RETURNS TABLE("id" "uuid", "organization_id" "uuid", "display_name" "text", "ig_user_id" "text", "ig_username" "text", "status" "text", "last_error" "text", "token_expires_at" timestamp with time zone, "connected_at" timestamp with time zone, "ligada" boolean, "modo" "text", "linha_id" "uuid", "linha_nome" "text", "linha_tipo" "text", "conversas_so_direct" bigint, "cards_juntados" bigint, "pode_gerenciar" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT
        ic.id,
        ic.organization_id,
        coalesce(nullif(btrim(ic.display_name), ''), '@' || ic.ig_username, 'Instagram') AS display_name,
        ic.ig_user_id,
        ic.ig_username,
        ic.status,
        ic.last_error,
        ic.token_expires_at,
        ic.connected_at,
        ic.inbox_mode = 'on' AS ligada,
        ic.inbox_mode AS modo,
        pn.id AS linha_id,
        pn.display_name AS linha_nome,
        coalesce(pn.connection_type, 'business_api') AS linha_tipo,
        (SELECT count(*) FROM conversations c
          WHERE c.phone_number_id = ic.phone_number_id
            AND c.instagram_account_id = ic.ig_user_id
            AND c.channel = 'instagram') AS conversas_so_direct,
        (SELECT count(*) FROM conversations c
          WHERE c.phone_number_id = ic.phone_number_id
            AND c.instagram_account_id = ic.ig_user_id
            AND c.channel = 'whatsapp') AS cards_juntados,
        (public.auth_is_super_admin() OR public.user_is_org_admin(ic.organization_id)) AS pode_gerenciar
    FROM instagram_connections ic
    JOIN phone_numbers pn ON pn.id = ic.phone_number_id
    WHERE public.auth_is_super_admin()
       OR ic.organization_id IN (
            SELECT om.organization_id FROM organization_members om WHERE om.user_id = (SELECT auth.uid())
       )
    ORDER BY ic.connected_at;
$$;

COMMENT ON FUNCTION "public"."instagram_listar_conexoes"() IS 'Linhas Instagram (instagram_connections) das organizações do usuário, sem token. pode_gerenciar = admin da org ou super admin.';

CREATE OR REPLACE FUNCTION "public"."instagram_reprocessar_avisos"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_service_key text;
    v_project_url text;
BEGIN
    -- Nada para refazer: sai sem chamar ninguém.
    IF NOT EXISTS (
        SELECT 1 FROM instagram_webhook_events
         WHERE signature_valid
           AND tentativas < 5
           AND ((processed_at IS NULL AND received_at < now() - interval '2 minutes')
                OR process_note LIKE 'erro:%')
    ) AND NOT EXISTS (
        SELECT 1 FROM instagram_connections
         WHERE status = 'connected'
           AND access_token <> ''
           AND token_expires_at IS NOT NULL
           AND token_expires_at < now() + interval '10 days'
           AND (token_refresh_tried_at IS NULL OR token_refresh_tried_at < now() - interval '12 hours')
    ) THEN
        RETURN;
    END IF;

    v_service_key := public._segredo_obrigatorio('service_role_key');
    v_project_url := public._segredo_obrigatorio('project_url');

    PERFORM net.http_post(
        url     := v_project_url || '/functions/v1/instagram-reprocessar',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
        body    := '{}'::jsonb
    );
END;
$$;

CREATE OR REPLACE FUNCTION "public"."is_org_admin"("uid" "uuid", "org_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    result BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.organization_members 
        WHERE user_id = uid 
        AND organization_id = org_id 
        AND role = 'admin'
    ) INTO result;
    
    RETURN COALESCE(result, false);
END;
$$;

CREATE OR REPLACE FUNCTION "public"."is_org_member"("uid" "uuid", "org_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    result BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.organization_members 
        WHERE user_id = uid 
        AND organization_id = org_id
    ) INTO result;
    
    RETURN COALESCE(result, false);
END;
$$;

CREATE OR REPLACE FUNCTION "public"."is_super_admin"("uid" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    result BOOLEAN;
BEGIN
    SELECT COALESCE(is_super_admin, false) INTO result
    FROM public.profiles 
    WHERE id = uid;
    
    RETURN COALESCE(result, false);
END;
$$;

CREATE OR REPLACE FUNCTION "public"."mark_conversations_read"("p_conversation_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO 'public'
    AS $$
    INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
    SELECT DISTINCT auth.uid(), t.cid, now()
    FROM unnest(p_conversation_ids) AS t(cid)
    WHERE auth.uid() IS NOT NULL
      AND EXISTS (
          SELECT 1
          FROM conversations c
          WHERE c.id = t.cid
            AND c.phone_number_id = ANY (public.get_my_conversation_phone_ids())
      )
    ON CONFLICT (user_id, conversation_id)
    -- Abrir a conversa limpa os dois estados: o contador (marca d'água) e o
    -- lembrete manual. Sem o segundo, a marcação sobreviveria ao clique e o
    -- usuário teria que desmarcar à mão o que acabou de ler.
    DO UPDATE SET last_read_at = now(), marked_unread_at = NULL;
$$;

CREATE OR REPLACE FUNCTION "public"."merge_duplicate_conversations"() RETURNS TABLE("merged_count" integer, "details" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $_$
DECLARE
  grp RECORD;
  master_id UUID;
  master_name TEXT;
  dup_ids UUID[];
  all_ids UUID[];
  total_merged INT := 0;
  merge_details JSONB := '[]'::JSONB;
  merged_sector UUID;
  merged_avatar_url TEXT;
  merged_avatar_at TIMESTAMPTZ;
  merged_picture_url TEXT;
  merged_picture_at TIMESTAMPTZ;
  merged_last_msg TIMESTAMPTZ;
  merged_open_status TEXT;
BEGIN
  FOR grp IN
    WITH parsed_phones AS (
      SELECT
        c.id,
        c.contact_phone,
        c.contact_name,
        c.created_at,
        c.phone_number_id,
        p.country,
        p.ddd,
        p.local_number
      FROM conversations c
      CROSS JOIN LATERAL extract_br_phone_parts(c.contact_phone) p
      WHERE c.is_group = false
        AND c.contact_phone IS NOT NULL
        AND p.country = '55'
        AND p.ddd IS NOT NULL
        AND p.local_number IS NOT NULL
    )
    SELECT
      phone_number_id,
      ddd,
      local_number,
      array_agg(id ORDER BY created_at ASC) as all_ids,
      array_agg(contact_name ORDER BY created_at ASC) as all_names
    FROM parsed_phones
    GROUP BY phone_number_id, ddd, local_number
    HAVING count(*) > 1
  LOOP
    master_id := grp.all_ids[1];
    dup_ids := grp.all_ids[2:array_length(grp.all_ids, 1)];
    all_ids := grp.all_ids;

    SELECT name INTO master_name
    FROM unnest(grp.all_names) AS name
    WHERE name !~ '^\d+$'
    ORDER BY length(name) DESC
    LIMIT 1;

    IF master_name IS NULL THEN
      master_name := grp.all_names[1];
    END IF;

    -- Setor do merge, resolvido ANTES do DELETE das duplicatas: o do master
    -- quando existe, senão o primeiro setor definido entre as duplicatas (mais
    -- antiga primeiro). Sem isto o merge jogaria a conversa na triagem.
    SELECT COALESCE(
             (SELECT c.sector_id FROM conversations c WHERE c.id = master_id),
             (SELECT c.sector_id
              FROM conversations c
              WHERE c.id = ANY(dup_ids) AND c.sector_id IS NOT NULL
              ORDER BY c.created_at ASC
              LIMIT 1)
           )
      INTO merged_sector;

    -- Foto: a MAIS RECENTEMENTE conferida entre master e duplicatas, com o carimbo
    -- que veio junto (o par tem que andar junto, senão a sobrevivente fica com uma
    -- url velha carimbada de nova e o serviço não revalida).
    merged_avatar_url := NULL;
    merged_avatar_at := NULL;

    SELECT c.contact_avatar_url, c.contact_avatar_updated_at
      INTO merged_avatar_url, merged_avatar_at
      FROM conversations c
     WHERE c.id = ANY(all_ids)
       AND c.contact_avatar_url IS NOT NULL
     ORDER BY c.contact_avatar_updated_at DESC NULLS LAST
     LIMIT 1;

    IF merged_avatar_url IS NULL THEN
      -- Ninguém tem foto: preserva o carimbo mais recente mesmo assim. Com url NULL
      -- ele significa "conferido, não tem foto" — é o negativo durável que impede o
      -- serviço de reconsultar o WhatsApp a cada restart.
      SELECT max(c.contact_avatar_updated_at)
        INTO merged_avatar_at
        FROM conversations c
       WHERE c.id = ANY(all_ids);
    END IF;

    -- Campos legados: a foto mais antiga que existir.
    SELECT c.contact_picture_url, c.picture_fetched_at
      INTO merged_picture_url, merged_picture_at
      FROM conversations c
     WHERE c.id = ANY(all_ids)
       AND c.contact_picture_url IS NOT NULL
     ORDER BY c.created_at ASC
     LIMIT 1;

    -- Estado e relógio, resolvidos ANTES do DELETE. Fica ABERTA se qualquer lado
    -- estiver aberto ('active' vence 'waiting'; empate, a mais antiga). Relógio =
    -- o maior dos lados. Sem isto o master (o MAIS ANTIGO — pode ser um casco
    -- importado) impunha o status e o last_message_at dele à conversa viva.
    merged_open_status := NULL;
    merged_last_msg := NULL;

    SELECT max(c.last_message_at)
      INTO merged_last_msg
      FROM conversations c
     WHERE c.id = ANY(all_ids);

    SELECT c.status
      INTO merged_open_status
      FROM conversations c
     WHERE c.id = ANY(all_ids)
       AND c.status <> 'closed'
     ORDER BY (c.status = 'active') DESC, c.created_at ASC
     LIMIT 1;

    DELETE FROM messages m
    WHERE m.conversation_id = ANY(dup_ids)
      AND m.whatsapp_message_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM messages m2
        WHERE m2.whatsapp_message_id = m.whatsapp_message_id
          AND m2.id <> m.id
          AND (
            m2.conversation_id = master_id
            OR (m2.conversation_id = ANY(dup_ids) AND m2.id < m.id)
          )
      );

    UPDATE messages
    SET conversation_id = master_id
    WHERE conversation_id = ANY(dup_ids);

    INSERT INTO conversation_tags (conversation_id, tag_id, created_at)
    SELECT master_id, tag_id, MIN(created_at)
    FROM conversation_tags
    WHERE conversation_id = ANY(dup_ids)
    GROUP BY tag_id
    ON CONFLICT (conversation_id, tag_id) DO NOTHING;

    DELETE FROM conversation_tags
    WHERE conversation_id = ANY(dup_ids);

    DELETE FROM conversations
    WHERE id = ANY(dup_ids);

    UPDATE conversations
    SET
      contact_name = master_name,
      contact_phone = '55' || grp.ddd || '9' || grp.local_number,
      sector_id = merged_sector,
      contact_avatar_url = merged_avatar_url,
      contact_avatar_updated_at = merged_avatar_at,
      contact_picture_url = merged_picture_url,
      picture_fetched_at = merged_picture_at,
      status = COALESCE(merged_open_status, status),
      last_message_at = GREATEST(last_message_at, merged_last_msg),
      updated_at = NOW()
    WHERE id = master_id;

    total_merged := total_merged + array_length(dup_ids, 1);
    merge_details := merge_details || jsonb_build_object(
      'master_id', master_id,
      'merged_ids', dup_ids,
      'final_name', master_name,
      'normalized_phone', '55' || grp.ddd || '9' || grp.local_number
    );

    RAISE NOTICE 'Merged % duplicates into master %', array_length(dup_ids, 1), master_id;
  END LOOP;

  RETURN QUERY SELECT total_merged, merge_details;
END;
$_$;

CREATE OR REPLACE FUNCTION "public"."messages_carimbar_failed_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    NEW.metadata := jsonb_set(coalesce(NEW.metadata, '{}'::jsonb), '{failed_at}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."messages_leitura_reservar"("p_message_id" "uuid", "p_max_tentativas" integer DEFAULT 3, "p_janela_s" integer DEFAULT 300) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_leitura jsonb;
BEGIN
    UPDATE public.messages m
    SET metadata = jsonb_set(
        COALESCE(m.metadata, '{}'::jsonb),
        '{leitura}',
        COALESCE(m.metadata -> 'leitura', '{"v":1,"tentativas":0,"lacuna":false,"custo_usd":0}'::jsonb)
        || jsonb_build_object(
            'tentativas', COALESCE((m.metadata -> 'leitura' ->> 'tentativas')::int, 0) + 1,
            'em_leitura_desde', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'erro', NULL
        )
    )
    WHERE m.id = p_message_id
      AND COALESCE((m.metadata -> 'leitura' ->> 'lacuna')::boolean, false) = false
      AND (m.metadata -> 'leitura' ->> 'texto') IS NULL
      AND (m.metadata -> 'leitura' ->> 'at') IS NULL -- leitura concluída (a classe documento grava texto null)
      AND COALESCE((m.metadata -> 'leitura' ->> 'tentativas')::int, 0) < p_max_tentativas
      AND (
          (m.metadata -> 'leitura' ->> 'em_leitura_desde') IS NULL
          OR (m.metadata -> 'leitura' ->> 'em_leitura_desde')::timestamptz < now() - make_interval(secs => p_janela_s)
      )
    RETURNING m.metadata -> 'leitura' INTO v_leitura;

    RETURN v_leitura;   -- NULL: nada casou (outro worker lendo, esgotada, lacuna ou já lida)
END
$$;

COMMENT ON FUNCTION "public"."messages_leitura_reservar"("p_message_id" "uuid", "p_max_tentativas" integer, "p_janela_s" integer) IS 'Reserva atômica da leitura de mídia: tentativas + 1 e em_leitura_desde numa UPDATE só. NULL = não ler. Um worker morto no meio conta como tentativa, e a mídia venenosa para na 3ª.';

CREATE OR REPLACE FUNCTION "public"."messages_mesclar_metadata"("p_message_id" "uuid", "p_patch" "jsonb", "p_nivel2" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_novo jsonb;
BEGIN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'patch deve ser um objeto jsonb' USING ERRCODE = '22023';
    END IF;

    IF COALESCE(p_nivel2, false) THEN
        UPDATE public.messages m
        SET metadata = COALESCE(m.metadata, '{}'::jsonb) || (
            SELECT COALESCE(jsonb_object_agg(
                       e.k,
                       CASE
                           WHEN jsonb_typeof(e.v) = 'object' AND jsonb_typeof(m.metadata -> e.k) = 'object'
                               THEN (m.metadata -> e.k) || e.v
                           ELSE e.v
                       END
                   ), '{}'::jsonb)
            FROM jsonb_each(p_patch) AS e(k, v)
        )
        WHERE m.id = p_message_id
        RETURNING m.metadata INTO v_novo;
    ELSE
        UPDATE public.messages m
        SET metadata = COALESCE(m.metadata, '{}'::jsonb) || p_patch
        WHERE m.id = p_message_id
        RETURNING m.metadata INTO v_novo;
    END IF;

    RETURN v_novo;   -- NULL se a linha não existe
END
$$;

COMMENT ON FUNCTION "public"."messages_mesclar_metadata"("p_message_id" "uuid", "p_patch" "jsonb", "p_nivel2" boolean) IS 'metadata || patch numa UPDATE só (sem read-modify-write). nivel2 mescla um nível abaixo as chaves cujo valor no patch é objeto. Devolve o metadata novo ou NULL se a mensagem não existe.';

CREATE OR REPLACE FUNCTION "public"."messages_registrar_edicao"("p_message_id" "uuid", "p_novo_conteudo" "text", "p_editado_em" timestamp with time zone, "p_flag_only" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    IF COALESCE(p_flag_only, false) THEN
        -- Sem o texto novo: marca a edição e registra que o conteúdo exibido está defasado.
        UPDATE public.messages m
        SET is_edited = true,
            edited_at = p_editado_em,
            metadata = COALESCE(m.metadata, '{}'::jsonb) || '{"edit_content_unavailable": true}'::jsonb
        WHERE m.id = p_message_id
          AND NOT m.is_deleted;
    ELSE
        -- No SET de um UPDATE, m.content à direita é o valor ANTIGO: o histórico guarda o texto
        -- anterior sem SELECT. "at" no mesmo formato do JS (toISOString, milissegundos).
        UPDATE public.messages m
        SET content = p_novo_conteudo,
            is_edited = true,
            edited_at = p_editado_em,
            metadata = COALESCE(m.metadata, '{}'::jsonb) || jsonb_build_object(
                'edit_history',
                (CASE WHEN jsonb_typeof(m.metadata -> 'edit_history') = 'array'
                      THEN m.metadata -> 'edit_history'
                      ELSE '[]'::jsonb END)
                || jsonb_build_array(jsonb_build_object(
                    'content', m.content,
                    'at', to_char(p_editado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                ))
            )
        WHERE m.id = p_message_id
          AND NOT m.is_deleted
          AND m.content IS DISTINCT FROM p_novo_conteudo;
    END IF;
    RETURN FOUND;
END
$$;

COMMENT ON FUNCTION "public"."messages_registrar_edicao"("p_message_id" "uuid", "p_novo_conteudo" "text", "p_editado_em" timestamp with time zone, "p_flag_only" boolean) IS 'Edição de mensagem numa UPDATE só: content novo + edit_history (texto antigo) ou, com flag_only, edit_content_unavailable. Ignora mensagem apagada e, fora do flag_only, texto igual ao atual (a edição chega por dois caminhos do Baileys). Devolve FOUND.';

CREATE OR REPLACE FUNCTION "public"."mirror_group_messages_to_siblings"("p_lookback" interval DEFAULT '00:15:00'::interval, "p_settle" interval DEFAULT '00:02:00'::interval, "p_mark_read" boolean DEFAULT false, "p_max_rows" integer DEFAULT 2000) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    copied integer;
BEGIN
    WITH src_conv AS (
        -- Conversas de grupo com atividade na janela. Dirigir por
        -- conversations.last_message_at (idx_conversations_last_message_at) em vez
        -- de varrer messages por created_at é o que mantém isto barato: não existe
        -- índice só por created_at em messages, e são ~31 conversas de grupo ativas
        -- numa janela de 15 minutos.
        SELECT c.id, c.group_jid, c.phone_number_id,
               pn.organization_id, pn.phone_number, pn.display_name
          FROM conversations c
          JOIN phone_numbers pn ON pn.id = c.phone_number_id
         WHERE c.is_group
           AND c.group_jid IS NOT NULL
           AND c.last_message_at >= now() - p_lookback
    ),
    pair AS (
        -- Mesmo grupo, mesma organização, outra linha. O group_jid é o único
        -- vínculo confiável de "mesmo grupo" (mesma regra do mirror-group-history).
        SELECT s.id           AS src_id,
               s.phone_number AS src_phone,
               s.display_name AS src_name,
               t.id           AS tgt_id,
               t.created_at   AS tgt_created
          FROM src_conv s
          JOIN conversations t
            ON t.group_jid = s.group_jid
           AND t.is_group
           AND t.phone_number_id <> s.phone_number_id
          JOIN phone_numbers tpn ON tpn.id = t.phone_number_id
         WHERE tpn.organization_id = s.organization_id
    ),
    todo AS (
        -- DISTINCT ON: com três ou quatro linhas no mesmo grupo, duas irmãs podem
        -- oferecer a mesma mensagem para a terceira no mesmo comando. Preferir a
        -- origem 'inbound', que carrega o participante real, à 'outbound', cujo
        -- remetente precisa ser traduzido.
        SELECT DISTINCT ON (p.tgt_id, m.whatsapp_message_id)
               p.tgt_id, p.src_id, p.src_phone, p.src_name,
               m.whatsapp_message_id, m.content, m.message_type, m.direction,
               m.created_at, m.sender_phone, m.sender_name, m.sender_jid,
               m.media_url, m.media_mime_type, m.media_filename, m.media_size_bytes,
               m.metadata, m.reaction, m.our_reaction,
               m.is_deleted, m.deleted_at, m.is_edited, m.edited_at,
               m.quoted_message_id
          FROM pair p
          JOIN messages m ON m.conversation_id = p.src_id
         WHERE m.created_at >= now() - p_lookback
           AND m.created_at <  now() - p_settle
           -- Nada anterior à existência da conversa de destino: isso é histórico,
           -- e histórico é decisão humana pelo mirror-group-history.
           AND m.created_at >= p.tgt_created
           -- Sem wamid não há chave de dedup: a cópia duplicaria a cada rodada.
           AND m.whatsapp_message_id IS NOT NULL
           AND m.is_imported = false
           AND NOT EXISTS (
                 SELECT 1 FROM messages x
                  WHERE x.conversation_id = p.tgt_id
                    AND x.whatsapp_message_id = m.whatsapp_message_id
               )
         ORDER BY p.tgt_id, m.whatsapp_message_id,
                  (m.direction = 'inbound') DESC, m.created_at
         LIMIT p_max_rows
    )
    INSERT INTO messages (
        conversation_id, whatsapp_message_id, content, message_type, direction,
        created_at, sender_phone, sender_name, sender_jid,
        media_url, media_mime_type, media_filename, media_size_bytes,
        metadata, reaction, our_reaction,
        is_deleted, deleted_at, is_edited, edited_at,
        is_imported, quoted_message_id, status, read_at
    )
    SELECT
        t.tgt_id,
        t.whatsapp_message_id,
        t.content,
        t.message_type,
        -- Toda cópia é de ENTRADA. A mensagem que a linha de origem mandou chega
        -- na irmã como mensagem de outro número — foi exatamente o que o banco
        -- registrou nativamente quando as duas estavam no ar. A UI decide "minha
        -- vs dele" só por direction, então é isto que põe o balão do lado certo.
        'inbound',
        t.created_at,
        CASE WHEN t.direction = 'outbound' THEN t.src_phone ELSE t.sender_phone END,
        CASE WHEN t.direction = 'outbound' THEN t.src_name  ELSE t.sender_name  END,
        CASE WHEN t.direction = 'outbound' THEN NULL        ELSE t.sender_jid   END,
        t.media_url, t.media_mime_type, t.media_filename, t.media_size_bytes,
        -- Marca de origem: é o que permite desfazer só o espelhamento sem tocar no
        -- histórico importado, que também usa is_imported.
        COALESCE(t.metadata, '{}'::jsonb)
          || jsonb_build_object('mirrored_from_conversation_id', t.src_id::text),
        t.reaction, t.our_reaction,
        t.is_deleted, t.deleted_at, t.is_edited, t.edited_at,
        true,
        -- Citação traduzida pelo wamid, o único identificador que as duas conversas
        -- compartilham. Fica nula quando a citada ainda não existe no destino:
        -- perder a citação degrada a exibição, perder a mensagem não.
        (SELECT tq.id
           FROM messages tq
          WHERE tq.conversation_id = t.tgt_id
            AND tq.whatsapp_message_id = (
                  SELECT sq.whatsapp_message_id FROM messages sq WHERE sq.id = t.quoted_message_id
                )
          LIMIT 1),
        CASE WHEN p_mark_read THEN 'read' ELSE 'sent' END,
        CASE WHEN p_mark_read THEN t.created_at ELSE NULL END
      FROM todo t
    -- Rede final contra a corrida com a ingestão nativa da irmã: se ela gravar
    -- entre o NOT EXISTS e o INSERT, a cópia é descartada em silêncio.
    ON CONFLICT (whatsapp_message_id, conversation_id) DO NOTHING;

    GET DIAGNOSTICS copied = ROW_COUNT;
    RETURN copied;
END;
$$;

COMMENT ON FUNCTION "public"."mirror_group_messages_to_siblings"("p_lookback" interval, "p_settle" interval, "p_mark_read" boolean, "p_max_rows" integer) IS 'Copia mensagens de grupo para as conversas irmãs da mesma organização que ainda não as têm. Idempotente por (whatsapp_message_id, conversation_id).';

CREATE OR REPLACE FUNCTION "public"."normalize_phone"("phone" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
BEGIN
    RETURN regexp_replace(coalesce(phone, ''), '\D', '', 'g');
END;
$$;

CREATE OR REPLACE FUNCTION "public"."phone_lookup_variations"("p_phone" "text") RETURNS "text"[]
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  WITH d AS (
    SELECT regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') AS digits
  ),
  parts AS (
    SELECT d.digits, p.country, p.ddd, p.local_number
    FROM d
    LEFT JOIN LATERAL public.extract_br_phone_parts(d.digits) p ON true
  )
  SELECT CASE
    WHEN digits = '' THEN '{}'::text[]
    WHEN country IS DISTINCT FROM '55' OR ddd IS NULL OR local_number IS NULL
      THEN ARRAY[digits]
    -- extract_br_phone_parts ASSUME que o 5º dígito de um 13 é o nono dígito e
    -- o descarta sem conferir. Sem esta guarda, 5511899990001 geraria
    -- 5511999990001 — OUTRA PESSOA. Espelha o `localNumber.startsWith("9")` do
    -- getLookupVariations.
    WHEN length(digits) = 13 AND substring(digits, 5, 1) <> '9'
      THEN ARRAY[digits]
    -- Dedup preservando a ordem (os dígitos exatos sempre primeiro): para 13
    -- dígitos a primeira forma gerada repete a entrada, e sondar o índice duas
    -- vezes por participante é desperdício.
    ELSE ARRAY(
      SELECT v
      FROM unnest(ARRAY[
        digits,
        '55' || ddd || '9' || local_number,
        '55' || ddd || local_number,
        ddd || '9' || local_number,
        ddd || local_number
      ]) WITH ORDINALITY AS t(v, ord)
      GROUP BY v
      ORDER BY min(ord)
    )
  END
  FROM parts;
$$;

COMMENT ON FUNCTION "public"."phone_lookup_variations"("p_phone" "text") IS 'Formas equivalentes de um telefone para busca em conversations.contact_phone (BR com/sem 9, com/sem 55). Espelha getLookupVariations em src/lib/phone.ts.';

CREATE OR REPLACE FUNCTION "public"."prevent_phone_reactivation_conflict"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.is_active = TRUE
     AND (OLD.is_active = FALSE OR OLD.is_active IS NULL)
     AND NEW.phone_number IS NOT NULL
     AND NEW.phone_number <> 'Aguardando conexão...'
     AND EXISTS (
       SELECT 1 FROM phone_numbers
       WHERE phone_number = NEW.phone_number
         AND is_active = TRUE
         AND id <> NEW.id
     ) THEN
    RAISE EXCEPTION 'phone_number % already active in another record', NEW.phone_number
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."prevent_primary_in_assignees"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.conversations
        WHERE id = NEW.conversation_id AND assigned_to = NEW.user_id
    ) THEN
        RAISE EXCEPTION 'User % is already the primary assignee of conversation %',
            NEW.user_id, NEW.conversation_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."process_scheduled_broadcasts"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    broadcast_record RECORD;
    v_service_key    text;
    v_project_url    text;
BEGIN
    v_service_key := public._segredo_obrigatorio('service_role_key');
    v_project_url := public._segredo_obrigatorio('project_url');

    FOR broadcast_record IN
        SELECT id
        FROM broadcasts
        WHERE status = 'scheduled'
          AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT 5
    LOOP
        -- Dispatch BEFORE claiming. If this raises, the row stays 'scheduled' and
        -- the next tick retries it, instead of being stranded in 'processing'
        -- where the cron can never see it again.
        PERFORM net.http_post(
            url     := v_project_url || '/functions/v1/broadcast-execute',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || v_service_key
            ),
            body    := jsonb_build_object('broadcastId', broadcast_record.id)
        );

        UPDATE broadcasts
        SET status     = 'processing',
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
        WHERE id = broadcast_record.id;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION "public"."process_scheduled_broadcasts"() IS 'Invoked every minute by the process-scheduled-broadcasts cron job. Dispatches due scheduled broadcasts to the broadcast-execute edge function via pg_net. Reads its service_role key from Vault.';

CREATE OR REPLACE FUNCTION "public"."process_scheduled_messages"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    msg_record    RECORD;
    v_service_key text;
    v_project_url text;
    v_claimed     integer;
BEGIN
    -- O front chama como tick best-effort depois de "Enviar agora".
    -- Usuário logado que não é membro de nenhuma org (cadastro aberto) não
    -- dispara nada. Cron (postgres, sem JWT) e service_role passam direto.
    IF coalesce(auth.role(), '') = 'authenticated'
       AND cardinality(public.get_my_org_ids()) = 0 THEN
        RETURN;
    END IF;

    -- First, so anything the reaper requeues is eligible in THIS tick instead of
    -- waiting another minute.
    PERFORM reap_stuck_scheduled_messages();

    v_service_key := public._segredo_obrigatorio('service_role_key');
    v_project_url := public._segredo_obrigatorio('project_url');

    FOR msg_record IN
        SELECT id
        FROM scheduled_messages
        WHERE status = 'scheduled'
          AND COALESCE(next_attempt_at, scheduled_at) <= now()
        ORDER BY COALESCE(next_attempt_at, scheduled_at) ASC
        LIMIT 50
    LOOP
        -- Claim BEFORE dispatch (o executor ignora linha que não esteja em
        -- 'processing'). O recheque de status é a única barreira contra dois
        -- ticks concorrentes despacharem a mesma linha.
        UPDATE scheduled_messages
        SET status          = 'processing',
            attempts        = attempts + 1,
            last_attempt_at = now(),
            next_attempt_at = NULL,
            updated_at      = now()
        WHERE id = msg_record.id
          AND status = 'scheduled';
        GET DIAGNOSTICS v_claimed = ROW_COUNT;
        CONTINUE WHEN v_claimed = 0;

        PERFORM net.http_post(
            url     := v_project_url || '/functions/v1/scheduled-message-execute',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || v_service_key
            ),
            body    := jsonb_build_object('scheduledMessageId', msg_record.id::text)
        );
    END LOOP;
END;
$$;

COMMENT ON FUNCTION "public"."process_scheduled_messages"() IS 'Invoked every minute by the process-scheduled-messages cron job (and on demand by the panel''s "send now"). Reaps stuck rows, then atomically claims and dispatches due scheduled messages to the scheduled-message-execute edge function via pg_net. Reads its service_role key from Vault.';

CREATE OR REPLACE FUNCTION "public"."process_survey_timeouts"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
    v_service_key text;
    v_project_url text;
BEGIN
    v_service_key := public._segredo_obrigatorio('service_role_key');
    v_project_url := public._segredo_obrigatorio('project_url');

    PERFORM net.http_post(
        url     := v_project_url || '/functions/v1/survey-timeout-execute',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
        body    := '{}'::jsonb
    );
END;
$$;

CREATE OR REPLACE FUNCTION "public"."profiles_guard_protected_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_jwt_role text := coalesce(auth.role(), '');
BEGIN
    IF NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.email IS NOT DISTINCT FROM OLD.email
       AND NEW.is_super_admin IS NOT DISTINCT FROM OLD.is_super_admin THEN
        RETURN NEW;
    END IF;

    -- Edge function com a chave de serviço.
    IF v_jwt_role = 'service_role' THEN
        RETURN NEW;
    END IF;

    -- Sessão direta no banco, sem JWT (SQL editor, cron, Management API).
    -- INVOKER: current_user é quem rodou o UPDATE, não o dono da função.
    IF v_jwt_role = '' AND current_user IN ('postgres', 'supabase_admin') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'profiles: id, email e is_super_admin só mudam pelo service_role'
        USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION "public"."profiles_guard_protected_columns"() IS 'Trigger BEFORE UPDATE de profiles: id, email e is_super_admin só mudam com JWT service_role ou em sessão direta sem JWT (postgres/supabase_admin). SECURITY INVOKER de propósito: current_user precisa ser quem executou o UPDATE.';

CREATE OR REPLACE FUNCTION "public"."promote_co_owner_to_primary"("p_conversation_id" "uuid", "p_new_primary_user_id" "uuid", "p_keep_old_as_co_owner" boolean DEFAULT false) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    old_primary UUID;
BEGIN
    -- Escopo por linha: sem acesso à conversa, sem transferência.
    IF NOT (public.auth_is_super_admin()
            OR public.user_can_access_conversation(p_conversation_id)) THEN
        RAISE EXCEPTION 'Access denied to conversation' USING ERRCODE = '42501';
    END IF;

    -- O novo dono precisa ser membro da org da linha da conversa.
    -- Sem isto, dava para entregar a conversa (e o acesso a ela) a um usuário
    -- de outra organização. Super admin (que pode não ser membro) continua
    -- podendo receber, como já acessa toda conversa.
    IF NOT public.is_super_admin(p_new_primary_user_id) AND NOT EXISTS (
        SELECT 1
        FROM public.conversations c
        JOIN public.phone_numbers pn ON pn.id = c.phone_number_id
        JOIN public.organization_members om ON om.organization_id = pn.organization_id
        WHERE c.id = p_conversation_id
          AND om.user_id = p_new_primary_user_id
    ) THEN
        RAISE EXCEPTION 'New primary is not a member of the conversation organization' USING ERRCODE = '42501';
    END IF;

    -- Lock the conversation row to avoid races with concurrent transfers
    SELECT assigned_to INTO old_primary
    FROM public.conversations
    WHERE id = p_conversation_id
    FOR UPDATE;

    -- Remove the new primary from co_owners if they were there.
    -- Needed because the prevent_primary_in_assignees trigger would otherwise
    -- fail on the UPDATE below if the same user is both primary and co-owner.
    DELETE FROM public.conversation_assignees
    WHERE conversation_id = p_conversation_id
      AND user_id = p_new_primary_user_id;

    -- Promote the new primary
    UPDATE public.conversations
    SET assigned_to = p_new_primary_user_id,
        status = 'active',
        updated_at = now()
    WHERE id = p_conversation_id;

    -- Optionally demote the old primary to co-owner
    IF p_keep_old_as_co_owner
       AND old_primary IS NOT NULL
       AND old_primary <> p_new_primary_user_id THEN
        INSERT INTO public.conversation_assignees (conversation_id, user_id, added_by)
        VALUES (p_conversation_id, old_primary, auth.uid())
        ON CONFLICT (conversation_id, user_id) DO NOTHING;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."reap_stuck_scheduled_messages"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    -- Generous on purpose: the executor's own work (Meta/QR call, media, DB
    -- writes) can legitimately take tens of seconds, and reaping a live attempt
    -- is how you get a double send.
    c_stale_after   constant interval := interval '5 minutes';
    -- Past this much lateness a requeue would deliver a message whose moment has
    -- gone. Fail it loudly instead of sending it at the wrong time.
    c_max_delay     constant interval := interval '1 hour';
    c_max_attempts  constant integer  := 3;
    v_recovered     integer;
    v_requeued      integer;
    v_exhausted     integer;
BEGIN
    UPDATE scheduled_messages
    SET status     = 'sent',
        sent_at    = COALESCE(sent_at, now()),
        updated_at = now()
    WHERE status = 'processing'
      AND COALESCE(last_attempt_at, updated_at) < now() - c_stale_after
      AND whatsapp_message_id IS NOT NULL;
    GET DIAGNOSTICS v_recovered = ROW_COUNT;

    UPDATE scheduled_messages
    SET status          = 'scheduled',
        next_attempt_at = now(),
        error_message   = COALESCE(error_message, 'Dispatch did not complete; requeued by reaper'),
        updated_at      = now()
    WHERE status = 'processing'
      AND COALESCE(last_attempt_at, updated_at) < now() - c_stale_after
      AND whatsapp_message_id IS NULL
      AND attempts < c_max_attempts
      AND scheduled_at >= now() - c_max_delay;
    GET DIAGNOSTICS v_requeued = ROW_COUNT;

    UPDATE scheduled_messages
    SET status        = 'failed',
        error_message = COALESCE(
            error_message,
            CASE
                WHEN scheduled_at < now() - c_max_delay
                    THEN format('Dispatch did not complete and the schedule is more than %s late; not sending', c_max_delay)
                ELSE format('Dispatch did not complete after %s attempts', c_max_attempts)
            END
        ),
        updated_at    = now()
    WHERE status = 'processing'
      AND COALESCE(last_attempt_at, updated_at) < now() - c_stale_after
      AND whatsapp_message_id IS NULL
      AND (attempts >= c_max_attempts OR scheduled_at < now() - c_max_delay);
    GET DIAGNOSTICS v_exhausted = ROW_COUNT;

    IF v_recovered + v_requeued + v_exhausted > 0 THEN
        RAISE LOG 'reap_stuck_scheduled_messages: % recovered as sent, % requeued, % exhausted',
            v_recovered, v_requeued, v_exhausted;
    END IF;
END;
$$;

COMMENT ON FUNCTION "public"."reap_stuck_scheduled_messages"() IS 'Resolves scheduled_messages stuck in status=processing after a dispatch that never completed. Called at the top of process_scheduled_messages() every minute.';

CREATE OR REPLACE FUNCTION "public"."record_message_receipts"("p_message_ids" "uuid"[], "p_receipts" "jsonb") RETURNS TABLE("message_id" "uuid", "delivered_count" integer, "read_count" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
#variable_conflict use_column
begin
  insert into public.message_receipts as mr
    (message_id, participant_jid, participant_phone, delivered_at, read_at)
  select
    x.m_id,
    x.pj,
    max(x.phone),
    min(x.d_at),
    max(x.r_at)
  from (
    select
      m_id,
      r->>'participant_jid' as pj,
      nullif(r->>'participant_phone', '') as phone,
      -- leitura implica entrega: todo recibo válido preenche delivered_at
      to_timestamp((r->>'ts')::double precision) as d_at,
      case when r->>'kind' = 'read'
           then to_timestamp((r->>'ts')::double precision) end as r_at
    from unnest(p_message_ids) as m_id
    cross join jsonb_array_elements(p_receipts) as r
    where coalesce(r->>'participant_jid', '') <> ''
      and (r->>'kind') in ('delivered', 'read')
      and (r->>'ts') ~ '^\d+(\.\d+)?$'
  ) x
  group by x.m_id, x.pj
  on conflict (message_id, participant_jid) do update set
    delivered_at = coalesce(mr.delivered_at, excluded.delivered_at),
    read_at = coalesce(mr.read_at, excluded.read_at),
    participant_phone = coalesce(excluded.participant_phone, mr.participant_phone),
    updated_at = now();

  return query
    select
      mr.message_id,
      count(*) filter (where mr.delivered_at is not null)::integer,
      count(*) filter (where mr.read_at is not null)::integer
    from public.message_receipts mr
    where mr.message_id = any (p_message_ids)
    group by mr.message_id;
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."record_poll_vote"("p_message_id" "uuid", "p_voter" "text", "p_voter_name" "text", "p_options" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.messages
  set metadata =
    jsonb_set(
      jsonb_set(
        metadata,
        '{poll,votes}',
        coalesce(metadata #> '{poll,votes}', '{}'::jsonb)
          || jsonb_build_object(p_voter, p_options)
      ),
      '{poll,voter_names}',
      coalesce(metadata #> '{poll,voter_names}', '{}'::jsonb)
        || jsonb_build_object(p_voter, coalesce(p_voter_name, ''))
    )
  where id = p_message_id
    and metadata ? 'poll';
end;
$$;

CREATE OR REPLACE FUNCTION "public"."refresh_conversation_last_message_on_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Cascade de DELETE em conversations: a linha-pai já está invisível quando
    -- os triggers dos filhos rodam. Sem esta guarda, apagar uma conversa com N
    -- mensagens faria N probes, cada um varrendo N entradas mortas do índice
    -- (O(N²)). Retry de envio (whatsapp-send:456) e limpeza de duplicatas no
    -- merge passam pelo caminho normal abaixo.
    IF NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = OLD.conversation_id) THEN
      RETURN OLD;
    END IF;
    PERFORM public.conversation_refresh_last_message(OLD.conversation_id);
    RETURN OLD;
  END IF;

  PERFORM public.conversation_refresh_last_message(NEW.conversation_id);
  IF OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN
    -- Mensagem movida (merge_duplicate_conversations): os dois lados.
    PERFORM public.conversation_refresh_last_message(OLD.conversation_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."release_broadcast_claims"("p_recipient_ids" "uuid"[], "p_refund_attempt" boolean DEFAULT true) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_count integer;
BEGIN
    UPDATE public.broadcast_recipients
    SET status     = 'pending',
        claimed_at = NULL,
        attempts   = GREATEST(0, attempts - CASE WHEN p_refund_attempt THEN 1 ELSE 0 END)
    WHERE id = ANY(p_recipient_ids)
      AND status = 'sending';

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."resolve_group_participant_contacts"("p_phone_number_id" "uuid", "p_phones" "text"[]) RETURNS TABLE("input_phone" "text", "conversation_id" "uuid", "contact_name" "text", "contact_phone" "text", "avatar_url" "text", "matched_phone_number_id" "uuid", "same_phone_number" boolean, "name_is_phone_like" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH scope AS MATERIALIZED (
    -- ESCOPO — a ÚNICA coisa entre esta função e todas as conversas do banco.
    -- Telefones da MESMA organização do número do grupo QUE o chamador pode
    -- acessar.
    SELECT array_agg(pn.id) AS ids
    FROM public.phone_numbers pn
    WHERE pn.id = ANY (public.get_my_conversation_phone_ids())
      AND pn.organization_id = (
        SELECT organization_id FROM public.phone_numbers WHERE id = p_phone_number_id
      )
  ),
  sector_scope AS MATERIALIZED (
    -- Isolamento por setor, calculado uma vez.
    SELECT public.get_my_open_phone_ids() AS open_ids,
           public.get_my_sector_ids() AS sector_ids
  ),
  inputs AS (
    SELECT DISTINCT regexp_replace(p, '\D', '', 'g') AS digits
    FROM unnest(coalesce(p_phones, '{}'::text[])) AS p
  ),
  candidates AS MATERIALIZED (
    SELECT i.digits, v.variation
    FROM inputs i
    CROSS JOIN LATERAL unnest(public.phone_lookup_variations(i.digits)) AS v(variation)
    WHERE length(i.digits) BETWEEN 8 AND 15
  )
  SELECT DISTINCT ON (c.digits)
    c.digits                                                AS input_phone,
    cv.id                                                   AS conversation_id,
    cv.contact_name,
    cv.contact_phone,
    coalesce(cv.contact_avatar_url, cv.contact_picture_url)  AS avatar_url,
    cv.phone_number_id                                      AS matched_phone_number_id,
    (cv.phone_number_id = p_phone_number_id)                AS same_phone_number,
    (cv.contact_name !~ '[[:alpha:]]')                      AS name_is_phone_like
  FROM candidates c
  CROSS JOIN sector_scope ss
  JOIN public.conversations cv
    ON cv.contact_phone = c.variation
   AND cv.is_group = false
   AND cv.phone_number_id = ANY ((SELECT ids FROM scope)::uuid[])
   AND (
        cv.phone_number_id = ANY (ss.open_ids)
        OR cv.sector_id IS NULL
        OR cv.sector_id = ANY (ss.sector_ids)
        OR public.user_is_assignee(cv.id, auth.uid())
   )
  ORDER BY
    c.digits,
    (cv.phone_number_id = p_phone_number_id) DESC,  -- o número do próprio grupo primeiro
    (cv.contact_name ~ '[[:alpha:]]') DESC,         -- entre duplicatas, a que tem nome de verdade
    cv.last_message_at DESC NULLS LAST,
    cv.id;
$$;

COMMENT ON FUNCTION "public"."resolve_group_participant_contacts"("p_phone_number_id" "uuid", "p_phones" "text"[]) IS 'Resolve telefones de participantes de grupo para a conversa 1:1 existente (nome/avatar). Escopo = org do número do grupo INTERSECTADO com o acesso do chamador, e com o setor do chamador quando a linha tem sector_isolation_enabled.';

CREATE OR REPLACE FUNCTION "public"."retry_broadcast_failures"("p_broadcast_id" "uuid", "p_organization_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    c_chunk          constant integer := 500;
    v_status         text;
    v_requeued       integer := 0;
    v_chunk_requeued integer;
BEGIN
    SELECT status INTO v_status
    FROM public.broadcasts
    WHERE id = p_broadcast_id
      AND organization_id = p_organization_id
    FOR UPDATE;

    IF v_status IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;

    -- Só estado terminal-com-falha. Retry num 'cancelled' ressuscitaria o que
    -- alguém acabou de parar; num 'scheduled' dispararia a campanha inteira
    -- adiantada; num 'draft' publicaria uma lista possivelmente incompleta;
    -- num 'processing' é redundante (o driver já está alimentando workers).
    IF v_status NOT IN ('completed', 'failed') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'not_retryable',
            'status', v_status
        );
    END IF;

    -- 1. Requeue PRIMEIRO. Enquanto o pai continua terminal, o DRIVER o ignora
    --    (exige 'processing'), então não há worker competindo com este UPDATE.
    LOOP
        WITH batch AS (
            SELECT id
            FROM public.broadcast_recipients
            WHERE broadcast_id = p_broadcast_id
              AND status = 'failed'
            LIMIT c_chunk
        )
        UPDATE public.broadcast_recipients r
        SET status        = 'pending',
            attempts      = 0,
            claimed_at    = NULL,
            error_message = NULL
        FROM batch
        WHERE r.id = batch.id;

        GET DIAGNOSTICS v_chunk_requeued = ROW_COUNT;
        v_requeued := v_requeued + v_chunk_requeued;
        EXIT WHEN v_chunk_requeued < c_chunk;
    END LOOP;

    IF v_requeued = 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'nothing_to_retry');
    END IF;

    -- 2. Reabre DEPOIS. Na ordem inversa, o FINALIZER (cron de 1 minuto) veria
    --    um 'processing' sem nada pendente e o reconcluiria antes das linhas
    --    voltarem -- e um disparo 'completed' com linhas 'pending' nunca mais é
    --    despachado por ninguém.
    UPDATE public.broadcasts
    SET status       = 'processing',
        completed_at = NULL,
        updated_at   = now()
    WHERE id = p_broadcast_id;

    RETURN jsonb_build_object('ok', true, 'requeued', v_requeued);
END;
$$;

COMMENT ON FUNCTION "public"."retry_broadcast_failures"("p_broadcast_id" "uuid", "p_organization_id" "uuid") IS 'Reenfileira os destinatários falhados de um disparo terminal (requeue antes de reabrir o pai, attempts zerado) e devolve o pai para processing. Escopo de tenant por parâmetro.';

CREATE OR REPLACE FUNCTION "public"."scheduled_messages_autor_e_arquivos"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    -- Só o usuário logado (front pelo PostgREST). service_role (executor,
    -- echo-api), cron e postgres passam direto.
    IF coalesce(auth.role(), '') <> 'authenticated' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.created_by := auth.uid();
    ELSE
        NEW.created_by := OLD.created_by;
        NEW.media := OLD.media;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."scheduled_messages_autor_e_arquivos"() IS 'Trigger de scheduled_messages: para authenticated, created_by = auth.uid() no INSERT e created_by/media imutáveis no UPDATE (o executor confere o caminho do arquivo contra o created_by).';

CREATE OR REPLACE FUNCTION "public"."search_messages"("p_phone_number_id" "uuid", "p_search_term" "text", "p_direction" "text" DEFAULT NULL::"text", "p_message_types" "text"[] DEFAULT NULL::"text"[], "p_date_from" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_date_to" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_has_media" boolean DEFAULT NULL::boolean, "p_limit" integer DEFAULT 50) RETURNS TABLE("id" "uuid", "content" "text", "created_at" timestamp with time zone, "direction" "text", "message_type" "text", "conversation_id" "uuid", "contact_name" "text", "contact_phone" "text", "is_group" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth', 'extensions'
    AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_super BOOLEAN;
    v_open_ids UUID[];
    v_sector_ids UUID[];
    v_co_owned UUID[];
BEGIN
    -- Return empty if no user or search term too short
    IF v_user_id IS NULL OR LENGTH(TRIM(p_search_term)) < 2 THEN
        RETURN;
    END IF;

    -- Escopo por linha: agent só busca nas linhas atribuídas;
    -- admin nas linhas da org; super admin em qualquer uma.
    v_is_super := public.auth_is_super_admin();
    IF NOT v_is_super
       AND NOT public.user_can_access_phone_line(p_phone_number_id) THEN
        RETURN;
    END IF;

    -- Os conjuntos do recorte por setor, resolvidos UMA vez (chamada direta
    -- no WHERE rodaria por linha de conversa).
    v_open_ids := public.get_my_open_phone_ids();
    v_sector_ids := public.get_my_sector_ids();
    v_co_owned := public.get_my_co_owned_conversation_ids();

    RETURN QUERY
    WITH accessible_conversations AS (
        -- A autorização por LINHA já aconteceu acima, uma vez; aqui fica o
        -- recorte por SETOR, que é por conversa e não por linha.
        SELECT c.id, c.contact_name, c.contact_phone, c.is_group
        FROM conversations c
        WHERE c.phone_number_id = p_phone_number_id
          AND (
              v_is_super
              OR c.phone_number_id = ANY (v_open_ids)
              OR c.sector_id IS NULL
              OR c.sector_id = ANY (v_sector_ids)
              OR c.assigned_to = v_user_id
              OR c.id = ANY (v_co_owned)
          )
    )
    SELECT
        m.id,
        m.content,
        m.created_at,
        m.direction,
        m.message_type,
        m.conversation_id,
        ac.contact_name,
        ac.contact_phone,
        ac.is_group
    FROM messages m
    INNER JOIN accessible_conversations ac ON ac.id = m.conversation_id
    WHERE m.content ILIKE '%' || TRIM(p_search_term) || '%'
      -- Optional filters
      AND (p_direction IS NULL OR m.direction = p_direction)
      AND (p_message_types IS NULL OR m.message_type = ANY(p_message_types))
      AND (p_date_from IS NULL OR m.created_at >= p_date_from)
      AND (p_date_to IS NULL OR m.created_at < p_date_to)
      AND (
          p_has_media IS NULL
          OR (p_has_media = TRUE AND m.message_type IN ('image', 'video', 'audio', 'ptt', 'document', 'sticker'))
          OR (p_has_media = FALSE AND (m.message_type IS NULL OR m.message_type = 'text'))
      )
    ORDER BY m.created_at DESC
    LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."send_pipeline_heartbeat"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    c_window constant interval := interval '8 hours';

    v_inbound      integer;
    v_outbound     integer;
    v_hard         integer;
    v_undec        integer;
    v_cron_fail    integer;
    v_cron_ok      integer;
    v_probe        public.qr_health_probe;
    v_active_alerts text;

    v_media_total  integer;
    v_media_conv   integer;
    v_media_chan   integer;
    v_media_nokey  integer;
    v_media_net    integer;
    v_media_crypt  integer;
    v_media_other  integer;
    v_media_causes text;

    v_healthy      boolean;
    v_title        text;
    v_summary      text;
    v_details      jsonb;
    v_url          text;
    v_key          text;
begin
    select count(*) filter (where direction = 'inbound'),
           count(*) filter (where direction = 'outbound')
      into v_inbound, v_outbound
      from public.messages
     where created_at > now() - c_window;

    -- Mesma lista de actions duras do check_message_failure_alerts.
    select count(*) filter (where action in ('msg_write_failed','msg_write_degraded','msg_payload_invalid',
                                             'msg_handler_throw','msg_drop_unhandled','webhook_dead','webhook_spilled')
                               or action like 'handler_throw%'),
           count(*) filter (where action = 'msg_drop_undecrypted')
      into v_hard, v_undec
      from public.qr_message_log
     where created_at > now() - c_window;

    -- Falhas de mídia: uma linha por message_id, preferindo a que traz o
    -- diagnóstico do serviço (a outra é o payload gravado pela edge).
    with raw as (
        select l.message_id, l.to_jid, l.baileys_result,
               row_number() over (partition by l.message_id
                                  order by (l.baileys_result->>'last_error_code' is not null) desc,
                                           l.created_at desc) as rn
          from public.qr_message_log l
         where l.action = 'media_download_failed'
           and l.created_at > now() - c_window
    ), f as (
        select to_jid,
               coalesce(baileys_result->>'last_error_code', '') as code,
               coalesce(baileys_result->>'last_error', '')      as msg
          from raw where rn = 1
    )
    select count(*),
           count(*) filter (where to_jid not like '%@newsletter%'),
           count(*) filter (where to_jid like '%@newsletter%'),
           count(*) filter (where code in ('MEDIA_NOT_FOUND','MEDIA_UNKNOWN')
                               or msg ilike '%empty media key%'),
           count(*) filter (where code in ('MEDIA_NETWORK','ENOTFOUND')
                               or msg ilike '%fetch failed%'),
           count(*) filter (where code in ('MEDIA_EXPIRED','ERR_OSSL_BAD_DECRYPT')
                               or msg ilike '%bad decrypt%')
      into v_media_total, v_media_conv, v_media_chan, v_media_nokey, v_media_net, v_media_crypt
      from f;

    v_media_other := greatest(v_media_total - v_media_nokey - v_media_net - v_media_crypt, 0);

    v_media_causes := nullif(concat_ws(' · ',
        case when v_media_nokey > 0 then format('sem mediaKey %s', v_media_nokey) end,
        case when v_media_net   > 0 then format('rede %s',         v_media_net)   end,
        case when v_media_crypt > 0 then format('decrypt %s',      v_media_crypt) end,
        case when v_media_other > 0 then format('outros %s',       v_media_other) end), '');

    -- Os dois detectores rodaram e terminaram bem?
    select count(*) filter (where d.status = 'succeeded'),
           count(*) filter (where d.status <> 'succeeded')
      into v_cron_ok, v_cron_fail
      from cron.job_run_details d
      join cron.job j on j.jobid = d.jobid
     where j.jobname in ('check-message-failure-alerts', 'qr-service-health')
       and d.start_time > now() - c_window;

    select * into v_probe from public.qr_health_probe where id;

    select string_agg(alert_key, ', ') into v_active_alerts
      from public.system_alert_state where active_since is not null;

    v_healthy := v_probe.consecutive_unreachable = 0
             and v_probe.consecutive_stalled = 0
             and v_active_alerts is null
             and v_cron_ok > 0;

    v_title := case when v_healthy
                    then 'Tudo OK no Echo — últimas 8 horas'
                    else 'Resumo do Echo com pendências — últimas 8 horas' end;

    v_summary := format(
        '%s mensagens recebidas e %s enviadas. qr-service %s (v%s, %s sessões). %s',
        v_inbound, v_outbound,
        case when v_probe.consecutive_unreachable = 0 then 'respondendo' else 'SEM RESPOSTA' end,
        coalesce(v_probe.last_health->>'version', '?'),
        coalesce(v_probe.last_health->>'sessions', '?'),
        case when v_active_alerts is null then 'Nenhum alerta ativo.'
             else 'Alertas ativos: ' || v_active_alerts || '.' end);

    v_details := jsonb_build_array(
        jsonb_build_object('label', 'Mensagens recebidas',          'value', v_inbound::text),
        jsonb_build_object('label', 'Mensagens enviadas',           'value', v_outbound::text),
        jsonb_build_object('label', 'Falhas duras de processamento','value', v_hard::text),
        jsonb_build_object('label', 'Indecifráveis (ruído normal)', 'value', v_undec::text),
        jsonb_build_object('label', 'Downloads de mídia falhos (conversas)', 'value', v_media_conv::text),
        jsonb_build_object('label', 'Mídia falha em canais (sem mediaKey, esperado)',
            'value', v_media_chan::text),
        jsonb_build_object('label', 'Causa das falhas de mídia',
            'value', coalesce(v_media_causes, 'nenhuma')),
        jsonb_build_object('label', 'Fila em disco do qr-service',  'value', coalesce(v_probe.last_health->>'outbox_disk', '?')),
        jsonb_build_object('label', 'Última resposta do qr-service',
            'value', coalesce(to_char(v_probe.last_ok_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'nenhuma')),
        jsonb_build_object('label', 'Execuções dos detectores (ok / falha)',
            'value', format('%s / %s', v_cron_ok, v_cron_fail)));

    BEGIN
        v_key := public._segredo_obrigatorio('service_role_key');
        v_url := public._segredo_obrigatorio('project_url');
    EXCEPTION WHEN SQLSTATE '55000' THEN
        RAISE WARNING 'send_pipeline_heartbeat: % (notificação não enviada)', SQLERRM;
        RETURN;
    END;

    perform net.http_post(
        url     := v_url || '/functions/v1/send-failure-alert',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key),
        body    := jsonb_build_object(
            'alert_key', 'pipeline_heartbeat',
            'count', v_hard,
            'window_minutes', 480,
            'tone', case when v_healthy then 'ok' else 'alert' end,
            'title', v_title,
            'summary', v_summary,
            'details', v_details,
            'hint', 'Heartbeat automático a cada 8h (22h, 06h, 14h). Se este e-mail parar de chegar, o canal de alerta está quebrado.'));
end;
$$;

COMMENT ON FUNCTION "public"."send_pipeline_heartbeat"() IS 'Prova de vida do canal de alerta: a cada 8h envia por send-failure-alert (tone=ok) o resumo do período — volume, falhas (mídia deduplicada por message_id, separando conversa de canal e nomeando a causa), saúde do qr-service e execuções dos detectores. Cron pipeline-heartbeat.';

CREATE OR REPLACE FUNCTION "public"."set_ai_api_key"("p_org_id" "uuid", "p_raw_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    -- Authorization check: user must be admin of the org
    IF NOT EXISTS (
        SELECT 1 FROM public.organization_members 
        WHERE organization_id = p_org_id 
        AND user_id = auth.uid() 
        AND role = 'admin'
    ) AND NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND is_super_admin = true
    ) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    -- A passphrase vem do segredo ai_key_secret do Vault (a mesma que get_decrypted_ai_key usa: mude nas duas).
    UPDATE public.organizations
    SET ai_api_key_encrypted = pgp_sym_encrypt(p_raw_key, public._segredo_obrigatorio('ai_key_secret')),
        ai_api_key = NULL -- Clear the plain text key
    WHERE id = p_org_id;

END;
$$;

CREATE OR REPLACE FUNCTION "public"."set_conversation_manual_unread"("p_conversation_id" "uuid", "p_unread" boolean) RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO 'public'
    AS $$
    INSERT INTO conversation_reads (user_id, conversation_id, last_read_at, marked_unread_at)
    SELECT auth.uid(), p_conversation_id, now(),
           CASE WHEN p_unread THEN now() ELSE NULL END
    WHERE auth.uid() IS NOT NULL
      AND p_conversation_id IS NOT NULL
      AND EXISTS (
          SELECT 1
          FROM conversations c
          WHERE c.id = p_conversation_id
            AND c.phone_number_id = ANY (public.get_my_conversation_phone_ids())
      )
    ON CONFLICT (user_id, conversation_id)
    DO UPDATE SET marked_unread_at = CASE WHEN p_unread THEN now() ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION "public"."share_contact_avatar_across_lines"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_org uuid;
  v_key text;
  v_url text;
  v_at timestamptz;
BEGIN
  -- O UPDATE feito aqui dentro dispara este mesmo gatilho nas irmãs: corta no 2º nível.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.is_group OR NEW.channel IS NOT DISTINCT FROM 'instagram' OR NEW.contact_phone IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT pn.organization_id INTO v_org
    FROM public.phone_numbers pn
   WHERE pn.id = NEW.phone_number_id;
  IF v_org IS NULL THEN
    RETURN NEW;
  END IF;

  v_key := coalesce(public.br_phone_key(NEW.contact_phone),
                    pg_catalog.regexp_replace(NEW.contact_phone, '\D', '', 'g'));
  IF v_key IS NULL OR v_key = '' THEN
    RETURN NEW;
  END IF;

  -- PUXAR (BEFORE INSERT): conversa nova sem foto herda a mais nova das irmãs.
  IF TG_WHEN = 'BEFORE' THEN
    IF NEW.contact_avatar_url IS NOT NULL THEN
      RETURN NEW;
    END IF;
    SELECT c.contact_avatar_url, c.contact_avatar_updated_at
      INTO v_url, v_at
      FROM public.conversations c
      JOIN public.phone_numbers pn ON pn.id = c.phone_number_id
     WHERE pn.organization_id = v_org
       AND c.is_group = false
       AND c.channel IS DISTINCT FROM 'instagram'
       AND c.contact_avatar_url IS NOT NULL
       AND coalesce(public.br_phone_key(c.contact_phone),
                    pg_catalog.regexp_replace(c.contact_phone, '\D', '', 'g')) = v_key
     ORDER BY c.contact_avatar_updated_at DESC NULLS LAST
     LIMIT 1;
    IF v_url IS NOT NULL THEN
      NEW.contact_avatar_url := v_url;
      NEW.contact_avatar_updated_at := coalesce(v_at, now());
    END IF;
    RETURN NEW;
  END IF;

  -- EMPURRAR (AFTER): só quando a foto mudou de verdade.
  IF NEW.contact_avatar_url IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.contact_avatar_url IS NOT DISTINCT FROM NEW.contact_avatar_url
     AND OLD.contact_avatar_updated_at IS NOT DISTINCT FROM NEW.contact_avatar_updated_at THEN
    RETURN NEW;
  END IF;

  v_at := coalesce(NEW.contact_avatar_updated_at, now());

  UPDATE public.conversations t
     SET contact_avatar_url = NEW.contact_avatar_url,
         contact_avatar_updated_at = v_at
    FROM public.phone_numbers pn
   WHERE pn.id = t.phone_number_id
     AND pn.organization_id = v_org
     AND t.id <> NEW.id
     AND t.is_group = false
     AND t.channel IS DISTINCT FROM 'instagram'
     AND t.contact_avatar_url IS DISTINCT FROM NEW.contact_avatar_url
     AND (t.contact_avatar_url IS NULL
          OR coalesce(t.contact_avatar_updated_at, '-infinity'::timestamptz) < v_at)
     AND coalesce(public.br_phone_key(t.contact_phone),
                  pg_catalog.regexp_replace(t.contact_phone, '\D', '', 'g')) = v_key;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "public"."snooze_system_alert"("p_key" "text", "p_hours" numeric DEFAULT 4) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    -- Só a operação silencia alerta global: service_role, super admin ou
    -- sessão direta no banco (SQL editor/cron, sem JWT e fora do PostgREST).
    IF NOT (
        coalesce(auth.role(), '') = 'service_role'
        OR (SELECT public.auth_is_super_admin())
        OR (coalesce(auth.role(), '') = '' AND session_user <> 'authenticator')
    ) THEN
        RAISE EXCEPTION 'somente super admin ou service_role pode silenciar alertas'
            USING ERRCODE = '42501';
    END IF;

    UPDATE system_alert_state
       -- Multiplicação de interval aceita numeric (0.5 = 30 min).
       SET snoozed_until = now() + p_hours * interval '1 hour',
           updated_at = now()
     WHERE alert_key = p_key;

    UPDATE system_alerts SET is_active = false, updated_at = now()
     WHERE id = (SELECT system_alert_id FROM system_alert_state WHERE alert_key = p_key);
END;
$$;

CREATE OR REPLACE FUNCTION "public"."touch_broadcast_recipient"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."trg_compartilhar_tira_de_disparos"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  UPDATE public.conversations
     SET disparo_desde         = NULL,
         ia_desde              = NULL,
         ia_sem_resposta_desde = NULL
   WHERE id = NEW.conversation_id
     AND (disparo_desde IS NOT NULL OR ia_desde IS NOT NULL);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."trg_conversa_dono_e_aba_disparos"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  IF NEW.assigned_to IS NOT NULL THEN
    NEW.disparo_desde := NULL;
    NEW.ia_desde := NULL;
    NEW.ia_sem_resposta_desde := NULL;
  ELSIF OLD.assigned_to IS NOT NULL
        AND NEW.disparo_desde IS NULL
        AND NEW.disparo_origem IS NOT NULL   -- já passou pela aba Disparos
        AND NEW.status IS DISTINCT FROM 'closed'
        AND NOT EXISTS (SELECT 1 FROM public.messages m
                         WHERE m.conversation_id = NEW.id
                           AND m.direction = 'inbound'
                           AND NOT m.is_imported
                           AND m.message_type NOT IN ('button_reply', 'list_reply', 'nfm_reply', 'reaction', 'group_action')
                           AND NOT (m.message_type = 'unsupported' AND m.metadata IS NULL)) THEN
    NEW.disparo_desde := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."trg_conversation_close_lifecycle"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.status = 'closed' THEN
    NEW.closed_at := COALESCE(NEW.closed_at, now());
  ELSE
    NEW.closed_at    := NULL;
    NEW.close_reason := NULL;
    NEW.closed_by    := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."trg_conversation_close_lifecycle"() IS 'Dono do invariante closed_at/close_reason/closed_by: preenche closed_at ao entrar em closed, zera os três ao sair. Só roda em transição real de status.';

CREATE OR REPLACE FUNCTION "public"."trg_normalize_conversation_phone"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    -- Grupo: a identidade (e o destino do envio) é o JID. Nunca um telefone.
    IF NEW.is_group = true THEN
        IF NEW.group_jid IS NOT NULL THEN
            NEW.contact_phone := NEW.group_jid;
        END IF;
        RETURN NEW;
    END IF;

    -- Direct do Instagram não tem telefone
    IF NEW.channel = 'instagram' THEN
        RETURN NEW;
    END IF;

    -- Only clean non-numeric characters, preserve exact number
    -- Do NOT add 55 prefix - user is responsible for entering complete number
    NEW.contact_phone := regexp_replace(NEW.contact_phone, '\D', '', 'g');

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."trg_resposta_movida_tira_de_disparos"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  UPDATE public.conversations
     SET disparo_desde = NULL
   WHERE id = NEW.conversation_id
     AND disparo_desde IS NOT NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."trg_setor_segue_dono"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_ligado boolean;
  v_setor  uuid;
BEGIN
  SELECT pn.sector_isolation_enabled AND pn.sector_follows_owner
    INTO v_ligado
    FROM public.phone_numbers pn
   WHERE pn.id = NEW.phone_number_id;

  IF NOT COALESCE(v_ligado, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.assigned_to IS NULL THEN
    NEW.sector_id := NULL;
    RETURN NEW;
  END IF;

  -- O setor que o comando trouxe é um setor do dono nesta linha: fica.
  IF NEW.sector_id IS NOT NULL AND EXISTS (
       SELECT 1
         FROM public.sectors s
         JOIN public.sector_members sm ON sm.sector_id = s.id
        WHERE s.id = NEW.sector_id
          AND s.phone_number_id = NEW.phone_number_id
          AND sm.user_id = NEW.assigned_to) THEN
    RETURN NEW;
  END IF;

  SELECT s.id
    INTO v_setor
    FROM public.sectors s
    JOIN public.sector_members sm ON sm.sector_id = s.id
    LEFT JOIN public.organization_members om
           ON om.user_id = NEW.assigned_to
          AND om.organization_id = s.organization_id
   WHERE s.phone_number_id = NEW.phone_number_id
     AND sm.user_id = NEW.assigned_to
   ORDER BY (om.sector_id IS NOT DISTINCT FROM s.id) DESC, s.created_at, s.id
   LIMIT 1;

  NEW.sector_id := v_setor;  -- NULL quando o dono não tem setor nesta linha
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."trg_setor_segue_dono_avisa"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_ligado boolean;
  v_org    uuid;
  v_user   uuid;
BEGIN
  SELECT pn.sector_isolation_enabled AND pn.sector_follows_owner, pn.organization_id
    INTO v_ligado, v_org
    FROM public.phone_numbers pn
   WHERE pn.id = NEW.phone_number_id;

  IF NOT COALESCE(v_ligado, false) THEN
    RETURN NULL;
  END IF;

  FOR v_user IN
    SELECT DISTINCT upn.user_id
      FROM public.user_phone_numbers upn
     WHERE upn.phone_number_id = NEW.phone_number_id
       AND upn.user_id IS DISTINCT FROM NEW.assigned_to
       AND upn.user_id IS DISTINCT FROM auth.uid()
       AND NOT EXISTS (SELECT 1 FROM public.organization_members om
                        WHERE om.user_id = upn.user_id
                          AND om.organization_id = v_org
                          AND om.role = 'admin')
  LOOP
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('conversationId', NEW.id),
        'conversation-left-scope',
        'user-' || v_user || '-notifications',
        false
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'setor_segue_dono: aviso para % falhou: %', v_user, SQLERRM;
    END;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."trg_status_do_disparo"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  UPDATE public.conversations
     SET disparo_status = NEW.status
   WHERE id = NEW.conversation_id
     AND disparo_msg_id = NEW.id
     AND disparo_status IS DISTINCT FROM NEW.status;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."trigger_automation_flow_atomic"("p_flow_id" "uuid", "p_conversation_id" "uuid", "p_cooldown_minutes" integer, "p_context" "jsonb", "p_start_node_id" "text") RETURNS TABLE("session_id" "uuid", "status" "text", "message" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
    v_cooldown_interval INTERVAL;
    v_last_execution TIMESTAMPTZ;
    v_session_id UUID;
    v_inserted_id UUID;
BEGIN
    -- Set default cooldown if null
    v_cooldown_interval := (COALESCE(p_cooldown_minutes, 30) || ' minutes')::interval;

    -- Lock the conversation row to serialize access for this conversation
    -- This key-based lock prevents concurrent checks for the same conversation
    PERFORM pg_advisory_xact_lock(hashtext('automation_flow_' || p_conversation_id::text || '_' || p_flow_id::text));

    -- Check for recent execution
    SELECT created_at INTO v_last_execution
    FROM public.automation_sessions
    WHERE flow_id = p_flow_id
    AND conversation_id = p_conversation_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_last_execution IS NOT NULL AND (NOW() - v_last_execution) < v_cooldown_interval THEN
        RETURN QUERY SELECT
            NULL::UUID,
            'cooldown_active'::TEXT,
            'Flow is on cooldown. Last execution: ' || v_last_execution::TEXT;
        RETURN;
    END IF;

    -- Create new session if no cooldown
    -- expires_at = 24 hours from now (safety net for orphaned sessions)
    INSERT INTO public.automation_sessions (
        flow_id,
        conversation_id,
        current_node_id,
        context,
        status,
        created_at,
        expires_at
    ) VALUES (
        p_flow_id,
        p_conversation_id,
        p_start_node_id,
        p_context,
        'active',
        NOW(),
        NOW() + INTERVAL '24 hours'
    )
    RETURNING id INTO v_inserted_id;

    RETURN QUERY SELECT
        v_inserted_id,
        'success'::TEXT,
        'Session created successfully'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_automation_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_broadcast_counts"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    -- Handle INSERT
    IF (TG_OP = 'INSERT') THEN
        UPDATE broadcasts 
        SET 
            total_recipients = total_recipients + 1,
            sent_count = sent_count + CASE WHEN NEW.status = 'sent' THEN 1 ELSE 0 END,
            failed_count = failed_count + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
            updated_at = NOW()
        WHERE id = NEW.broadcast_id;
        
    -- Handle UPDATE: combine decrement (old) and increment (new) in single expression
    ELSIF (TG_OP = 'UPDATE') THEN
        IF (OLD.status IS DISTINCT FROM NEW.status) THEN
            UPDATE broadcasts 
            SET 
                sent_count = sent_count 
                    - CASE WHEN OLD.status = 'sent' THEN 1 ELSE 0 END 
                    + CASE WHEN NEW.status = 'sent' THEN 1 ELSE 0 END,
                failed_count = failed_count 
                    - CASE WHEN OLD.status = 'failed' THEN 1 ELSE 0 END 
                    + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
                updated_at = NOW()
            WHERE id = NEW.broadcast_id;
        END IF;
        
    -- Handle DELETE
    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE broadcasts 
        SET 
            total_recipients = total_recipients - 1,
            sent_count = sent_count - CASE WHEN OLD.status = 'sent' THEN 1 ELSE 0 END,
            failed_count = failed_count - CASE WHEN OLD.status = 'failed' THEN 1 ELSE 0 END,
            updated_at = NOW()
        WHERE id = OLD.broadcast_id;
    END IF;
    
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_broadcasts_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_conversation_last_message_at"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_content    text;
  v_type       text;
  v_direction  text;
  v_is_deleted boolean;
  v_disparo    jsonb;
  v_campanha   text;
  v_ia         jsonb;
  v_conv       record;
  v_resposta   boolean;
  v_de_gente   boolean;
BEGIN
  -- Lock da conversa antes do probe (mesma razão de conversation_refresh_last_message).
  SELECT c.status, c.assigned_to, c.disparo_desde, c.ia_desde
    INTO v_conv
    FROM public.conversations c
   WHERE c.id = NEW.conversation_id
     FOR UPDATE;

  -- AFTER INSERT: NEW já é visível, o probe devolve sempre >= 1 linha.
  SELECT left(m.content, 200), m.message_type, m.direction, m.is_deleted
    INTO v_content, v_type, v_direction, v_is_deleted
    FROM public.messages m
   WHERE m.conversation_id = NEW.conversation_id
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1;

  -- Mensagem da IA em conversa que não é de gente: entra (ou continua) em Com a IA.
  -- Conversa com dono, ou aberta em que alguém do time já escreveu, segue o caminho
  -- comum lá embaixo.
  IF NEW.direction = 'outbound' AND NOT NEW.is_imported
     AND jsonb_typeof(NEW.metadata -> 'ia') = 'object'
     AND (v_conv.ia_desde IS NOT NULL
          OR (v_conv.assigned_to IS NULL
              AND (v_conv.status = 'closed'
                   OR NOT EXISTS (SELECT 1 FROM public.messages m
                                   WHERE m.conversation_id = NEW.conversation_id
                                     AND m.id <> NEW.id
                                     AND m.direction = 'outbound'
                                     AND NOT m.is_imported
                                     AND m.message_type <> 'group_action'
                                     AND (m.sent_by IS NOT NULL
                                          OR (m.metadata -> 'disparo' IS NULL
                                              AND m.metadata -> 'ia' IS NULL
                                              AND m.metadata ->> 'template_name' IS NULL
                                              AND (m.metadata ->> 'automacao') IS DISTINCT FROM 'true')))))) THEN
    v_ia := NEW.metadata -> 'ia';
    UPDATE public.conversations c
       SET last_message_at = GREATEST(COALESCE(c.last_message_at, NEW.created_at), NEW.created_at),
           -- Mesma razão de Disparos: 'waiting' e 'pending' viram 'active' para o
           -- auto-close de 30 dias encerrar a conversa parada.
           status          = CASE WHEN c.status IN ('closed', 'waiting', 'pending') THEN 'active' ELSE c.status END,
           ia_desde        = COALESCE(c.ia_desde, NEW.created_at),
           ia_origem       = COALESCE(NULLIF(btrim(left(v_ia ->> 'origem', 40)), ''), c.ia_origem, 'ia'),
           -- A IA respondeu: a rede de segurança zera.
           ia_sem_resposta_desde = NULL,
           -- A IA assumiu: a conversa deixa de ser só disparo.
           disparo_desde   = NULL,
           last_message_content    = v_content,
           last_message_type       = v_type,
           last_message_direction  = v_direction,
           last_message_is_deleted = v_is_deleted
     WHERE c.id = NEW.conversation_id;
    RETURN NEW;
  END IF;

  IF NEW.direction = 'outbound' AND NOT NEW.is_imported
     AND jsonb_typeof(NEW.metadata -> 'disparo') = 'object' THEN
    v_disparo   := NEW.metadata -> 'disparo';
    v_campanha := NULLIF(btrim(left(v_disparo ->> 'campanha', 120)), '');

    -- Disparo para quem já está sendo atendido (pelo time ou pela IA): a conversa
    -- fica onde está. Só a prévia acompanha (é o que conversation_refresh_last_message faria).
    IF v_conv.disparo_desde IS NULL
       AND v_conv.status IS DISTINCT FROM 'closed'
       AND (
            v_conv.ia_desde IS NOT NULL
         OR v_conv.assigned_to IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.messages m
                     WHERE m.conversation_id = NEW.conversation_id
                       AND m.direction = 'inbound'
                       AND NOT m.is_imported
                       AND m.message_type NOT IN ('button_reply', 'list_reply', 'nfm_reply', 'reaction', 'group_action')
                       AND NOT (m.message_type = 'unsupported' AND m.metadata IS NULL))
         -- Conversa de gente: envio com autor, ou texto que não é disparo, nem
         -- modelo, nem robô (integrações pela API e o aparelho mandam sem autor). Modelo sem
         -- marca conta como disparo.
         OR EXISTS (SELECT 1 FROM public.messages m
                     WHERE m.conversation_id = NEW.conversation_id
                       AND m.direction = 'outbound'
                       AND NOT m.is_imported
                       AND m.message_type <> 'group_action'
                       AND (m.sent_by IS NOT NULL
                            OR (m.metadata -> 'disparo' IS NULL
                                AND m.metadata ->> 'template_name' IS NULL
                                AND (m.metadata ->> 'automacao') IS DISTINCT FROM 'true')))
       ) THEN
      UPDATE public.conversations
         SET last_message_content    = v_content,
             last_message_type       = v_type,
             last_message_direction  = v_direction,
             last_message_is_deleted = v_is_deleted
       WHERE id = NEW.conversation_id;
      RETURN NEW;
    END IF;

    UPDATE public.conversations c
       SET last_message_at    = GREATEST(COALESCE(c.last_message_at, NEW.created_at), NEW.created_at),
           -- 'waiting' (conversa nova da echo-api) e 'pending' viram 'active': o
           -- auto-close de 30 dias só olha 'active', e disparo sem resposta tem de
           -- sair sozinho para Encerrados como toda conversa parada.
           status             = CASE WHEN c.status IN ('closed', 'waiting', 'pending') THEN 'active' ELSE c.status END,
           disparo_desde      = COALESCE(c.disparo_desde, NEW.created_at),
           disparo_origem     = COALESCE(NULLIF(btrim(left(v_disparo ->> 'origem', 40)), ''), c.disparo_origem, 'disparo'),
           disparo_msg_id     = NEW.id,
           disparo_status     = NEW.status,
           disparo_rotulo     = COALESCE(NULLIF(btrim(left(v_disparo ->> 'rotulo', 80)), ''), c.disparo_rotulo),
           disparo_campanhas = CASE
                                  WHEN v_campanha IS NULL THEN
                                    CASE WHEN c.disparo_desde IS NULL THEN NULL ELSE c.disparo_campanhas END
                                  WHEN c.disparo_desde IS NULL THEN ARRAY[v_campanha]
                                  ELSE (ARRAY[v_campanha] || array_remove(COALESCE(c.disparo_campanhas, '{}'), v_campanha))[1:10]
                                END,
           last_message_content    = v_content,
           last_message_type       = v_type,
           last_message_direction  = v_direction,
           last_message_is_deleted = v_is_deleted
     WHERE c.id = NEW.conversation_id;
    RETURN NEW;
  END IF;

  -- A pessoa respondeu de verdade. Reação, evento de grupo e a bolha fantasma
  -- do QR ('unsupported' sem metadata) nunca contam; 'unsupported' com
  -- original_type/degraded_reason é mensagem real da pessoa e conta. Toque em botão, lista ou Flow também conta:
  -- sobe para o time (melhor ver a mais que perder).
  -- Tira de Disparos, nunca de Com a IA: quem responde é a IA.
  v_resposta := NEW.direction = 'inbound'
            AND NOT NEW.is_imported
            AND NEW.message_type NOT IN ('reaction', 'group_action')
            AND NOT (NEW.message_type = 'unsupported' AND NEW.metadata IS NULL);
  -- Saiu mensagem que não é disparo, nem robô (automação do Echo grava
  -- metadata.automacao), nem IA: alguém agiu na conversa (painel, API,
  -- aparelho). Com autor, o autor vira dono abaixo.
  v_de_gente := NEW.direction = 'outbound'
            AND NOT NEW.is_imported
            AND NEW.message_type <> 'group_action'
            AND (NEW.metadata ->> 'automacao') IS DISTINCT FROM 'true'
            AND jsonb_typeof(NEW.metadata -> 'ia') IS DISTINCT FROM 'object';

  UPDATE public.conversations
     SET last_message_at = GREATEST(COALESCE(last_message_at, NEW.created_at), NEW.created_at),
         status = CASE
                    WHEN NEW.direction = 'inbound'
                     AND NEW.is_imported = false
                     AND status = 'closed' THEN 'active'
                    ELSE status
                  END,
         -- Quem manda a primeira mensagem numa conversa sem dono passa a ser o dono,
         -- em qualquer aba (antes: só Disparos e Com a IA). Só envio com autor:
         -- automação, IA, disparo e eco do aparelho não assumem por ninguém.
         -- Reação não é mensagem. Conversa encerrada também assume: a próxima
         -- inbound a reabre já com dono.
         assigned_to = CASE
                         WHEN v_de_gente AND assigned_to IS NULL
                              AND NEW.sent_by IS NOT NULL
                              AND NEW.message_type <> 'reaction'
                           THEN NEW.sent_by
                         ELSE assigned_to
                       END,
         disparo_desde = CASE
                           WHEN v_conv.disparo_desde IS NOT NULL AND (v_resposta OR v_de_gente) THEN NULL
                           ELSE disparo_desde
                         END,
         ia_desde = CASE
                      WHEN v_conv.ia_desde IS NOT NULL AND v_de_gente THEN NULL
                      ELSE ia_desde
                    END,
         -- A pessoa escreveu com a IA atendendo: começa a contar (só a primeira).
         -- Disparo e automação não respondem por ela; gente do time, sim.
         ia_sem_resposta_desde = CASE
                                   WHEN v_conv.ia_desde IS NOT NULL AND v_de_gente THEN NULL
                                   WHEN v_conv.ia_desde IS NOT NULL AND v_resposta
                                     THEN COALESCE(ia_sem_resposta_desde, NEW.created_at)
                                   ELSE ia_sem_resposta_desde
                                 END,
         last_message_content    = v_content,
         last_message_type       = v_type,
         last_message_direction  = v_direction,
         last_message_is_deleted = v_is_deleted
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_phone_number_sessions_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_scheduled_messages_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."user_can_access_conversation"("conv_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = conv_id
        AND (
            -- Responsável e coproprietário nunca perdem a conversa, mesmo fora
            -- do setor deles: é o que sustenta o encaminhamento com custódia.
            c.assigned_to = auth.uid()
            OR EXISTS (
                SELECT 1 FROM conversation_assignees ca
                WHERE ca.conversation_id = c.id AND ca.user_id = auth.uid()
            )
            OR (
                public.user_can_access_phone_line(c.phone_number_id)
                AND (
                    -- Triagem: conversa sem setor é de todos os da linha.
                    c.sector_id IS NULL
                    -- Linha sem isolamento: basta o acesso à linha.
                    OR NOT COALESCE(
                        (SELECT pn.sector_isolation_enabled
                         FROM phone_numbers pn WHERE pn.id = c.phone_number_id),
                        false
                    )
                    -- Sou membro do setor da conversa.
                    OR EXISTS (
                        SELECT 1 FROM sector_members sm
                        WHERE sm.sector_id = c.sector_id
                          AND sm.user_id = auth.uid()
                    )
                    -- Admin da org da linha não é limitado por setor.
                    OR public.user_is_org_admin(public.get_phone_org_id(c.phone_number_id))
                )
            )
        )
    );
$$;

COMMENT ON FUNCTION "public"."user_can_access_conversation"("conv_id" "uuid") IS 'Cached check if current user can access a conversation. Used by RLS policies.
SECURITY DEFINER allows bypassing other RLS checks internally.
Linha acessível OU assigned_to OU coproprietário. Quando a linha tem sector_isolation_enabled, o ramo da linha exige ainda que a conversa esteja sem setor (triagem) ou num setor do usuário; admin da org e assignees seguem passando.';

CREATE OR REPLACE FUNCTION "public"."user_can_access_phone_line"("p_phone_number_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM user_phone_numbers upn
        WHERE upn.phone_number_id = p_phone_number_id
          AND upn.user_id = auth.uid()
    )
    OR EXISTS (
        SELECT 1
        FROM phone_numbers pn
        JOIN organization_members om ON om.organization_id = pn.organization_id
        WHERE pn.id = p_phone_number_id
          AND om.user_id = auth.uid()
          AND om.role = 'admin'
    );
$$;

COMMENT ON FUNCTION "public"."user_can_access_phone_line"("p_phone_number_id" "uuid") IS 'Usuário atual pode acessar esta linha de WhatsApp? true se a linha está atribuída a ele em user_phone_numbers OU se ele é admin (organization_members.role) da org dona da linha. NULL devolve false (fail-closed). Base das RLS de conversations e de user_can_access_conversation.';

CREATE OR REPLACE FUNCTION "public"."user_has_broadcast_access"("broadcast_phone_number_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    RETURN public.auth_is_super_admin()
        OR public.user_can_access_phone_line(broadcast_phone_number_id);
END;
$$;

CREATE OR REPLACE FUNCTION "public"."user_has_phone_access"("_phone_number_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_phone_numbers
        WHERE phone_number_id = _phone_number_id
        AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION "public"."user_has_scheduled_message_access"("msg_phone_number_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    RETURN public.auth_is_super_admin()
        OR public.user_can_access_phone_line(msg_phone_number_id);
END;
$$;

CREATE OR REPLACE FUNCTION "public"."user_is_assignee"("p_conversation_id" "uuid", "p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.conversations
        WHERE id = p_conversation_id AND assigned_to = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM public.conversation_assignees
        WHERE conversation_id = p_conversation_id AND user_id = p_user_id
    );
$$;

CREATE OR REPLACE FUNCTION "public"."user_is_org_admin"("_org_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.organization_members
        WHERE organization_id = _org_id
        AND user_id = auth.uid()
        AND role = 'admin'
    );
$$;

CREATE TABLE IF NOT EXISTS "public"."action_button_phone_numbers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "action_button_id" "uuid" NOT NULL,
    "phone_number_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."analytics_daily_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "date" "date" NOT NULL,
    "currency" "text" DEFAULT 'BRL'::"text",
    "total_cost" numeric(10,4) DEFAULT 0,
    "conversation_count" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."analytics_daily_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "template_id" character varying(255) NOT NULL,
    "template_name" character varying(255) NOT NULL,
    "date" "date" NOT NULL,
    "category" character varying(50),
    "sent" integer DEFAULT 0,
    "delivered" integer DEFAULT 0,
    "read" integer DEFAULT 0,
    "clicked" integer DEFAULT 0,
    "components" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."api_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "key_hash" "text" NOT NULL,
    "key_preview" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone,
    "organization_id" "uuid"
);

CREATE TABLE IF NOT EXISTS "public"."automation_executions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "flow_id" "uuid",
    "session_id" "uuid",
    "conversation_id" "uuid",
    "organization_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "trigger_message" "jsonb",
    "trigger_type" "text",
    "matched_by" "text",
    "execution_log" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "stop_reason" "text",
    "error" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "phone_number_id" "uuid",
    "contact_phone" "text",
    CONSTRAINT "automation_executions_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'failed'::"text", 'stopped'::"text", 'no_match'::"text", 'cancelled'::"text"])))
);

COMMENT ON TABLE "public"."automation_executions" IS 'Execution history for automation flows';

COMMENT ON COLUMN "public"."automation_executions"."execution_log" IS 'Array of execution steps with timestamps and details';

CREATE TABLE IF NOT EXISTS "public"."automation_flows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "phone_number_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT false,
    "trigger_type" "text" NOT NULL,
    "trigger_config" "jsonb" DEFAULT '{}'::"jsonb",
    "flow_data" "jsonb" DEFAULT '{"edges": [], "nodes": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cooldown_minutes" integer DEFAULT 30,
    "run_in_groups" boolean DEFAULT false NOT NULL,
    CONSTRAINT "automation_flows_trigger_type_check" CHECK (("trigger_type" = ANY (ARRAY['message_received'::"text", 'keyword'::"text", 'conversation_created'::"text", 'message_sent'::"text"])))
);

COMMENT ON COLUMN "public"."automation_flows"."cooldown_minutes" IS 'Minutes to wait before this automation can trigger again for the same conversation. Default 30 minutes.';

COMMENT ON COLUMN "public"."automation_flows"."run_in_groups" IS 'Se falso (padrão), o fluxo é ignorado em conversas de grupo (conversations.is_group = true).';

CREATE TABLE IF NOT EXISTS "public"."automation_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "flow_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "current_node_id" "text" NOT NULL,
    "context" "jsonb" DEFAULT '{}'::"jsonb",
    "status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '24:00:00'::interval),
    CONSTRAINT "automation_sessions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'completed'::"text", 'cancelled'::"text", 'expired'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."automation_triggers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "flow_id" "uuid" NOT NULL,
    "trigger_type" "text" NOT NULL,
    "trigger_config" "jsonb" DEFAULT '{}'::"jsonb",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "automation_triggers_trigger_type_check" CHECK (("trigger_type" = ANY (ARRAY['message_received'::"text", 'keyword'::"text", 'conversation_created'::"text", 'message_sent'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."broadcasts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "phone_number_id" "uuid" NOT NULL,
    "template_id" "text" NOT NULL,
    "template_name" "text" NOT NULL,
    "template_language" "text" DEFAULT 'pt_BR'::"text" NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "scheduled_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "total_recipients" integer DEFAULT 0,
    "sent_count" integer DEFAULT 0,
    "failed_count" integer DEFAULT 0,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "template_components" "jsonb",
    "body_variable_count" integer DEFAULT 0,
    "button_variable_count" integer DEFAULT 0,
    "header_media" "jsonb",
    "concurrency" integer DEFAULT 5 NOT NULL,
    "throttled_at" timestamp with time zone,
    "last_dispatch_at" timestamp with time zone,
    CONSTRAINT "broadcasts_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'scheduled'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"])))
);

COMMENT ON COLUMN "public"."broadcasts"."header_media" IS 'Optional WhatsApp template header media. Shape: { format: IMAGE|VIDEO|DOCUMENT, link: text, filename?: text }';

COMMENT ON COLUMN "public"."broadcasts"."concurrency" IS 'Current in-worker send concurrency, adapted at runtime: raised while the provider is healthy, dropped to 1 on the first 429/rate error.';

COMMENT ON COLUMN "public"."broadcasts"."throttled_at" IS 'Last time the provider rate-limited this broadcast. Suppresses scale-up while recent.';

COMMENT ON COLUMN "public"."broadcasts"."last_dispatch_at" IS 'Last time dispatch_broadcast_work() sent workers at this broadcast. Prevents dispatch stampedes.';

CREATE TABLE IF NOT EXISTS "public"."close_reasons" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    "phone_number_id" "uuid"
);

CREATE TABLE IF NOT EXISTS "public"."conversation_assignees" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "added_by" "uuid",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "role" "text" DEFAULT 'co_owner'::"text" NOT NULL
);

COMMENT ON TABLE "public"."conversation_assignees" IS 'Co-owners of a conversation. The primary owner is still stored in conversations.assigned_to — this table is additive and the primary is never duplicated here (enforced by trigger).';

COMMENT ON COLUMN "public"."conversation_assignees"."role" IS 'Reserved for future expansion: co_owner | observer | supervisor. MVP only uses co_owner.';

CREATE TABLE IF NOT EXISTS "public"."conversation_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."conversation_prefs" (
    "user_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "pinned_at" timestamp with time zone,
    "archived_at" timestamp with time zone,
    "muted_until" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."conversation_reads" (
    "user_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "last_read_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "marked_unread_at" timestamp with time zone
);

COMMENT ON COLUMN "public"."conversation_reads"."marked_unread_at" IS 'Quando o usuário marcou a conversa como não lida à mão. NULL = não marcada. Independente de last_read_at: vale mesmo para conversas sem inbound recente, que a janela de 30 dias de get_unread_counts jamais badgearia.';

CREATE TABLE IF NOT EXISTS "public"."conversation_tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "whatsapp_id" "text",
    "contact_name" "text" NOT NULL,
    "contact_phone" "text" NOT NULL,
    "last_message_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assigned_to" "uuid",
    "status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "close_reason" "text",
    "closed_at" timestamp with time zone,
    "phone_number_id" "uuid",
    "is_group" boolean DEFAULT false,
    "group_jid" "text",
    "source" "text" DEFAULT 'organic'::"text",
    "last_auto_reply_at" timestamp with time zone,
    "contact_picture_url" "text",
    "picture_fetched_at" timestamp with time zone,
    "contact_avatar_url" "text",
    "contact_avatar_updated_at" timestamp with time zone,
    "closed_by" "uuid",
    "sector_id" "uuid",
    "last_message_content" "text",
    "last_message_type" "text",
    "last_message_direction" "text",
    "last_message_is_deleted" boolean,
    "channel" "text" DEFAULT 'whatsapp'::"text" NOT NULL,
    "instagram_account_id" "text",
    "instagram_user_id" "text",
    "instagram_username" "text",
    "br_phone_key" "text" GENERATED ALWAYS AS ("public"."br_phone_key"("contact_phone")) STORED,
    "disparo_desde" timestamp with time zone,
    "disparo_rotulo" "text",
    "disparo_campanhas" "text"[],
    "disparo_origem" "text",
    "disparo_msg_id" "uuid",
    "disparo_status" "text",
    "group_subject" "text",
    "ia_desde" timestamp with time zone,
    "ia_origem" "text",
    "ia_sem_resposta_desde" timestamp with time zone,
    CONSTRAINT "conversations_channel_check" CHECK (("channel" = ANY (ARRAY['whatsapp'::"text", 'instagram'::"text"]))),
    CONSTRAINT "conversations_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'pending'::"text", 'waiting'::"text", 'closed'::"text"])))
);

ALTER TABLE ONLY "public"."conversations" REPLICA IDENTITY FULL;

COMMENT ON COLUMN "public"."conversations"."source" IS 'How the conversation was created: organic, broadcast, api';

COMMENT ON COLUMN "public"."conversations"."contact_avatar_url" IS 'URL to stored profile picture in Supabase Storage';

COMMENT ON COLUMN "public"."conversations"."contact_avatar_updated_at" IS 'Data da última CONFERIDA da foto de perfil, não da última troca. url preenchida + carimbo = foto guardada no Storage; url NULL + carimbo = conferido e o contato não tem foto visível (privacidade, ou perfil sem foto). O segundo caso é o que impede o qr-service de reconsultar o WhatsApp para os mesmos contatos a cada restart.';

COMMENT ON COLUMN "public"."conversations"."closed_by" IS 'User who closed the conversation. NULL = closed by system (cron, API, etc).';

COMMENT ON COLUMN "public"."conversations"."sector_id" IS 'Setor responsável pela conversa. NULL = triagem (visível a todos os da linha). Definido quando alguém assume a conversa ou a encaminha para outro setor.';

COMMENT ON COLUMN "public"."conversations"."last_message_content" IS 'left(content, 200) da última mensagem por (created_at DESC, id DESC). Mantido por trigger; NULL = conversa sem mensagem ou backfill pendente.';

COMMENT ON COLUMN "public"."conversations"."last_message_type" IS 'message_type da última mensagem (mesma regra de last_message_content).';

COMMENT ON COLUMN "public"."conversations"."last_message_direction" IS 'direction da última mensagem. NULL = sem mensagem/backfill pendente — o front só monta a prévia quando não é NULL.';

COMMENT ON COLUMN "public"."conversations"."last_message_is_deleted" IS 'is_deleted da última mensagem: o front mostra "Mensagem apagada" e ignora o content.';

COMMENT ON COLUMN "public"."conversations"."br_phone_key" IS 'Gerada: public.br_phone_key(contact_phone). Chave de duplicada do merge_duplicate_conversations.';

COMMENT ON COLUMN "public"."conversations"."disparo_desde" IS 'Não nulo = conversa na aba Disparos (só recebeu disparo, ninguém escreveu ainda). Mantido pelos gatilhos de conversations/messages.';

COMMENT ON COLUMN "public"."conversations"."disparo_rotulo" IS 'Rótulo do último disparo (ex.: "Campanha · Lembrete"), vindo de messages.metadata.disparo.rotulo.';

COMMENT ON COLUMN "public"."conversations"."disparo_campanhas" IS 'Campanhas dos disparos enquanto a conversa está na aba Disparos (o mais novo primeiro).';

COMMENT ON COLUMN "public"."conversations"."disparo_origem" IS 'Quem disparou por último (messages.metadata.disparo.origem). Não nulo = a conversa já passou pela aba Disparos.';

COMMENT ON COLUMN "public"."conversations"."disparo_msg_id" IS 'Última mensagem de disparo da conversa na aba (o status dela vira disparo_status).';

COMMENT ON COLUMN "public"."conversations"."disparo_status" IS 'Status do último disparo (sent, delivered, read, failed): a linha da aba diz se a pessoa leu.';

COMMENT ON COLUMN "public"."conversations"."group_subject" IS 'Nome do grupo no WhatsApp (subject), mantido pelo whatsapp-webhook. contact_name é o nome exibido: acompanha este enquanto forem iguais; diferente = apelido. NULL = grupo ainda sem nome gravado ou conversa individual.';

COMMENT ON COLUMN "public"."conversations"."ia_desde" IS 'Não nulo = uma IA está atendendo (aba Com a IA). Mantido pelos gatilhos de conversations/messages.';

COMMENT ON COLUMN "public"."conversations"."ia_origem" IS 'Qual IA atendeu por último (messages.metadata.ia.origem, ex.: "assistente-vendas").';

COMMENT ON COLUMN "public"."conversations"."ia_sem_resposta_desde" IS 'Com a IA: hora da primeira mensagem da pessoa ainda sem resposta da IA ou do time. A tela devolve a conversa ao time depois de 10 minutos.';

CREATE TABLE IF NOT EXISTS "public"."disconnect_alert_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "phone_number_id" "uuid" NOT NULL,
    "emails_sent" "text"[] NOT NULL,
    "disconnected_at" timestamp with time zone NOT NULL,
    "alert_sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "success" boolean DEFAULT false,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."group_participant_aliases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "group_jid" "text" NOT NULL,
    "participant_jid" "text" NOT NULL,
    "alias" "text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."instagram_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "phone_number_id" "uuid" NOT NULL,
    "ig_user_id" "text" NOT NULL,
    "ig_username" "text",
    "access_token" "text" NOT NULL,
    "token_expires_at" timestamp with time zone,
    "scopes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "subscribed_fields" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "status" "text" DEFAULT 'connected'::"text" NOT NULL,
    "last_error" "text",
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "inbox_mode" "text" DEFAULT 'off'::"text" NOT NULL,
    "display_name" "text",
    "token_refresh_tried_at" timestamp with time zone,
    CONSTRAINT "instagram_connections_inbox_mode_check" CHECK (("inbox_mode" = ANY (ARRAY['off'::"text", 'on'::"text"]))),
    CONSTRAINT "instagram_connections_status_check" CHECK (("status" = ANY (ARRAY['connected'::"text", 'disconnected'::"text", 'error'::"text"])))
);

COMMENT ON TABLE "public"."instagram_connections" IS 'Conta profissional do Instagram ligada a uma linha do Echo (o Direct aparece na mesma linha). Token só no servidor.';

CREATE TABLE IF NOT EXISTS "public"."instagram_webhook_events" (
    "id" bigint NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "signature_valid" boolean NOT NULL,
    "object" "text",
    "ig_account_id" "text",
    "sender_id" "text",
    "recipient_id" "text",
    "event_type" "text" NOT NULL,
    "event_hash" "text" NOT NULL,
    "mid" "text",
    "event_at" timestamp with time zone,
    "payload" "jsonb" NOT NULL,
    "processed_at" timestamp with time zone,
    "process_note" "text",
    "tentativas" integer DEFAULT 0 NOT NULL
);

COMMENT ON TABLE "public"."instagram_webhook_events" IS 'Avisos crus do Meta para o Instagram Direct (fase 1: só registro). Texto de cliente: só o servidor lê.';

CREATE SEQUENCE IF NOT EXISTS "public"."instagram_webhook_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."instagram_webhook_events_id_seq" OWNED BY "public"."instagram_webhook_events"."id";

CREATE TABLE IF NOT EXISTS "public"."linha_identidade" (
    "identidade" "text" NOT NULL,
    "phone_number_id" "uuid" NOT NULL,
    "origem" "text" NOT NULL,
    "visto_em" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "linha_identidade_origem_check" CHECK (("origem" = ANY (ARRAY['telefone'::"text", 'remetente'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."message_hidden" (
    "user_id" "uuid" NOT NULL,
    "message_id" "uuid" NOT NULL,
    "hidden_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."message_reactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "message_id" "uuid" NOT NULL,
    "reactor_jid" "text",
    "reactor_name" "text",
    "reactor_user_id" "uuid",
    "is_from_me" boolean DEFAULT false NOT NULL,
    "emoji" "text" NOT NULL,
    "reacted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "message_reactions_emoji_check" CHECK ((("char_length"("emoji") >= 1) AND ("char_length"("emoji") <= 16)))
);

ALTER TABLE ONLY "public"."message_reactions" REPLICA IDENTITY FULL;

CREATE TABLE IF NOT EXISTS "public"."message_receipts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "message_id" "uuid" NOT NULL,
    "participant_jid" "text" NOT NULL,
    "participant_phone" "text",
    "delivered_at" timestamp with time zone,
    "read_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."message_receipts" REPLICA IDENTITY FULL;

CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "whatsapp_message_id" "text",
    "content" "text" NOT NULL,
    "message_type" "text" DEFAULT 'text'::"text",
    "direction" "text" NOT NULL,
    "sent_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "read_at" timestamp with time zone,
    "status" "text" DEFAULT 'sent'::"text",
    "error_message" "text",
    "media_url" "text",
    "media_mime_type" "text",
    "media_filename" "text",
    "media_size_bytes" bigint,
    "sender_phone" "text",
    "sender_name" "text",
    "quoted_message_id" "uuid",
    "flow_response_json" "jsonb",
    "flow_token" "text",
    "reaction" "text",
    "metadata" "jsonb",
    "our_reaction" "text",
    "sender_jid" "text",
    "is_edited" boolean DEFAULT false NOT NULL,
    "edited_at" timestamp with time zone,
    "is_imported" boolean DEFAULT false NOT NULL,
    "is_deleted" boolean DEFAULT false NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "messages_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"]))),
    CONSTRAINT "messages_message_type_check" CHECK (("message_type" = ANY (ARRAY['text'::"text", 'image'::"text", 'audio'::"text", 'video'::"text", 'document'::"text", 'location'::"text", 'sticker'::"text", 'template'::"text", 'button_reply'::"text", 'list_reply'::"text", 'flow'::"text", 'nfm_reply'::"text", 'contact'::"text", 'deleted'::"text", 'unsupported'::"text", 'reaction'::"text", 'group_action'::"text", 'ptt'::"text", 'list'::"text", 'poll'::"text", 'call'::"text"])))
)
WITH ("autovacuum_vacuum_scale_factor"='0.02', "autovacuum_vacuum_insert_scale_factor"='0.02', "autovacuum_analyze_scale_factor"='0.02');

ALTER TABLE ONLY "public"."messages" REPLICA IDENTITY FULL;

COMMENT ON COLUMN "public"."messages"."media_url" IS 'URL of the media file in Supabase Storage or WhatsApp CDN';

COMMENT ON COLUMN "public"."messages"."media_mime_type" IS 'MIME type: image/jpeg, video/mp4, application/pdf, etc';

COMMENT ON COLUMN "public"."messages"."media_filename" IS 'Original filename of the uploaded file';

COMMENT ON COLUMN "public"."messages"."media_size_bytes" IS 'File size in bytes';

COMMENT ON COLUMN "public"."messages"."quoted_message_id" IS 'Reference to the message being replied to (quote/reply feature)';

COMMENT ON COLUMN "public"."messages"."flow_response_json" IS 'Structured JSON data from WhatsApp Flow responses (nfm_reply)';

COMMENT ON COLUMN "public"."messages"."flow_token" IS 'Unique token to correlate flow invocations with responses';

COMMENT ON COLUMN "public"."messages"."reaction" IS 'Emoji reaction on this message from the contact';

COMMENT ON COLUMN "public"."messages"."metadata" IS 'Stores additional message data like template_name, language_code, and components for template messages';

COMMENT ON COLUMN "public"."messages"."our_reaction" IS 'Emoji reaction we sent on this message';

COMMENT ON COLUMN "public"."messages"."sender_jid" IS 'Original WhatsApp JID of the sender (for group messages)';

COMMENT ON COLUMN "public"."messages"."is_imported" IS 'True when the row was inserted via import-history edge function from a historic export, not via the live WhatsApp webhook.';

COMMENT ON COLUMN "public"."messages"."is_deleted" IS 'Mensagem apagada para todos. O conteúdo original é preservado; a UI apenas sinaliza.';

COMMENT ON COLUMN "public"."messages"."deleted_at" IS 'Quando a exclusão foi registrada pelo Echo (não é o horário do aparelho).';

CREATE TABLE IF NOT EXISTS "public"."organization_action_buttons" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "position" integer DEFAULT 1 NOT NULL,
    "label" "text" DEFAULT 'Ação'::"text" NOT NULL,
    "button_type" "text" DEFAULT 'webhook'::"text" NOT NULL,
    "url" "text",
    "icon" "text" DEFAULT 'zap'::"text" NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "organization_action_buttons_button_type_check" CHECK (("button_type" = ANY (ARRAY['webhook'::"text", 'link'::"text", 'import_history'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."organization_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."org_role" DEFAULT 'agent'::"public"."org_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "sector_id" "uuid"
);

CREATE TABLE IF NOT EXISTS "public"."organization_webhooks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "url" "text" NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "whatsapp_waba_id" "text",
    "whatsapp_access_token" "text",
    "whatsapp_verify_token" "text",
    "ai_api_key" "text",
    "ai_insights_prompt" "text" DEFAULT 'Analise os dados fornecidos e gere insights estratégicos sobre o desempenho do atendimento, identificando tendências, pontos de melhoria e oportunidades de eficiência. Foque em métricas de volume, tempo de resposta e engajamento.'::"text",
    "ai_api_key_encrypted" "text",
    "whatsapp_app_id" "text"
);

COMMENT ON COLUMN "public"."organizations"."whatsapp_app_id" IS 'Meta App ID used by the Resumable Upload API for media template headers.';

CREATE TABLE IF NOT EXISTS "public"."phone_number_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "phone_number_id" "uuid" NOT NULL,
    "connection_type" "text" DEFAULT 'qr'::"text",
    "session_data" "jsonb",
    "connection_status" "text" DEFAULT 'disconnected'::"text",
    "qr_code" "text",
    "last_connected_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "last_disconnected_at" timestamp with time zone,
    "last_offline_recovery_at" timestamp with time zone,
    "last_offline_recovered_count" integer
);

COMMENT ON COLUMN "public"."phone_number_sessions"."last_disconnected_at" IS 'Instante da última queda. Espelho de sessions/<id>/disconnect_timestamp.txt, que vive no volume; usado como cutoff do history sync quando o arquivo não existe mais.';

COMMENT ON COLUMN "public"."phone_number_sessions"."last_offline_recovery_at" IS 'Quando a fila offline terminou de ser drenada (connection.update com receivedPendingNotifications).';

COMMENT ON COLUMN "public"."phone_number_sessions"."last_offline_recovered_count" IS 'Quantas mensagens type=append chegaram naquela drenagem.';

CREATE TABLE IF NOT EXISTS "public"."phone_numbers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "phone_number_id" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "phone_number" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "theme_hue" integer DEFAULT 15,
    "organization_id" "uuid",
    "auto_reply_message" "text",
    "connection_type" "text" DEFAULT 'business_api'::"text",
    "qr_session_status" "text" DEFAULT 'disconnected'::"text",
    "disconnect_alert_enabled" boolean DEFAULT false,
    "disconnect_alert_threshold_minutes" integer DEFAULT 1,
    "disconnect_alert_emails" "text"[] DEFAULT '{}'::"text"[],
    "disconnect_alert_cooldown_minutes" integer DEFAULT 15,
    "append_agent_name" boolean DEFAULT false NOT NULL,
    "keep_device_notifications" boolean DEFAULT true NOT NULL,
    "sector_isolation_enabled" boolean DEFAULT false NOT NULL,
    "typing_indicator_enabled" boolean DEFAULT false NOT NULL,
    "send_read_receipts" boolean DEFAULT false NOT NULL,
    "qr_provider" "text" DEFAULT 'baileys'::"text" NOT NULL,
    "provider_config" "jsonb",
    "voice_calls_enabled" boolean DEFAULT false NOT NULL,
    "sector_follows_owner" boolean DEFAULT false NOT NULL
);

COMMENT ON COLUMN "public"."phone_numbers"."auto_reply_message" IS 'Automatic reply message sent when a contact messages this number. If NULL or empty, no auto-reply is sent.';

COMMENT ON COLUMN "public"."phone_numbers"."keep_device_notifications" IS 'true (padrão): a sessão se apresenta como unavailable e o WhatsApp mantém as notificações no celular. false: apresenta-se available — o celular para de notificar, em troca de presença completa do contato (online/visto por último e entrega confiável do chatstate de digitando). Só afeta conexões QR/Baileys; a Cloud API ignora.';

COMMENT ON COLUMN "public"."phone_numbers"."sector_isolation_enabled" IS 'Liga o isolamento por setor nesta linha: atendente passa a ver só as conversas dos setores dele mais a triagem (sector_id NULL). false = visibilidade só por linha. Desligar não apaga conversations.sector_id: religar devolve a mesma divisão.';

COMMENT ON COLUMN "public"."phone_numbers"."send_read_receipts" IS 'true: abrir a conversa no painel envia confirmação de leitura (tique azul) ao contato — QR via readMessages, Cloud API via status:read. Opt-in por número.';

COMMENT ON COLUMN "public"."phone_numbers"."qr_provider" IS 'Lib do serviço de QR (qr-service/) que atende a linha (baileys, zapo, ...). Default baileys.';

COMMENT ON COLUMN "public"."phone_numbers"."provider_config" IS 'Config específica do provider (ex.: instância/apiKey de provider HTTP). Nunca exposta ao front.';

COMMENT ON COLUMN "public"."phone_numbers"."voice_calls_enabled" IS 'Linha aceita ligação de voz (fazer e receber). Desligado por padrão; só tem efeito onde o serviço anuncia a capability voice_call.';

COMMENT ON COLUMN "public"."phone_numbers"."sector_follows_owner" IS 'Com sector_isolation_enabled: o setor da conversa acompanha o dono (gatilho trg_setor_segue_dono). Com um setor por pessoa, cada atendente vê só a conversa sem dono e a dela.';

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "phone" "text",
    "is_super_admin" boolean DEFAULT false,
    "email" "text",
    "copiloto_enabled" boolean DEFAULT false NOT NULL
);

COMMENT ON TABLE "public"."profiles" IS 'Perfis de usuário. SELECT: o próprio perfil, super admin ou quem divide alguma organização. UPDATE: só first_name/last_name/phone do próprio perfil; id, email e is_super_admin só pelo service_role (trigger trg_profiles_guard_protected_columns).';

COMMENT ON COLUMN "public"."profiles"."copiloto_enabled" IS 'Copiloto de respostas (IA) ligado para este usuário: a edge copiloto sugere respostas na conversa aberta. Desligado por padrão; precisa de chave de IA na organização.';

CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "endpoint" "text" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth" "text" NOT NULL,
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."qr_health_probe" (
    "id" boolean DEFAULT true NOT NULL,
    "request_id" bigint,
    "requested_at" timestamp with time zone,
    "last_ok_at" timestamp with time zone,
    "last_health" "jsonb",
    "consecutive_unreachable" integer DEFAULT 0 NOT NULL,
    "consecutive_stalled" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "qr_health_probe_id_check" CHECK ("id")
);

COMMENT ON TABLE "public"."qr_health_probe" IS 'Estado do health-check outside-in do qr-service. Uma linha; escrita só por check_qr_service_health().';

CREATE TABLE IF NOT EXISTS "public"."qr_message_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "phone_number_id" "uuid",
    "to_jid" "text" NOT NULL,
    "message_id" "text",
    "action" "text" NOT NULL,
    "success" boolean DEFAULT true NOT NULL,
    "error" "text",
    "socket_state" integer,
    "session_status" "text",
    "baileys_result" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."quick_replies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "phone_number_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "shortcut" "text" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "quick_replies_content_check" CHECK ((("char_length"("content") >= 1) AND ("char_length"("content") <= 4096))),
    CONSTRAINT "quick_replies_shortcut_check" CHECK (("shortcut" ~ '^[a-z0-9_-]{1,30}$'::"text"))
);

COMMENT ON TABLE "public"."quick_replies" IS 'Frases prontas por linha, inseridas no composer via "/atalho"; compartilhadas por quem acessa a linha';

COMMENT ON COLUMN "public"."quick_replies"."shortcut" IS 'Texto digitado após "/" para filtrar; lowercase [a-z0-9_-]{1,30}, único por linha';

COMMENT ON COLUMN "public"."quick_replies"."content" IS 'Corpo inserido no composer no lugar do token; texto puro, ≤4096 (limite do WhatsApp)';

CREATE TABLE IF NOT EXISTS "public"."scheduled_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "phone_number_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "message_type" "text" NOT NULL,
    "content" "text",
    "quoted_message_id" "uuid",
    "mentions" "jsonb" DEFAULT '[]'::"jsonb",
    "template_name" "text",
    "template_language" "text" DEFAULT 'pt_BR'::"text",
    "template_components" "jsonb",
    "body_variables" "jsonb" DEFAULT '[]'::"jsonb",
    "button_variables" "jsonb" DEFAULT '[]'::"jsonb",
    "contact_phone" "text" NOT NULL,
    "contact_name" "text",
    "scheduled_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "error_message" "text",
    "whatsapp_message_id" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "header_media" "jsonb",
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_attempt_at" timestamp with time zone,
    "next_attempt_at" timestamp with time zone,
    "media" "jsonb",
    CONSTRAINT "scheduled_messages_media_check" CHECK (((("message_type" <> 'media'::"text") AND ("media" IS NULL)) OR (("message_type" = 'media'::"text") AND ("jsonb_typeof"("media") = 'array'::"text") AND (("jsonb_array_length"("media") >= 1) AND ("jsonb_array_length"("media") <= 30)) AND (NOT "jsonb_path_exists"("media", '$[*]?(!(exists (@."storage_path")) || @."storage_path".type() != "string")'::"jsonpath"))))),
    CONSTRAINT "scheduled_messages_message_type_check" CHECK (("message_type" = ANY (ARRAY['text'::"text", 'template'::"text", 'media'::"text"]))),
    CONSTRAINT "scheduled_messages_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'processing'::"text", 'sent'::"text", 'failed'::"text", 'cancelled'::"text"])))
);

COMMENT ON COLUMN "public"."scheduled_messages"."header_media" IS 'Optional WhatsApp template header media. Shape: { format: IMAGE|VIDEO|DOCUMENT, link: text, filename?: text }';

COMMENT ON COLUMN "public"."scheduled_messages"."attempts" IS 'Dispatch attempts consumed. Incremented by process_scheduled_messages() when it claims the row. Capped at 3 (mirrored as MAX_ATTEMPTS in scheduled-message-execute).';

COMMENT ON COLUMN "public"."scheduled_messages"."last_attempt_at" IS 'When the current/last dispatch was claimed. Staleness clock for reap_stuck_scheduled_messages().';

COMMENT ON COLUMN "public"."scheduled_messages"."next_attempt_at" IS 'Backoff gate for a retry. NULL means "eligible at scheduled_at". Never overwrite scheduled_at with this.';

COMMENT ON COLUMN "public"."scheduled_messages"."media" IS 'Arquivos de um agendamento message_type=media, na ordem de envio: [{storage_path, filename, mime_type, size_bytes, caption?, width?, height?, view_once?, whatsapp_message_id?}]. O executor grava whatsapp_message_id por item; a coluna whatsapp_message_id só depois do último.';

CREATE TABLE IF NOT EXISTS "public"."sector_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sector_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

COMMENT ON TABLE "public"."sector_members" IS 'Fonte de verdade do vínculo membro <-> setor (N:N). organization_members.sector_id é o setor PADRÃO do membro (usado pelo Analytics e ao assumir conversa da triagem), não o conjunto de acessos.';

CREATE TABLE IF NOT EXISTS "public"."sectors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "phone_number_id" "uuid",
    "color" "text"
);

COMMENT ON COLUMN "public"."sectors"."phone_number_id" IS 'Linha a que este setor pertence. NULL = setor sem linha definida, válido para todos os números da organização.';

CREATE TABLE IF NOT EXISTS "public"."session_connection_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "phone_number_id" "uuid",
    "event" "text" NOT NULL,
    "status_code" integer,
    "error_message" "text",
    "reason" "text",
    "reconnect_attempts" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "session_connection_log_event_check" CHECK (("event" = ANY (ARRAY['close'::"text", 'open'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."system_alert_state" (
    "alert_key" "text" NOT NULL,
    "system_alert_id" "uuid",
    "active_since" timestamp with time zone,
    "last_seen_at" timestamp with time zone,
    "last_notified_at" timestamp with time zone,
    "snoozed_until" timestamp with time zone,
    "last_window_count" integer,
    "updated_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."system_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "message" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone,
    CONSTRAINT "system_alerts_severity_check" CHECK (("severity" = ANY (ARRAY['normal'::"text", 'warning'::"text", 'critical'::"text"])))
);

COMMENT ON TABLE "public"."system_alerts" IS 'System status alerts displayed in the dashboard header';

COMMENT ON COLUMN "public"."system_alerts"."severity" IS 'Alert severity: normal (green), warning (yellow), critical (red)';

CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" DEFAULT '#3b82f6'::"text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    "phone_number_id" "uuid"
);

CREATE TABLE IF NOT EXISTS "public"."user_invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "phone_number_id" "uuid" NOT NULL,
    "invited_by" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "accepted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."user_phone_numbers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "phone_number_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."user_stickers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "file_url" "text" NOT NULL,
    "file_sha256" "text" NOT NULL,
    "mime_type" "text" DEFAULT 'image/webp'::"text" NOT NULL,
    "is_animated" boolean DEFAULT false NOT NULL,
    "width" integer NOT NULL,
    "height" integer NOT NULL,
    "size_bytes" integer NOT NULL,
    "meta_compliant" boolean GENERATED ALWAYS AS ((("mime_type" = 'image/webp'::"text") AND ("width" = 512) AND ("height" = 512) AND (((NOT "is_animated") AND ("size_bytes" <= 100000)) OR ("is_animated" AND ("size_bytes" <= 500000))))) STORED,
    "source" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_stickers_file_sha256_check" CHECK (("file_sha256" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "user_stickers_source_check" CHECK (("source" = ANY (ARRAY['upload'::"text", 'saved'::"text"])))
);

COMMENT ON TABLE "public"."user_stickers" IS 'Coleção pessoal de figurinhas por usuário; arquivo em attachments/stickers/<user_id>/<sha256>.webp';

COMMENT ON COLUMN "public"."user_stickers"."meta_compliant" IS 'true = dentro da spec da Meta Cloud API (webp 512x512, ≤100KB estático / ≤500KB animado); fora de spec só envia via QR';

ALTER TABLE ONLY "public"."instagram_webhook_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."instagram_webhook_events_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."action_button_phone_numbers"
    ADD CONSTRAINT "action_button_phone_numbers_action_button_id_phone_number_i_key" UNIQUE ("action_button_id", "phone_number_id");

ALTER TABLE ONLY "public"."action_button_phone_numbers"
    ADD CONSTRAINT "action_button_phone_numbers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."analytics_daily_metrics"
    ADD CONSTRAINT "analytics_daily_metrics_organization_id_date_key" UNIQUE ("organization_id", "date");

ALTER TABLE ONLY "public"."analytics_daily_metrics"
    ADD CONSTRAINT "analytics_daily_metrics_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."analytics_daily_templates"
    ADD CONSTRAINT "analytics_daily_templates_organization_id_template_id_date_key" UNIQUE ("organization_id", "template_id", "date");

ALTER TABLE ONLY "public"."analytics_daily_templates"
    ADD CONSTRAINT "analytics_daily_templates_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_key_hash_key" UNIQUE ("key_hash");

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."automation_executions"
    ADD CONSTRAINT "automation_executions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."automation_flows"
    ADD CONSTRAINT "automation_flows_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."automation_sessions"
    ADD CONSTRAINT "automation_sessions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."automation_triggers"
    ADD CONSTRAINT "automation_triggers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."aviso_de_mensagem"
    ADD CONSTRAINT "aviso_de_mensagem_organization_id_chave_key" UNIQUE ("organization_id", "chave");

ALTER TABLE ONLY "public"."aviso_de_mensagem"
    ADD CONSTRAINT "aviso_de_mensagem_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."broadcast_recipients"
    ADD CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."broadcasts"
    ADD CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."close_reasons"
    ADD CONSTRAINT "close_reasons_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."conversation_assignees"
    ADD CONSTRAINT "conversation_assignees_conversation_id_user_id_key" UNIQUE ("conversation_id", "user_id");

ALTER TABLE ONLY "public"."conversation_assignees"
    ADD CONSTRAINT "conversation_assignees_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."conversation_notes"
    ADD CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."conversation_prefs"
    ADD CONSTRAINT "conversation_prefs_pkey" PRIMARY KEY ("user_id", "conversation_id");

ALTER TABLE ONLY "public"."conversation_reads"
    ADD CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("user_id", "conversation_id");

ALTER TABLE ONLY "public"."conversation_tags"
    ADD CONSTRAINT "conversation_tags_conversation_id_tag_id_key" UNIQUE ("conversation_id", "tag_id");

ALTER TABLE ONLY "public"."conversation_tags"
    ADD CONSTRAINT "conversation_tags_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."disconnect_alert_log"
    ADD CONSTRAINT "disconnect_alert_log_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."group_participant_aliases"
    ADD CONSTRAINT "group_participant_aliases_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."instagram_connections"
    ADD CONSTRAINT "instagram_connections_ig_user_unique" UNIQUE ("ig_user_id");

ALTER TABLE ONLY "public"."instagram_connections"
    ADD CONSTRAINT "instagram_connections_line_unique" UNIQUE ("phone_number_id");

ALTER TABLE ONLY "public"."instagram_connections"
    ADD CONSTRAINT "instagram_connections_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."instagram_webhook_events"
    ADD CONSTRAINT "instagram_webhook_events_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."linha_identidade"
    ADD CONSTRAINT "linha_identidade_pkey" PRIMARY KEY ("identidade");

ALTER TABLE ONLY "public"."message_hidden"
    ADD CONSTRAINT "message_hidden_pkey" PRIMARY KEY ("user_id", "message_id");

ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."message_receipts"
    ADD CONSTRAINT "message_receipts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_whatsapp_message_id_conversation_id_key" UNIQUE ("whatsapp_message_id", "conversation_id");

ALTER TABLE ONLY "public"."organization_action_buttons"
    ADD CONSTRAINT "organization_action_buttons_organization_id_position_key" UNIQUE ("organization_id", "position");

ALTER TABLE ONLY "public"."organization_action_buttons"
    ADD CONSTRAINT "organization_action_buttons_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_organization_id_user_id_key" UNIQUE ("organization_id", "user_id");

ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."organization_webhooks"
    ADD CONSTRAINT "organization_webhooks_organization_id_key" UNIQUE ("organization_id");

ALTER TABLE ONLY "public"."organization_webhooks"
    ADD CONSTRAINT "organization_webhooks_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_slug_key" UNIQUE ("slug");

ALTER TABLE ONLY "public"."phone_number_sessions"
    ADD CONSTRAINT "phone_number_sessions_phone_number_id_key" UNIQUE ("phone_number_id");

ALTER TABLE ONLY "public"."phone_number_sessions"
    ADD CONSTRAINT "phone_number_sessions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."phone_numbers"
    ADD CONSTRAINT "phone_numbers_phone_number_id_key" UNIQUE ("phone_number_id");

ALTER TABLE ONLY "public"."phone_numbers"
    ADD CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_endpoint_key" UNIQUE ("endpoint");

ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."qr_health_probe"
    ADD CONSTRAINT "qr_health_probe_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."qr_message_log"
    ADD CONSTRAINT "qr_message_log_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."quick_replies"
    ADD CONSTRAINT "quick_replies_phone_number_id_shortcut_key" UNIQUE ("phone_number_id", "shortcut");

ALTER TABLE ONLY "public"."quick_replies"
    ADD CONSTRAINT "quick_replies_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."sector_members"
    ADD CONSTRAINT "sector_members_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."sector_members"
    ADD CONSTRAINT "sector_members_sector_id_user_id_key" UNIQUE ("sector_id", "user_id");

ALTER TABLE ONLY "public"."sectors"
    ADD CONSTRAINT "sectors_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."session_connection_log"
    ADD CONSTRAINT "session_connection_log_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."system_alert_state"
    ADD CONSTRAINT "system_alert_state_pkey" PRIMARY KEY ("alert_key");

ALTER TABLE ONLY "public"."system_alerts"
    ADD CONSTRAINT "system_alerts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."group_participant_aliases"
    ADD CONSTRAINT "unique_participant_alias" UNIQUE ("organization_id", "group_jid", "participant_jid");

ALTER TABLE ONLY "public"."user_invitations"
    ADD CONSTRAINT "user_invitations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."user_invitations"
    ADD CONSTRAINT "user_invitations_token_key" UNIQUE ("token");

ALTER TABLE ONLY "public"."user_phone_numbers"
    ADD CONSTRAINT "user_phone_numbers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."user_phone_numbers"
    ADD CONSTRAINT "user_phone_numbers_user_id_phone_number_id_key" UNIQUE ("user_id", "phone_number_id");

ALTER TABLE ONLY "public"."user_stickers"
    ADD CONSTRAINT "user_stickers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."user_stickers"
    ADD CONSTRAINT "user_stickers_user_id_file_sha256_key" UNIQUE ("user_id", "file_sha256");

CREATE INDEX "aviso_de_mensagem_pendente_idx" ON "public"."aviso_de_mensagem" USING "btree" ("proxima_em") WHERE ("estado" = ANY (ARRAY['enviando'::"text", 'repetir'::"text"]));

CREATE UNIQUE INDEX "conversations_instagram_pessoa_na_linha" ON "public"."conversations" USING "btree" ("phone_number_id", "instagram_account_id", "instagram_user_id") WHERE ("instagram_user_id" IS NOT NULL);

CREATE INDEX "idx_action_button_phone_numbers_button_id" ON "public"."action_button_phone_numbers" USING "btree" ("action_button_id");

CREATE INDEX "idx_action_button_phone_numbers_phone_id" ON "public"."action_button_phone_numbers" USING "btree" ("phone_number_id");

CREATE INDEX "idx_api_keys_organization_id" ON "public"."api_keys" USING "btree" ("organization_id");

CREATE INDEX "idx_automation_executions_conversation_id" ON "public"."automation_executions" USING "btree" ("conversation_id");

CREATE INDEX "idx_automation_executions_flow_id" ON "public"."automation_executions" USING "btree" ("flow_id");

CREATE INDEX "idx_automation_executions_organization_id" ON "public"."automation_executions" USING "btree" ("organization_id");

CREATE INDEX "idx_automation_executions_retencao" ON "public"."automation_executions" USING "btree" ("started_at") WHERE ("status" = ANY (ARRAY['stopped'::"text", 'no_match'::"text"]));

CREATE INDEX "idx_automation_executions_started_at" ON "public"."automation_executions" USING "btree" ("started_at" DESC);

CREATE INDEX "idx_automation_flows_active" ON "public"."automation_flows" USING "btree" ("is_active") WHERE ("is_active" = true);

CREATE INDEX "idx_automation_flows_org" ON "public"."automation_flows" USING "btree" ("organization_id");

CREATE INDEX "idx_automation_flows_phone" ON "public"."automation_flows" USING "btree" ("phone_number_id");

CREATE INDEX "idx_automation_sessions_conv" ON "public"."automation_sessions" USING "btree" ("conversation_id");

CREATE INDEX "idx_automation_sessions_flow" ON "public"."automation_sessions" USING "btree" ("flow_id");

CREATE INDEX "idx_automation_sessions_status" ON "public"."automation_sessions" USING "btree" ("status") WHERE ("status" = 'active'::"text");

CREATE INDEX "idx_automation_triggers_active" ON "public"."automation_triggers" USING "btree" ("is_active") WHERE ("is_active" = true);

CREATE INDEX "idx_automation_triggers_flow" ON "public"."automation_triggers" USING "btree" ("flow_id");

CREATE INDEX "idx_automation_triggers_type" ON "public"."automation_triggers" USING "btree" ("trigger_type");

CREATE INDEX "idx_broadcasts_org" ON "public"."broadcasts" USING "btree" ("organization_id");

CREATE INDEX "idx_broadcasts_phone" ON "public"."broadcasts" USING "btree" ("phone_number_id");

CREATE INDEX "idx_broadcasts_status" ON "public"."broadcasts" USING "btree" ("status");

CREATE INDEX "idx_close_reasons_organization_id" ON "public"."close_reasons" USING "btree" ("organization_id");

CREATE INDEX "idx_close_reasons_phone_number_id" ON "public"."close_reasons" USING "btree" ("phone_number_id");

CREATE INDEX "idx_conversation_assignees_conversation" ON "public"."conversation_assignees" USING "btree" ("conversation_id");

CREATE INDEX "idx_conversation_assignees_user" ON "public"."conversation_assignees" USING "btree" ("user_id");

CREATE INDEX "idx_conversation_notes_conversation_id" ON "public"."conversation_notes" USING "btree" ("conversation_id");

CREATE INDEX "idx_conversation_notes_created_at" ON "public"."conversation_notes" USING "btree" ("created_at");

CREATE INDEX "idx_conversation_notes_created_by" ON "public"."conversation_notes" USING "btree" ("created_by");

CREATE INDEX "idx_conversation_prefs_conversation" ON "public"."conversation_prefs" USING "btree" ("conversation_id");

CREATE INDEX "idx_conversation_reads_conversation" ON "public"."conversation_reads" USING "btree" ("conversation_id");

CREATE INDEX "idx_conversation_reads_manual_unread" ON "public"."conversation_reads" USING "btree" ("user_id") WHERE ("marked_unread_at" IS NOT NULL);

CREATE INDEX "idx_conversation_tags_conversation_id" ON "public"."conversation_tags" USING "btree" ("conversation_id");

CREATE INDEX "idx_conversation_tags_tag_id" ON "public"."conversation_tags" USING "btree" ("tag_id");

CREATE INDEX "idx_conversations_assigned_to" ON "public"."conversations" USING "btree" ("assigned_to");

CREATE INDEX "idx_conversations_closed_by" ON "public"."conversations" USING "btree" ("closed_by");

CREATE INDEX "idx_conversations_group_jid" ON "public"."conversations" USING "btree" ("group_jid");

CREATE INDEX "idx_conversations_last_message_at" ON "public"."conversations" USING "btree" ("last_message_at" DESC);

CREATE INDEX "idx_conversations_phone_br_key" ON "public"."conversations" USING "btree" ("phone_number_id", "br_phone_key") WHERE ((NOT "is_group") AND ("br_phone_key" IS NOT NULL));

CREATE INDEX "idx_conversations_phone_last_msg_id" ON "public"."conversations" USING "btree" ("phone_number_id", "last_message_at" DESC, "id" DESC);

CREATE INDEX "idx_conversations_phone_number_id" ON "public"."conversations" USING "btree" ("phone_number_id");

CREATE UNIQUE INDEX "idx_conversations_unique_phone" ON "public"."conversations" USING "btree" ("phone_number_id", "contact_phone", "is_group");

CREATE INDEX "idx_disconnect_alert_log_phone" ON "public"."disconnect_alert_log" USING "btree" ("phone_number_id");

CREATE INDEX "idx_disconnect_alert_log_sent_at" ON "public"."disconnect_alert_log" USING "btree" ("alert_sent_at" DESC);

CREATE INDEX "idx_gpa_org_group" ON "public"."group_participant_aliases" USING "btree" ("organization_id", "group_jid");

CREATE INDEX "idx_gpa_participant" ON "public"."group_participant_aliases" USING "btree" ("participant_jid");

CREATE INDEX "idx_message_hidden_message" ON "public"."message_hidden" USING "btree" ("message_id");

CREATE INDEX "idx_message_reactions_message" ON "public"."message_reactions" USING "btree" ("message_id");

CREATE INDEX "idx_message_receipts_message" ON "public"."message_receipts" USING "btree" ("message_id");

CREATE INDEX "idx_messages_content_trgm" ON "public"."messages" USING "gin" ("content" "public"."gin_trgm_ops");

CREATE INDEX "idx_messages_conv_created" ON "public"."messages" USING "btree" ("conversation_id", "created_at" DESC);

CREATE INDEX "idx_messages_created_at" ON "public"."messages" USING "btree" ("created_at" DESC);

COMMENT ON INDEX "public"."idx_messages_created_at" IS 'Janelas de data sem conversation_id — as 8 RPCs de analytics. O índice composto (conversation_id, created_at) não cobre essas consultas. Btree e não BRIN: import de histórico grava linha antiga em página nova e mata a correlação.';

CREATE INDEX "idx_messages_flow_token" ON "public"."messages" USING "btree" ("flow_token") WHERE ("flow_token" IS NOT NULL);

CREATE INDEX "idx_messages_media_type" ON "public"."messages" USING "btree" ("message_type") WHERE ("message_type" <> 'text'::"text");

CREATE INDEX "idx_messages_quoted_message_id" ON "public"."messages" USING "btree" ("quoted_message_id") WHERE ("quoted_message_id" IS NOT NULL);

CREATE INDEX "idx_messages_sent_by" ON "public"."messages" USING "btree" ("sent_by") WHERE ("sent_by" IS NOT NULL);

CREATE INDEX "idx_messages_unread_inbound_conv_created" ON "public"."messages" USING "btree" ("conversation_id", "created_at" DESC) WHERE (("direction" = 'inbound'::"text") AND ("read_at" IS NULL));

CREATE INDEX "idx_messages_unread_inbound_v2" ON "public"."messages" USING "btree" ("conversation_id", "created_at" DESC) WHERE (("direction" = 'inbound'::"text") AND ("read_at" IS NULL) AND ("message_type" IS DISTINCT FROM 'group_action'::"text"));

CREATE INDEX "idx_org_members_user_id" ON "public"."organization_members" USING "btree" ("user_id");

CREATE INDEX "idx_organization_action_buttons_org_id" ON "public"."organization_action_buttons" USING "btree" ("organization_id");

CREATE INDEX "idx_organization_webhooks_org_id" ON "public"."organization_webhooks" USING "btree" ("organization_id");

CREATE INDEX "idx_phone_number_sessions_phone_number_id" ON "public"."phone_number_sessions" USING "btree" ("phone_number_id");

CREATE INDEX "idx_phone_numbers_org_id" ON "public"."phone_numbers" USING "btree" ("organization_id");

CREATE UNIQUE INDEX "idx_phone_numbers_unique_jid_active" ON "public"."phone_numbers" USING "btree" ("phone_number") WHERE (("is_active" = true) AND ("phone_number" IS NOT NULL) AND ("phone_number" <> 'Aguardando conexão...'::"text"));

CREATE INDEX "idx_push_subscriptions_user" ON "public"."push_subscriptions" USING "btree" ("user_id");

CREATE INDEX "idx_qr_message_log_created" ON "public"."qr_message_log" USING "btree" ("created_at" DESC);

CREATE INDEX "idx_qr_message_log_failures" ON "public"."qr_message_log" USING "btree" ("phone_number_id", "success", "created_at" DESC) WHERE ("success" = false);

CREATE INDEX "idx_qr_message_log_message_id" ON "public"."qr_message_log" USING "btree" ("message_id") WHERE ("message_id" IS NOT NULL);

CREATE INDEX "idx_recipients_broadcast" ON "public"."broadcast_recipients" USING "btree" ("broadcast_id");

CREATE INDEX "idx_recipients_claimable" ON "public"."broadcast_recipients" USING "btree" ("broadcast_id", "created_at", "id") WHERE ("status" = 'pending'::"text");

CREATE INDEX "idx_recipients_inflight" ON "public"."broadcast_recipients" USING "btree" ("claimed_at") WHERE ("status" = 'sending'::"text");

CREATE INDEX "idx_scheduled_messages_conversation" ON "public"."scheduled_messages" USING "btree" ("conversation_id");

CREATE INDEX "idx_scheduled_messages_created_by" ON "public"."scheduled_messages" USING "btree" ("created_by");

CREATE INDEX "idx_scheduled_messages_due" ON "public"."scheduled_messages" USING "btree" (COALESCE("next_attempt_at", "scheduled_at")) WHERE ("status" = 'scheduled'::"text");

CREATE INDEX "idx_scheduled_messages_org" ON "public"."scheduled_messages" USING "btree" ("organization_id");

CREATE INDEX "idx_scheduled_messages_phone" ON "public"."scheduled_messages" USING "btree" ("phone_number_id");

CREATE INDEX "idx_scheduled_messages_processing" ON "public"."scheduled_messages" USING "btree" ("last_attempt_at") WHERE ("status" = 'processing'::"text");

CREATE INDEX "idx_scheduled_messages_scheduled" ON "public"."scheduled_messages" USING "btree" ("scheduled_at") WHERE ("status" = 'scheduled'::"text");

CREATE INDEX "idx_scheduled_messages_status" ON "public"."scheduled_messages" USING "btree" ("status");

CREATE INDEX "idx_sector_members_user" ON "public"."sector_members" USING "btree" ("user_id");

CREATE INDEX "idx_sectors_phone_number" ON "public"."sectors" USING "btree" ("phone_number_id");

CREATE INDEX "idx_session_connection_log_phone" ON "public"."session_connection_log" USING "btree" ("phone_number_id", "created_at" DESC);

CREATE INDEX "idx_system_alerts_active" ON "public"."system_alerts" USING "btree" ("is_active", "expires_at");

CREATE INDEX "idx_tags_organization_id" ON "public"."tags" USING "btree" ("organization_id");

CREATE INDEX "idx_tags_phone_number_id" ON "public"."tags" USING "btree" ("phone_number_id");

CREATE INDEX "idx_user_phone_numbers_user_id" ON "public"."user_phone_numbers" USING "btree" ("user_id");

CREATE INDEX "idx_user_stickers_user_mru" ON "public"."user_stickers" USING "btree" ("user_id", "last_used_at" DESC);

CREATE UNIQUE INDEX "instagram_webhook_events_hash" ON "public"."instagram_webhook_events" USING "btree" ("event_hash");

CREATE INDEX "instagram_webhook_events_mid" ON "public"."instagram_webhook_events" USING "btree" ("mid") WHERE ("mid" IS NOT NULL);

CREATE INDEX "instagram_webhook_events_recebido" ON "public"."instagram_webhook_events" USING "btree" ("received_at" DESC);

CREATE INDEX "instagram_webhook_events_sem_assinatura" ON "public"."instagram_webhook_events" USING "btree" ("received_at") WHERE (NOT "signature_valid");

CREATE INDEX "linha_identidade_phone_number_id_idx" ON "public"."linha_identidade" USING "btree" ("phone_number_id");

CREATE INDEX "message_reactions_reacted_at" ON "public"."message_reactions" USING "btree" ("reacted_at");

CREATE UNIQUE INDEX "uq_message_reactions_reactor" ON "public"."message_reactions" USING "btree" ("message_id", COALESCE("reactor_jid", ''::"text"), "is_from_me");

CREATE UNIQUE INDEX "uq_message_receipts_participant" ON "public"."message_receipts" USING "btree" ("message_id", "participant_jid");

CREATE OR REPLACE TRIGGER "automation_flows_updated_at" BEFORE UPDATE ON "public"."automation_flows" FOR EACH ROW EXECUTE FUNCTION "public"."update_automation_updated_at"();

CREATE OR REPLACE TRIGGER "automation_sessions_updated_at" BEFORE UPDATE ON "public"."automation_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."update_automation_updated_at"();

CREATE OR REPLACE TRIGGER "broadcast_recipients_updated_at" BEFORE UPDATE ON "public"."broadcast_recipients" FOR EACH ROW EXECUTE FUNCTION "public"."touch_broadcast_recipient"();

CREATE OR REPLACE TRIGGER "broadcasts_updated_at" BEFORE UPDATE ON "public"."broadcasts" FOR EACH ROW EXECUTE FUNCTION "public"."update_broadcasts_updated_at"();

CREATE OR REPLACE TRIGGER "messages_failed_at" BEFORE UPDATE OF "status" ON "public"."messages" FOR EACH ROW WHEN ((("new"."status" = 'failed'::"text") AND ("old"."status" IS DISTINCT FROM 'failed'::"text"))) EXECUTE FUNCTION "public"."messages_carimbar_failed_at"();

CREATE OR REPLACE TRIGGER "messages_metadata_guarda" BEFORE UPDATE OF "metadata" ON "public"."messages" FOR EACH ROW WHEN ((("old"."metadata" -> 'leitura'::"text") IS DISTINCT FROM ("new"."metadata" -> 'leitura'::"text"))) EXECUTE FUNCTION "public"."_messages_metadata_guarda"();

CREATE OR REPLACE TRIGGER "messages_metadata_guarda_insert" BEFORE INSERT ON "public"."messages" FOR EACH ROW WHEN ((("new"."metadata" -> 'leitura'::"text") IS NOT NULL)) EXECUTE FUNCTION "public"."_messages_metadata_guarda"();

CREATE OR REPLACE TRIGGER "on_message_changed" AFTER DELETE OR UPDATE OF "content", "message_type", "is_deleted", "direction", "created_at", "conversation_id" ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."refresh_conversation_last_message_on_change"();

CREATE OR REPLACE TRIGGER "on_message_inserted" AFTER INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."update_conversation_last_message_at"();

CREATE OR REPLACE TRIGGER "phone_number_sessions_updated_at" BEFORE UPDATE ON "public"."phone_number_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."update_phone_number_sessions_updated_at"();

CREATE OR REPLACE TRIGGER "scheduled_messages_autor_e_arquivos" BEFORE INSERT OR UPDATE ON "public"."scheduled_messages" FOR EACH ROW EXECUTE FUNCTION "public"."scheduled_messages_autor_e_arquivos"();

CREATE OR REPLACE TRIGGER "scheduled_messages_updated_at" BEFORE UPDATE ON "public"."scheduled_messages" FOR EACH ROW EXECUTE FUNCTION "public"."update_scheduled_messages_updated_at"();

CREATE OR REPLACE TRIGGER "tr_broadcast_counts_delete" AFTER DELETE ON "public"."broadcast_recipients" FOR EACH ROW EXECUTE FUNCTION "public"."broadcast_counts_on_change"();

CREATE OR REPLACE TRIGGER "tr_broadcast_counts_insert" AFTER INSERT ON "public"."broadcast_recipients" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_counts_on_insert"();

CREATE OR REPLACE TRIGGER "tr_broadcast_counts_update" AFTER UPDATE ON "public"."broadcast_recipients" FOR EACH ROW WHEN ((("old"."status" IS DISTINCT FROM "new"."status") AND (("old"."status" = ANY (ARRAY['sent'::"text", 'failed'::"text"])) OR ("new"."status" = ANY (ARRAY['sent'::"text", 'failed'::"text"]))))) EXECUTE FUNCTION "public"."broadcast_counts_on_change"();

CREATE OR REPLACE TRIGGER "trg_compartilhar_tira_de_disparos" AFTER INSERT ON "public"."conversation_assignees" FOR EACH ROW EXECUTE FUNCTION "public"."trg_compartilhar_tira_de_disparos"();

CREATE OR REPLACE TRIGGER "trg_conversa_dono_e_aba_disparos" BEFORE UPDATE OF "assigned_to" ON "public"."conversations" FOR EACH ROW WHEN (("old"."assigned_to" IS DISTINCT FROM "new"."assigned_to")) EXECUTE FUNCTION "public"."trg_conversa_dono_e_aba_disparos"();

CREATE OR REPLACE TRIGGER "trg_conversation_close_lifecycle" BEFORE UPDATE OF "status" ON "public"."conversations" FOR EACH ROW WHEN (("old"."status" IS DISTINCT FROM "new"."status")) EXECUTE FUNCTION "public"."trg_conversation_close_lifecycle"();

CREATE OR REPLACE TRIGGER "trg_normalize_conversation_phone_before" BEFORE INSERT OR UPDATE OF "contact_phone" ON "public"."conversations" FOR EACH ROW EXECUTE FUNCTION "public"."trg_normalize_conversation_phone"();

CREATE OR REPLACE TRIGGER "trg_prevent_phone_reactivation_conflict" BEFORE UPDATE ON "public"."phone_numbers" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_phone_reactivation_conflict"();

CREATE OR REPLACE TRIGGER "trg_prevent_primary_in_assignees" BEFORE INSERT OR UPDATE ON "public"."conversation_assignees" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_primary_in_assignees"();

CREATE OR REPLACE TRIGGER "trg_profiles_guard_protected_columns" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."profiles_guard_protected_columns"();

CREATE OR REPLACE TRIGGER "trg_quick_replies_updated_at" BEFORE UPDATE ON "public"."quick_replies" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "trg_resposta_movida_tira_de_disparos" AFTER UPDATE OF "conversation_id" ON "public"."messages" FOR EACH ROW WHEN ((("old"."conversation_id" IS DISTINCT FROM "new"."conversation_id") AND ("new"."direction" = 'inbound'::"text") AND (NOT "new"."is_imported") AND ("new"."message_type" <> ALL (ARRAY['button_reply'::"text", 'list_reply'::"text", 'nfm_reply'::"text", 'reaction'::"text", 'group_action'::"text"])) AND (NOT (("new"."message_type" = 'unsupported'::"text") AND ("new"."metadata" IS NULL))))) EXECUTE FUNCTION "public"."trg_resposta_movida_tira_de_disparos"();

CREATE OR REPLACE TRIGGER "trg_setor_segue_dono_avisa" AFTER UPDATE OF "assigned_to" ON "public"."conversations" FOR EACH ROW WHEN (("old"."assigned_to" IS DISTINCT FROM "new"."assigned_to")) EXECUTE FUNCTION "public"."trg_setor_segue_dono_avisa"();

CREATE OR REPLACE TRIGGER "trg_setor_segue_dono_ins" BEFORE INSERT ON "public"."conversations" FOR EACH ROW WHEN ((("new"."assigned_to" IS NOT NULL) OR ("new"."sector_id" IS NOT NULL))) EXECUTE FUNCTION "public"."trg_setor_segue_dono"();

CREATE OR REPLACE TRIGGER "trg_setor_segue_dono_upd" BEFORE UPDATE OF "assigned_to", "sector_id" ON "public"."conversations" FOR EACH ROW WHEN ((("old"."assigned_to" IS DISTINCT FROM "new"."assigned_to") OR ("old"."sector_id" IS DISTINCT FROM "new"."sector_id"))) EXECUTE FUNCTION "public"."trg_setor_segue_dono"();

CREATE OR REPLACE TRIGGER "trg_share_avatar_pull" BEFORE INSERT ON "public"."conversations" FOR EACH ROW WHEN ((("new"."contact_avatar_url" IS NULL) AND ("new"."is_group" = false))) EXECUTE FUNCTION "public"."share_contact_avatar_across_lines"();

CREATE OR REPLACE TRIGGER "trg_share_avatar_push" AFTER INSERT OR UPDATE OF "contact_avatar_url", "contact_avatar_updated_at" ON "public"."conversations" FOR EACH ROW WHEN ((("new"."contact_avatar_url" IS NOT NULL) AND ("new"."is_group" = false))) EXECUTE FUNCTION "public"."share_contact_avatar_across_lines"();

CREATE OR REPLACE TRIGGER "trg_status_do_disparo" AFTER UPDATE OF "status" ON "public"."messages" FOR EACH ROW WHEN ((("old"."status" IS DISTINCT FROM "new"."status") AND ("new"."direction" = 'outbound'::"text") AND ("jsonb_typeof"(("new"."metadata" -> 'disparo'::"text")) = 'object'::"text"))) EXECUTE FUNCTION "public"."trg_status_do_disparo"();

CREATE OR REPLACE TRIGGER "trg_user_stickers_cap" BEFORE INSERT ON "public"."user_stickers" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_user_stickers_cap"();

CREATE OR REPLACE TRIGGER "update_conversations_updated_at" BEFORE UPDATE ON "public"."conversations" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_phone_numbers_updated_at" BEFORE UPDATE ON "public"."phone_numbers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

ALTER TABLE ONLY "public"."action_button_phone_numbers"
    ADD CONSTRAINT "action_button_phone_numbers_action_button_id_fkey" FOREIGN KEY ("action_button_id") REFERENCES "public"."organization_action_buttons"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."action_button_phone_numbers"
    ADD CONSTRAINT "action_button_phone_numbers_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."analytics_daily_metrics"
    ADD CONSTRAINT "analytics_daily_metrics_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."analytics_daily_templates"
    ADD CONSTRAINT "analytics_daily_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");

ALTER TABLE ONLY "public"."automation_executions"
    ADD CONSTRAINT "automation_executions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."automation_executions"
    ADD CONSTRAINT "automation_executions_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "public"."automation_flows"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."automation_executions"
    ADD CONSTRAINT "automation_executions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."automation_executions"
    ADD CONSTRAINT "automation_executions_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."automation_executions"
    ADD CONSTRAINT "automation_executions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."automation_sessions"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."automation_flows"
    ADD CONSTRAINT "automation_flows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."automation_flows"
    ADD CONSTRAINT "automation_flows_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."automation_sessions"
    ADD CONSTRAINT "automation_sessions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."automation_sessions"
    ADD CONSTRAINT "automation_sessions_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "public"."automation_flows"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."automation_triggers"
    ADD CONSTRAINT "automation_triggers_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "public"."automation_flows"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."aviso_de_mensagem"
    ADD CONSTRAINT "aviso_de_mensagem_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."broadcast_recipients"
    ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."broadcasts"
    ADD CONSTRAINT "broadcasts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."broadcasts"
    ADD CONSTRAINT "broadcasts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."broadcasts"
    ADD CONSTRAINT "broadcasts_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."close_reasons"
    ADD CONSTRAINT "close_reasons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");

ALTER TABLE ONLY "public"."close_reasons"
    ADD CONSTRAINT "close_reasons_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_assignees"
    ADD CONSTRAINT "conversation_assignees_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."conversation_assignees"
    ADD CONSTRAINT "conversation_assignees_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_assignees"
    ADD CONSTRAINT "conversation_assignees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_notes"
    ADD CONSTRAINT "conversation_notes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_notes"
    ADD CONSTRAINT "conversation_notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."conversation_prefs"
    ADD CONSTRAINT "conversation_prefs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_prefs"
    ADD CONSTRAINT "conversation_prefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_reads"
    ADD CONSTRAINT "conversation_reads_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_reads"
    ADD CONSTRAINT "conversation_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_tags"
    ADD CONSTRAINT "conversation_tags_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_tags"
    ADD CONSTRAINT "conversation_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."disconnect_alert_log"
    ADD CONSTRAINT "disconnect_alert_log_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."group_participant_aliases"
    ADD CONSTRAINT "group_participant_aliases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."group_participant_aliases"
    ADD CONSTRAINT "group_participant_aliases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."instagram_connections"
    ADD CONSTRAINT "instagram_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."instagram_connections"
    ADD CONSTRAINT "instagram_connections_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."linha_identidade"
    ADD CONSTRAINT "linha_identidade_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."message_hidden"
    ADD CONSTRAINT "message_hidden_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."message_hidden"
    ADD CONSTRAINT "message_hidden_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."message_receipts"
    ADD CONSTRAINT "message_receipts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_quoted_message_id_fkey" FOREIGN KEY ("quoted_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."organization_action_buttons"
    ADD CONSTRAINT "organization_action_buttons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."organization_webhooks"
    ADD CONSTRAINT "organization_webhooks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."phone_number_sessions"
    ADD CONSTRAINT "phone_number_sessions_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."phone_numbers"
    ADD CONSTRAINT "phone_numbers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."qr_message_log"
    ADD CONSTRAINT "qr_message_log_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."quick_replies"
    ADD CONSTRAINT "quick_replies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."quick_replies"
    ADD CONSTRAINT "quick_replies_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."quick_replies"
    ADD CONSTRAINT "quick_replies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_quoted_message_id_fkey" FOREIGN KEY ("quoted_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."sector_members"
    ADD CONSTRAINT "sector_members_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."sector_members"
    ADD CONSTRAINT "sector_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."sectors"
    ADD CONSTRAINT "sectors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."sectors"
    ADD CONSTRAINT "sectors_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."session_connection_log"
    ADD CONSTRAINT "session_connection_log_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."system_alert_state"
    ADD CONSTRAINT "system_alert_state_system_alert_id_fkey" FOREIGN KEY ("system_alert_id") REFERENCES "public"."system_alerts"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");

ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_invitations"
    ADD CONSTRAINT "user_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_invitations"
    ADD CONSTRAINT "user_invitations_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_phone_numbers"
    ADD CONSTRAINT "user_phone_numbers_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_phone_numbers"
    ADD CONSTRAINT "user_phone_numbers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_stickers"
    ADD CONSTRAINT "user_stickers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

CREATE POLICY "Admins can create automation flows" ON "public"."automation_flows" FOR INSERT WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "automation_flows"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("organization_members"."role" = 'admin'::"public"."org_role"))))));

CREATE POLICY "Admins can create invitations" ON "public"."user_invitations" FOR INSERT WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."user_is_org_admin"("public"."get_phone_org_id"("phone_number_id"))));

CREATE POLICY "Admins can create org webhooks" ON "public"."organization_webhooks" FOR INSERT WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "organization_webhooks"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("organization_members"."role" = 'admin'::"public"."org_role"))))));

CREATE POLICY "Admins can delete automation flows" ON "public"."automation_flows" FOR DELETE USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "automation_flows"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("organization_members"."role" = 'admin'::"public"."org_role"))))));

CREATE POLICY "Admins can delete invitations" ON "public"."user_invitations" FOR DELETE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM ("public"."phone_numbers" "pn"
     JOIN "public"."organization_members" "om" ON (("pn"."organization_id" = "om"."organization_id")))
  WHERE (("pn"."id" = "user_invitations"."phone_number_id") AND ("om"."user_id" = "auth"."uid"()) AND ("om"."role" = 'admin'::"public"."org_role"))))));

CREATE POLICY "Admins can delete org webhooks" ON "public"."organization_webhooks" FOR DELETE USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "organization_webhooks"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("organization_members"."role" = 'admin'::"public"."org_role"))))));

CREATE POLICY "Admins can manage action button phones" ON "public"."action_button_phone_numbers" USING ((EXISTS ( SELECT 1
   FROM ("public"."organization_action_buttons" "oab"
     JOIN "public"."organization_members" "om" ON (("om"."organization_id" = "oab"."organization_id")))
  WHERE (("oab"."id" = "action_button_phone_numbers"."action_button_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = 'admin'::"public"."org_role")))));

CREATE POLICY "Admins can manage org action buttons" ON "public"."organization_action_buttons" USING ((EXISTS ( SELECT 1
   FROM "public"."organization_members" "om"
  WHERE (("om"."organization_id" = "organization_action_buttons"."organization_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = 'admin'::"public"."org_role")))));

CREATE POLICY "Admins can manage sectors" ON "public"."sectors" USING (((EXISTS ( SELECT 1
   FROM "public"."organization_members" "om"
  WHERE (("om"."organization_id" = "sectors"."organization_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = 'admin'::"public"."org_role")))) OR ( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin")));

CREATE POLICY "Admins can manage triggers" ON "public"."automation_triggers" USING ((EXISTS ( SELECT 1
   FROM ("public"."automation_flows" "af"
     JOIN "public"."organization_members" "om" ON (("om"."organization_id" = "af"."organization_id")))
  WHERE (("af"."id" = "automation_triggers"."flow_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = 'admin'::"public"."org_role")))));

CREATE POLICY "Admins can update automation flows" ON "public"."automation_flows" FOR UPDATE USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "automation_flows"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("organization_members"."role" = 'admin'::"public"."org_role"))))));

CREATE POLICY "Admins can update org webhooks" ON "public"."organization_webhooks" FOR UPDATE USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "organization_webhooks"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("organization_members"."role" = 'admin'::"public"."org_role"))))));

CREATE POLICY "Admins can update organizations" ON "public"."organizations" FOR UPDATE USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "organizations"."id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("organization_members"."role" = 'admin'::"public"."org_role"))))));

CREATE POLICY "Admins can view analytics metrics" ON "public"."analytics_daily_metrics" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "analytics_daily_metrics"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("organization_members"."role" = 'admin'::"public"."org_role")))));

CREATE POLICY "Admins can view template metrics" ON "public"."analytics_daily_templates" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "analytics_daily_templates"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("organization_members"."role" = 'admin'::"public"."org_role")))));

CREATE POLICY "Anyone can read active alerts" ON "public"."system_alerts" FOR SELECT TO "authenticated" USING ((("is_active" = true) AND (("expires_at" IS NULL) OR ("expires_at" > "now"()))));

CREATE POLICY "Members can view action button phones" ON "public"."action_button_phone_numbers" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."organization_action_buttons" "oab"
     JOIN "public"."organization_members" "om" ON (("om"."organization_id" = "oab"."organization_id")))
  WHERE (("oab"."id" = "action_button_phone_numbers"."action_button_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));

CREATE POLICY "Members can view org action buttons" ON "public"."organization_action_buttons" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."organization_members" "om"
  WHERE (("om"."organization_id" = "organization_action_buttons"."organization_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));

CREATE POLICY "Members can view org disconnect logs" ON "public"."disconnect_alert_log" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."phone_numbers" "pn"
     JOIN "public"."organization_members" "om" ON (("om"."organization_id" = "pn"."organization_id")))
  WHERE (("pn"."id" = "disconnect_alert_log"."phone_number_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));

CREATE POLICY "Members can view sectors" ON "public"."sectors" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."organization_members" "om"
  WHERE (("om"."organization_id" = "sectors"."organization_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) OR ( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin")));

CREATE POLICY "Org members can view triggers" ON "public"."automation_triggers" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."automation_flows" "af"
     JOIN "public"."organization_members" "om" ON (("om"."organization_id" = "af"."organization_id")))
  WHERE (("af"."id" = "automation_triggers"."flow_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));

CREATE POLICY "Super admins can create organizations" ON "public"."organizations" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))));

CREATE POLICY "Super admins can delete organizations" ON "public"."organizations" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))));

CREATE POLICY "Super admins can manage all action button phones" ON "public"."action_button_phone_numbers" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))));

CREATE POLICY "Super admins can manage all action buttons" ON "public"."organization_action_buttons" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))));

CREATE POLICY "Super admins can manage all triggers" ON "public"."automation_triggers" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))));

CREATE POLICY "Super admins can view all disconnect logs" ON "public"."disconnect_alert_log" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))));

CREATE POLICY "Users can create API keys" ON "public"."api_keys" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (( SELECT "public"."user_is_org_admin"("api_keys"."organization_id") AS "user_is_org_admin") OR ( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin"))));

CREATE POLICY "Users can create conversation notes" ON "public"."conversation_notes" FOR INSERT WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (("created_by" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "conversation_notes"."conversation_id"))))));

CREATE POLICY "Users can delete conversation notes" ON "public"."conversation_notes" FOR DELETE USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR ("created_by" = ( SELECT "auth"."uid"() AS "uid"))));

CREATE POLICY "Users can delete own API keys" ON "public"."api_keys" FOR DELETE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "Users can update own API keys" ON "public"."api_keys" FOR UPDATE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (("organization_id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[])) OR ( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin"))));

CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "Users can view automation flows" ON "public"."automation_flows" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "automation_flows"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));

CREATE POLICY "Users can view automation sessions" ON "public"."automation_sessions" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR (EXISTS ( SELECT 1
   FROM ("public"."automation_flows" "af"
     JOIN "public"."organization_members" "om" ON (("om"."organization_id" = "af"."organization_id")))
  WHERE (("af"."id" = "automation_sessions"."flow_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));

CREATE POLICY "Users can view conversation notes" ON "public"."conversation_notes" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "conversation_notes"."conversation_id")))));

CREATE POLICY "Users can view invitations" ON "public"."user_invitations" FOR SELECT USING (("public"."auth_is_super_admin"() OR (EXISTS ( SELECT 1
   FROM ("public"."phone_numbers" "pn"
     JOIN "public"."organization_members" "om" ON (("pn"."organization_id" = "om"."organization_id")))
  WHERE (("pn"."id" = "user_invitations"."phone_number_id") AND ("om"."user_id" = "auth"."uid"()) AND ("om"."role" = 'admin'::"public"."org_role"))))));

CREATE POLICY "Users can view org webhooks" ON "public"."organization_webhooks" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profiles"."is_super_admin" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "organization_webhooks"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));

CREATE POLICY "Users can view own API keys" ON "public"."api_keys" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "Users can view their organization's executions" ON "public"."automation_executions" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("organization_id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[]))));

ALTER TABLE "public"."action_button_phone_numbers" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."analytics_daily_metrics" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."analytics_daily_templates" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."automation_executions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."automation_flows" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."automation_sessions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."automation_triggers" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."aviso_de_mensagem" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."broadcast_recipients" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."broadcasts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "broadcasts_delete" ON "public"."broadcasts" FOR DELETE TO "authenticated" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))));

CREATE POLICY "broadcasts_insert" ON "public"."broadcasts" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))));

CREATE POLICY "broadcasts_select" ON "public"."broadcasts" FOR SELECT TO "authenticated" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))));

CREATE POLICY "broadcasts_update" ON "public"."broadcasts" FOR UPDATE TO "authenticated" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[])))) WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))));

ALTER TABLE "public"."close_reasons" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "close_reasons_delete" ON "public"."close_reasons" FOR DELETE TO "authenticated" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."can_manage_phone_number"("phone_number_id")));

CREATE POLICY "close_reasons_insert" ON "public"."close_reasons" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."can_manage_phone_number"("phone_number_id")));

CREATE POLICY "close_reasons_select" ON "public"."close_reasons" FOR SELECT TO "authenticated" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."can_manage_phone_number"("phone_number_id") OR (("phone_number_id" IS NULL) AND ("organization_id" IN ( SELECT "om"."organization_id"
   FROM "public"."organization_members" "om"
  WHERE ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));

ALTER TABLE "public"."conversation_assignees" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_assignees_delete" ON "public"."conversation_assignees" FOR DELETE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "conversation_assignees"."conversation_id")))));

CREATE POLICY "conversation_assignees_insert" ON "public"."conversation_assignees" FOR INSERT WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "conversation_assignees"."conversation_id")))));

CREATE POLICY "conversation_assignees_select" ON "public"."conversation_assignees" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "conversation_assignees"."conversation_id")))));

ALTER TABLE "public"."conversation_notes" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."conversation_prefs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_prefs_delete_own" ON "public"."conversation_prefs" FOR DELETE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "conversation_prefs_insert_own" ON "public"."conversation_prefs" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "conversation_prefs"."conversation_id")))));

CREATE POLICY "conversation_prefs_select_own" ON "public"."conversation_prefs" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "conversation_prefs_update_own" ON "public"."conversation_prefs" FOR UPDATE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

ALTER TABLE "public"."conversation_reads" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_reads_delete_own" ON "public"."conversation_reads" FOR DELETE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "conversation_reads_insert_own" ON "public"."conversation_reads" FOR INSERT WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE (("c"."id" = "conversation_reads"."conversation_id") AND ("c"."phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[])))))));

CREATE POLICY "conversation_reads_select_own" ON "public"."conversation_reads" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "conversation_reads_update_own" ON "public"."conversation_reads" FOR UPDATE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

ALTER TABLE "public"."conversation_tags" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_tags_delete" ON "public"."conversation_tags" FOR DELETE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "conversation_tags"."conversation_id")))));

CREATE POLICY "conversation_tags_insert" ON "public"."conversation_tags" FOR INSERT WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "conversation_tags"."conversation_id")))));

CREATE POLICY "conversation_tags_select" ON "public"."conversation_tags" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "conversation_tags"."conversation_id")))));

ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversations_insert" ON "public"."conversations" FOR INSERT WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[])) AND (("sector_id" IS NULL) OR ("phone_number_id" = ANY (( SELECT "public"."get_my_open_phone_ids"() AS "get_my_open_phone_ids")::"uuid"[])) OR ("sector_id" = ANY (( SELECT "public"."get_my_sector_ids"() AS "get_my_sector_ids")::"uuid"[]))))));

COMMENT ON POLICY "conversations_insert" ON "public"."conversations" IS 'Criar conversa exige acesso à linha (mesma definição de conversations_select) e, quando o setor é informado, que ele seja meu ou que o isolamento não se aplique a mim nesta linha.';

CREATE POLICY "conversations_select" ON "public"."conversations" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("assigned_to" = ( SELECT "auth"."uid"() AS "uid")) OR ("id" = ANY (( SELECT "public"."get_my_co_owned_conversation_ids"() AS "get_my_co_owned_conversation_ids")::"uuid"[])) OR ("phone_number_id" = ANY (( SELECT "public"."get_my_open_phone_ids"() AS "get_my_open_phone_ids")::"uuid"[])) OR (("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[])) AND (("sector_id" IS NULL) OR ("sector_id" = ANY (( SELECT "public"."get_my_sector_ids"() AS "get_my_sector_ids")::"uuid"[]))))));

CREATE POLICY "conversations_update" ON "public"."conversations" FOR UPDATE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("assigned_to" = ( SELECT "auth"."uid"() AS "uid")) OR ("id" = ANY (( SELECT "public"."get_my_co_owned_conversation_ids"() AS "get_my_co_owned_conversation_ids")::"uuid"[])) OR ("phone_number_id" = ANY (( SELECT "public"."get_my_open_phone_ids"() AS "get_my_open_phone_ids")::"uuid"[])) OR (("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[])) AND (("sector_id" IS NULL) OR ("sector_id" = ANY (( SELECT "public"."get_my_sector_ids"() AS "get_my_sector_ids")::"uuid"[]))))));

ALTER TABLE "public"."disconnect_alert_log" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gpa_delete" ON "public"."group_participant_aliases" FOR DELETE TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "group_participant_aliases"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_super_admin" = true))))));

CREATE POLICY "gpa_insert" ON "public"."group_participant_aliases" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "group_participant_aliases"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_super_admin" = true))))));

CREATE POLICY "gpa_select" ON "public"."group_participant_aliases" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "group_participant_aliases"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_super_admin" = true))))));

CREATE POLICY "gpa_update" ON "public"."group_participant_aliases" FOR UPDATE TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."organization_members"
  WHERE (("organization_members"."organization_id" = "group_participant_aliases"."organization_id") AND ("organization_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_super_admin" = true))))));

ALTER TABLE "public"."group_participant_aliases" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."instagram_connections" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."instagram_webhook_events" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."linha_identidade" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."message_hidden" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "message_hidden_delete_own" ON "public"."message_hidden" FOR DELETE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "message_hidden_insert_own" ON "public"."message_hidden" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."messages" "m"
  WHERE ("m"."id" = "message_hidden"."message_id")))));

CREATE POLICY "message_hidden_select_own" ON "public"."message_hidden" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

ALTER TABLE "public"."message_reactions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "message_reactions_select" ON "public"."message_reactions" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."messages" "m"
  WHERE ("m"."id" = "message_reactions"."message_id")))));

ALTER TABLE "public"."message_receipts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "message_receipts_select" ON "public"."message_receipts" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."messages" "m"
  WHERE ("m"."id" = "message_receipts"."message_id")))));

ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_insert" ON "public"."messages" FOR INSERT WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."user_can_access_conversation"("conversation_id")));

CREATE POLICY "messages_select" ON "public"."messages" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "messages"."conversation_id")))));

CREATE POLICY "messages_update" ON "public"."messages" FOR UPDATE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM "public"."conversations" "c"
  WHERE ("c"."id" = "messages"."conversation_id")))));

CREATE POLICY "org_members_delete" ON "public"."organization_members" FOR DELETE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (("user_id" <> ( SELECT "auth"."uid"() AS "uid")) AND ("organization_id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[])) AND "public"."user_is_org_admin"("organization_id"))));

CREATE POLICY "org_members_insert" ON "public"."organization_members" FOR INSERT WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (("organization_id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[])) AND "public"."user_is_org_admin"("organization_id"))));

CREATE POLICY "org_members_select" ON "public"."organization_members" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("organization_id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[]))));

CREATE POLICY "org_members_update" ON "public"."organization_members" FOR UPDATE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (("organization_id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[])) AND "public"."user_is_org_admin"("organization_id"))));

ALTER TABLE "public"."organization_action_buttons" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."organization_members" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."organization_webhooks" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "orgs_select" ON "public"."organizations" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[]))));

ALTER TABLE "public"."phone_number_sessions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "phone_number_sessions_select_authenticated" ON "public"."phone_number_sessions" FOR SELECT TO "authenticated" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."user_has_phone_access"("phone_number_id") OR ("phone_number_id" IN ( SELECT "pn"."id"
   FROM "public"."phone_numbers" "pn"
  WHERE (("pn"."organization_id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[])) AND "public"."user_is_org_admin"("pn"."organization_id"))))));

CREATE POLICY "phone_number_sessions_service_only" ON "public"."phone_number_sessions" TO "service_role" USING (true) WITH CHECK (true);

ALTER TABLE "public"."phone_numbers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "phone_numbers_manage" ON "public"."phone_numbers" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (("organization_id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[])) AND (EXISTS ( SELECT 1
   FROM "public"."organization_members" "om"
  WHERE (("om"."organization_id" = "phone_numbers"."organization_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = 'admin'::"public"."org_role")))))));

CREATE POLICY "phone_numbers_select" ON "public"."phone_numbers" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."user_is_org_admin"("organization_id") OR "public"."user_has_phone_access"("id")));

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_escopo" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("id" = ( SELECT "auth"."uid"() AS "uid")) OR ( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("id" IN ( SELECT "om"."user_id"
   FROM "public"."organization_members" "om"
  WHERE ("om"."organization_id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[]))))));

ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "push_subscriptions_delete_own" ON "public"."push_subscriptions" FOR DELETE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "push_subscriptions_insert_own" ON "public"."push_subscriptions" FOR INSERT WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "push_subscriptions_select_own" ON "public"."push_subscriptions" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "push_subscriptions_update_own" ON "public"."push_subscriptions" FOR UPDATE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

ALTER TABLE "public"."qr_health_probe" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."qr_message_log" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."quick_replies" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quick_replies_delete" ON "public"."quick_replies" FOR DELETE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))));

CREATE POLICY "quick_replies_insert" ON "public"."quick_replies" FOR INSERT WITH CHECK (((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))) AND ("organization_id" = ( SELECT "pn"."organization_id"
   FROM "public"."phone_numbers" "pn"
  WHERE ("pn"."id" = "quick_replies"."phone_number_id")))));

CREATE POLICY "quick_replies_select" ON "public"."quick_replies" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))));

CREATE POLICY "quick_replies_update" ON "public"."quick_replies" FOR UPDATE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[])))) WITH CHECK (((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))) AND ("organization_id" = ( SELECT "pn"."organization_id"
   FROM "public"."phone_numbers" "pn"
  WHERE ("pn"."id" = "quick_replies"."phone_number_id")))));

CREATE POLICY "recipients_delete" ON "public"."broadcast_recipients" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."broadcasts" "b"
  WHERE ("b"."id" = "broadcast_recipients"."broadcast_id"))));

CREATE POLICY "recipients_insert" ON "public"."broadcast_recipients" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."broadcasts" "b"
  WHERE ("b"."id" = "broadcast_recipients"."broadcast_id"))));

CREATE POLICY "recipients_select" ON "public"."broadcast_recipients" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."broadcasts" "b"
  WHERE ("b"."id" = "broadcast_recipients"."broadcast_id"))));

CREATE POLICY "recipients_update" ON "public"."broadcast_recipients" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."broadcasts" "b"
  WHERE ("b"."id" = "broadcast_recipients"."broadcast_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."broadcasts" "b"
  WHERE ("b"."id" = "broadcast_recipients"."broadcast_id"))));

ALTER TABLE "public"."scheduled_messages" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scheduled_messages_delete" ON "public"."scheduled_messages" FOR DELETE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))));

CREATE POLICY "scheduled_messages_insert" ON "public"."scheduled_messages" FOR INSERT WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))));

CREATE POLICY "scheduled_messages_select" ON "public"."scheduled_messages" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))));

CREATE POLICY "scheduled_messages_update" ON "public"."scheduled_messages" FOR UPDATE USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[])))) WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("phone_number_id" = ANY (( SELECT "public"."get_my_conversation_phone_ids"() AS "get_my_conversation_phone_ids")::"uuid"[]))));

ALTER TABLE "public"."sector_members" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sector_members_manage" ON "public"."sector_members" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM ("public"."sectors" "s"
     JOIN "public"."organization_members" "om" ON (("om"."organization_id" = "s"."organization_id")))
  WHERE (("s"."id" = "sector_members"."sector_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = 'admin'::"public"."org_role")))))) WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM ("public"."sectors" "s"
     JOIN "public"."organization_members" "om" ON (("om"."organization_id" = "s"."organization_id")))
  WHERE (("s"."id" = "sector_members"."sector_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("om"."role" = 'admin'::"public"."org_role"))))));

CREATE POLICY "sector_members_select" ON "public"."sector_members" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR (EXISTS ( SELECT 1
   FROM ("public"."sectors" "s"
     JOIN "public"."organization_members" "om" ON (("om"."organization_id" = "s"."organization_id")))
  WHERE (("s"."id" = "sector_members"."sector_id") AND ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));

ALTER TABLE "public"."sectors" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."session_connection_log" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."system_alert_state" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."system_alerts" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tags_delete" ON "public"."tags" FOR DELETE TO "authenticated" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."can_manage_phone_number"("phone_number_id")));

CREATE POLICY "tags_insert" ON "public"."tags" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."can_manage_phone_number"("phone_number_id")));

CREATE POLICY "tags_select" ON "public"."tags" FOR SELECT TO "authenticated" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."can_manage_phone_number"("phone_number_id") OR (("phone_number_id" IS NULL) AND ("organization_id" IN ( SELECT "om"."organization_id"
   FROM "public"."organization_members" "om"
  WHERE ("om"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));

CREATE POLICY "tags_update" ON "public"."tags" FOR UPDATE TO "authenticated" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."can_manage_phone_number"("phone_number_id")));

ALTER TABLE "public"."user_invitations" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."user_phone_numbers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_phone_numbers_manage" ON "public"."user_phone_numbers" USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."user_is_org_admin"("public"."get_phone_org_id"("phone_number_id")))) WITH CHECK ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR "public"."user_is_org_admin"("public"."get_phone_org_id"("phone_number_id"))));

CREATE POLICY "user_phone_numbers_select" ON "public"."user_phone_numbers" FOR SELECT USING ((( SELECT "public"."auth_is_super_admin"() AS "auth_is_super_admin") OR ("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("phone_number_id" IN ( SELECT "pn"."id"
   FROM "public"."phone_numbers" "pn"
  WHERE ("pn"."organization_id" = ANY (( SELECT "public"."get_my_org_ids"() AS "get_my_org_ids")::"uuid"[]))))));

ALTER TABLE "public"."user_stickers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_stickers_delete_own" ON "public"."user_stickers" FOR DELETE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "user_stickers_insert_own" ON "public"."user_stickers" FOR INSERT WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "user_stickers_select_own" ON "public"."user_stickers" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "user_stickers_update_own" ON "public"."user_stickers" FOR UPDATE USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."conversation_assignees";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."conversation_tags";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."conversations";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."message_reactions";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."message_receipts";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."messages";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."scheduled_messages";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."system_alerts";

GRANT USAGE ON SCHEMA "public" TO "postgres";

GRANT USAGE ON SCHEMA "public" TO "anon";

GRANT USAGE ON SCHEMA "public" TO "authenticated";

GRANT USAGE ON SCHEMA "public" TO "service_role";

GRANT USAGE ON SCHEMA "public" TO "supabase_auth_admin";

-- ===========================================================================================
-- Privilégios. O dump só emitia GRANT ALL e REVOKE FROM PUBLIC; num `supabase start` os default privileges dão
-- EXECUTE/ALL a anon e authenticated em tudo que o postgres cria. Cada objeto abaixo é revogado de todos os papéis e
-- recebe de volta só os privilégios listados.
-- ===========================================================================================

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role, supabase_auth_admin;


-- ---- funções ----
-- _segredo_obrigatorio (função nova)
REVOKE ALL ON FUNCTION public._segredo_obrigatorio(p_nome text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public._segredo_obrigatorio(p_nome text) TO service_role;

-- dispatch_fetch_analytics (função nova)
REVOKE ALL ON FUNCTION public.dispatch_fetch_analytics() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.dispatch_fetch_analytics() TO service_role;

-- get_org_whatsapp_config (função nova)
REVOKE ALL ON FUNCTION public.get_org_whatsapp_config(p_org_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_org_whatsapp_config(p_org_id uuid) TO authenticated, service_role;

-- get_org_ai_config (função nova)
REVOKE ALL ON FUNCTION public.get_org_ai_config(p_org_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_org_ai_config(p_org_id uuid) TO authenticated, service_role;

-- _messages_metadata_guarda
REVOKE ALL ON FUNCTION public._messages_metadata_guarda() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public._messages_metadata_guarda() TO service_role;

-- accept_invitation
REVOKE ALL ON FUNCTION public.accept_invitation(token_input text, user_id_input uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.accept_invitation(token_input text, user_id_input uuid) TO PUBLIC, anon, authenticated, service_role;

-- assert_org_analytics_access
REVOKE ALL ON FUNCTION public.assert_org_analytics_access(p_org_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.assert_org_analytics_access(p_org_id uuid) TO authenticated, service_role;

-- auth_is_super_admin
REVOKE ALL ON FUNCTION public.auth_is_super_admin() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.auth_is_super_admin() TO PUBLIC, anon, authenticated, service_role;

-- auth_user_org_ids
REVOKE ALL ON FUNCTION public.auth_user_org_ids() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.auth_user_org_ids() TO PUBLIC, anon, authenticated, service_role;

-- aviso_de_mensagem_pegar_lote
REVOKE ALL ON FUNCTION public.aviso_de_mensagem_pegar_lote(p_limite integer) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.aviso_de_mensagem_pegar_lote(p_limite integer) TO service_role;

-- aviso_de_mensagem_repetir
REVOKE ALL ON FUNCTION public.aviso_de_mensagem_repetir() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.aviso_de_mensagem_repetir() TO service_role;

-- backfill_conversations_last_message
REVOKE ALL ON FUNCTION public.backfill_conversations_last_message(p_batch integer) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.backfill_conversations_last_message(p_batch integer) TO service_role;

-- br_phone_key
REVOKE ALL ON FUNCTION public.br_phone_key(phone text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.br_phone_key(phone text) TO PUBLIC, anon, authenticated, service_role;

-- broadcast_counts_on_change
REVOKE ALL ON FUNCTION public.broadcast_counts_on_change() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.broadcast_counts_on_change() TO PUBLIC, anon, authenticated, service_role;

-- broadcast_counts_on_insert
REVOKE ALL ON FUNCTION public.broadcast_counts_on_insert() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.broadcast_counts_on_insert() TO PUBLIC, anon, authenticated, service_role;

-- can_manage_phone_number
REVOKE ALL ON FUNCTION public.can_manage_phone_number(p_phone_number_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.can_manage_phone_number(p_phone_number_id uuid) TO PUBLIC, anon, authenticated, service_role;

-- cancel_broadcast
REVOKE ALL ON FUNCTION public.cancel_broadcast(p_broadcast_id uuid, p_organization_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.cancel_broadcast(p_broadcast_id uuid, p_organization_id uuid) TO service_role;

-- check_and_update_auto_reply_cooldown
REVOKE ALL ON FUNCTION public.check_and_update_auto_reply_cooldown(p_conversation_id uuid, p_cooldown_minutes integer) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.check_and_update_auto_reply_cooldown(p_conversation_id uuid, p_cooldown_minutes integer) TO service_role;

-- check_message_failure_alerts
REVOKE ALL ON FUNCTION public.check_message_failure_alerts() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.check_message_failure_alerts() TO service_role;

-- check_qr_service_health
REVOKE ALL ON FUNCTION public.check_qr_service_health() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.check_qr_service_health() TO service_role;

-- claim_broadcast_batch
REVOKE ALL ON FUNCTION public.claim_broadcast_batch(p_broadcast_id uuid, p_limit integer) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.claim_broadcast_batch(p_broadcast_id uuid, p_limit integer) TO service_role;

-- close_inactive_conversations
REVOKE ALL ON FUNCTION public.close_inactive_conversations() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.close_inactive_conversations() TO service_role;

-- conversa_do_telefone_na_linha
REVOKE ALL ON FUNCTION public.conversa_do_telefone_na_linha(p_phone_number_id uuid, p_telefone text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.conversa_do_telefone_na_linha(p_phone_number_id uuid, p_telefone text) TO authenticated, service_role;

-- conversation_refresh_last_message
REVOKE ALL ON FUNCTION public.conversation_refresh_last_message(p_conversation_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.conversation_refresh_last_message(p_conversation_id uuid) TO service_role;

-- create_onboarding_organization (ACL ajustado: sem EXECUTE para anon/PUBLIC: só super admin cria organização, e a função confere)
REVOKE ALL ON FUNCTION public.create_onboarding_organization(p_name text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.create_onboarding_organization(p_name text) TO authenticated, service_role;

-- dispatch_broadcast_work
REVOKE ALL ON FUNCTION public.dispatch_broadcast_work() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.dispatch_broadcast_work() TO service_role;

-- enforce_user_stickers_cap
REVOKE ALL ON FUNCTION public.enforce_user_stickers_cap() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.enforce_user_stickers_cap() TO PUBLIC, anon, authenticated, service_role;

-- extract_br_phone_parts
REVOKE ALL ON FUNCTION public.extract_br_phone_parts(phone text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.extract_br_phone_parts(phone text) TO PUBLIC, anon, authenticated, service_role;

-- generate_org_slug
REVOKE ALL ON FUNCTION public.generate_org_slug(p_name text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.generate_org_slug(p_name text) TO PUBLIC, anon, authenticated, service_role;

-- get_advanced_analytics_stats
REVOKE ALL ON FUNCTION public.get_advanced_analytics_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_advanced_analytics_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) TO authenticated, service_role;

-- get_agent_detailed_stats
REVOKE ALL ON FUNCTION public.get_agent_detailed_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_agent_detailed_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) TO authenticated, service_role;

-- get_analytics_daily_volume
REVOKE ALL ON FUNCTION public.get_analytics_daily_volume(p_org_id uuid, p_days integer, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_analytics_daily_volume(p_org_id uuid, p_days integer, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) TO authenticated, service_role;

-- get_analytics_stats
REVOKE ALL ON FUNCTION public.get_analytics_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_analytics_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) TO service_role;

-- get_attendance_report
REVOKE ALL ON FUNCTION public.get_attendance_report(p_org_id uuid, p_phone_ids uuid[], p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_agent_ids uuid[], p_conversation_kind text, p_idle_hours integer, p_unanswered_hours integer, p_business_start time without time zone, p_business_end time without time zone, p_business_days integer[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_attendance_report(p_org_id uuid, p_phone_ids uuid[], p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_agent_ids uuid[], p_conversation_kind text, p_idle_hours integer, p_unanswered_hours integer, p_business_start time without time zone, p_business_end time without time zone, p_business_days integer[]) TO authenticated, service_role;

-- get_button_click_stats
REVOKE ALL ON FUNCTION public.get_button_click_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_button_click_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) TO authenticated, service_role;

-- get_channel_volume
REVOKE ALL ON FUNCTION public.get_channel_volume(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_channel_volume(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) TO authenticated, service_role;

-- get_close_reason_stats
REVOKE ALL ON FUNCTION public.get_close_reason_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_close_reason_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) TO authenticated, service_role;

-- get_connection_health
REVOKE ALL ON FUNCTION public.get_connection_health(p_org_id uuid, p_days integer) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_connection_health(p_org_id uuid, p_days integer) TO authenticated, service_role;

-- get_conversation_reactions
REVOKE ALL ON FUNCTION public.get_conversation_reactions(p_conversation_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_conversation_reactions(p_conversation_id uuid) TO authenticated, service_role;

-- get_conversation_tags_for_user
REVOKE ALL ON FUNCTION public.get_conversation_tags_for_user(p_phone_number_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_conversation_tags_for_user(p_phone_number_id uuid) TO authenticated, service_role;

-- get_decrypted_ai_key (ACL ajustado: sem EXECUTE para anon/PUBLIC: a função já recusa quem não é admin da org, e anon nem precisa chegar lá)
REVOKE ALL ON FUNCTION public.get_decrypted_ai_key(p_org_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_decrypted_ai_key(p_org_id uuid) TO authenticated, service_role;

-- get_hourly_heatmap
REVOKE ALL ON FUNCTION public.get_hourly_heatmap(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_hourly_heatmap(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[]) TO authenticated, service_role;

-- get_invitation_by_token
REVOKE ALL ON FUNCTION public.get_invitation_by_token(token_input text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_invitation_by_token(token_input text) TO PUBLIC, anon, authenticated, service_role;

-- get_last_messages
REVOKE ALL ON FUNCTION public.get_last_messages(conversation_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_last_messages(conversation_ids uuid[]) TO authenticated, service_role;

-- get_my_co_owned_conversation_ids
REVOKE ALL ON FUNCTION public.get_my_co_owned_conversation_ids() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_my_co_owned_conversation_ids() TO anon, authenticated, service_role, supabase_realtime_admin;

-- get_my_conversation_phone_ids
REVOKE ALL ON FUNCTION public.get_my_conversation_phone_ids() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_my_conversation_phone_ids() TO PUBLIC, anon, authenticated, service_role;

-- get_my_open_phone_ids
REVOKE ALL ON FUNCTION public.get_my_open_phone_ids() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_my_open_phone_ids() TO anon, authenticated, service_role, supabase_realtime_admin;

-- get_my_org_ids
REVOKE ALL ON FUNCTION public.get_my_org_ids() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_my_org_ids() TO PUBLIC, anon, authenticated, service_role;

-- get_my_org_role
REVOKE ALL ON FUNCTION public.get_my_org_role(_organization_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_my_org_role(_organization_id uuid) TO PUBLIC, anon, authenticated, service_role;

-- get_my_phone_ids
REVOKE ALL ON FUNCTION public.get_my_phone_ids() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_my_phone_ids() TO PUBLIC, anon, authenticated, service_role;

-- get_my_sector_ids
REVOKE ALL ON FUNCTION public.get_my_sector_ids() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_my_sector_ids() TO anon, authenticated, service_role, supabase_realtime_admin;

-- get_org_agent_stats
REVOKE ALL ON FUNCTION public.get_org_agent_stats(org_id uuid, start_date timestamp with time zone, end_date timestamp with time zone, phone_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_org_agent_stats(org_id uuid, start_date timestamp with time zone, end_date timestamp with time zone, phone_ids uuid[]) TO service_role;

-- get_org_daily_volume
REVOKE ALL ON FUNCTION public.get_org_daily_volume(org_id uuid, days integer, phone_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_org_daily_volume(org_id uuid, days integer, phone_ids uuid[]) TO service_role;

-- get_org_message_stats
REVOKE ALL ON FUNCTION public.get_org_message_stats(org_id uuid, start_date timestamp with time zone, end_date timestamp with time zone, phone_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_org_message_stats(org_id uuid, start_date timestamp with time zone, end_date timestamp with time zone, phone_ids uuid[]) TO service_role;

-- get_phone_org_id
REVOKE ALL ON FUNCTION public.get_phone_org_id(_phone_number_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_phone_org_id(_phone_number_id uuid) TO authenticated, service_role;

-- get_service_metrics
REVOKE ALL ON FUNCTION public.get_service_metrics(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[], p_sla_seconds integer) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_service_metrics(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone, p_phone_ids uuid[], p_sector_ids uuid[], p_agent_ids uuid[], p_sla_seconds integer) TO authenticated, service_role;

-- get_template_stats
REVOKE ALL ON FUNCTION public.get_template_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_template_stats(p_org_id uuid, p_start_date timestamp with time zone, p_end_date timestamp with time zone) TO authenticated, service_role;

-- get_unread_counts
REVOKE ALL ON FUNCTION public.get_unread_counts(p_phone_number_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_unread_counts(p_phone_number_id uuid) TO authenticated, service_role;

-- get_user_organization_ids
REVOKE ALL ON FUNCTION public.get_user_organization_ids(uid uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_user_organization_ids(uid uuid) TO service_role;

-- handle_new_user
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO PUBLIC, anon, authenticated, service_role;

-- hook_before_user_created
REVOKE ALL ON FUNCTION public.hook_before_user_created(event jsonb) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.hook_before_user_created(event jsonb) TO supabase_auth_admin;

-- instagram_configurar_conexao
REVOKE ALL ON FUNCTION public.instagram_configurar_conexao(p_conexao uuid, p_ligada boolean, p_nome text, p_linha uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.instagram_configurar_conexao(p_conexao uuid, p_ligada boolean, p_nome text, p_linha uuid) TO authenticated, service_role;

-- instagram_desconectar
REVOKE ALL ON FUNCTION public.instagram_desconectar(p_conexao uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.instagram_desconectar(p_conexao uuid) TO authenticated, service_role;

-- instagram_juntar_conversa
REVOKE ALL ON FUNCTION public.instagram_juntar_conversa(p_conversa uuid, p_telefone text, p_so_ver boolean) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.instagram_juntar_conversa(p_conversa uuid, p_telefone text, p_so_ver boolean) TO authenticated, service_role;

-- instagram_linha_pode_hospedar
REVOKE ALL ON FUNCTION public.instagram_linha_pode_hospedar(p_tipo text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.instagram_linha_pode_hospedar(p_tipo text) TO authenticated, service_role;

-- instagram_listar_conexoes
REVOKE ALL ON FUNCTION public.instagram_listar_conexoes() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.instagram_listar_conexoes() TO authenticated, service_role;

-- instagram_reprocessar_avisos
REVOKE ALL ON FUNCTION public.instagram_reprocessar_avisos() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.instagram_reprocessar_avisos() TO service_role;

-- is_org_admin
REVOKE ALL ON FUNCTION public.is_org_admin(uid uuid, org_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.is_org_admin(uid uuid, org_id uuid) TO service_role;

-- is_org_member
REVOKE ALL ON FUNCTION public.is_org_member(uid uuid, org_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.is_org_member(uid uuid, org_id uuid) TO service_role;

-- is_super_admin
REVOKE ALL ON FUNCTION public.is_super_admin(uid uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.is_super_admin(uid uuid) TO service_role;

-- mark_conversations_read
REVOKE ALL ON FUNCTION public.mark_conversations_read(p_conversation_ids uuid[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.mark_conversations_read(p_conversation_ids uuid[]) TO authenticated, service_role;

-- merge_duplicate_conversations
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_conversations() TO service_role;

-- messages_carimbar_failed_at
REVOKE ALL ON FUNCTION public.messages_carimbar_failed_at() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.messages_carimbar_failed_at() TO service_role;

-- messages_leitura_reservar
REVOKE ALL ON FUNCTION public.messages_leitura_reservar(p_message_id uuid, p_max_tentativas integer, p_janela_s integer) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.messages_leitura_reservar(p_message_id uuid, p_max_tentativas integer, p_janela_s integer) TO service_role;

-- messages_mesclar_metadata
REVOKE ALL ON FUNCTION public.messages_mesclar_metadata(p_message_id uuid, p_patch jsonb, p_nivel2 boolean) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.messages_mesclar_metadata(p_message_id uuid, p_patch jsonb, p_nivel2 boolean) TO service_role;

-- messages_registrar_edicao
REVOKE ALL ON FUNCTION public.messages_registrar_edicao(p_message_id uuid, p_novo_conteudo text, p_editado_em timestamp with time zone, p_flag_only boolean) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.messages_registrar_edicao(p_message_id uuid, p_novo_conteudo text, p_editado_em timestamp with time zone, p_flag_only boolean) TO service_role;

-- mirror_group_messages_to_siblings
REVOKE ALL ON FUNCTION public.mirror_group_messages_to_siblings(p_lookback interval, p_settle interval, p_mark_read boolean, p_max_rows integer) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.mirror_group_messages_to_siblings(p_lookback interval, p_settle interval, p_mark_read boolean, p_max_rows integer) TO service_role;

-- normalize_phone
REVOKE ALL ON FUNCTION public.normalize_phone(phone text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.normalize_phone(phone text) TO PUBLIC, anon, authenticated, service_role;

-- phone_lookup_variations
REVOKE ALL ON FUNCTION public.phone_lookup_variations(p_phone text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.phone_lookup_variations(p_phone text) TO PUBLIC, anon, authenticated, service_role;

-- prevent_phone_reactivation_conflict
REVOKE ALL ON FUNCTION public.prevent_phone_reactivation_conflict() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.prevent_phone_reactivation_conflict() TO PUBLIC, anon, authenticated, service_role;

-- prevent_primary_in_assignees
REVOKE ALL ON FUNCTION public.prevent_primary_in_assignees() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.prevent_primary_in_assignees() TO PUBLIC, anon, authenticated, service_role;

-- process_scheduled_broadcasts
REVOKE ALL ON FUNCTION public.process_scheduled_broadcasts() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.process_scheduled_broadcasts() TO service_role;

-- process_scheduled_messages
REVOKE ALL ON FUNCTION public.process_scheduled_messages() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.process_scheduled_messages() TO authenticated, service_role;

-- process_survey_timeouts
REVOKE ALL ON FUNCTION public.process_survey_timeouts() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.process_survey_timeouts() TO service_role;

-- profiles_guard_protected_columns
REVOKE ALL ON FUNCTION public.profiles_guard_protected_columns() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.profiles_guard_protected_columns() TO service_role;

-- promote_co_owner_to_primary
REVOKE ALL ON FUNCTION public.promote_co_owner_to_primary(p_conversation_id uuid, p_new_primary_user_id uuid, p_keep_old_as_co_owner boolean) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.promote_co_owner_to_primary(p_conversation_id uuid, p_new_primary_user_id uuid, p_keep_old_as_co_owner boolean) TO authenticated, service_role;

-- reap_stuck_scheduled_messages
REVOKE ALL ON FUNCTION public.reap_stuck_scheduled_messages() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.reap_stuck_scheduled_messages() TO service_role;

-- record_message_receipts
REVOKE ALL ON FUNCTION public.record_message_receipts(p_message_ids uuid[], p_receipts jsonb) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.record_message_receipts(p_message_ids uuid[], p_receipts jsonb) TO service_role;

-- record_poll_vote
REVOKE ALL ON FUNCTION public.record_poll_vote(p_message_id uuid, p_voter text, p_voter_name text, p_options jsonb) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.record_poll_vote(p_message_id uuid, p_voter text, p_voter_name text, p_options jsonb) TO service_role;

-- refresh_conversation_last_message_on_change
REVOKE ALL ON FUNCTION public.refresh_conversation_last_message_on_change() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.refresh_conversation_last_message_on_change() TO service_role;

-- release_broadcast_claims
REVOKE ALL ON FUNCTION public.release_broadcast_claims(p_recipient_ids uuid[], p_refund_attempt boolean) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.release_broadcast_claims(p_recipient_ids uuid[], p_refund_attempt boolean) TO service_role;

-- resolve_group_participant_contacts
REVOKE ALL ON FUNCTION public.resolve_group_participant_contacts(p_phone_number_id uuid, p_phones text[]) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.resolve_group_participant_contacts(p_phone_number_id uuid, p_phones text[]) TO authenticated, service_role;

-- retry_broadcast_failures
REVOKE ALL ON FUNCTION public.retry_broadcast_failures(p_broadcast_id uuid, p_organization_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.retry_broadcast_failures(p_broadcast_id uuid, p_organization_id uuid) TO service_role;

-- scheduled_messages_autor_e_arquivos
REVOKE ALL ON FUNCTION public.scheduled_messages_autor_e_arquivos() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.scheduled_messages_autor_e_arquivos() TO service_role;

-- search_messages
REVOKE ALL ON FUNCTION public.search_messages(p_phone_number_id uuid, p_search_term text, p_direction text, p_message_types text[], p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_has_media boolean, p_limit integer) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.search_messages(p_phone_number_id uuid, p_search_term text, p_direction text, p_message_types text[], p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_has_media boolean, p_limit integer) TO PUBLIC, anon, authenticated, service_role;

-- send_pipeline_heartbeat
REVOKE ALL ON FUNCTION public.send_pipeline_heartbeat() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.send_pipeline_heartbeat() TO service_role;

-- set_ai_api_key (ACL ajustado: sem EXECUTE para anon/PUBLIC: só authenticated (a função checa admin da org ou super admin) e service_role)
REVOKE ALL ON FUNCTION public.set_ai_api_key(p_org_id uuid, p_raw_key text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.set_ai_api_key(p_org_id uuid, p_raw_key text) TO authenticated, service_role;

-- set_conversation_manual_unread
REVOKE ALL ON FUNCTION public.set_conversation_manual_unread(p_conversation_id uuid, p_unread boolean) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.set_conversation_manual_unread(p_conversation_id uuid, p_unread boolean) TO authenticated, service_role;

-- share_contact_avatar_across_lines
REVOKE ALL ON FUNCTION public.share_contact_avatar_across_lines() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.share_contact_avatar_across_lines() TO service_role;

-- snooze_system_alert
REVOKE ALL ON FUNCTION public.snooze_system_alert(p_key text, p_hours numeric) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.snooze_system_alert(p_key text, p_hours numeric) TO authenticated, service_role;

-- touch_broadcast_recipient
REVOKE ALL ON FUNCTION public.touch_broadcast_recipient() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.touch_broadcast_recipient() TO PUBLIC, anon, authenticated, service_role;

-- trg_compartilhar_tira_de_disparos
REVOKE ALL ON FUNCTION public.trg_compartilhar_tira_de_disparos() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.trg_compartilhar_tira_de_disparos() TO service_role;

-- trg_conversa_dono_e_aba_disparos
REVOKE ALL ON FUNCTION public.trg_conversa_dono_e_aba_disparos() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.trg_conversa_dono_e_aba_disparos() TO service_role;

-- trg_conversation_close_lifecycle
REVOKE ALL ON FUNCTION public.trg_conversation_close_lifecycle() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.trg_conversation_close_lifecycle() TO PUBLIC, anon, authenticated, service_role;

-- trg_normalize_conversation_phone
REVOKE ALL ON FUNCTION public.trg_normalize_conversation_phone() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.trg_normalize_conversation_phone() TO PUBLIC, anon, authenticated, service_role;

-- trg_resposta_movida_tira_de_disparos
REVOKE ALL ON FUNCTION public.trg_resposta_movida_tira_de_disparos() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.trg_resposta_movida_tira_de_disparos() TO service_role;

-- trg_setor_segue_dono
REVOKE ALL ON FUNCTION public.trg_setor_segue_dono() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.trg_setor_segue_dono() TO service_role;

-- trg_setor_segue_dono_avisa
REVOKE ALL ON FUNCTION public.trg_setor_segue_dono_avisa() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.trg_setor_segue_dono_avisa() TO service_role;

-- trg_status_do_disparo
REVOKE ALL ON FUNCTION public.trg_status_do_disparo() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.trg_status_do_disparo() TO service_role;

-- trigger_automation_flow_atomic
-- (identificador entre aspas de propósito: o divisor de statements da CLI 2.x do Supabase trata um nome sem aspas
-- com "atomic" como o início de um bloco e engole o resto do arquivo; com aspas a migração aplica nas CLIs 2.x e 3.x)
REVOKE ALL ON FUNCTION public."trigger_automation_flow_atomic"(p_flow_id uuid, p_conversation_id uuid, p_cooldown_minutes integer, p_context jsonb, p_start_node_id text) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public."trigger_automation_flow_atomic"(p_flow_id uuid, p_conversation_id uuid, p_cooldown_minutes integer, p_context jsonb, p_start_node_id text) TO service_role;

-- update_automation_updated_at
REVOKE ALL ON FUNCTION public.update_automation_updated_at() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.update_automation_updated_at() TO PUBLIC, anon, authenticated, service_role;

-- update_broadcast_counts
REVOKE ALL ON FUNCTION public.update_broadcast_counts() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.update_broadcast_counts() TO PUBLIC, anon, authenticated, service_role;

-- update_broadcasts_updated_at
REVOKE ALL ON FUNCTION public.update_broadcasts_updated_at() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.update_broadcasts_updated_at() TO PUBLIC, anon, authenticated, service_role;

-- update_conversation_last_message_at
REVOKE ALL ON FUNCTION public.update_conversation_last_message_at() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.update_conversation_last_message_at() TO service_role;

-- update_phone_number_sessions_updated_at
REVOKE ALL ON FUNCTION public.update_phone_number_sessions_updated_at() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.update_phone_number_sessions_updated_at() TO PUBLIC, anon, authenticated, service_role;

-- update_scheduled_messages_updated_at
REVOKE ALL ON FUNCTION public.update_scheduled_messages_updated_at() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.update_scheduled_messages_updated_at() TO PUBLIC, anon, authenticated, service_role;

-- update_updated_at
REVOKE ALL ON FUNCTION public.update_updated_at() FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO PUBLIC, anon, authenticated, service_role;

-- user_can_access_conversation
REVOKE ALL ON FUNCTION public.user_can_access_conversation(conv_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.user_can_access_conversation(conv_id uuid) TO PUBLIC, anon, authenticated, service_role;

-- user_can_access_phone_line
REVOKE ALL ON FUNCTION public.user_can_access_phone_line(p_phone_number_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.user_can_access_phone_line(p_phone_number_id uuid) TO authenticated, service_role;

-- user_has_broadcast_access
REVOKE ALL ON FUNCTION public.user_has_broadcast_access(broadcast_phone_number_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.user_has_broadcast_access(broadcast_phone_number_id uuid) TO PUBLIC, anon, authenticated, service_role;

-- user_has_phone_access
REVOKE ALL ON FUNCTION public.user_has_phone_access(_phone_number_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.user_has_phone_access(_phone_number_id uuid) TO PUBLIC, anon, authenticated, service_role;

-- user_has_scheduled_message_access
REVOKE ALL ON FUNCTION public.user_has_scheduled_message_access(msg_phone_number_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.user_has_scheduled_message_access(msg_phone_number_id uuid) TO PUBLIC, anon, authenticated, service_role;

-- user_is_assignee
REVOKE ALL ON FUNCTION public.user_is_assignee(p_conversation_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.user_is_assignee(p_conversation_id uuid, p_user_id uuid) TO service_role;

-- user_is_org_admin
REVOKE ALL ON FUNCTION public.user_is_org_admin(_org_id uuid) FROM PUBLIC, anon, authenticated, service_role, supabase_realtime_admin, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.user_is_org_admin(_org_id uuid) TO PUBLIC, anon, authenticated, service_role;


-- ---- tabelas ----
-- action_button_phone_numbers
REVOKE ALL ON TABLE public.action_button_phone_numbers FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.action_button_phone_numbers TO anon;
GRANT ALL ON TABLE public.action_button_phone_numbers TO authenticated;
GRANT ALL ON TABLE public.action_button_phone_numbers TO service_role;

-- analytics_daily_metrics
REVOKE ALL ON TABLE public.analytics_daily_metrics FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.analytics_daily_metrics TO anon;
GRANT ALL ON TABLE public.analytics_daily_metrics TO authenticated;
GRANT ALL ON TABLE public.analytics_daily_metrics TO service_role;

-- analytics_daily_templates
REVOKE ALL ON TABLE public.analytics_daily_templates FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.analytics_daily_templates TO anon;
GRANT ALL ON TABLE public.analytics_daily_templates TO authenticated;
GRANT ALL ON TABLE public.analytics_daily_templates TO service_role;

-- api_keys
REVOKE ALL ON TABLE public.api_keys FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.api_keys TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.api_keys TO authenticated;
GRANT ALL ON TABLE public.api_keys TO service_role;
GRANT UPDATE (is_active) ON TABLE public.api_keys TO authenticated;

-- automation_executions
REVOKE ALL ON TABLE public.automation_executions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.automation_executions TO anon;
GRANT ALL ON TABLE public.automation_executions TO authenticated;
GRANT ALL ON TABLE public.automation_executions TO service_role;

-- automation_flows
REVOKE ALL ON TABLE public.automation_flows FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.automation_flows TO anon;
GRANT ALL ON TABLE public.automation_flows TO authenticated;
GRANT ALL ON TABLE public.automation_flows TO service_role;

-- automation_sessions
REVOKE ALL ON TABLE public.automation_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.automation_sessions TO anon;
GRANT ALL ON TABLE public.automation_sessions TO authenticated;
GRANT ALL ON TABLE public.automation_sessions TO service_role;

-- automation_triggers
REVOKE ALL ON TABLE public.automation_triggers FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.automation_triggers TO anon;
GRANT ALL ON TABLE public.automation_triggers TO authenticated;
GRANT ALL ON TABLE public.automation_triggers TO service_role;

-- aviso_de_mensagem
REVOKE ALL ON TABLE public.aviso_de_mensagem FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.aviso_de_mensagem TO service_role;

-- broadcast_recipients
REVOKE ALL ON TABLE public.broadcast_recipients FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.broadcast_recipients TO anon;
GRANT ALL ON TABLE public.broadcast_recipients TO authenticated;
GRANT ALL ON TABLE public.broadcast_recipients TO service_role;

-- broadcasts
REVOKE ALL ON TABLE public.broadcasts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.broadcasts TO anon;
GRANT ALL ON TABLE public.broadcasts TO authenticated;
GRANT ALL ON TABLE public.broadcasts TO service_role;

-- close_reasons
REVOKE ALL ON TABLE public.close_reasons FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.close_reasons TO anon;
GRANT ALL ON TABLE public.close_reasons TO authenticated;
GRANT ALL ON TABLE public.close_reasons TO service_role;

-- conversation_assignees
REVOKE ALL ON TABLE public.conversation_assignees FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversation_assignees TO anon;
GRANT ALL ON TABLE public.conversation_assignees TO authenticated;
GRANT ALL ON TABLE public.conversation_assignees TO service_role;

-- conversation_notes
REVOKE ALL ON TABLE public.conversation_notes FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversation_notes TO anon;
GRANT ALL ON TABLE public.conversation_notes TO authenticated;
GRANT ALL ON TABLE public.conversation_notes TO service_role;

-- conversation_prefs
REVOKE ALL ON TABLE public.conversation_prefs FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversation_prefs TO anon;
GRANT ALL ON TABLE public.conversation_prefs TO authenticated;
GRANT ALL ON TABLE public.conversation_prefs TO service_role;

-- conversation_reads
REVOKE ALL ON TABLE public.conversation_reads FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversation_reads TO authenticated;
GRANT ALL ON TABLE public.conversation_reads TO service_role;

-- conversation_tags
REVOKE ALL ON TABLE public.conversation_tags FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversation_tags TO anon;
GRANT ALL ON TABLE public.conversation_tags TO authenticated;
GRANT ALL ON TABLE public.conversation_tags TO service_role;

-- conversations
REVOKE ALL ON TABLE public.conversations FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.conversations TO anon;
GRANT ALL ON TABLE public.conversations TO authenticated;
GRANT ALL ON TABLE public.conversations TO service_role;

-- disconnect_alert_log
REVOKE ALL ON TABLE public.disconnect_alert_log FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.disconnect_alert_log TO anon;
GRANT ALL ON TABLE public.disconnect_alert_log TO authenticated;
GRANT ALL ON TABLE public.disconnect_alert_log TO service_role;

-- group_participant_aliases
REVOKE ALL ON TABLE public.group_participant_aliases FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.group_participant_aliases TO anon;
GRANT ALL ON TABLE public.group_participant_aliases TO authenticated;
GRANT ALL ON TABLE public.group_participant_aliases TO service_role;

-- instagram_connections
REVOKE ALL ON TABLE public.instagram_connections FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.instagram_connections TO service_role;

-- instagram_webhook_events
REVOKE ALL ON TABLE public.instagram_webhook_events FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.instagram_webhook_events TO service_role;

-- linha_identidade
REVOKE ALL ON TABLE public.linha_identidade FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.linha_identidade TO service_role;

-- message_hidden
REVOKE ALL ON TABLE public.message_hidden FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.message_hidden TO anon;
GRANT ALL ON TABLE public.message_hidden TO authenticated;
GRANT ALL ON TABLE public.message_hidden TO service_role;

-- message_reactions
REVOKE ALL ON TABLE public.message_reactions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.message_reactions TO anon;
GRANT ALL ON TABLE public.message_reactions TO authenticated;
GRANT ALL ON TABLE public.message_reactions TO service_role;

-- message_receipts
REVOKE ALL ON TABLE public.message_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.message_receipts TO anon;
GRANT ALL ON TABLE public.message_receipts TO authenticated;
GRANT ALL ON TABLE public.message_receipts TO service_role;

-- messages
REVOKE ALL ON TABLE public.messages FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.messages TO anon;
GRANT ALL ON TABLE public.messages TO authenticated;
GRANT ALL ON TABLE public.messages TO service_role;

-- organization_action_buttons
REVOKE ALL ON TABLE public.organization_action_buttons FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.organization_action_buttons TO anon;
GRANT ALL ON TABLE public.organization_action_buttons TO authenticated;
GRANT ALL ON TABLE public.organization_action_buttons TO service_role;

-- organization_members
REVOKE ALL ON TABLE public.organization_members FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.organization_members TO anon;
GRANT ALL ON TABLE public.organization_members TO authenticated;
GRANT ALL ON TABLE public.organization_members TO service_role;

-- organization_webhooks
REVOKE ALL ON TABLE public.organization_webhooks FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.organization_webhooks TO anon;
GRANT ALL ON TABLE public.organization_webhooks TO authenticated;
GRANT ALL ON TABLE public.organization_webhooks TO service_role;

-- organizations (ACL ajustado: authenticated não lê whatsapp_access_token, whatsapp_verify_token, ai_api_key nem ai_api_key_encrypted; anon não acessa a tabela)
REVOKE ALL ON TABLE public.organizations FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT, DELETE ON TABLE public.organizations TO authenticated;
GRANT SELECT (id, name, slug, created_at, updated_at, whatsapp_waba_id, whatsapp_app_id, ai_insights_prompt) ON TABLE public.organizations TO authenticated;
GRANT UPDATE (name, updated_at, whatsapp_waba_id, whatsapp_app_id, whatsapp_access_token, ai_insights_prompt) ON TABLE public.organizations TO authenticated;
GRANT ALL ON TABLE public.organizations TO service_role;

-- phone_number_sessions
REVOKE ALL ON TABLE public.phone_number_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.phone_number_sessions TO anon;
GRANT ALL ON TABLE public.phone_number_sessions TO authenticated;
GRANT ALL ON TABLE public.phone_number_sessions TO service_role;

-- phone_numbers
REVOKE ALL ON TABLE public.phone_numbers FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.phone_numbers TO anon;
GRANT ALL ON TABLE public.phone_numbers TO authenticated;
GRANT ALL ON TABLE public.phone_numbers TO service_role;

-- profiles
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.profiles TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;
GRANT UPDATE (copiloto_enabled) ON TABLE public.profiles TO authenticated;
GRANT UPDATE (first_name) ON TABLE public.profiles TO authenticated;
GRANT UPDATE (last_name) ON TABLE public.profiles TO authenticated;
GRANT UPDATE (phone) ON TABLE public.profiles TO authenticated;

-- push_subscriptions
REVOKE ALL ON TABLE public.push_subscriptions FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.push_subscriptions TO anon;
GRANT ALL ON TABLE public.push_subscriptions TO authenticated;
GRANT ALL ON TABLE public.push_subscriptions TO service_role;

-- qr_health_probe
REVOKE ALL ON TABLE public.qr_health_probe FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.qr_health_probe TO service_role;

-- qr_message_log
REVOKE ALL ON TABLE public.qr_message_log FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.qr_message_log TO anon;
GRANT ALL ON TABLE public.qr_message_log TO authenticated;
GRANT ALL ON TABLE public.qr_message_log TO service_role;

-- quick_replies
REVOKE ALL ON TABLE public.quick_replies FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.quick_replies TO anon;
GRANT ALL ON TABLE public.quick_replies TO authenticated;
GRANT ALL ON TABLE public.quick_replies TO service_role;

-- scheduled_messages
REVOKE ALL ON TABLE public.scheduled_messages FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.scheduled_messages TO anon;
GRANT ALL ON TABLE public.scheduled_messages TO authenticated;
GRANT ALL ON TABLE public.scheduled_messages TO service_role;

-- sector_members
REVOKE ALL ON TABLE public.sector_members FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.sector_members TO anon;
GRANT ALL ON TABLE public.sector_members TO authenticated;
GRANT ALL ON TABLE public.sector_members TO service_role;

-- sectors
REVOKE ALL ON TABLE public.sectors FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.sectors TO anon;
GRANT ALL ON TABLE public.sectors TO authenticated;
GRANT ALL ON TABLE public.sectors TO service_role;

-- session_connection_log
REVOKE ALL ON TABLE public.session_connection_log FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.session_connection_log TO service_role;

-- system_alert_state
REVOKE ALL ON TABLE public.system_alert_state FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.system_alert_state TO service_role;

-- system_alerts
REVOKE ALL ON TABLE public.system_alerts FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.system_alerts TO anon;
GRANT ALL ON TABLE public.system_alerts TO authenticated;
GRANT ALL ON TABLE public.system_alerts TO service_role;

-- tags
REVOKE ALL ON TABLE public.tags FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.tags TO anon;
GRANT ALL ON TABLE public.tags TO authenticated;
GRANT ALL ON TABLE public.tags TO service_role;

-- user_invitations
REVOKE ALL ON TABLE public.user_invitations FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.user_invitations TO anon;
GRANT ALL ON TABLE public.user_invitations TO authenticated;
GRANT ALL ON TABLE public.user_invitations TO service_role;

-- user_phone_numbers
REVOKE ALL ON TABLE public.user_phone_numbers FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.user_phone_numbers TO anon;
GRANT ALL ON TABLE public.user_phone_numbers TO authenticated;
GRANT ALL ON TABLE public.user_phone_numbers TO service_role;

-- user_stickers
REVOKE ALL ON TABLE public.user_stickers FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.user_stickers TO anon;
GRANT ALL ON TABLE public.user_stickers TO authenticated;
GRANT ALL ON TABLE public.user_stickers TO service_role;


-- ---- sequences ----
REVOKE ALL ON SEQUENCE public.instagram_webhook_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON SEQUENCE public.instagram_webhook_events_id_seq TO service_role;


-- Restaura a sessão (o dump zera o search_path e desliga a checagem de corpo de função).
SELECT pg_catalog.set_config('search_path', '"$user", public, extensions', false);
SET check_function_bodies = true;
SET client_min_messages = notice;
SET row_security = on;
