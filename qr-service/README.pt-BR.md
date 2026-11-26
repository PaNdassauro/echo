# Serviço de QR do Echo

**Português** · [English](README.md) · [README do Echo](../README.pt-BR.md) ·
[Guia de instalação](../docs/self-hosting.md#11-qr-service-qr-numbers) (em inglês)

O serviço de QR mora na pasta `qr-service/` do repositório do Echo. Ele conecta números de WhatsApp ao
[Echo](#como-ele-se-liga-ao-echo) pela leitura de
um QR code (ou digitando um código de pareamento) no celular, do mesmo jeito que o WhatsApp Web. Ele
mantém essas sessões abertas, repassa ao Echo tudo o que chega e expõe uma API HTTP que o Echo usa para
enviar mensagens, administrar grupos, ler perfis e fazer ligações de voz.

É um serviço Node.js / Express escrito em TypeScript. O protocolo do WhatsApp fica a cargo de
bibliotecas de terceiros atrás de um adapter, e cada número pode rodar numa biblioteca diferente.

A pasta é um projeto npm próprio (pacote `echo-qr-service`), com `package.json`, `package-lock.json`,
`node_modules`, `Dockerfile` e `Dockerfile.voip` seus. A raiz do repositório não é workspace do npm:
rode todos os comandos abaixo de dentro de `qr-service/` (`cd qr-service` a partir da raiz). O `npm ci`
da raiz não instala as dependências desta pasta, e o `npm test` da raiz não roda os testes dela.

> [!WARNING]
> **Este serviço usa bibliotecas não oficiais do WhatsApp Web.** Ele não tem vínculo com o WhatsApp nem
> com a Meta, nem é endossado por eles. Automatizar uma conta pessoal ou comercial do WhatsApp desta
> forma pode violar os Termos de Serviço do WhatsApp, e o WhatsApp pode restringir ou banir de vez os
> números conectados. O serviço tem proteções que reduzem esse risco (ver
> [Proteções contra banimento](#proteções-contra-banimento)), mas nada aqui impede um banimento. Use
> números que você pode perder e use a Cloud API oficial do WhatsApp (que o Echo também suporta) para
> prospecção a frio e envio em massa.

## Sumário

- [Como ele se liga ao Echo](#como-ele-se-liga-ao-echo)
- [Requisitos](#requisitos)
- [Início rápido com Docker Compose](#início-rápido-com-docker-compose)
- [Rodar sem Docker](#rodar-sem-docker)
- [Ligar ao Echo](#ligar-ao-echo)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Providers](#providers)
- [Ligações de voz](#ligações-de-voz)
- [API HTTP](#api-http)
- [Contrato com o Echo](#contrato-com-o-echo)
- [Persistência das sessões](#persistência-das-sessões)
- [Health checks](#health-checks)
- [Proteções contra banimento](#proteções-contra-banimento)
- [Testes](#testes)
- [Licença](#licença)

## Como ele se liga ao Echo

O Echo é uma caixa de entrada de WhatsApp multi-tenant para equipes, construída sobre o Supabase
(Postgres, Edge Functions, Realtime, Storage) com front em React. Um número no Echo é uma linha em
`phone_numbers`. Os números com `connection_type = 'qr'` são atendidos por este serviço; os da Cloud
API oficial, não.

```
 celular (WhatsApp) ──► serviço de QR ──► edge function whatsapp-webhook do Echo (rotas /qr-*) ──► Postgres
                           ▲    │
                           │    └──► Supabase: tabelas, Storage (attachments), broadcast do Realtime
 front do Echo ────────────┤        (chave service_role)
 edge functions do Echo ───┘  API HTTP (token Bearer)
```

- **Entrada:** o serviço baixa a mídia, sobe para o bucket `attachments` e faz um POST de cada evento
  (mensagem, recibo, reação, edição, exclusão, voto de enquete, evento de grupo) para a edge function
  `whatsapp-webhook`. A edge function grava as linhas; o front recebe tudo pelo Realtime.
- **Saída:** as edge functions do Echo (`whatsapp-send`, `whatsapp-send-media`, …) e o front chamam a
  API HTTP deste serviço.
- O serviço também lê e grava algumas tabelas do Echo direto, com a chave `service_role`
  (`phone_numbers`, `phone_number_sessions`, `conversations`, `messages`, `qr_message_log`,
  `session_connection_log`, `profiles`, `organization_members`). Por isso precisa de um banco criado
  pelas migrações do Echo (`../supabase/migrations/`).

Cada projeto Supabase tem de ter **exatamente uma** instância deste serviço. Duas instâncias apontando
para o mesmo projeto abrem as mesmas sessões de WhatsApp e derrubam uma à outra com `401 conflict`.

## Requisitos

- **Node.js 22** (`qr-service/.nvmrc`, `engines: >=22.0.0`). O provider `zapo` depende do `WebSocket` global do
  Node 22.
- **ffmpeg** no `PATH`. Não é preciso para subir o serviço, mas as mensagens de voz
  (`/message/send-voice` converte qualquer áudio para OGG/Opus) e o tom de teste das ligações falham sem
  ele. As duas imagens Docker já instalam.
- Um projeto Supabase do **Echo** (hospedado ou `npx supabase start` local, rodado na raiz do
  repositório) com as migrações do Echo aplicadas e a edge function `whatsapp-webhook` publicada (ou
  servida localmente).
- Opcional: um **PostgreSQL** para o provider `zapo` (o Compose já sobe um).
- Para o início rápido com Compose: Docker com **Compose v2.24 ou mais novo** (o arquivo usa
  `env_file` com `required: false`).

## Início rápido com Docker Compose

```bash
cd qr-service
cp .env.example .env
# edite o .env: SUPABASE_URL, SUPABASE_SERVICE_KEY, WEBHOOK_URL, QR_WEBHOOK_SECRET, ZAPO_PG_PASSWORD
# (e ALLOWED_ORIGINS para um front que não esteja em localhost)
docker compose up -d --build
curl -s localhost:3000/health
```

O contexto de build do `docker-compose.yml`, do `Dockerfile` e do `Dockerfile.voip` é a pasta
`qr-service/`, então rode o `docker compose` de lá. O container e a imagem local se chamam
`echo-qr-service` (o nome do pacote npm). O `docker-compose.yml` sobe dois containers:

| Serviço | O que é |
|---|---|
| `echo-qr-service` | este serviço, construído pelo `Dockerfile` (Alpine, com `ffmpeg` e `tini`; roda como o usuário `node`, sem root, e tem `HEALTHCHECK` em `/health`), porta `${QR_PORT:-3000}` no host |
| `zapo-db` | `postgres:16-alpine`, interno à rede do Compose, usado só pelo provider `zapo` |

O Compose se recusa a subir se faltar (ou estiver vazia) qualquer uma destas cinco variáveis (a
mensagem cita uma variável por vez, então preencha as cinco no `.env` antes):

| Variável | Por que o Compose exige |
|---|---|
| `SUPABASE_URL` | obrigatória para o serviço |
| `SUPABASE_SERVICE_KEY` | obrigatória para o serviço |
| `WEBHOOK_URL` | obrigatória para o serviço |
| `QR_WEBHOOK_SECRET` | obrigatória para o serviço |
| `ZAPO_PG_PASSWORD` | senha do Postgres `zapo-db`, usada também na `ZAPO_PG_URL` que ele passa ao serviço |

`ZAPO_PG_PASSWORD` é obrigatória no `docker-compose.yml`, sem valor padrão: o `docker compose` recusa
subir sem ela. Gere com `openssl rand -hex 24` (hexadecimal, seguro dentro da URL de conexão) e coloque
no `qr-service/.env`. O compose usa o mesmo valor como `POSTGRES_PASSWORD` do Postgres da zapo e na
`ZAPO_PG_URL` do serviço. Defina-a antes do primeiro `docker compose up`: o Postgres grava a senha no
volume `zapo_pg` na criação, e trocá-la depois exige recriar o volume (`docker compose down -v`, o que
apaga as sessões da zapo) ou rodar `ALTER USER` no banco. Fora do compose, `ZAPO_PG_URL` continua
opcional e aponta para qualquer Postgres seu: `postgres://zapo:<senha>@host:5432/zapo`.

O Compose define sozinho `ZAPO_PG_URL` e `ZAPO_PG_TABLE_PREFIX`, então os dois providers ficam
disponíveis. O container `zapo-db` não publica porta. As sessões ficam no volume `qr_sessions` e o banco
da zapo em `zapo_pg` (ver [Persistência das sessões](#persistência-das-sessões)).

Para gravar na imagem o commit que o `/health` informa:

```bash
GIT_SHA=$(git rev-parse --short HEAD) docker compose build
```

O Compose não passa `APP_VERSION`; sem ela, o `/health` informa a versão do `package.json`.

**Supabase local:** se o Echo roda com `supabase start` na mesma máquina, `127.0.0.1` dentro do
container é o próprio container. O `docker-compose.yml` já declara
`extra_hosts: host.docker.internal:host-gateway` (necessário no Linux), então use
`http://host.docker.internal:54321` em `SUPABASE_URL` e
`http://host.docker.internal:54321/functions/v1/whatsapp-webhook` em `WEBHOOK_URL`. Ou rode o serviço
sem Docker (próxima seção). Limitação: com um Supabase local, o `media_url` que o Echo manda para um
número QR aponta para o Storage no endereço que a edge function enxerga (`http://127.0.0.1:54321`), que não
é o da `SUPABASE_URL`, e o serviço o recusa como host privado. Defina `ECHO_PUBLIC_URL` com esse endereço
(`http://127.0.0.1:54321`): o serviço reconhece a URL como do próprio Storage e baixa pela `SUPABASE_URL`
(ver a nota sobre `media_url` em [API HTTP](#api-http)).

## Rodar sem Docker

```bash
cd qr-service
nvm use            # Node 22
npm ci
cp .env.example .env   # preencha as obrigatórias
npm run build
npm start          # node dist/index.js
```

Para desenvolvimento, `npm run dev` roda `tsx watch src/index.ts`. O `.env` é lido da pasta atual, e as
sessões ficam em `./sessions` relativo à pasta atual: suba o serviço a partir da pasta `qr-service/`
(`qr-service/.env` e `qr-service/sessions/` são ignorados pelo git).

Sem `ZAPO_PG_URL` só o provider `baileys` é registrado, e o log diz
`[Provider] zapo desabilitada (defina ZAPO_PG_URL para registrar)`.

## Ligar ao Echo

O Echo precisa saber onde o serviço está, e os dois lados precisam do mesmo segredo. No Echo (detalhes
na seção 11 do [guia de instalação](../docs/self-hosting.md#11-qr-service-qr-numbers), em inglês):

| Onde | Nome | Valor |
|---|---|---|
| Secret das edge functions | `QR_SERVICE_URL` | URL deste serviço vista pelas edge functions |
| Secret das edge functions | `QR_WEBHOOK_SECRET` | o mesmo valor de `QR_WEBHOOK_SECRET` aqui |
| Segredo do Vault (usado pelos cron jobs do banco) | `qr_service_url` | URL deste serviço vista pelo banco |
| Variável de build do front | `VITE_QR_SERVICE_URL` | URL deste serviço vista pelo navegador |

Neste serviço:

- `WEBHOOK_URL` = `<SUPABASE_URL>/functions/v1/whatsapp-webhook` (sem barra no fim).
- `ALLOWED_ORIGINS` precisa incluir a origem de onde o front do Echo é servido, porque o navegador chama
  este serviço direto.
- `QR_WEBHOOK_SECRET` é obrigatória nos dois lados, com o mesmo valor: sem ela este serviço não sobe, e
  a edge function responde `503` em toda rota `/qr-*` (valor diferente recebe `401`).
- `SUPABASE_SERVICE_KEY` precisa ser **o mesmo valor** que as edge functions recebem em
  `SUPABASE_SERVICE_ROLE_KEY`, que é o JWT `service_role` legado do projeto. As edge functions se
  autenticam neste serviço mandando essa chave como token Bearer, e o serviço a compara byte a byte com
  `SUPABASE_SERVICE_KEY`. Se forem diferentes (por exemplo, uma chave `sb_secret_…` aqui), toda chamada
  de edge function recebe `401 Invalid token`.

Para conectar um número: crie um número QR no Echo (Configurações > Números). O Echo chama
`POST /session/connect` e mostra o QR code que recebe por `GET /session/qr/:phoneNumberId`. Leia-o com
o WhatsApp do celular (Dispositivos conectados).

## Variáveis de ambiente

Todas são lidas por `process.env` em `src/`. O `dotenv` carrega o `.env` da pasta atual. O
`.env.example` documenta a mesma lista.

### Obrigatórias

Sem qualquer uma delas o serviço sai com código 1.

| Variável | Padrão | Descrição |
|---|---|---|
| `SUPABASE_URL` | nenhum | URL do projeto Supabase do Echo. Também é a base do broadcast do Realtime (`/realtime/v1/api/broadcast`), do alerta de desconexão (`/functions/v1/send-disconnect-alert`) e do upload resumível de mídia (`/storage/v1/upload/resumable`). |
| `SUPABASE_SERVICE_KEY` | nenhum | Chave `service_role` legada (JWT) do Supabase. Usada pelo cliente admin do Supabase e aceita como token Bearer servidor a servidor na API deste serviço. Nunca exponha no navegador. Qual valor usar: ver [Ligar ao Echo](#ligar-ao-echo). |
| `WEBHOOK_URL` | nenhum | URL da edge function `whatsapp-webhook` do Echo, sem barra no fim. O serviço acrescenta `/qr-message`, `/qr-delivery-update` etc. |
| `QR_WEBHOOK_SECRET` | nenhum | Vai no header `x-qr-secret` de todo POST para o `WEBHOOK_URL`. Tem de ser igual ao secret `QR_WEBHOOK_SECRET` da edge function `whatsapp-webhook`. O serviço recusa subir sem ela, e a edge function responde 503 nas rotas `/qr-*` quando não tem o secret. Gere com `openssl rand -hex 32`. |

### Recomendadas

| Variável | Padrão | Descrição |
|---|---|---|
| `ALLOWED_ORIGINS` | `http://localhost:8080,http://localhost:5173` | Origens do CORS, separadas por vírgula. Inclua a origem do front do Echo. Chamadas servidor a servidor não passam pelo CORS. |
| `PORT` | `3000` | Porta HTTP. |
| `ECHO_PUBLIC_URL` | `SUPABASE_URL` | Endereço público do Echo (`https://echo.exemplo.com`, sem barra no fim), o que o navegador abre. Defina quando a `SUPABASE_URL` for um endereço interno (o Echo auto-hospedado em Docker usa `http://gateway:8000`): a URL pública de toda mídia recebida e foto de perfil gravada no banco sai dele, e uma `media_url` do próprio Storage nesse endereço é baixada pela `SUPABASE_URL`. O serviço nunca chama o Supabase por ele. Sem ele a base pública é a `SUPABASE_URL` e nada muda. Valor que não seja uma URL `http(s)` faz o serviço recusar o boot (exit 1, citando a variável). |

### Provider zapo

| Variável | Padrão | Descrição |
|---|---|---|
| `ZAPO_PG_URL` | nenhum | String de conexão do PostgreSQL próprio do provider `zapo` (não é o banco do Supabase). Sem ela o provider `zapo` não é registrado. |
| `ZAPO_PG_TABLE_PREFIX` | `wa_zapo_` | Prefixo das tabelas da zapo nesse banco. |

### Mídia (bytes)

| Variável | Padrão | Descrição |
|---|---|---|
| `MAX_MEDIA_BYTES` | `52428800` (50 MiB) | Maior mídia recebida que o serviço baixa. Acima disso a mensagem chega ao Echo sem o arquivo (`media_too_large`). Mantenha o `file_size_limit` do bucket `attachments` pelo menos nesse valor. A edge function `whatsapp-send-media` do Echo tem o próprio `MAX_MEDIA_BYTES` para a mídia enviada. |
| `MEDIA_STREAM_THRESHOLD_BYTES` | `16777216` (16 MiB) | Acima disso a mídia recebida vai em stream para um arquivo temporário e sobe por upload resumível (TUS), sem ficar inteira na memória. |
| `MEDIA_DISK_RESERVE_BYTES` | `2147483648` (2 GiB) | Espaço livre em disco que os temporários de mídia sempre deixam intacto (as credenciais das sessões ficam no mesmo disco). |

### Entrega ao Echo

| Variável | Padrão | Descrição |
|---|---|---|
| `MAX_PENDING_WEBHOOKS` | `500` | Chamadas de webhook guardadas em memória. Acima disso as novas vão para `sessions/_outbox/` e são entregues depois. |

### Proteções contra banimento

| Variável | Padrão | Descrição |
|---|---|---|
| `SEND_MIN_GAP_MS` / `SEND_MAX_GAP_MS` | `0` / `0` (desligado) | Intervalo aleatório entre dois envios da mesma sessão, em ms. O espaçamento liga quando `SEND_MAX_GAP_MS` é maior que 0 (se for menor que `SEND_MIN_GAP_MS`, sobe para ele). Exemplo: `1000` e `3000`. |
| `SEND_MAX_QUEUE_WAIT_MS` | `60000` | Com o espaçamento ligado, o envio que esperaria mais que isso é recusado na hora. |
| `NEW_CONTACT_HOURLY_CAP` | `20` | Contatos novos distintos (de quem nunca chegou mensagem) que uma sessão pode abordar por hora. `0` desliga o limite. |
| `QR_HOURLY_CAP` | `5` | Pareamentos (QR ou código) por número por hora. `0` ou valor inválido vira `5`. |
| `CONNECT_COOLDOWN_AFTER_FATAL_MS` | `1800000` (30 min) | Depois de um `401`/`403` numa sessão que já estava pareada, as reconexões manuais são recusadas por esse tempo. `0` desliga. |
| `RESTORE_STAGGER_MS` | `3000` | Intervalo entre as restaurações de sessão no boot. |

### Ligações de voz (só zapo)

| Variável | Padrão | Descrição |
|---|---|---|
| `VOIP_ENABLED` | desligado | `1` carrega o plugin `@zapo-js/voip`. Só funciona na imagem `Dockerfile.voip`, que já define o valor. |
| `VOIP_MAX_CONCURRENT_CALLS` | `1` | Ligações simultâneas por número (mínimo 1). |

### Informação de build

| Variável | Padrão | Descrição |
|---|---|---|
| `APP_VERSION` | `dev` | Versão informada por `/health` e `/session/health`. Sem valor ou com `dev`, vale a versão do `package.json`. Definida por `--build-arg APP_VERSION=…` nos dois Dockerfiles. |
| `GIT_SHA` | `unknown` | Commit informado pelos health checks. Definida por `--build-arg GIT_SHA=…`. |

### Só no Docker Compose

| Variável | Padrão | Descrição |
|---|---|---|
| `QR_PORT` | `3000` | Porta publicada no host pelo `docker-compose.yml`. |
| `GIT_SHA` | `local` | Passada como build arg pelo `docker-compose.yml`. |
| `ZAPO_PG_PASSWORD` | nenhum (**obrigatória** no Compose) | Senha do Postgres `zapo-db`; o Compose monta a `ZAPO_PG_URL` com ela. Gere com `openssl rand -hex 24` antes do primeiro `docker compose up`. Ver [Início rápido com Docker Compose](#início-rápido-com-docker-compose). |

## Providers

Um provider é uma biblioteca de WhatsApp embrulhada no contrato `WhatsAppClient` (`src/adapter/`). Cada
número escolhe o seu em `phone_numbers.qr_provider` (padrão `baileys`). Vêm dois:

| Provider | Biblioteca | Onde a sessão mora | Observações |
|---|---|---|---|
| `baileys` (padrão) | [Baileys](https://github.com/WhiskeySockets/Baileys) `7.0.0-rc14` (pacote npm `baileys`, instalado como `@whiskeysockets/baileys`) | arquivos em `sessions/<phone_number_id>/` | Exporta e importa credenciais, busca histórico sob demanda. Sem ligação de voz (as rotas de ligação respondem 501). |
| `zapo` | [zapo-js](https://www.npmjs.com/package/zapo-js) com `@zapo-js/store-postgres` | o próprio PostgreSQL (`ZAPO_PG_URL`) | Registrado só com `ZAPO_PG_URL` definida. Faz ligação de voz com a imagem VoIP. Não exporta credenciais e não busca histórico sob demanda. |

Cada provider declara as suas capabilities; as rotas respondem `501` para o que o provider do número não
faz. Nenhum outro provider (por exemplo, um sidecar com whatsmeow) acompanha o código; o
`src/adapter/README.md` explica como acrescentar um.

**Trocar o provider de um número** não exige ler um QR novo:

```bash
curl -X POST "$QR_SERVICE/session/migrate-provider/<phone_number_id>" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" -H 'content-type: application/json' \
  -d '{"to":"zapo"}'
```

O serviço fecha a sessão, exporta as credenciais, guarda um backup em
`sessions/_snapshots/<phone_number_id>/`, importa no provider de destino, grava
`phone_numbers.qr_provider` e reconecta. Para voltar, chame de novo com `{"to":"baileys"}`; o backup é
usado porque a zapo não exporta. A página de operação do Echo (`/ops`) oferece a mesma ação. O serviço a permite
a qualquer membro da organização do número (ou super admin); a restrição a admin existe só na interface do Echo.

## Ligações de voz

A ligação de voz só existe no provider `zapo` com o plugin `@zapo-js/voip`, que depende do binário
nativo `@roamhq/wrtc`. Esse binário exige glibc 2.34 e não carrega no Alpine, então a ligação precisa da
imagem Debian:

```bash
cd qr-service
docker build -f Dockerfile.voip \
  --build-arg APP_VERSION=$(node -p "require('./package.json').version") \
  --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t echo-qr-service:voip .
```

O `Dockerfile.voip` define `VOIP_ENABLED=1`. Com o Compose, ponha `dockerfile: Dockerfile.voip` dentro
de `build:` no `docker-compose.yml`. Um número tem ligação só quando
`GET /call/:phoneNumberId/capability` devolve `{"voice_call": true}`, e só então o Echo mostra a tela de
ligação. O WhatsApp permite uma ligação por vez por conta, então `VOIP_MAX_CONCURRENT_CALLS` acima de 1
só serve para experimento.

## API HTTP

Toda rota, menos `GET /health`, exige um token, enviado como `Authorization: Bearer <token>`. As rotas
de Server-Sent Events e o WebSocket de áudio da ligação também aceitam `?access_token=<token>`, porque o
`EventSource` e o WebSocket do navegador não mandam headers.

O token é:

- a chave de serviço (`SUPABASE_SERVICE_KEY`), usada pelas edge functions do Echo: acesso total; ou
- o access token (JWT) de um usuário do Supabase do projeto do Echo, usado pelo front. É validado no
  Supabase Auth e fica em cache por 60 s.

As rotas com `:phoneNumberId` (o `phone_numbers.id` do Echo, ou o id do número na Meta) conferem também
se o usuário pode operar aquele número: ele precisa ser super admin (`profiles.is_super_admin`) ou
membro da organização dona do número. Senão recebe `403` (`404` se o número não existe). A chave de
serviço pula essa checagem.

### `/session`

| Método e caminho | Para quê |
|---|---|
| `POST /session/connect` | Inicia uma sessão. Corpo: `{ phoneNumberId, forceNew?, usePairingCode?, phoneNumber? }`. A checagem de número usa o `phoneNumberId` do corpo. Devolve `429` quando uma proteção recusa o pareamento. |
| `GET /session/qr/:phoneNumberId` | Stream SSE com os eventos `qr`, `pairing_code` e de conexão. |
| `GET /session/qr-code/:phoneNumberId` | QR code atual (alternativa por polling). |
| `GET /session/pairing-code/:phoneNumberId` | Código de pareamento atual (alternativa por polling). |
| `GET /session/status/:phoneNumberId` | Estado da sessão. |
| `POST /session/lid-map/:phoneNumberId` | Resolve LIDs do WhatsApp para telefone (até 500). |
| `POST /session/migrate-provider/:phoneNumberId` | Passa o número para outro provider. Corpo: `{ to }`. |
| `POST /session/presence-mode/:phoneNumberId` | Aplica `keepDeviceNotifications` numa sessão viva. |
| `POST /session/sync/:phoneNumberId` | Pede ao celular o histórico de uma conversa antes de uma mensagem âncora. |
| `POST /session/auto-recover/:phoneNumberId` | Roda já a varredura de recuperação pós-queda. |
| `POST`, `GET`, `DELETE /session/avatar-backfill/:phoneNumberId` | Inicia, consulta ou cancela a varredura em segundo plano das fotos de perfil que faltam. |
| `DELETE /session/disconnect/:phoneNumberId` | Faz logout e remove a sessão. |
| `GET /session/health` | Estado de todas as sessões, providers, limites de proteção e outbox. Não depende de número. Só com a chave de serviço (`SUPABASE_SERVICE_KEY`); token de usuário recebe `403`. |

### `/message` (todas `POST /message/<ação>/:phoneNumberId`)

`send` (texto), `send-media` (upload multipart ou `media_url`), `send-voice` (qualquer áudio,
convertido para OGG/Opus com ffmpeg), `send-contact`, `send-location`, `send-poll`, `poll-vote`,
`mark-read`, `delete`, `edit`, `presence` (digitando/gravando), `presence-subscribe`, `react`.

### `/groups`

| Método e caminho | Para quê |
|---|---|
| `GET /groups/:phoneNumberId` | Lista os grupos. |
| `POST /groups/:phoneNumberId/join` | Entra por código de convite ou link `https://chat.whatsapp.com/<código>`. |
| `GET /groups/:phoneNumberId/invite-info/:code` | Prévia de um grupo pelo código de convite. |
| `POST /groups/:phoneNumberId/create` | Cria um grupo. |
| `GET /groups/:phoneNumberId/:groupJid` | Metadados e membros do grupo. |
| `POST`, `DELETE /groups/:phoneNumberId/:groupJid/participants` | Adiciona ou remove participantes. Adicionar é recusado com `403`, salvo se o número for admin do grupo ou o grupo deixar qualquer membro adicionar. |
| `POST /groups/:phoneNumberId/:groupJid/invite-message` | Manda convite do grupo a um contato que não pode ser adicionado direto. |
| `PATCH /groups/:phoneNumberId/:groupJid/subject` | Renomeia. |
| `PATCH /groups/:phoneNumberId/:groupJid/description` | Muda a descrição. |
| `PUT /groups/:phoneNumberId/:groupJid/picture` | Muda a foto (multipart ou `media_url`). |
| `POST /groups/:phoneNumberId/:groupJid/promote`, `.../demote` | Promove ou rebaixa admins. |
| `DELETE /groups/:phoneNumberId/:groupJid/leave` | Sai do grupo. |
| `PATCH /groups/:phoneNumberId/:groupJid/settings` | Quem pode mandar mensagem / editar os dados do grupo. |
| `PATCH /groups/:phoneNumberId/:groupJid/member-add-mode` | Quem pode adicionar membros. |
| `PATCH /groups/:phoneNumberId/:groupJid/join-approval` | Aprovação de admin para entrar. |
| `PATCH /groups/:phoneNumberId/:groupJid/ephemeral` | Mensagens temporárias. |
| `GET /groups/:phoneNumberId/:groupJid/invite-code` | Código e link de convite. |
| `POST /groups/:phoneNumberId/:groupJid/invite-code/revoke` | Revoga e devolve um link novo. |
| `GET`, `POST /groups/:phoneNumberId/:groupJid/join-requests` | Lista, aprova ou recusa pedidos de entrada. |

### `/profile`

| Método e caminho | Para quê |
|---|---|
| `GET /profile/:phoneNumberId` | Nome e foto do próprio número conectado. |
| `PUT /profile/:phoneNumberId/picture` | Muda a foto (multipart ou `media_url`). |
| `PATCH /profile/:phoneNumberId/name` | Muda o nome de exibição. |

### `/sticker`

| Método e caminho | Para quê |
|---|---|
| `POST /sticker/convert` | Converte uma imagem (PNG, JPEG, WebP, GIF, animada ou não) em figurinha WebP 512×512. Qualquer token válido; não depende de número. |

### `/call` (voz, só `zapo` com VoIP)

| Método e caminho | Para quê |
|---|---|
| `GET /call/:phoneNumberId/capability` | `{ voice_call: boolean }`. |
| `GET /call/:phoneNumberId/events` | Stream SSE com o estado das ligações (é assim que se descobre uma ligação entrando). |
| `POST /call/:phoneNumberId/start` | Inicia uma ligação. Corpo: `{ to, tone? }`. |
| `POST /call/:phoneNumberId/:callId/accept` | Atende uma ligação. |
| `POST /call/:phoneNumberId/:callId/end` | Desliga. |
| `GET /call/:phoneNumberId/:callId` | Estado da ligação. |
| WebSocket `/call/:phoneNumberId/:callId/audio?access_token=…` | Áudio ao vivo. Mesmas checagens de token e de número das rotas HTTP. |

Uploads (`multipart/form-data`, campo `file`) vão até 50 MiB. As rotas que aceitam `media_url` baixam o
arquivo do lado do servidor. Só hosts http(s) públicos são aceitos: endereços de loopback, privados,
link-local, `.internal` e `.local` são recusados (proteção contra SSRF). Uma exceção: a URL do **Storage
desta própria instalação** (`<ECHO_PUBLIC_URL ou SUPABASE_URL>/storage/v1/object/public/attachments/...`, ou o
mesmo caminho sob a `SUPABASE_URL`) é baixada pela `SUPABASE_URL`, sem a guarda, porque o endereço vem da
configuração e não de quem chamou, e redirecionamento não é seguido. É assim que as edge functions do Echo
entregam anexos quando tudo roda numa rede Docker só. Qualquer outra coisa, inclusive host privado que não
seja o Storage, continua passando pela guarda.

## Contrato com o Echo

**Serviço → Echo (`WEBHOOK_URL`).** Cada evento é um `POST` com corpo JSON para
`${WEBHOOK_URL}/<rota>`, com o header `x-qr-secret: <QR_WEBHOOK_SECRET>` e sem header
`Authorization`. Por isso a função `whatsapp-webhook` do Echo tem de ficar com `verify_jwt = false`.

| Rota | Evento |
|---|---|
| `/qr-message` | mensagem recebida, ou enviada pelo próprio celular |
| `/qr-delivery-update` | status de entrega de uma mensagem enviada |
| `/qr-message-receipt` | recibos de leitura/entrega por participante em grupo |
| `/qr-reaction` | reação |
| `/qr-message-edited` | edição |
| `/qr-message-deleted` | exclusão |
| `/qr-poll-vote` | voto em enquete |
| `/qr-group-event` | mudança no grupo (participantes, nome, …) |

A entrega passa por um outbox: falha que vale repetir (5xx, 408, 429, rede, timeout) é repetida em
memória (2 s, 8 s, 30 s) e depois gravada em `sessions/_outbox/`, que uma varredura repete a cada 60 s e
no boot. Um 4xx permanente leva o evento para `sessions/_outbox_dead/` e grava uma linha
`webhook_dead` em `qr_message_log`. Um 404 é descartado (o Echo não conhece a mensagem referida). O Echo
deduplica as reentregas.

**Serviço → Supabase.** Com a chave de serviço, o serviço também:

- sobe mídia para o bucket `attachments` do Storage (supabase-js, ou TUS para arquivo grande);
- faz POST em `${SUPABASE_URL}/functions/v1/send-disconnect-alert` quando um número cai (headers
  `apikey` e `Authorization: Bearer <chave de serviço>`);
- manda as atualizações de presença como broadcast do Realtime no tópico `presence-<phone_number_id>`;
- lê e atualiza as tabelas do Echo listadas em [Como ele se liga ao Echo](#como-ele-se-liga-ao-echo).
  O diagnóstico vai para `qr_message_log` e as aberturas e quedas de conexão para
  `session_connection_log`.

**Echo → serviço.** As edge functions mandam `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`; o
front manda o access token do usuário. Ver [API HTTP](#api-http).

## Persistência das sessões

Tudo o que o serviço precisa guardar entre reinícios fica em `sessions/` (relativo à pasta de trabalho;
`/app/sessions` nas imagens):

| Caminho | Conteúdo |
|---|---|
| `sessions/<phone_number_id>/` | credenciais e chaves do Baileys de um número |
| `sessions/_outbox/` | eventos de webhook esperando entrega |
| `sessions/_outbox_dead/` | eventos que o Echo recusou de vez |
| `sessions/_snapshots/<phone_number_id>/` | backups de credenciais feitos pelo `migrate-provider` |

As sessões do provider `zapo` ficam no banco de `ZAPO_PG_URL`.

Monte `sessions/` num volume persistente (o Compose usa `qr_sessions`, mais `zapo_pg` para o banco da
zapo). Se ele se perder, todo número terá de ler o QR de novo, e cada leitura registra um dispositivo
conectado novo no celular, o que o WhatsApp conta contra o número.

**Dono do volume.** A imagem do `Dockerfile` roda como o usuário `node` (uid 1000), não como root, e
`/app/sessions` é dele: um volume **novo** herda esse dono. Um volume criado por uma imagem antiga (que rodava
como root) continua com `root` como dono, e o serviço não consegue gravar `sessions/_outbox/` nem as
credenciais (`Permission denied`, medido). Por isso o boot testa a escrita em `sessions/` e, se falhar, aborta com
`[FATAL]` e o comando abaixo (em vez de subir "healthy" sem guardar nada). Corrija uma vez antes de subir a imagem nova:

```bash
docker run --rm -u 0 -v <volume>:/app/sessions --entrypoint chown echo-qr-service -R 1000:1000 /app/sessions
```

`<volume>` é `qr_sessions` com o nome do projeto do Compose na frente (`docker volume ls`). O
`Dockerfile.voip` continua rodando como root.

No boot o serviço restaura toda sessão guardada cujo id ainda existe em `phone_numbers`, uma a cada
`RESTORE_STAGGER_MS`. **Sessão guardada cujo id não está em `phone_numbers` é apagada.** Nunca suba o
serviço com um volume `sessions/` existente e um `SUPABASE_URL` de outro projeto.

No `SIGTERM`/`SIGINT` o serviço fecha as sessões, espera até 8 s pelos webhooks em voo e grava o resto em
`sessions/_outbox/`.

## Health checks

- `GET /health` (público): `status`, `version`, `commit`, uptime, memória, número de sessões, webhooks
  pendentes e estado do outbox (`outbox_mem`, `outbox_disk`, `outbox_oldest_disk_age_s`,
  `outbox_stalled`, `outbox_skipped`) e a fila de fotos de perfil (`avatars`). `outbox_stalled: true`
  quer dizer que a fila em disco parou porque o Echo recusa o evento da frente; é o campo para alertar.
- `GET /session/health` (só com a chave de serviço, `SUPABASE_SERVICE_KEY`): estado e provider de cada sessão, providers registrados,
  `reachout_locks`, `message_capping` e os `protection_limits` em vigor. A edge function
  `qr-service-health` do Echo lê os dois.

O `phone_numbers.qr_session_status` no banco pode ficar atrasado; o `/session/health` é o estado vivo.

## Proteções contra banimento

O WhatsApp restringe contas sobretudo por comportamento: pareamento repetido, prospecção a frio e
volume para quem nunca escreveu ao número. Atualizar a biblioteca não muda isso. O que o serviço faz:

- **Um QR por pedido de conexão.** QR que expira não gera outro sozinho (`qr_expired`); o usuário
  precisa pedir de novo.
- **Limite de pareamentos:** `QR_HOURLY_CAP` por número por hora.
- **Espera depois de queda fatal:** `CONNECT_COOLDOWN_AFTER_FATAL_MS` depois de um `401`/`403` numa
  sessão pareada. Um `403` costuma ser conta suspensa; re-parear em loop piora.
- **Limite de contatos novos:** `NEW_CONTACT_HOURLY_CAP` contatos novos distintos por sessão por hora.
- **Bloqueio de abordagem:** quando o WhatsApp responde um envio com o erro `463` (reach-out
  time-locked), o serviço bloqueia por um tempo os envios daquele número a contatos frios
  (`reachout_locks` no `/session/health`).
- **Espaçamento opcional entre envios:** `SEND_MIN_GAP_MS` / `SEND_MAX_GAP_MS` (desligado por padrão,
  porque atendimento em tempo real não pode esperar).
- **Restauração escalonada** no boot (`RESTORE_STAGGER_MS`), para um reinício não abrir todas as
  sessões no mesmo segundo, do mesmo IP.
- **Fila de fotos de perfil** com disjuntor para HTTP 429.

Adicionar participantes em grupo também pode derrubar a sessão (`401 conflict`); link de convite
(`invite-code` + `join`) é o caminho mais seguro.

## Testes

```bash
cd qr-service
npm ci
npm run build          # tsc, tem de terminar com 0 erros
npm run -s test:all    # todas as suítes abaixo
```

Os testes rodam no test runner do Node (`node --import tsx --test`) e em scripts Node simples, não no
Vitest. O job `qr-service` do CI do repositório (`../.github/workflows/ci.yml`) roda os mesmos
`npm ci`, `npm run build` e `npm run -s test:all` no Node 22.

| Script | O que cobre |
|---|---|
| `test:message-fallback` | texto de fallback dos tipos de mensagem sem renderização nativa (inclusive Pix) |
| `test:outbox-sweep` | repetição e varredura em disco do outbox de webhooks |
| `check:adapter` | só `src/adapter/<provider>/` pode importar a própria biblioteca |
| `test:secret-edit`, `test:zapo-parity`, `test:group-self`, `test:group-subject`, `test:group-add`, `test:zapo-wa-version` | testes de unidade de comportamentos isolados |
| `test:session-health` | `GET /session/health` só para a chave de serviço (JWT de usuário recebe `403`), com um Supabase Auth falso |
| `test:own-profile` | foto do próprio perfil contra um servidor de WhatsApp falso |
| `test:media` | upload resumível (inclusive a reescrita do `Location`), temporários de mídia, dimensões de mídia |
| `test:public-url` | URL pública × interna do Storage (`ECHO_PUBLIC_URL`) e a guarda SSRF deixando passar o Storage próprio |
| `test:qr-sse` | o SSE do QR manda cabeçalhos e um 1º byte na hora, depois um `: ping` a cada 25 s |
| `test:boot-public-url` | `ECHO_PUBLIC_URL` inválida aborta o boot; válida ou ausente sobe |
| `test:adapter-contract` | o contrato `WhatsAppClient` dos dois providers, contra o `@zapo-js/fake-server` (protocolo real, sem celular) |
| `test:avatar-queue` | fila de fotos de perfil |

Nenhum teste fala com o WhatsApp nem com um projeto Supabase. `test:own-profile` e
`test:adapter-contract` definem `NODE_TLS_REJECT_UNAUTHORIZED=0` só para o servidor falso local. O
`scripts/tus-smoke.mts` é um teste manual do upload resumível contra um Storage de verdade
(`SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node --import tsx scripts/tus-smoke.mts <bytes>`).

## Licença

MIT, ver o [LICENSE](../LICENSE) do repositório (o campo `license` do `package.json` também é `MIT`).
Algumas dependências usam outras licenças, inclusive GPL-3.0 (`libsignal`, via Baileys); leia o
[NOTICE](NOTICE) antes de redistribuir uma imagem Docker construída.

Contribuições: [CONTRIBUTING.md](../CONTRIBUTING.md#qr-service) (seção "QR service", em inglês).
Mudanças: o [CHANGELOG.md](../CHANGELOG.md) do repositório, que lista juntas as versões do app e do
serviço.
