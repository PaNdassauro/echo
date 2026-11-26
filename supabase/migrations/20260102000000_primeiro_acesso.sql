-- Primeiro acesso (/setup) e fechamento da leitura da chave de IA.
--
-- Primeiro acesso: com a instalação vazia (nenhum super admin e nenhuma organização), a edge `primeiro-acesso` cria
-- o usuário pelo admin API do Auth (que não passa pelo hook before_user_created) e chama
-- public.instalacao_concluir_setup(). A função, sob advisory lock, promove o usuário a super admin, cria a
-- organização e o vínculo de admin. Duas chamadas simultâneas: a primeira a pegar o lock vence; a segunda recebe
-- PT409 (o PostgREST devolve HTTP 409) e a edge apaga o usuário que ela mesma criou.
--
-- Não cria tabela: o estado "instalação configurada" é o próprio dado (existe super admin OU existe organização).
-- Se o operador apagar os dois, o /setup reabre, e esse é o caminho de recuperação.
--
-- As duas funções novas são só do service_role: a edge expõe apenas o boolean (GET) e a decisão (POST).
-- Nenhuma delas é usada por policy de tabela da publication supabase_realtime, então a exceção de EXECUTE do
-- Realtime não se aplica.
--
-- Também: get_decrypted_ai_key(uuid) deixa de ser executável por `authenticated`. A função aceitava um admin da
-- organização (útil só para teste) e devolvia a chave de IA em claro pelo REST. Os chamadores reais (edges copiloto,
-- transcrever-audio e generate-insights) usam a service role. Quem precisa só saber se existe chave usa
-- get_org_ai_config, que devolve um boolean.
--
-- Cada bloco `-- @@ Título` é aplicado por vez em scripts/run-sql.mjs (caminho Supabase Cloud) e o arquivo inteiro
-- roda numa transação no migrate do docker e na CLI do Supabase.

-- @@ instalacao_precisa_setup
CREATE OR REPLACE FUNCTION public.instalacao_precisa_setup()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
    SELECT NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.is_super_admin)
       AND NOT EXISTS (SELECT 1 FROM public.organizations);
$$;

COMMENT ON FUNCTION public.instalacao_precisa_setup() IS
    'true enquanto a instalação não tem super admin nem organização. Só service_role (a edge primeiro-acesso expõe o boolean).';

REVOKE ALL ON FUNCTION public.instalacao_precisa_setup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instalacao_precisa_setup() TO service_role;

-- @@ instalacao_concluir_setup
CREATE OR REPLACE FUNCTION public.instalacao_concluir_setup(p_user_id uuid, p_organizacao text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_nome text := btrim(coalesce(p_organizacao, ''));
    v_slug text;
    v_org  uuid;
BEGIN
    -- Uma conclusão por vez na instalação inteira; o lock solta no fim da transação. Cada comando seguinte toma
    -- um snapshot novo (READ COMMITTED), então quem esperou aqui já enxerga o que o vencedor gravou.
    PERFORM pg_advisory_xact_lock(hashtextextended('echo:primeiro-acesso', 0));

    IF NOT public.instalacao_precisa_setup() THEN
        RAISE EXCEPTION 'instalação já configurada' USING ERRCODE = 'PT409';
    END IF;
    IF length(v_nome) < 2 OR length(v_nome) > 100 THEN
        RAISE EXCEPTION 'nome da organização precisa ter de 2 a 100 caracteres' USING ERRCODE = '22023';
    END IF;
    IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
        RAISE EXCEPTION 'usuário não existe' USING ERRCODE = '22023';
    END IF;

    -- O trigger on_auth_user_created já criou o perfil; garante se faltar.
    INSERT INTO public.profiles (id, email)
    SELECT u.id, u.email FROM auth.users u WHERE u.id = p_user_id
    ON CONFLICT (id) DO NOTHING;

    UPDATE public.profiles SET is_super_admin = true WHERE id = p_user_id;

    -- generate_org_slug devolve '' para nome sem nenhum caractere ASCII alfanumérico (por exemplo, só ideogramas).
    v_slug := public.generate_org_slug(v_nome);
    IF coalesce(v_slug, '') = '' THEN
        v_slug := public.generate_org_slug('organizacao');
    END IF;

    INSERT INTO public.organizations (name, slug) VALUES (v_nome, v_slug) RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, user_id, role) VALUES (v_org, p_user_id, 'admin');

    RETURN jsonb_build_object('organization_id', v_org);
END;
$$;

COMMENT ON FUNCTION public.instalacao_concluir_setup(uuid, text) IS
    'Conclui o primeiro acesso: super admin + organização + vínculo admin, sob advisory lock. PT409 se a instalação já foi configurada. Só service_role.';

REVOKE ALL ON FUNCTION public.instalacao_concluir_setup(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instalacao_concluir_setup(uuid, text) TO service_role;

-- @@ get_decrypted_ai_key: só service_role
REVOKE EXECUTE ON FUNCTION public.get_decrypted_ai_key(uuid) FROM authenticated;
