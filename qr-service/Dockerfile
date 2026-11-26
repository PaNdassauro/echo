FROM node:22.22.3-alpine3.24 AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npx tsc

FROM node:22.22.3-alpine3.24 AS runtime

WORKDIR /app

# tini: init/reaper. ffmpeg: transcodifica áudio p/ opus (mensagens de voz / PTT).
RUN apk add --no-cache tini ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Roda como `node` (uid 1000), não como root. O diretório de sessões nasce do `node`:
# um volume NOVO herda esse dono. Volume antigo, criado quando a imagem rodava como
# root, precisa de um `chown -R 1000:1000` único (ver "Volume de sessões" no README).
RUN mkdir -p /app/sessions && chown node:node /app/sessions

# Identidade da imagem, servida por /health e /session/health. Fica no fim de
# propósito: muda a cada build e invalidaria as camadas de npm ci se subisse.
# Sem --build-arg o health responde a versão do package.json e commit 'unknown'
# (ex.: build direto do código por um PaaS). Ver src/lib/version.ts.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA

EXPOSE 3000

USER node

# /health é público e não fala com o WhatsApp. Pelo IP, sem depender de como o
# `localhost` do container resolve. A porta segue o `PORT` do serviço (default 3000): PaaS que injeta PORT
# não pode deixar o container "unhealthy" para sempre. A forma shell expande na hora de rodar.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
