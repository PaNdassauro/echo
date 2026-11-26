# CLAUDE.md

Guia para agentes e contribuidores que trabalham neste repositório. UI, comentários e commits em pt-BR; os guias de `docs/` estão em inglês (o README tem par pt-BR).
Instalação com Docker (o caminho recomendado): `docs/self-hosting.md` (Cloud API da Meta na seção 12). Instalação com
Supabase Cloud ou CLI: `docs/alternatives/supabase-cloud.md`. Variáveis: `.env.example` (o modelo do `.env` do stack
Docker), `.env.development.example` (o front em desenvolvimento) e `supabase/functions/.env.example` (segredos das
edges no caminho Supabase, lista completa). Instagram Direct: `docs/instagram/README.md`.

## O que é

Echo: caixa de entrada de WhatsApp multi-tenant para equipes (atribuição, automações em fluxo, disparos, analytics,
API pública). Este repositório tem o front (React + Vite), as edge functions (Deno), o banco (migrações do Supabase)
e, na pasta `qr-service/`, o serviço Node que conecta números por QR (projeto npm próprio; regras dele em
`qr-service/CLAUDE.md`). O Postgres é o cérebro (RLS, RPCs, triggers, pg_cron + pg_net), as edge functions são a camada
de integração e o React é visão + realtime. O mesmo código roda de dois jeitos: no stack Docker (`./install.sh`, ver
"Instalação auto-hospedada") e num projeto Supabase (Cloud ou CLI) com o front num host estático.

Canal por linha em `phone_numbers.connection_type`: `business_api` (Cloud API da Meta: templates, janela de 24h) e
`qr` (serviço de QR, sem janela). Vários pontos tratam "não é `qr`" como Cloud API (`OFFICIAL_CONNECTION_TYPES` em
`_shared/meta-webhook.ts` é a lista fechada do lado oficial): tipo novo de linha exige revisar todos. O Instagram Direct
não é linha em `phone_numbers`: `instagram_connections.phone_number_id` pendura a conta numa linha existente, que divide
a caixa com ela.

## Antes de qualquer coisa

- O `.env` da raiz é do stack Docker (gerado pelo `install.sh`, com segredos): não copie o `.env.example` para ele e
  nunca o cole em issue, log ou commit. O front em desenvolvimento lê `.env.development.local`, copiado de
  `.env.development.example` (`cp .env.development.example .env.development.local`); ele fala com o projeto das
  `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` dali. Confira para onde aponta antes de rodar `npm run dev` ou
  de abrir conversas: abrir uma conversa marca as mensagens como lidas.
- Os scripts de `scripts/` falam com um projeto de verdade e não têm projeto padrão: os da Management API pedem
  `--ref`/`SUPABASE_PROJECT_REF` (`schema-sync.mjs`: `--from`/`--to`) e saem com erro sem ele; outros
  (`replay-write-failures.mjs`…) leem o `.env` do repo. Rode primeiro com `--dry-run` e use lote pequeno como canário.
- Desenvolvimento local: `npx supabase start` aplica `supabase/migrations/` e roda `supabase/seed.sql`, que cria no Vault
  os quatro segredos que o SQL lê (ver "Banco"). O `seed.sql` é só para o stack local.
- Primeiro administrador: `npm run bootstrap:admin -- --email <email> --password <senha> --org "<nome>"` (o mesmo que
  `node scripts/bootstrap-admin.mjs …`), com `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` no ambiente
  (`BOOTSTRAP_ADMIN_PASSWORD` substitui `--password`). Cria ou reaproveita o usuário já confirmado, marca super admin,
  cria a organização e o vínculo de admin; é idempotente e funciona com o hook de cadastro ligado ou desligado.
- Cadastro por convite: `public.hook_before_user_created` (recusa e-mail sem convite em `user_invitations`) vem
  DESLIGADO no `supabase/config.toml` (stack local e projeto Supabase). Desligado, a API de cadastro do Auth
  (`/auth/v1/signup`) aceita qualquer e-mail, mesmo que a tela `/auth` só mostre o formulário de cadastro com convite.
  Ligue depois do primeiro admin. **No stack Docker ele já vem ligado** (`GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED` no
  `docker-compose.yml`): lá só e-mail com convite pendente cria conta, e o primeiro administrador nasce na tela `/setup`.
- Não gere tráfego em lote nas sessões do WhatsApp (varrer fotos de perfil, puxar metadata de grupos, adicionar
  participantes em massa): é o tipo de comportamento que leva a restrição e ban da conta.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Front em `http://localhost:8080` (se a porta estiver ocupada, o Vite sobe em outra: ler a saída) |
| `npm test` | `vitest run` (jsdom; `src/**/*.test.{ts,tsx}` e `scripts/*.test.mjs`) |
| `npx vitest run src/lib/conversationListReducer.test.ts` | Um arquivo de teste |
| `npx vitest run <arquivo> -t "trecho do nome"` | Um teste pelo nome |
| `npm run typecheck` | `tsc -b`: o type-check que vale (`src/` e `vite.config.ts`) |
| `npm run lint` | ESLint. A base tem 484 erros (teto 488) e 78 avisos herdados na raiz (quase todos `no-explicit-any`; o lint ignora `qr-service/`) e o CI não bloqueia no lint: compare com a contagem antes da sua mudança |
| `npm run build` | Vite/esbuild. **Não** checa tipos |
| `npm run check:edge` | `deno check` nas 46 edge functions, no roteador do runtime (`docker/functions/main.ts`) e no `echo-admin`. Precisa de `deno` 2.5.6 no PATH (sem ele: `npx -y deno@2.5.6 …`) |
| `npm run test:edge` | `deno test` em `tests/` e `supabase/functions/_shared` (inclui o varredor de processo único). O 1º run baixa `npm:typescript` e `npm:nodemailer`: precisa de rede |
| `npm run test:router` | `deno test` do runtime das funções (`docker/functions/tests`) |
| `npm run check:verify-jwt` | toda função do `supabase/config.toml` tem pasta e toda pasta tem entrada (46 funções) |
| `npm run test:infra` | `scripts/smoke/testes-infra.sh`: guarda de segredos, entrypoint do gateway, Caddyfile e arquivos do compose, em Docker, sem subir o stack (~1 min) |
| `npm run smoke:selfhost` | `scripts/smoke-selfhost.sh`: sobe o stack real (projeto `echo-smoke`, portas 58290-58292), exercita a instalação e derruba (~5 min medidos, de 270 a 380 s nas rodadas; são 156 checagens). `--manter` deixa de pé |
| `npm run test:sql` | `tests/sql/rodar.sh`: testes SQL do primeiro acesso; exige um stack **vazio** (sem administrador) no ar, `ECHO_PROJECT=<projeto>` |
| `docker compose --env-file .env.example config -q` | os arquivos do compose são válidos |
| `npm run gen:types:local` | Regenera `src/integrations/supabase/types.ts` a partir do stack local |
| `npm run gen:types -- --ref <ref>` | O mesmo, de um projeto hospedado pela Management API (`SUPABASE_ACCESS_TOKEN`) |
| `node scripts/run-sql.mjs <arquivo.sql> --ref <ref> [--dry-run] [--raw]` | SQL pela Management API (ver "Banco") |
| `cd qr-service && npm ci && npm run build && npm run -s test:all` | Serviço de QR: instala, compila e testa (o `npm test` da raiz não roda esses testes) |

Node 22 (`.nvmrc`). Deno 2.5.6 para as edges (a versão do CI e da imagem `functions`); os scripts npm chamam `deno` direto, então ele precisa estar no PATH. Rodando um comando à mão, `npx -y deno@2.5.6 …` funciona.

