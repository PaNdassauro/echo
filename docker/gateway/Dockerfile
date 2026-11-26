# Gateway do Echo: o front compilado + Caddy (mesma origem para o navegador). Contexto de build: a raiz do repo.
#
# Estágio 1 compila o front SEM nenhuma VITE_* no ambiente (o .dockerignore deixa os .env de fora do contexto): a
# configuração vem em tempo de execução, de /config.js, que o entrypoint escreve a cada subida.
# --ignore-scripts: não baixa o binário da devDependency `supabase` nem roda pós-instalações de esbuild/@swc/core
# (os binários vêm pelos pacotes opcionais de plataforma; ver M-INFRA-0b no relatório).
ARG NODE_BASE=node:22.22.3-alpine3.24
ARG CADDY_BASE=caddy:2.10.2-alpine

FROM ${NODE_BASE} AS front
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# Falha alta se alguma VITE_* chegar ao build (ela seria embutida no bundle e vazaria de uma instalação para outra).
RUN if env | grep -q '^VITE_'; then echo "VITE_* no ambiente do build: remova" >&2; exit 1; fi \
 && npm run build

FROM ${CADDY_BASE}
COPY --from=front /app/dist /srv
COPY supabase/templates/recovery.html /srv/_email/recovery.html
COPY docker/gateway/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 docker/gateway/entrypoint.sh /usr/local/bin/echo-gateway-entrypoint
# O entrypoint escreve /srv/config.js e /etc/caddy/gerado/servers-proxy.caddy a cada subida (camada gravável do
# próprio container; nada de bind mount).
RUN mkdir -p /etc/caddy/gerado
EXPOSE 80 443 8000
ENTRYPOINT ["/usr/local/bin/echo-gateway-entrypoint"]
