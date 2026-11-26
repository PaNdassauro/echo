# Imagem do banco do Echo: a imagem supabase/postgres + os scripts de init e as migrações DENTRO dela.
# É a mesma imagem de três serviços do compose (db, db-init, migrate); só o `db` tem `build:`.
# Sem bind mount: arquivo montado sem +x derruba o Postgres (getkey), SELinux recusa bind sem rótulo, e a migração
# vem sempre do mesmo build do esquema. Contexto de build: a raiz do repo.
ARG PG_BASE=public.ecr.aws/supabase/postgres:17.6.1.095
FROM ${PG_BASE}
ARG PG_BASE
# O `./echo backup` grava esta base no manifest e o `restore` recusa um backup de outra base de Postgres.
LABEL org.echo.postgres-base=${PG_BASE}
COPY --chmod=0755 docker/db/getkey.sh docker/db/preflight.sh docker/db/db-init.sh docker/migrate/migrate.sh /echo/
COPY supabase/migrations /echo/migrations
# Versão do Echo que construiu a imagem (o ./echo e o install.sh exportam ECHO_VERSION; sem ela, "dev").
ARG ECHO_VERSION=dev
LABEL org.echo.version=${ECHO_VERSION}