### O que conta como verificado

- `npx tsc --noEmit` na raiz checa **zero** arquivos (o `tsconfig.json` é solução, com `files: []`) e sai 0. Use
  `npm run typecheck` ou `npx tsc --noEmit -p tsconfig.app.json`, e rode de novo depois do último arquivo editado.
- O typecheck cobre só `src/` e `vite.config.ts`, com `strict: false`. Edge function só passa pelo `deno check`, e o
  `check:edge` cobre as 46 funções, o runtime e o `echo-admin`. `scripts/` e `tests/` não passam por type-check (os
  `.test.mjs` de `scripts/` rodam no Vitest).
- O Vitest roda sem `globals`: teste de componente precisa de `afterEach(cleanup)` explícito. Máquina carregada dá
  timeout falso de 5 s: antes de caçar teste instável, rode de novo com `--testTimeout=30000` (o `hookTimeout` de 30 s já está no `vite.config.ts`).
- Não tire "passou" de comando com pipe: `cmd | tail && echo OK` testa o `tail`. Use `; echo "EXIT=${PIPESTATUS[0]}"`.
- Teste de front fica ao lado do código (`src/**/*.test.ts[x]`); teste de edge em `tests/<área>/` ou ao lado do helper
  em `_shared/*.test.ts`. Não existe E2E de ponta a ponta; o servidor falso de WhatsApp (`@zapo-js/fake-server`) só
  existe nos testes do serviço de QR.
- O CI (`.github/workflows/ci.yml`, na raiz) tem quatro jobs independentes: `web` (typecheck, Vitest, build sem nenhuma
  `VITE_*` e lint não bloqueante), `edge` (Deno 2.5.6: `check:edge`, `test:edge`, `test:router`, `check:verify-jwt`),
  `qr-service` (em `qr-service/`: Node 22, `npm ci`, `npm run build` e `npm run -s test:all`, com cache do npm em
  `qr-service/package-lock.json`) e `selfhost` (shellcheck, `docker compose config`, `test:infra` e a fumaça; só em push
  para `main` e em PR que toca o stack). Nenhum workflow publica imagem, faz deploy ou usa segredo. O serviço de QR tem projeto npm próprio:
  rode `npm ci` dentro de `qr-service/` para trabalhar nele. O lint da raiz ignora `qr-service/` (a base tem 484 erros, teto 488, e
  78 avisos herdados na raiz), e o deploy estático do front (ex.: Vercel, via `.vercelignore`) não sobe `qr-service/`.

## Arquitetura

**Entrada.** A Meta chama o `whatsapp-webhook` (ramo Cloud API, assinado com `X-Hub-Signature-256`). O serviço de QR
chama as rotas `/qr-*` do mesmo webhook (`/qr-message`, `/qr-delivery-update`, `/qr-message-receipt`,
`/qr-message-deleted`, `/qr-message-edited`, `/qr-reaction`, `/qr-poll-vote`, `/qr-group-event`), com o header
`x-qr-secret` igual ao `QR_WEBHOOK_SECRET`. O segredo é obrigatório dos dois lados: sem ele a edge responde 503 em
toda rota `/qr-*` (valor diferente = 401) e o serviço de QR nem sobe. O webhook
normaliza o telefone, acha ou cria a conversa, sobe a mídia para o bucket `attachments` e grava em `messages` (upsert
por `(whatsapp_message_id, conversation_id)` com `ignoreDuplicates`). Depois chama o `automation-execute`, emite os
webhooks da organização e manda web push. O front recebe tudo por Realtime.

**Saída.** O front chama as `whatsapp-send*`; integrações usam a `echo-api` (`/echo-api/{recurso}/{id?}/{ação?}`, chave
de `api_keys`, docs em `/api-docs/:slug`). A função grava a linha **antes** de falar com o provedor e o status anda
`sent → delivered → read | failed` pelos recibos. Todo ponto que grava mensagem de saída chama `emitMessageSent`
(`_shared/webhooks.ts`). O eco do aparelho cai no `ignoreDuplicates` e não emite nada, então writer novo sem essa
chamada deixa o receptor do webhook sem `message.sent`.

**Aviso único** (`_shared/aviso-unico.ts`, tabela `aviso_de_mensagem`, só linha QR): cada linha no grupo grava a sua
cópia, e a primeira reserva o único aviso ao webhook da organização. Sem ok do receptor, o cron
`aviso-de-mensagem-repetir` (edge `aviso-repetir`) repete até 10 vezes e grava `webhook_dead`.

**Serviço de QR** (`qr-service/`). Rotas → `SessionManager` → adapter `WhatsAppClient`, com os providers `baileys`
e `zapo`. O `SessionManager` concentra a regra de negócio: outbox em disco com retry e replay, resolução de LID,
proteções contra ban. O provider de cada linha fica em `phone_numbers.qr_provider`, e a troca sem re-parear é
`POST /session/migrate-provider/:id` (no front, só pelo `/ops`). Ligação de voz existe só na zapo com `VOIP_ENABLED=1`;
a UI aparece só quando `GET /call/:id/capability` diz `voice_call: true` (`useVoiceCallCapability`).
Ligação Echo ↔ serviço: `WEBHOOK_URL` do serviço aponta para o `whatsapp-webhook`; `QR_WEBHOOK_SECRET` é igual nos
dois lados (obrigatória nos dois); o front usa `VITE_QR_SERVICE_URL` via `qrFetch` (`src/lib/qrService.ts`, JWT do
usuário); as edges usam `QR_SERVICE_URL` com `qrAuthHeaders` (`_shared/qr.ts`, service role); o SQL lê
`qr_service_url` do Vault. O `SUPABASE_SERVICE_KEY` do serviço é o JWT legado de service_role, o mesmo valor que as
edges recebem como `SUPABASE_SERVICE_ROLE_KEY`: o serviço compara o Bearer byte a byte, e chave `sb_secret_` dá 401.

**Tenancy e visibilidade.** Toda tabela tem `organization_id` e RLS. O papel vem de `organization_members.role`
(`admin` | `agent`) mais `profiles.is_super_admin`, lidos no `OrganizationContext`. A visibilidade de conversa é **por
linha** (`get_my_conversation_phone_ids()` e afins), não por dono. A policy de `messages` herda a de `conversations`.
Isolamento por setor é chave por linha (`phone_numbers.sector_isolation_enabled`, `sector_follows_owner`).

**Front.**
- Rotas em `src/App.tsx`. Públicas: `/`, `/auth`, `/setup`, `/api-docs/:slug`. Protegidas: `/dashboard/:conversationId`,
  `/settings`, `/analytics`, `/atendimentos`, `/broadcasts`, `/automations/:id`, `/super-admin`, `/ops` (só admin:
  conexão, bans e lib por linha via RPC `get_connection_health` + edge `qr-service-health`).
- Dados via supabase-js direto nos hooks (`src/hooks/`, `src/hooks/chat/`), com useState/useEffect. O React Query
  aparece nos hooks mais novos (`useConnectionHealth`, `useQrServiceHealth`, `useVoiceCallCapability`…).
- Payload externo passa por Zod: linha de realtime, resposta de RPC, resposta do serviço de QR
  (ex.: `src/lib/conversationRealtime.ts`).
- Canal realtime novo usa `subscribeWithBackoff` (`src/lib/realtimeReconnect.ts`).
- Service worker registrado à mão (`src/lib/serviceWorkerRegistration.ts`): procura atualização a cada 60 s e adia o
  reload durante ligação. `index.html` fica fora do precache e `/storage/` fora do runtime cache (`vite.config.ts`):
  passar cada foto pelo SW travava a rolagem. Dev (sem SW) × build se compara com "Bypass for network" no DevTools.
