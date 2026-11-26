# Runtime das edge functions do Echo: Deno puro, processo único, dependências pré-baixadas no build.
# Contexto de build: a raiz do repositório (`docker build -f docker/functions/Dockerfile .`).
#
# As dependências das funções vêm do registro npm, com lock congelado: o tarball de uma versão do npm é imutável, então a
# integridade do docker/functions/deno.lock vale de verdade e uma divergência quebra o BUILD, nunca a instalação em
# execução. Os fontes importam do esm.sh (é o que o caminho Supabase Cloud/CLI usa); o mapa de imports do deno.json os
# redireciona para `npm:` neste runtime, então o build não busca código no esm.sh. Dependência nova entra nesse mapa
# (docker/functions/tests/mapa-imports.test.ts cobra). O runtime sobe com --cached-only (sem rede).
FROM denoland/deno:alpine-2.5.6
WORKDIR /app

COPY supabase/functions /app/functions
COPY supabase/config.toml /app/config.toml
# Nada de ambiente de desenvolvimento nem de teste dentro da imagem (o .dockerignore da raiz também barra os .env).
RUN find /app/functions \( -name '.env' -o -name '.env.*' \) -type f -delete \
 && find /app/functions \( -name '*.test.ts' -o -name '*.test-helper.ts' \) -type f -delete

COPY docker/functions/gen-verify-jwt-map.mjs /app/docker/functions/gen-verify-jwt-map.mjs
# Mapa verify_jwt por função (falha o build se o config.toml declarar função sem pasta).
RUN deno run --allow-read --allow-write /app/docker/functions/gen-verify-jwt-map.mjs \
      /app/functions /app/config.toml --out /app/verify_jwt.json

COPY docker/functions/deno.json docker/functions/deno.lock \
     docker/functions/main.ts docker/functions/runtime.ts docker/functions/router.ts \
     docker/functions/config.ts docker/functions/common.ts docker/functions/echo-admin.ts \
     /app/docker/functions/
COPY docker/functions/shim /app/docker/functions/shim
COPY --chmod=0755 docker/functions/echo-admin /usr/local/bin/echo-admin

# Pré-cache de todo o grafo: o roteador importa as funções dinamicamente, então as entradas vão explícitas
# (inclui o npm: do nodemailer e o unpdf, ambos com especificador literal; o unpdf passa pelo mapa de imports).
RUN deno cache --frozen --config /app/docker/functions/deno.json \
      /app/docker/functions/main.ts /app/functions/*/index.ts /app/docker/functions/echo-admin.ts \
 && du -sh /deno-dir

USER deno
EXPOSE 9000
HEALTHCHECK --interval=3s --timeout=3s --retries=40 --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:9000/_health || exit 1
CMD ["deno", "run", "--cached-only", "--config", "/app/docker/functions/deno.json", \
     "--allow-net", "--allow-env", "--allow-read=/app,/deno-dir", "--allow-sys", \
     "/app/docker/functions/main.ts"]
