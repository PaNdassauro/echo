-- Dados de DESENVOLVIMENTO LOCAL. Roda no `supabase start` e no `supabase db reset`; não é migração e
-- não deve ser aplicado em produção.
--
-- O que faz: cria no Vault os segredos que as funções SQL e os cron jobs leem (ver public._segredo_obrigatorio).
-- Sem eles os crons de minuto falham com "Segredo ... ausente no Vault" (visível em cron.job_run_details).
-- Cada segredo só é criado se ainda não existir, então rodar de novo não sobrescreve o que você ajustou.
--
--   project_url       URL que o Postgres usa para chamar as edge functions. No stack local o gateway do Supabase
--                     responde em http://kong:8000 dentro da rede do Docker (alternativa: http://host.docker.internal:54321).
--   service_role_key  JWT de service_role do stack local, gerado aqui mesmo e assinado com o jwt_secret do banco
--                     (app.settings.jwt_secret; se ausente, o padrão público do `supabase start`). Se você mudou o
--                     jwt_secret em supabase/config.toml, confira o valor com `supabase status` e recrie o segredo.
--   qr_service_url    URL do serviço de QR rodando na sua máquina (porta 3000 por padrão).
--   ai_key_secret     passphrase que cifra as chaves de IA das organizações (pgcrypto). Aleatória por instalação:
--                     trocá-la depois torna ilegíveis as chaves já salvas.
--
-- Num Supabase hospedado o seed não roda e o Vault começa vazio: crie os mesmos quatro nomes com os seus valores
-- (select vault.create_secret('<valor>', '<nome>');). Até criar, os crons que chamam edge functions falham a cada
-- minuto com 'Segredo "x" ausente no Vault' e a dica de como criar (cron.job_run_details).
--   project_url       https://<ref>.supabase.co
--   service_role_key  o JWT LEGADO de service_role (eyJ..., Settings > API > Legacy API keys). Uma chave sb_secret_,
--                     ou as chaves legadas desligadas, fazem as edge functions chamadas pelo cron (verify_jwt)
--                     responderem 401. Como o pg_net é assíncrono, o cron grava succeeded e o erro só aparece em:
--                     select status_code, content from net._http_response order by created desc;
--   qr_service_url    URL pública do serviço de QR. Sem serviço de QR, desligue o job qr-service-health (ver a migração do cron).
--   ai_key_secret     uma passphrase aleatória; trocá-la depois torna ilegíveis as chaves de IA já salvas.

DO $seed$
DECLARE
    -- jwt_secret do banco; se o stack não o expõe, vale o padrão público do supabase start (config.toml [auth].jwt_secret)
    v_jwt_secret text := coalesce(nullif(current_setting('app.settings.jwt_secret', true), ''), 'super-secret-jwt-token-with-at-least-32-characters-long');
    v_header     text;
    v_payload    text;
    v_assinado   text;
    v_key        text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'project_url') THEN
        PERFORM vault.create_secret('http://kong:8000', 'project_url', 'URL do projeto Supabase (stack local)');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'qr_service_url') THEN
        PERFORM vault.create_secret('http://host.docker.internal:3000', 'qr_service_url', 'URL do serviço de QR (stack local)');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'ai_key_secret') THEN
        PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'ai_key_secret',
                                    'Passphrase que cifra as chaves de IA das organizações');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'service_role_key') THEN
        BEGIN
            -- JWT HS256 {role: service_role}: mesmo formato das chaves do stack local, com validade longa
            v_header  := translate(encode(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'), 'base64'), E'+/=\n', '-_');
            v_payload := translate(encode(convert_to('{"iss":"supabase-demo","role":"service_role","exp":1983812996}', 'utf8'), 'base64'), E'+/=\n', '-_');
            v_assinado := v_header || '.' || v_payload;
            v_key := v_assinado || '.' || translate(
                encode(extensions.hmac(convert_to(v_assinado, 'utf8'), convert_to(v_jwt_secret, 'utf8'), 'sha256'), 'base64'),
                E'+/=\n', '-_');
            PERFORM vault.create_secret(v_key, 'service_role_key', 'JWT de service_role usado pelos cron jobs (stack local)');
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'seed: não consegui gerar o service_role_key (%); crie à mão: select vault.create_secret(''<service_role key do supabase status>'', ''service_role_key'');', SQLERRM;
        END;
    END IF;
END
$seed$;