- Liga/desliga por linha já tem forma: coluna em `phone_numbers` (`sector_isolation_enabled`, `voice_calls_enabled`,
  `typing_indicator_enabled`, `send_read_receipts`, `disconnect_alert_enabled`, `qr_provider`);
  `organization_action_buttons` (tipos `webhook`, `link`, `import_history`, vínculo opcional por número em
  `action_button_phone_numbers`); `instagram_connections` (`inbox_mode` `off`|`on`, `display_name`); env da edge
  (`WHATSAPP_APP_SECRET_ENFORCE`, `EDGE_INTERNAL_AUTH_ENFORCE`). Comportamento por linha **aparece em Configurações**.

**Realtime e notificações.** Um canal global (`global-notifications`, em `GlobalNotificationListener.tsx`) alimenta
não-lido, som, toast, título e favicon. O badge se reconstrói pela RPC `get_unread_counts` (por usuário, janela de
30 dias) em focus, visibilidade e reconexão. Web Push: `public/push-sw.js` via `importScripts` + edge `send-web-push`.
A lista de conversas lê a prévia denormalizada em `conversations.last_message_*` (mantida pelo trigger
`on_message_inserted`), com `LIST_COLUMNS` explícito (`src/lib/conversationListQuery.ts`), e aplica os eventos por
reducer puro (`conversationListReducer`). `refreshConversationById` cobre o UPDATE que tira a conversa do escopo da RLS,
que não chega pelo Realtime.

**IA.** Cada organização usa a própria chave (`set_ai_api_key`, cifrada com o segredo `ai_key_secret` do Vault;
leitura só por `get_decrypted_ai_key`). `_shared/ai-provider.ts` manda chave `sk-ant-` para a Anthropic e qualquer
outra para a OpenAI. Copiloto (edge `copiloto`, liga por usuário em `profiles.copiloto_enabled`) sugere respostas e
nunca envia. Transcrição de áudio (edge `transcrever-audio`) e leitor de mídia (`_shared/leitura-midia.ts`) gravam em
`messages.metadata.leitura`, o mesmo campo que o copiloto lê.

**Instagram Direct** (`docs/instagram/README.md`): conversa só do Direct tem `channel='instagram'` e
`contact_phone='ig:<IGSID>'`; card juntado ao WhatsApp (`instagram_juntar_conversa`) fica `channel='whatsapp'` com
`instagram_user_id`, e cada mensagem do Direct leva `metadata.canal='instagram'`. Uma conta divide a caixa com **uma**
linha (`instagram_connections_line_unique`). Envio pelo caminho do WhatsApp recusa conversa do Direct (`recusarSeDirect`
em `_shared/canal.ts`); o front esconde o que é só do WhatsApp com `ehDirect()`/`temDirect()`
(`src/lib/directDoInstagram.ts`).

**Crons** (`supabase/migrations/20260101000300_cron.sql`, pg_cron + pg_net; vêm na migração, idempotentes).

| Job | Quando (UTC) | O que faz |
|---|---|---|
| `process-scheduled-broadcasts`, `dispatch-broadcast-work`, `process-scheduled-messages` | 1 min | disparos e mensagens agendadas |
| `process-survey-timeouts`, `aviso-de-mensagem-repetir` | 1 min | timeout de pesquisa; repetição de aviso de webhook sem ok |
| `check-message-failure-alerts` | 1 min | e-mail (SMTP ou Resend, se configurado) + push de falha de mensagem |
| `qr-service-health` | 1 min | olha o serviço de QR de fora. Sem serviço de QR, desligue este job |
| `merge-duplicate-conversations`, `instagram-reprocessar-avisos` | 5 min | junta duplicadas pelo nono dígito; refaz aviso do Instagram e renova token |
| `close-inactive-conversations-daily`, `fetch-analytics-daily` | 00h, 03h | auto-close de 30 dias; snapshot de analytics |
| `automation-executions-retencao` | 10 min | retenção de `automation_executions` |
| `purge-qr-message-log`, `purge-cron-history`, `aviso-de-mensagem-limpar` | 03h30, 04h15, 04h23 | retenção |
| `pipeline-heartbeat` | 01h, 09h, 17h | manda "Tudo OK"; se parar de chegar, o canal de alerta quebrou |

São 16 jobs (`select jobname from cron.job`). Os que chamam edge leem `project_url` e `service_role_key` do Vault.
Sem esses dois, os detectores (`check_message_failure_alerts`, `check_qr_service_health`, `send_pipeline_heartbeat`) e
a repetição de aviso (`aviso_de_mensagem_repetir`) só dão `WARNING`; os dispatchers falham com erro e dica. Já o
`qr-service-health` falha a cada minuto sem `qr_service_url`. O pg_net é assíncrono: o cron grava `succeeded` mesmo
quando a edge respondeu 401. O erro real fica em
`select status_code, content from net._http_response order by created desc`.

## Instalação auto-hospedada (Docker)

`git clone` + `./install.sh` sobe o Echo inteiro com Docker, sem conta, CLI ou projeto Supabase. Para quem usa, o texto
é `docs/self-hosting.md`; aqui está o que quem mexe no código precisa respeitar. O código é o mesmo dos dois caminhos
(Docker e projeto Supabase): o que muda é configuração (`ECHO_PUBLIC_URL`, `/config.js`, segredos do Vault) e, no
Docker, o runtime das funções e o gateway que vivem em `docker/`. **Sem `ECHO_PUBLIC_URL`, sem `/config.js` preenchido
e sem `ECHO_SETUP_TOKEN`, o comportamento é o do caminho Supabase** (pública = `SUPABASE_URL`; front pelas `VITE_*`;
`/setup` desligado): não quebre isso.

- **Serviços** (`docker-compose.yml`, dez, sem `container_name` e sem bind mount): `db` (imagem própria sobre a
  `supabase/postgres`), `db-init` e `migrate` (one-shot, a mesma imagem do `db`), `auth` (GoTrue), `storage`,
  `realtime`, `rest` (PostgREST), `functions` (runtime Deno), `qr` (`qr-service/`) e `gateway` (Caddy: front + uma
  origem para todas as APIs). Só o gateway publica porta. Ordem: `db` → `db-init` → `auth`/`storage`/`realtime` →
  `migrate` → `rest` → `gateway` → `qr`; `functions` sobe em paralelo. Script, migração, Caddyfile e front vão
  **dentro das imagens**: bind mount sem `+x` derruba o banco e o SELinux recusa bind sem rótulo.
- **`.env` e variáveis.** O `.env` é gerado por `docker/tools/gen-keys.mjs` (sem dependências, roda também num
  `node:alpine`) e é a chave-raiz do Vault: nunca vai a log, issue ou commit. Variável nova do stack entra no
  `.env.example`, no serviço do compose que a lê, no `gen-keys.mjs` se for gerada e na tabela de
  `docs/self-hosting.md`; `scripts/env-paridade.test.mjs` falha se `.env.example` e compose divergirem. Mudou o `.env`:
  `./echo up` (o `restart` não relê o arquivo). `COMPOSE_FILE` do `.env` lista os arquivos do compose
  (`docker/compose/dominio.yml`, `docker/compose/proxy-rede.yml`, `docker-compose.override.yml` do usuário); um
  `docker compose` solto roda de dentro da pasta do repositório, o `./echo` roda de qualquer lugar.
