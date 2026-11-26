-- Auth e Storage do Echo.
-- Parte do baseline do Echo. Mudança de esquema vai numa migração nova, não nesta.
-- Depende do baseline (usa public.handle_new_user e public.get_my_org_ids).

-- ---------------------------------------------------------------------------------------------------------------
-- Auth: todo usuário novo ganha um perfil (public.profiles). A entrada na organização do convite é feita depois,
-- pelo RPC public.accept_invitation.
-- A confirmação de e-mail é do próprio Supabase Auth. O hook before_user_created (cadastro só por convite) está no
-- baseline como public.hook_before_user_created e só vale se for ligado em supabase/config.toml.
-- ---------------------------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------------------------------------------
-- Storage: um bucket público, `attachments`. Aceita qualquer tipo de arquivo (allowed_mime_types NULL: cada tipo
-- recusado seria um arquivo perdido) e vai até 1 GiB. O limite global do projeto (storage.file_size_limit em
-- supabase/config.toml) também precisa permitir 1 GiB.
-- ---------------------------------------------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('attachments', 'attachments', true, 1073741824, NULL)
ON CONFLICT (id) DO UPDATE
   SET public = EXCLUDED.public,
       file_size_limit = EXCLUDED.file_size_limit,
       allowed_mime_types = EXCLUDED.allowed_mime_types;

-- A leitura é pública pela URL do bucket; estas policies valem para as chamadas autenticadas da API.
-- Gravar só nos prefixos que o app usa: outbound/<uid>, stickers/<uid>, template-headers, template-samples,
-- broadcast-headers e automation. Prefixo novo exige policy nova antes do deploy do front.
DROP POLICY IF EXISTS attachments_insert_prefixos ON storage.objects;
CREATE POLICY attachments_insert_prefixos ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'attachments'
        AND cardinality((SELECT public.get_my_org_ids())) > 0
        AND (
            (
                (storage.foldername(name))[1] = ANY (ARRAY['outbound', 'stickers'])
                AND cardinality(storage.foldername(name)) = 2
                AND (storage.foldername(name))[2] = ((SELECT auth.uid()))::text
            )
            OR (
                (storage.foldername(name))[1] = ANY (ARRAY['template-headers', 'template-samples', 'broadcast-headers'])
                AND (
                    cardinality(storage.foldername(name)) = 1
                    OR (
                        cardinality(storage.foldername(name)) = 2
                        AND (storage.foldername(name))[2] = ANY (((SELECT public.get_my_org_ids()))::text[])
                    )
                )
            )
            OR (
                (storage.foldername(name))[1] = 'automation'
                AND cardinality(storage.foldername(name)) = 1
            )
        )
    );

DROP POLICY IF EXISTS attachments_select_proprios ON storage.objects;
CREATE POLICY attachments_select_proprios ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'attachments'
        AND (
            owner_id = ((SELECT auth.uid()))::text
            OR (storage.foldername(name))[1] = ((SELECT auth.uid()))::text
            OR (
                (storage.foldername(name))[1] = ANY (ARRAY['outbound', 'stickers'])
                AND (storage.foldername(name))[2] = ((SELECT auth.uid()))::text
            )
        )
    );

DROP POLICY IF EXISTS attachments_delete_proprios ON storage.objects;
CREATE POLICY attachments_delete_proprios ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'attachments'
        AND (
            owner_id = ((SELECT auth.uid()))::text
            OR (storage.foldername(name))[1] = ((SELECT auth.uid()))::text
            OR (
                (storage.foldername(name))[1] = ANY (ARRAY['outbound', 'stickers'])
                AND (storage.foldername(name))[2] = ((SELECT auth.uid()))::text
            )
        )
    );
