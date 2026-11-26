-- Cron jobs do Echo (pg_cron + pg_net).
-- Parte do baseline do Echo. Mudança de esquema vai numa migração nova, não nesta.
-- Idempotente: cada job é desagendado pelo nome antes de ser agendado.
-- Nenhum comando carrega URL nem chave: as funções leem project_url e service_role_key do Vault.

-- process-scheduled-broadcasts
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-scheduled-broadcasts') THEN
        PERFORM cron.unschedule('process-scheduled-broadcasts');
    END IF;
    PERFORM cron.schedule('process-scheduled-broadcasts', '* * * * *', $cron$SELECT public.process_scheduled_broadcasts()$cron$);
END
$do$;


-- close-inactive-conversations-daily
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'close-inactive-conversations-daily') THEN
        PERFORM cron.unschedule('close-inactive-conversations-daily');
    END IF;
    PERFORM cron.schedule('close-inactive-conversations-daily', '0 0 * * *', $cron$SELECT public.close_inactive_conversations()$cron$);
END
$do$;


-- fetch-analytics-daily
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fetch-analytics-daily') THEN
        PERFORM cron.unschedule('fetch-analytics-daily');
    END IF;
    PERFORM cron.schedule('fetch-analytics-daily', '0 3 * * *', $cron$SELECT public.dispatch_fetch_analytics()$cron$);
END
$do$;


-- merge-duplicate-conversations
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'merge-duplicate-conversations') THEN
        PERFORM cron.unschedule('merge-duplicate-conversations');
    END IF;
    PERFORM cron.schedule('merge-duplicate-conversations', '*/5 * * * *', $cron$SELECT public.merge_duplicate_conversations()$cron$);
END
$do$;


-- process-scheduled-messages
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-scheduled-messages') THEN
        PERFORM cron.unschedule('process-scheduled-messages');
    END IF;
    PERFORM cron.schedule('process-scheduled-messages', '* * * * *', $cron$SELECT public.process_scheduled_messages()$cron$);
END
$do$;


-- process-survey-timeouts
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-survey-timeouts') THEN
        PERFORM cron.unschedule('process-survey-timeouts');
    END IF;
    PERFORM cron.schedule('process-survey-timeouts', '* * * * *', $cron$SELECT public.process_survey_timeouts()$cron$);
END
$do$;


-- dispatch-broadcast-work
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-broadcast-work') THEN
        PERFORM cron.unschedule('dispatch-broadcast-work');
    END IF;
    PERFORM cron.schedule('dispatch-broadcast-work', '* * * * *', $cron$SELECT public.dispatch_broadcast_work()$cron$);
END
$do$;


-- check-message-failure-alerts
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-message-failure-alerts') THEN
        PERFORM cron.unschedule('check-message-failure-alerts');
    END IF;
    PERFORM cron.schedule('check-message-failure-alerts', '* * * * *', $cron$SELECT public.check_message_failure_alerts()$cron$);
END
$do$;


-- purge-qr-message-log
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-qr-message-log') THEN
        PERFORM cron.unschedule('purge-qr-message-log');
    END IF;
    PERFORM cron.schedule('purge-qr-message-log', '30 3 * * *', $cron$DELETE FROM public.qr_message_log WHERE action = 'delivery_update' AND created_at < now() - interval '14 days';
DELETE FROM public.qr_message_log WHERE success AND created_at < now() - interval '60 days';
DELETE FROM public.qr_message_log WHERE created_at < now() - interval '90 days';$cron$);
END
$do$;


-- qr-service-health
-- Exige o segredo qr_service_url. Sem serviço de QR (instalação só com a Cloud API), desligue:
-- select cron.alter_job((select jobid from cron.job where jobname = 'qr-service-health'), active := false);
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'qr-service-health') THEN
        PERFORM cron.unschedule('qr-service-health');
    END IF;
    PERFORM cron.schedule('qr-service-health', '* * * * *', $cron$SELECT public.check_qr_service_health()$cron$);
END
$do$;


-- pipeline-heartbeat
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pipeline-heartbeat') THEN
        PERFORM cron.unschedule('pipeline-heartbeat');
    END IF;
    PERFORM cron.schedule('pipeline-heartbeat', '0 1,9,17 * * *', $cron$SELECT public.send_pipeline_heartbeat()$cron$);
END
$do$;


-- instagram-reprocessar-avisos
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'instagram-reprocessar-avisos') THEN
        PERFORM cron.unschedule('instagram-reprocessar-avisos');
    END IF;
    PERFORM cron.schedule('instagram-reprocessar-avisos', '*/5 * * * *', $cron$SELECT public.instagram_reprocessar_avisos()$cron$);
END
$do$;


-- automation-executions-retencao
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'automation-executions-retencao') THEN
        PERFORM cron.unschedule('automation-executions-retencao');
    END IF;
    PERFORM cron.schedule('automation-executions-retencao', '*/10 * * * *', $cron$DELETE FROM public.automation_executions WHERE id IN (SELECT id FROM public.automation_executions WHERE status IN ('stopped', 'no_match') AND started_at < now() - interval '30 days' ORDER BY started_at LIMIT 5000);
DELETE FROM public.automation_executions WHERE id IN (SELECT id FROM public.automation_executions WHERE status IN ('completed', 'failed', 'cancelled') AND started_at < now() - interval '90 days' ORDER BY started_at LIMIT 5000)$cron$);
END
$do$;


-- purge-cron-history
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-cron-history') THEN
        PERFORM cron.unschedule('purge-cron-history');
    END IF;
    PERFORM cron.schedule('purge-cron-history', '15 4 * * *', $cron$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days' OR (end_time IS NULL AND start_time < now() - interval '7 days')$cron$);
END
$do$;


-- aviso-de-mensagem-repetir
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aviso-de-mensagem-repetir') THEN
        PERFORM cron.unschedule('aviso-de-mensagem-repetir');
    END IF;
    PERFORM cron.schedule('aviso-de-mensagem-repetir', '* * * * *', $cron$SELECT public.aviso_de_mensagem_repetir()$cron$);
END
$do$;


-- aviso-de-mensagem-limpar
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aviso-de-mensagem-limpar') THEN
        PERFORM cron.unschedule('aviso-de-mensagem-limpar');
    END IF;
    PERFORM cron.schedule('aviso-de-mensagem-limpar', '23 4 * * *', $cron$DELETE FROM public.aviso_de_mensagem WHERE estado IN ('entregue', 'falhou') AND criado_em < now() - interval '30 days'$cron$);
END
$do$;