- **Guarda de segredos.** O `db` recusa subir com segredo vazio, de exemplo, só de zeros ou no formato errado
  (`docker/db/preflight.sh`); o gateway confere as chaves. Por isso `cp .env.example .env` não sobe.
- **Regra de URL interna × pública (uma só).** Servidor chama API pela base **interna** (`SUPABASE_URL`, no Docker
  `http://gateway:8000`); URL que **sai do servidor** (gravada no banco, mandada ao navegador, a webhook, à Meta, em
  e-mail) usa `ECHO_PUBLIC_URL`. O anexo do nosso Storage é traduzido para a interna antes do fetch e dispensa a guarda
  SSRF; só `object/public/attachments/` conta como "anexo nosso" (URL assinada, `sign/`, é externa). URL escolhida por
  tenant ou usuário passa por `fetchExterno`/`fetchMidia` (`_shared/url-guard.ts`); `ECHO_OUTBOUND_ALLOW_HOSTS` é a
  exceção por host exato. Os helpers vêm em trio e mudam juntos, com as tabelas de teste:
  `supabase/functions/_shared/url-publica.ts` (`urlPublicaDoAnexo`, `paraUrlInterna`, `caminhoDoAnexoNosso`),
  `qr-service/src/lib/publicUrl.ts` e `src/lib/runtimeConfig.ts`. `ECHO_IMAGE_TRANSFORM=false` (sem imgproxy) desliga o
  pedido de miniatura do thumbhash.
- **Gateway** (`docker/gateway/`). Dois listeners: o público (`:80`, `:443` no modo domínio) e o interno (`:8000`), que
  nunca é publicado e fica preso ao IP do gateway na rede do compose (`ECHO_BIND_INTERNO`; com mais de uma rede, o
  apelido `ECHO_ALIAS_REDE_INTERNA`). O interno não tem limite de login nem bloqueios, e o log dele filtra `apikey` e
  `x-qr-secret` e mascara `token` na query; o mesmo filtro vale para os erros de proxy (logger default, snippet
  `(filtro_log)` declarado antes do bloco global). O `/storage/v1/*` público tem CSP próprio (`sandbox`, sem script) e
  `nosniff`: um PDF aberto pela URL crua na aba não renderiza, e o botão Baixar não é afetado. Os upstreams são
  `<serviço>.${ECHO_REDE_INTERNA}` (o nome curto resolveria para vizinho na rede do proxy; a qualificação só evita colisão acidental: apelido literal `<serviço>.<rede>` de container hostil na rede do proxy ainda captura o tráfego (medido), a conferência de sub-rede do entrypoint só vale na subida e a rede do proxy tem de ser de confiança); quem monta o próprio Compose
  define `ECHO_REDE_INTERNA` além de `ECHO_ALIAS_REDE_INTERNA`. O público bloqueia `/auth/v1/admin/*`, todo subcaminho de
  `/functions/v1/whatsapp-webhook` (a rota `/qr-*` é interna e o webhook roteia procurando `/qr-` no caminho) e
  `/qr/health`. O limite de login por IP usa o cabeçalho `X-Echo-Client-IP` que o gateway preenche; `X-Forwarded-For` só
  vale com `ECHO_BEHIND_PROXY=true` e de IP privado. O `/config.js` é escrito pelo entrypoint ao subir
  (`window.__ECHO_CONFIG__`); `features.email` só é `true` quando o envio funciona de verdade, a mesma regra de
  `_shared/email.ts` (`lerConfigEmail`) e do `./echo doctor`.
- **A CSP vive em dois lugares**: `vercel.json` (host estático) e `docker/gateway/Caddyfile`. O hash sha256 do script
  inline de tema do `index.html` tem de bater nos dois; `themePresets.test.ts` confere os dois. Mexeu nesse
  script ou na política: mude os dois (o do Caddy tem duas exceções ao `vercel.json`, ambas só com URL pública `http://`: `ECHO_CSP_WS` libera `ws://<host>` no
  `connect-src` e `ECHO_CSP_HTTP` libera `http://<host>` em `img-src`, `media-src` e `connect-src`).
- **Config do front em tempo de execução** (`src/lib/runtimeConfig.ts`): precedência por campo `/config.js`, depois
  `VITE_*`, depois a origem da página; um build serve qualquer instalação e `npm run build` não depende de nenhuma
  `VITE_*`. `VITE_QR_SERVICE_URL` vazia vale `<origem>/qr`. Link de convite usa `siteUrl()`; URL de função mostrada ao
  admin e na documentação usa `publicFunctionUrl()`, que só vira o `siteUrl` quando ele foi definido explicitamente (o
  `/config.js` do Docker sempre define), senão cai na base do Supabase.
- **Migrações e Vault** (`docker/migrate/migrate.sh`). O `migrate` cria os quatro segredos do Vault **antes** das
  migrações (cron nenhum acha o Vault vazio), aplica cada arquivo novo na sua transação, grava em
  `echo_meta.schema_migrations` (versão, nome, sha256, hora), cria os segredos de novo e recarrega o cache do PostgREST.
  Arquivo já aplicado com checksum diferente trava a subida (`rest` e `gateway` não sobem): migração aplicada não se
  edita. As migrações vêm da imagem do `db`, não do disco: depois de adicionar uma, reconstrua (`./echo upgrade` ou
  `docker compose build db`). Um `git pull` sozinho não atualiza nada. Os jobs do pg_cron vêm com a migração `…000300`
  (16 jobs); o `project_url` do Vault no Docker é `http://gateway:8000`.
- **Funções em processo único** (`docker/functions/`). As 46 funções rodam num só processo Deno (`router.ts` troca o
  `Deno.serve` por um registrador antes de cada import e despacha por `/functions/v1/<nome>`): a CPU de uma atrasa as
  outras, a memória é comum e não há isolamento de módulo, `globalThis` ou ambiente. Por isso `tests/processo-unico/`
  (parte do `npm run test:edge`) reprova, em `supabase/functions/**`: `let`/`var` de topo; `const X = new Map|Set|Array(…)`,
  `[]` ou `{}` de topo que o arquivo muta; chamada de configuração global de biblioteca no topo do módulo
  (`setVapidDetails` e afins); escrita em `globalThis`; `Deno.env.set/delete`; `import(…)` com argumento que não é
  literal (o `deno cache` do build não o segue e o runtime roda com `--cached-only`). Escape único: comentário
  `// processo-unico: <motivo>` na linha anterior (cache que não depende de organização nem de usuário); cada escape
  novo vai para a revisão. O `JWT_SECRET` é apagado do ambiente antes de a primeira função carregar. `verify_jwt` de
  cada função vem do `supabase/config.toml` (função fora do mapa exige JWT); `check:verify-jwt` confere. O `/_health`
  só responde ao loopback do próprio container (503 se alguma função falhou na carga).
- **Lock do runtime e mapa de imports.** No stack Docker as dependências das funções vêm do registro npm, com
  `docker/functions/deno.lock` versionado e congelado (`deno cache --frozen` no build; o tarball do npm é imutável, o
  módulo do esm.sh já mudou de bytes na mesma URL versionada e quebrou o build no CI). Os fontes continuam importando do
  esm.sh (é o que o caminho Supabase Cloud/CLI usa) e o `imports` de `docker/functions/deno.json` redireciona cada
  `https://esm.sh/<pacote>@<versão>` para `npm:<pacote>@<versão>` só neste runtime. Dependência nova das funções entra
  nesse mapa e regenera o lock (`docker/functions/tests/mapa-imports.test.ts`, no `test:router`, reprova import
  `https://` fora do mapa, qualquer módulo remoto no lock e `npm:` do mapa que não tenha a versão exata da URL do esm.sh):
  `deno cache --frozen=false --config docker/functions/deno.json docker/functions/main.ts supabase/functions/*/index.ts docker/functions/echo-admin.ts`.
  Commite o lock. A peer opcional `zod` de `npm:@anthropic-ai/sdk@0.110.0` (`^3.25.0 || ^4.0.0`) resolve no lock para
  `zod@3.23.8`, fora do intervalo: hoje não pesa, porque só os helpers `@anthropic-ai/sdk/helpers/zod` importam `zod/v4` e
  nenhuma função os usa. Usá-los exige subir o `zod` nos dois caminhos (fontes e mapa) antes.
