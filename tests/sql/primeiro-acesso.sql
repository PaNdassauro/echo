-- Testes SQL do primeiro acesso (migração 20260102000000_primeiro_acesso.sql).
--
-- Roda contra um banco de verdade, vazio (nenhum super admin, nenhuma organização), pelo tests/sql/rodar.sh.
-- Tudo aqui acontece numa transação que termina em ROLLBACK: nada fica no banco. A corrida entre duas sessões
-- (que precisa de COMMIT) é feita pelo rodar.sh.
--
-- Cada asserção sai como NOTICE "ASSERCAO ok|FALHOU <nome>" (e não numa tabela temporária: o ROLLBACK TO SAVEPOINT
-- desfaria as linhas gravadas depois dele, e a NOTICE já foi para o cliente). O rodar.sh conta as linhas e decide o
-- exit code.

\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned

BEGIN;

CREATE FUNCTION pg_temp.ck(p_nome text, p_ok boolean, p_detalhe text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF coalesce(p_ok, false) THEN
        RAISE NOTICE 'ASSERCAO ok      %', p_nome;
    ELSE
        RAISE NOTICE 'ASSERCAO FALHOU  %  [%]', p_nome, coalesce(p_detalhe, '');
    END IF;
END;
$$;

-- Pré-condição: banco vazio. Sem isso nada abaixo vale, então para aqui.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.organizations) OR EXISTS (SELECT 1 FROM public.profiles WHERE is_super_admin) THEN
        RAISE EXCEPTION 'tests/sql/primeiro-acesso.sql precisa de uma instalação vazia (sem organização nem super admin)';
    END IF;
END $$;