- **`echo-admin`** (`docker/functions/echo-admin`, `echo-admin.ts`) é a CLI de administração dentro da imagem
  `functions`, usada pelo `./echo` (`reset-password`, `recovery-link`, `setup-link`): o host não precisa de Node.
- **Primeiro acesso.** A tela `/setup` chama a edge `primeiro-acesso` (`verify_jwt = false`; protegida por
  `ECHO_SETUP_TOKEN` e pela RPC `instalacao_concluir_setup`, só `service_role`, com trava consultiva; a instalação já
  configurada dá `PT409`). Fecha sozinha quando existe organização ou super admin: instalação com organização e sem super
  admin fica fechada para o `/setup` e se conserta por SQL (`./echo psql`) ou `bootstrap-admin.mjs`. O nome da
  organização conta pontos de código (como o `length()` do Postgres) no Zod da edge, no do front e na RPC (22023 vira
  400 `payload_invalido`). `get_decrypted_ai_key` é só `service_role`: a tela lê só o boolean (`get_org_ai_config`).
  O `send-invitation` não recupera mais conta órfã (usuário no Auth sem `profiles`).
- **E-mail é opcional**: SMTP (`SMTP_*`, nodemailer), Resend ou nada, sempre por `_shared/email.ts`. Sem transporte a
  função responde 200 com `email: "nao_configurado"`, nunca 5xx.
- **Serviço de QR no stack.** A imagem roda como o usuário `node` (uid 1000): volume de sessões criado por imagem
  antiga (root) precisa do `chown` descrito no `CHANGELOG.md`. O SSE do QR (`/qr/session/qr/<id>`) manda `: conectado` e
  `: ping` a cada 25 s e exige proxy sem buffer. Nenhuma medição abre sessão de WhatsApp.
- **O que não é fronteira de segurança**: o papel `zapo` do banco (o qr já tem a service role), as funções entre si
  (processo único), a rede do compose (qualquer container nela alcança o `:8000`, o banco e os outros serviços) e o
  loopback do `db`, que é `trust` (teste de senha só por rede). O `gateway` roda como root dentro do container.
- **Fumaça e testes de infra.** `npm run smoke:selfhost` (156 checagens) é a prova de que o `./install.sh` funciona:
  rode quando mexer em `docker/`, `install.sh`, `echo`, `supabase/` ou num Dockerfile. `npm run test:infra` roda sem
  subir o stack. Para testar o instalador sem tocar na sua instalação, use outro nome e porta
  (`COMPOSE_PROJECT_NAME=echo-dev ./install.sh --port 8099` numa cópia do repositório) e `down -v` no fim. Nunca rode
  `docker system prune` nem `volume prune` numa máquina com outros projetos.
- **Sem imagem publicada.** As quatro imagens do Echo (`db`, `functions`, `qr`, `gateway`) são construídas na máquina de
  quem instala; nenhum workflow publica imagem, faz deploy ou usa segredo.

## Regras do projeto (engenharia)

- **Toda feature vale para todas as linhas.** Nada de `if` por id de linha, organização ou número decidindo o que
  aparece. Gate só por dado genérico (integração ligada, backend dizendo "indisponível"). Esconder algo numa linha vira
  configuração disponível para todas, visível em Configurações.
- **Nada de tabela só para uma feature.** Antes de um `CREATE TABLE`, achar onde o dado já mora: coluna em
  `conversations`/`messages`, ou `metadata` jsonb com índice parcial (predicado `(expr) IS NOT NULL`, não
  `metadata ? 'chave'`; conferir com `EXPLAIN`). Se ainda precisar de tabela, justificar no cabeçalho da migração
  (ex.: segredo que o front não pode ler, como o token em `instagram_connections`).
- **Não pendurar feature num pipeline compartilhado** se ela precisar de exceção lá dentro (`if event_type…` na fila
  de outro, nos gatilhos). O estado vai na entidade que a feature já tem (a mensagem, a conversa).
- **Nada de função duplicada.** Antes de criar RPC ou helper, procurar: `user_is_org_admin()`,
  `auth_is_super_admin()`, `user_can_access_conversation()`, `user_has_phone_access()`, `get_my_org_role()`,
  `_shared/authz.ts`, `_shared/canal.ts`, `src/lib/`. Regra que existe no SQL e no TS ao mesmo tempo (ex.:
  `instagram_linha_pode_hospedar` ↔ `linhaPodeHospedar`) diz no comentário qual é o par e muda nos dois.
- **Credencial de integração por tenant** vai em tabela de config por escopo, com RLS só admin, nunca em secret global
  de função. O front recebe só um boolean via RPC `SECURITY DEFINER`.
- **Notificação precisa funcionar com a aba fora de foco** (som, título, favicon, Web Push), não só como toast.
- **Filtro novo** entra como seção dentro do controle de filtro existente, não como botão novo na toolbar.
- **Auto-close:** regra única de 30 dias sem atividade real, para qualquer `source`, só em conversa `active`. Conversa
  com tag nunca fecha sozinha.
- **Mensagens de grupo** só existem na conversa da linha que estava conectada. O espelhamento entre linhas irmãs não
  tem cron nem trigger, de propósito: depois de queda longa, `scripts/backfill-mirrored-group-messages.mjs --dry-run`.
- **Pix:** o card é só para o Pix nativo (`metadata.pix_code`); chave colada em texto continua texto. O parser
  (`src/lib/pixPayload.ts`) não pode remover espaços (só `\r\n`), senão o CRC quebra.
- **Ordem de deploy:** primeiro o lado que aceita o formato antigo e o novo (ex.: serviço de QR → edge → front).

## Banco (Supabase/Postgres)

**Migrações.** `supabase/migrations/` começa com cinco arquivos: `…000000_baseline.sql` (esquema `public`),
`…000100_auth_e_storage.sql` (trigger em `auth.users`, bucket e policies), `…000200_dados_de_referencia.sql`,
`…000300_cron.sql` e `20260102000000_primeiro_acesso.sql` (RPCs do `/setup`). Não edite esses arquivos: mudança de
esquema entra em migração nova (`npx supabase migration new <nome>`), aplicada do zero com `npx supabase db reset` no
stack local, seguida de `npm run gen:types:local`. No Docker o `migrate` aplica os arquivos da imagem do `db` e trava a
subida se o checksum de um já aplicado mudou (ver "Instalação auto-hospedada"). Projeto Supabase que já tem o baseline
aplicado e nunca usou a CLI precisa de `npx supabase migration repair <os 4 primeiros> --status applied` antes do
`db push`; com `--db-url '…?sslmode=disable'` a CLI 2.84.4 só aceita o parâmetro junto de `--debug`.
- Antes de `CREATE OR REPLACE` de função que já existe, partir da definição viva (`pg_get_functiondef`) ou da migração
  mais nova que a define. Reescrever a partir de uma versão antiga desfaz o que veio depois.
- `run-sql.mjs` divide o arquivo por marcadores `-- @@ Título` (a Management API só devolve o último statement). O
  `--dry-run` liga o GUC `echo.migrate_dry_run`, que um bloco `DO $$` lê com
  `current_setting('echo.migrate_dry_run', true)` para terminar em `RAISE EXCEPTION` e reverter. `--raw` é obrigatório
  para `CREATE INDEX CONCURRENTLY`, que não roda em transação. Índice em `messages` é sempre `CONCURRENTLY`, e a
  consulta que o usa é conferida com `EXPLAIN`.
- Não há transação entre requests da Management API: migração de dados atômica vai num bloco `DO $$…$$`.
  `BEGIN; …; ROLLBACK;` numa request só valida de verdade.
- `cron.job` não aceita UPDATE direto: use `cron.alter_job(jobid, active := false)`.

**Vault.** O SQL lê segredos por `public._segredo_obrigatorio(nome)`, sem fallback: `project_url`,
`service_role_key`, `qr_service_url`, `ai_key_secret`. Faltando, dá erro 55000 com a dica
`select vault.create_secret('<valor>', '<nome>')`. `service_role_key` tem de ser o JWT legado de service_role
(`eyJ…`): chave `sb_secret_` faz as edges chamadas pelo cron responderem 401. Trocar `ai_key_secret` depois torna
ilegíveis as chaves de IA já salvas.

**Tipos.** Só pelo `gen-types.mjs`: o `supabase gen types --linked` já descartou tabelas e saiu 0. O script só grava
se `conversation_assignees` e `automation_executions` estiverem no resultado; leia o diff antes de commitar.

**Grants e RLS.**
- Tabela nova em `public` nasce sem RLS e com `ALL` para `anon`/`authenticated` (backup e rascunho também; o prefixo
  `_` não esconde nada do PostgREST). No mesmo statement: `enable row level security` +
  `revoke all … from anon, authenticated`.
- Função nova em `public` nasce com EXECUTE para `anon`, e `REVOKE … FROM PUBLIC` não tira. Para `SECURITY DEFINER`
  ou tenant por parâmetro: `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role;` e conferir
  o `proacl`.
- Exceção obrigatória: função usada por policy de tabela na publication `supabase_realtime` (`messages`,
  `conversations`, `conversation_assignees`, `conversation_tags`, `message_reactions`, `message_receipts`,
  `scheduled_messages`, `system_alerts`) precisa de EXECUTE para `supabase_realtime_admin`, `authenticated` e `anon`.
  Sem isso o Realtime dá 42501 e morre em silêncio, com o canal ainda SUBSCRIBED. REST funcionando não prova nada.
- Em policy e WHERE, predicado de usuário vai como `(SELECT fn())` / `(SELECT auth.uid())`, que vira InitPlan. Chamada
  direta roda uma vez por linha, e CTE de 1 linha não protege. Com array: `x = ANY ((SELECT fn())::uuid[])`.
- Em subselect em `phone_numbers`, qualificar a coluna externa: `phone_numbers.id` é uuid e
  `phone_numbers.phone_number_id` é o id da Meta (text).
- PL/pgSQL com OUT param homônimo de coluna usada em `ON CONFLICT` precisa de `#variable_conflict use_column` (42702).
- `organizations` tem grant por coluna para `authenticated`: SELECT sem `whatsapp_access_token`,
  `whatsapp_verify_token`, `ai_api_key` e `ai_api_key_encrypted`. O front sabe se o segredo existe só pelas RPCs
  `get_org_whatsapp_config` (`tem_token`) e `get_org_ai_config` (`tem_chave`); a chave de IA se grava por
  `set_ai_api_key` e as edges a leem por `get_decrypted_ai_key` com service role. `select('*')` em `organizations` dá 42501, e coluna nova legível exige `GRANT SELECT (<coluna>)`.
- O bucket `attachments` aceita INSERT de `authenticated` só nos prefixos `outbound/<uid>`, `stickers/<uid>`,
  `template-headers`, `template-samples`, `broadcast-headers` e `automation`. Prefixo novo exige policy antes do front.

**Esquema e invariantes.**
- `messages.message_type` é um CHECK com lista fixa (`contact` no singular). Tipo novo exige migração drop+add **e**
  o `VALID_MESSAGE_TYPES` do `whatsapp-webhook`; senão dá 23514 e a mensagem some.
- Busca por wamid sempre filtra `conversation_id` (ou a linha). Duas linhas conectadas conversando entre si gravam o
  mesmo wamid em duas conversas, e o `.maybeSingle()` falha em silêncio.
- `conversations.closed_at/close_reason/closed_by` são do trigger `trg_conversation_close_lifecycle`; nenhum writer
  mexe neles. `last_message_*` só avançam, e mensagem `is_imported` não reabre conversa encerrada.
- `messages.created_at` é a hora de chegada, de propósito: o não-lido compara com `last_read_at`. A hora real do envio
  fica em `metadata.sent_at` (+ `delivered_late`), e é o que a janela de 24h usa (`src/lib/deliveryTiming.ts`). A Meta
  reentrega por dias o webhook recusado.
- `sent_by` NULL pode ser inbound, automação ou eco do aparelho: não use sozinho como sinal de um deles.
- `metadata.contact` tem os campos singulares + `contacts[]` opcional. O fallback `contacts ?? [singular]` é permanente.
- `metadata.media` = `{width,height,seconds?,source?}` em pixels de exibição. Ler só por `parseMediaDimensions`
  (`src/lib/mediaBox.ts`) / `MediaDimensionsSchema` (`_shared/media-probe.ts`, o par). Writer só faz merge.
- O bucket `attachments` aceita qualquer mime (`allowed_mime_types = NULL`): cada tipo recusado era arquivo perdido.
  O limite é o `file_size_limit` (1 GiB, também em `[storage]` do `config.toml`). Upload com chave `sb_secret_` exige o
  header `apikey` além do `Authorization`.

**PostgREST.**
- Toda resposta para em 1000 linhas (`max_rows`) e `.limit()` maior é ignorado: paginar com `.range()`.
- URL acima de ~30 KB dá 400: nada de `.in()` com centenas de wamids (lotes de até 150, upsert ou RPC).
- Vírgula e parênteses do input do usuário são sintaxe dentro de `.or()`: sanitizar.
- UPDATE que não casa nenhuma linha não dá erro: usar `.select('id')` e conferir. UPDATE em lote sob RLS org-wide
  atinge a org inteira: escopar por ids.

**Telefone BR.**
- `extract_br_phone_parts` assume o nono dígito sem conferir. Quem gera variantes precisa da guarda
  `substring(digits,5,1) = '9'` e não pode expandir número de outro país. Manter paridade com `getLookupVariations`
  (`src/lib/phone.ts`).
- `merge_duplicate_conversations` reescreve `contact_phone` para a forma com o 9. Igualdade exata de telefone é
  bomba-relógio.
- O grupo pode conhecer o número sem o 9. Variantes servem só como chave de busca; use o JID que o grupo devolveu.
- Conversa com LID cru no lugar do telefone: `contact_phone ~ '^\d{13,}$' AND contact_phone !~ '^55\d{11}$'`.
  Sanear com `scripts/resolve-lid-conversations.mjs`.

## Edge functions

- `verify_jwt` de cada função está declarado em `supabase/config.toml`: função nova se declara lá. `verify_jwt = false`
  só para quem não recebe JWT de usuário (Meta, serviço de QR, cron) e faz a própria autenticação no handler.