-- Dois usuários de teste. O trigger on_auth_user_created cria o perfil de cada um.
INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES
    ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'ana-teste@example.com', '{"full_name":"Ana Teste"}', now(), now()),
    ('00000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'bruno-teste@example.com', '{"full_name":"Bruno Teste"}', now(), now());

-- 1. banco vazio -> true
SELECT pg_temp.ck('banco vazio: instalacao_precisa_setup() = true', public.instalacao_precisa_setup() IS TRUE);

-- 2. concluir(A,'Acme') cria super admin, 1 organização e o vínculo admin
SAVEPOINT antes_de_concluir;

DO $$
DECLARE
    v jsonb;
    v_org uuid;
BEGIN
    v := public.instalacao_concluir_setup('00000000-0000-4000-8000-0000000000a1', '  Acme  ');
    v_org := (v ->> 'organization_id')::uuid;
    PERFORM pg_temp.ck('concluir(A): devolve organization_id', v_org IS NOT NULL, v::text);
    PERFORM pg_temp.ck('concluir(A): A virou super admin',
        (SELECT is_super_admin FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1') IS TRUE);
    PERFORM pg_temp.ck('concluir(A): B não virou super admin',
        (SELECT is_super_admin FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000b2') IS NOT TRUE);
    PERFORM pg_temp.ck('concluir(A): exatamente 1 organização, com o nome aparado',
        (SELECT count(*) FROM public.organizations) = 1
        AND (SELECT name FROM public.organizations WHERE id = v_org) = 'Acme',
        (SELECT name || '/' || slug FROM public.organizations WHERE id = v_org));
    PERFORM pg_temp.ck('concluir(A): slug gerado a partir do nome',
        (SELECT slug FROM public.organizations WHERE id = v_org) = 'acme');
    PERFORM pg_temp.ck('concluir(A): vínculo admin de A na organização',
        (SELECT count(*) FROM public.organization_members
          WHERE organization_id = v_org AND user_id = '00000000-0000-4000-8000-0000000000a1' AND role = 'admin') = 1);
    PERFORM pg_temp.ck('concluir(A): nenhum outro vínculo', (SELECT count(*) FROM public.organization_members) = 1);
    PERFORM pg_temp.ck('depois do setup: instalacao_precisa_setup() = false', public.instalacao_precisa_setup() IS FALSE);
END $$;

-- 3. concluir(B) com a instalação já configurada -> PT409, sem criar nada
DO $$
DECLARE
    v_estado text := 'sem erro';
BEGIN
    BEGIN
        PERFORM public.instalacao_concluir_setup('00000000-0000-4000-8000-0000000000b2', 'Beta');
    EXCEPTION WHEN OTHERS THEN
        v_estado := SQLSTATE;
    END;
    PERFORM pg_temp.ck('concluir(B) depois do setup: SQLSTATE PT409', v_estado = 'PT409', v_estado);
    PERFORM pg_temp.ck('concluir(B) recusado: continua 1 organização e B sem poder',
        (SELECT count(*) FROM public.organizations) = 1
        AND (SELECT is_super_admin FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000b2') IS NOT TRUE);
END $$;

-- 4. get_decrypted_ai_key: como authenticated -> 42501, como service_role -> valor. A chave é cifrada com o segredo
-- ai_key_secret do Vault (o mesmo que a função usa); sem ele o teste avisa em vez de adivinhar.
DO $$
DECLARE
    v_org uuid := (SELECT id FROM public.organizations LIMIT 1);
    v_estado text := 'sem erro';
    v_valor text;
BEGIN
    UPDATE public.organizations
       SET ai_api_key_encrypted = extensions.pgp_sym_encrypt('chave-de-teste', public._segredo_obrigatorio('ai_key_secret'))::text
     WHERE id = v_org;

    -- authenticated, mesmo sendo admin da organização
    PERFORM set_config('request.jwt.claims',
        json_build_object('sub', '00000000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
        PERFORM public.get_decrypted_ai_key(v_org);
    EXCEPTION WHEN OTHERS THEN
        v_estado := SQLSTATE;
    END;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.ck('get_decrypted_ai_key como authenticated: 42501', v_estado = '42501', v_estado);

    -- service_role
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    EXECUTE 'SET LOCAL ROLE service_role';
    v_estado := 'sem erro';
    BEGIN
        v_valor := public.get_decrypted_ai_key(v_org);
    EXCEPTION WHEN OTHERS THEN
        v_estado := SQLSTATE || ' ' || SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.ck('get_decrypted_ai_key como service_role: devolve a chave', v_valor = 'chave-de-teste',
        coalesce(v_valor, v_estado));
    PERFORM set_config('request.jwt.claims', '', true);
END $$;

-- 5. SET ROLE anon / authenticated -> 42501 nas duas funções
DO $$
DECLARE
    v_papel text;
    v_funcao text;
    v_estado text;
BEGIN
    FOREACH v_papel IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        FOREACH v_funcao IN ARRAY ARRAY['instalacao_precisa_setup', 'instalacao_concluir_setup'] LOOP
            v_estado := 'sem erro';
            EXECUTE format('SET LOCAL ROLE %I', v_papel);
            BEGIN
                IF v_funcao = 'instalacao_precisa_setup' THEN
                    PERFORM public.instalacao_precisa_setup();
                ELSE
                    PERFORM public.instalacao_concluir_setup('00000000-0000-4000-8000-0000000000b2', 'Beta');
                END IF;
            EXCEPTION WHEN OTHERS THEN
                v_estado := SQLSTATE;
            END;
            EXECUTE 'RESET ROLE';
            PERFORM pg_temp.ck(format('%s chamando %s: 42501', v_papel, v_funcao), v_estado = '42501', v_estado);
        END LOOP;
    END LOOP;
END $$;

-- 6. proacl das duas funções: só postgres e service_role, com EXECUTE
DO $$
DECLARE
    r record;
    v_papeis text;
BEGIN
    FOR r IN
        SELECT p.proname, p.proacl
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('instalacao_precisa_setup', 'instalacao_concluir_setup')
    LOOP
        SELECT string_agg(DISTINCT coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC'), ',' ORDER BY coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC'))
          INTO v_papeis
          FROM aclexplode(r.proacl) a
         WHERE a.privilege_type = 'EXECUTE';
        PERFORM pg_temp.ck(format('proacl de %s = postgres,service_role', r.proname),
            v_papeis = 'postgres,service_role', v_papeis || ' / ' || r.proacl::text);
    END LOOP;
    PERFORM pg_temp.ck('proacl: as duas funções existem',
        (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
            AND proname IN ('instalacao_precisa_setup', 'instalacao_concluir_setup')) = 2);
    SELECT string_agg(DISTINCT a.grantee::regrole::text, ',' ORDER BY a.grantee::regrole::text)
      INTO v_papeis
      FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.oid = 'public.get_decrypted_ai_key(uuid)'::regprocedure AND a.privilege_type = 'EXECUTE';
    PERFORM pg_temp.ck('proacl de get_decrypted_ai_key = postgres,service_role', v_papeis = 'postgres,service_role', v_papeis);
END $$;

-- 7. nome de organização só com ideogramas: slug não vazio (fallback 'organizacao'). Volta ao estado vazio antes.
ROLLBACK TO SAVEPOINT antes_de_concluir;

DO $$
DECLARE
    v_org uuid;
BEGIN
    PERFORM pg_temp.ck('depois do rollback ao savepoint: instalacao_precisa_setup() = true', public.instalacao_precisa_setup() IS TRUE);
    v_org := (public.instalacao_concluir_setup('00000000-0000-4000-8000-0000000000a1', '日本') ->> 'organization_id')::uuid;
    PERFORM pg_temp.ck('nome 日本: slug não vazio', coalesce((SELECT slug FROM public.organizations WHERE id = v_org), '') <> '',
        (SELECT slug FROM public.organizations WHERE id = v_org));
    PERFORM pg_temp.ck('nome 日本: slug = organizacao', (SELECT slug FROM public.organizations WHERE id = v_org) = 'organizacao');
END $$;

-- 8. validações de entrada (cada uma volta ao estado vazio)
ROLLBACK TO SAVEPOINT antes_de_concluir;

DO $$
DECLARE
    v_caso record;
    v_estado text;
BEGIN
    FOR v_caso IN
        SELECT * FROM (VALUES
            ('nome de 1 caractere',  '00000000-0000-4000-8000-0000000000a1'::uuid, 'A'),
            ('nome só com espaços',  '00000000-0000-4000-8000-0000000000a1'::uuid, '    '),
            ('nome nulo',            '00000000-0000-4000-8000-0000000000a1'::uuid, NULL),
            ('nome de 101 caracteres','00000000-0000-4000-8000-0000000000a1'::uuid, repeat('x', 101)),
            ('usuário inexistente',  '00000000-0000-4000-8000-0000000000ff'::uuid, 'Acme'),
            ('usuário nulo',         NULL::uuid,                                   'Acme')
        ) AS t(descricao, usuario, organizacao)
    LOOP
        v_estado := 'sem erro';
        BEGIN
            PERFORM public.instalacao_concluir_setup(v_caso.usuario, v_caso.organizacao);
        EXCEPTION WHEN OTHERS THEN
            v_estado := SQLSTATE;
        END;
        PERFORM pg_temp.ck('entrada inválida (' || v_caso.descricao || '): 22023', v_estado = '22023', v_estado);
    END LOOP;
    PERFORM pg_temp.ck('entradas inválidas não deixam nada: 0 organização e instalação ainda vazia',
        (SELECT count(*) FROM public.organizations) = 0 AND public.instalacao_precisa_setup() IS TRUE);

    -- nome de 100 caracteres é o limite aceito
    PERFORM public.instalacao_concluir_setup('00000000-0000-4000-8000-0000000000a1', repeat('x', 100));
    PERFORM pg_temp.ck('nome de 100 caracteres é aceito', (SELECT length(name) FROM public.organizations) = 100);
END $$;

-- 9. perfil ausente: a função recria (o trigger normalmente já criou)
ROLLBACK TO SAVEPOINT antes_de_concluir;

DO $$
BEGIN
    DELETE FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1';
    PERFORM public.instalacao_concluir_setup('00000000-0000-4000-8000-0000000000a1', 'Acme');
    PERFORM pg_temp.ck('perfil ausente: recriado com e-mail e super admin',
        (SELECT is_super_admin AND email = 'ana-teste@example.com' FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000a1') IS TRUE);
END $$;

ROLLBACK;