- A identidade sai sempre do JWT verificado (`_shared/authz.ts`: `requireUser`, `requireServiceRole`,
  `requirePhoneAccess`, `requireOrgRole`), nunca do corpo da requisição.
- Função servidor-a-servidor (chamada por cron, pelo serviço de QR ou por outra edge) passa por `checkInternalCaller`
  e só aceita a service role key ou uma chave `sb_secret_` conhecida. O padrão é recusar (401); só
  `EDGE_INTERNAL_AUTH_ENFORCE=0` troca para modo log, e isso é escape de migração, não configuração.
- Função nova que envia pelo WhatsApp (ou age numa conversa) recusa conversa do Direct: `recusarSeDirect` com o
  `conversation_id`, ou `channel` no `select` + guarda. Telefone `ig:<id>` nunca é telefone.
- `phone_number_id` na entrada aceita o UUID interno ou o id da Meta: só consulte a coluna `id` com UUID (senão 22P02).
- O `whatsapp-webhook` falha alto: erro permanente vira linha `unsupported` com `metadata.degraded_reason`; transiente
  devolve 503 (o serviço de QR retenta) ou 500 (a Meta reentrega). Falha de escrita grava `qr_message_log` com
  `success=false` e payload replayável (`_shared/failure-log.ts`; `scripts/replay-write-failures.mjs --dry-run`).
- Guarda de segurança nova entra **depois** do gate da feature flag, e passar a exigir credencial pede rampa: conferir e
  logar antes de recusar. A assinatura da Meta segue esse modelo: `WHATSAPP_APP_SECRET` (lista com vírgula) confere e
  loga; só recusa com segredo cadastrado **e** `WHATSAPP_APP_SECRET_ENFORCE=true`.
- E-mail das edges passa por `_shared/email.ts`: `SMTP_HOST` (com remetente `EMAIL_FROM` ou `SMTP_ADMIN_EMAIL`) usa
  SMTP; senão `RESEND_API_KEY` + `EMAIL_FROM` usa o Resend; senão a função não envia, responde 200 com
  `email: "nao_configurado"` e diz o motivo (no log ou na resposta). `SITE_URL` é obrigatória, sem padrão. Variável
  SMTP inválida (`SMTP_SECURE`, `SMTP_PORT`) é `email: "falhou"`, erro do operador.
- URL escolhida por organização ou usuário (webhook, nó de automação, preview de link, `media_url` da API, amostra de
  cabeçalho de template) passa por `fetchExterno`/`fetchMidia`; `fetch` cru nos pontos conhecidos
  reprova no `tests/url-guard/uso-da-guarda.test.ts`: ponto novo entra naquela lista.
- `automation-execute`: `message_received` casa sempre e ignora `keywords`. `keyword` casa com `includes()` (default
  `contains` no runtime) e roda **todos** os fluxos que casam; a UI cria gatilho `exact` e avisa colisão
  (`src/lib/automationKeywordCollisions.ts`). Rodar em grupo é opt-in por fluxo (`run_in_groups`); em grupo QR o
  `contactPhone` é o JID do grupo.
- Limite de mídia: `MAX_MEDIA_BYTES` (50 MB por padrão) existe na edge `whatsapp-send-media` e no serviço de QR. Suba os
  dois juntos.
- No front, erro de edge se lê com `checkEdgeFunctionResponseAsync` (`src/lib/utils.ts`), que abre o `error.context`.

## Front (convenções)

- Import com `@/` (= `src/`). Antes de criar primitivo, olhar `src/components/ui` além do shadcn:
  `responsive-dialog`, `confirm-destructive-dialog`, `swipeable-row`, `pull-to-refresh`, `id-copy-button`.
- Movimento: springs em `src/lib/motion.ts`; easings `out-strong`, `in-out-strong` e `drawer` no Tailwind;
  `MotionConfig` com `reducedMotion` na raiz (`src/App.tsx`).
- Erro para o usuário: `toUserMessage(error, fallbackComPróximoPasso)` (`src/lib/userFacingError.ts`). Título
  "Não foi possível <ação>". Nunca `description: error.message`.
- Troca de ícone por estado usa `<IconSwap>` (`src/components/ui/icon-swap.tsx`), não ternário de ícones.
- Botão tem um press só, `active:scale-[0.96]`. `future.hoverOnlyWhenSupported` está ligado: não escrever
  `[@media(hover:hover)]:`.
- Hover: linha de lista mantém `transition-colors duration-150 ease-out`; item de menu ou command fica instantâneo.
- Pulso de alerta anima `background-color`, nunca `opacity` do elemento, e para em `:not([data-state="active"])`
  (classes `tab-pulse-*` em `src/index.css`). Nada de `animate-pulse` em elemento colorido com texto. Keyframe novo em
  `tailwind.config.ts` exige reiniciar o dev server.
- Copy: `text-2xs` só em badge, frase em `text-xs`, sentence case. Glossário: atendente, tag, número, figurinha,
  cabeçalho, gatilho, fluxo, disparo, template.
- Tema: presets em `src/index.css` (`[data-app-theme]`); os escuros (midnight, dracula, nord, breu) ganham `.dark`.
  - Mudou o `--background` de um preset? Atualize o mapa duplicado do script anti-flash do `index.html`.
  - Qualquer edição nesse script exige recalcular o sha256 dele no `script-src` do `vercel.json`, senão a CSP o bloqueia.
  - Use tokens. `dark:` novo se testa nos presets escuros. Token que serve de fundo e de texto, no escuro, é cor clara +
    foreground escuro: valide o contraste nos dois sentidos. `--destructive`, `--success` e `--warning` ficam ≥4,5:1
    sobre o card e sobre o próprio fundo tingido (`bg-x/10–15 text-x`) em todos os presets.
- `tailwind-merge` não remove utilitário com modificador: nunca ponha variante (`max-md:`, `hover:`) na classe-base de
  um `cva` que os call sites sobrescrevem.
- Telefone digitado à mão usa `PhoneNumberInput` (`src/components/phone/`), que devolve E.164 em dígitos sem `+`. Nunca
  prefixe 55 pelo comprimento. Bandeira usa `CountryFlag` (subpath `string/3x2/<ISO>`; `react/3x2` arrasta todas).
- CSP do `vercel.json`: `connect-src` libera `https:` e `wss:`, `img-src` libera `https:`, `data:` e `blob:`, e
  `media-src` libera `https:` e `blob:`. O script inline do `index.html` entra pelo sha256 (ver "Tema" acima).
- Realtime:
  - Não ponha `navigate` nos deps de efeito que assina canal: ele muda a cada navegação e recria o canal (use ref).
  - `supabase.channel(nome)` deduplica por tópico e `removeChannel` é assíncrono: reassinar com nome fixo empilha
    bindings.
  - Não crie assinatura nova sem filtro em `messages` (cada linha custa uma checagem de RLS por assinante). O filtro só
    aceita `eq/neq/lt/lte/gt/gte/in`.
  - `GlobalNotificationListener.realtime.test.tsx` conta canais: o mock precisa devolver objeto estável.
- O gate de posse das notificações é **fail-closed** (sem usuário ou sem posse confirmada da conversa, não notifica),
  com retry no fetch da conversa: como a RLS é por linha, o INSERT chega a todos que veem a linha.
- Envio otimista: a linha real chega por três caminhos, em qualquer ordem (INSERT do realtime, `syncNewMessages` na
  reconexão, resposta do `invoke`). **Todos** passam por `src/lib/messageReconcile.ts` (`mergeIncomingMessage` /
  `settleOptimistic`), que casa por `whatsapp_message_id` e, no fallback por conteúdo, normaliza o `*Nome*\n\n` do
  `append_agent_name`. Caminho novo que anexa por `id` deixa uma bolha fantasma. Reenviar é `retryMessageId` no
  `whatsapp-send`, que atualiza a mesma linha. A faixa "Reconectando…" só aparece após `RECONNECT_GRACE_MS`.
- Coluna nova na lista de conversas exige migração aplicada antes do front: o `select` explícito dá 400 sem a coluna.
- Código assíncrono: token de geração conferido depois de cada `await`; desfazer por toast guarda o `dismiss` junto do
  DELETE pendente; exclusão adiada faz flush no `pagehide` (`src/lib/keepaliveDelete.ts`); atalho de salvar tem guarda
  de voo por ref; o TanStack v5 descarta callbacks de `mutate()` reusado (use `mutateAsync`).
- Radix: `Select` com `value=""` fica não controlado (use sentinela); Esc é capturado no document (use
  `onEscapeKeyDown`; cascata com `escapeInterceptorRef`); Checkbox/Radio/Switch dentro de linha clicável vira `<button>`
  aninhado (desenhe num `span aria-hidden` e ponha `role="checkbox"` na linha).
- Lista virtualizada (react-virtuoso): `aria-live` fora da lista; o container é o único tab stop; animação de entrada
  roda a cada mount (consuma com `onAnimationEnd` + chave estável).
- Custos do Analytics saem de `src/lib/analyticsCost.ts`, a fonte única (a RPC `get_advanced_analytics_stats` já
  filtra por `connection_type` e deixa de fora `metadata.canal='instagram'`).
- Mídia na conversa: a caixa é decidida na montagem (`resolveMediaBox` + `MediaFrame`) e travada por mensagem; `onLoad`
  só alimenta o cache. Limitador da roda em `src/lib/wheelScroll.ts` (`VITE_SCROLL_WHEEL_LIMITER=off` desliga). Nada de
  `will-change: scroll-position` nem `contain: paint` no scroller da conversa: o Chrome repinta a lista em loop.

## Serviço de QR (pasta `qr-service/`)

Regras completas, comandos e boot de fumaça em `qr-service/CLAUDE.md`; variáveis e rotas em
`qr-service/README.pt-BR.md`. O resumo abaixo é o que quem mexe no Echo precisa saber do serviço.

- Projeto npm próprio (`qr-service/package.json`, lockfile, `node_modules`, Dockerfiles e `docker-compose.yml`): rode
  `npm ci`, `npm run build` e `npm run -s test:all` dentro da pasta. Os testes dele usam `node --import tsx --test`,
  não Vitest. O `docker compose up -d --build` roda de dentro de `qr-service/` e exige `ZAPO_PG_PASSWORD` no
  `qr-service/.env` (definida antes do primeiro `up`: a senha fica gravada no volume `zapo_pg`).

- `GET /health` é público e diz `version`; `GET /session/health` (Bearer = service key) é a verdade sobre as sessões,
  com `protection_limits` e `reachout_locks`. `phone_numbers.qr_session_status` pode estar desatualizado.
- O diagnóstico é por `qr_message_log` (gravado por `SessionManager.debugLog`; action com prefixo `msg_drop_`,
  `handler_throw`, `msg_handler_throw`… vira `success=false`) e `session_connection_log`, lidos por SQL.
- O serviço é ESM: import relativo sem `.js` passa no `tsc` e nos testes (tsx) e derruba o container com
  `ERR_MODULE_NOT_FOUND`. Faça um boot de fumaça da imagem antes de publicar.
- No código: todo `.set()` de NodeCache passa por `cacheSet()`; listener leva try/catch por item; "já pareou?" se
  responde com `creds.me?.id`, nunca `creds.registered`; no `ZapoClient`, método sem implementação **lança** e sai do
  set de capabilities (nunca devolver `[]`/`null` em silêncio).
- Proteções por env: `NEW_CONTACT_HOURLY_CAP` (20), `QR_HOURLY_CAP` (5), `CONNECT_COOLDOWN_AFTER_FATAL_MS`,
  `SEND_MIN_GAP_MS`/`SEND_MAX_GAP_MS` (0 = desligado), `MAX_MEDIA_BYTES`. Um QR por `POST /session/connect`:
  `qr_expired` não reconecta. O ack 463 arma bloqueio local de contato frio.
- Ban e restrição vêm de comportamento: churn de pareamento (cada QR é um dispositivo novo), prospecção fria e volume
  para desconhecidos. Upgrade de lib não resolve. 403 = conta suspensa: não re-parear em loop. Adicionar participante
  em grupo pode derrubar a sessão com `401 <conflict>`; a alternativa é convite (`invite-code` + `join`).

## Diagnóstico: por onde começar

- **Queda de linha QR:** `/ops`, depois `session_connection_log`, depois `/session/health`. No log: 401 = deslogado,
  440 = sessão substituída, 515 = restart, 403 = suspensão.
- **Mensagem sumida (QR):** o wamid está em `messages`? Depois `qr_message_log` (`msg_drop_*`, `msg_skip_*`,
  `msg_handler_throw`, `media_download_failed`). Depois `/health`: `outbox_disk` sem cair e `outbox_oldest_disk_age_s`
  subindo = fila represada. `webhook_dead` zerado não prova saúde.
- **Todas as linhas da Cloud API param de receber ao mesmo tempo (saída normal):** webhook ou assinatura da Meta.
- **Cron "succeeded" e nada acontece:** `net._http_response` (401 = `service_role_key` errada no Vault) e
  `cron.job_run_details` com `status <> 'succeeded'`. Todos os jobs com "job startup timeout" no mesmo minuto =
  saturação puxada pelo Realtime (walrus × RLS).
- **Realtime mudo (typing funciona, mensagem não):** função de RLS sem EXECUTE (42501 nos logs do Realtime).
- **Mídia sem arquivo:** upload recusado pelo Storage (action `media_degraded` em `qr_message_log`, motivo
  `upload_failed`) ou acima de `MAX_MEDIA_BYTES` (`media_url`, `filename` e `mime` todos NULL).
- **Bolha "[Mensagem não suportada]":** `metadata IS NULL` = stanza só de protocolo; `metadata->>'original_type'`
  preenchido = tipo real ainda não mapeado; `unsupported` com wamid `wamid.%` veio da Cloud API e é mensagem real.
- **Recuperar período offline:** a fila offline (`messages.upsert` do tipo `append`) recupera na reconexão;
  `fetchMessageHistory` só puxa para trás de uma âncora, então conversa sem mensagem depois do buraco não volta.
- **Protocolo sem documentação:** medir antes de teorizar; o inbound do cliente oficial é o gabarito.

## Pendências conhecidas

- Voto de enquete dado pelo painel não conta no aparelho. Instrumentação: `poll_vote_out` / `poll_update_in`.
- O `GlobalNotificationListener` tem binding de UPDATE sem filtro em `messages` (reação e falha). Resolver pede decisão
  de arquitetura (reação por broadcast ou coluna separada).
- Propriedades de desenho que o operador precisa conhecer (detalhe em `SECURITY.md`): a mídia do bucket
  `attachments` é pública por URL não adivinhável; o isolamento entre organizações depende da RLS e das checagens dentro
  das funções `SECURITY DEFINER`, não de grants mínimos. Revise grants e policies antes de expor a instalação e a cada
  tabela ou função nova (regras em "Grants e RLS").
- `check_qr_service_health` e `process_survey_timeouts` chamam a cada minuto sem atalho para "nada a fazer".
- O fuso `America/Sao_Paulo` é fixo nas funções de analytics e no heartbeat.
