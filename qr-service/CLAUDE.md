# CLAUDE.md

Guia para agentes (Claude Code e afins) que mexem na pasta `qr-service/` do repositório do Echo. As
regras do resto do repositório (front, edge functions, banco) estão no `../CLAUDE.md`. Código,
comentários e mensagens de log ficam em pt-BR; o README do serviço tem versão em inglês e em português.

A pasta é um projeto npm independente: `package.json`, `package-lock.json`, `node_modules`, `Dockerfile`,
`Dockerfile.voip` e `docker-compose.yml` próprios. A raiz não é workspace: o `npm ci` e o `npm test` da
raiz não tocam aqui, e o ESLint da raiz ignora a pasta. Rode tudo de dentro de `qr-service/`.

## O que é

Serviço Node 22 / Express / TypeScript (ESM) que conecta números de WhatsApp por QR ou código de
pareamento e atende o Echo: entrega cada evento à edge `whatsapp-webhook` (rotas `/qr-*`, header
`x-qr-secret`) e expõe a API HTTP que o front e as edges do Echo chamam. Detalhes de instalação,
variáveis e rotas: `README.pt-BR.md`. `QR_WEBHOOK_SECRET` é obrigatória e igual à da edge, e
`SUPABASE_SERVICE_KEY` é o JWT legado de service_role, o mesmo que as edges mandam como Bearer.

## URL pública × interna (`ECHO_PUBLIC_URL`)

No Docker o serviço fala com o stack por `SUPABASE_URL=http://gateway:8000` (interna, o navegador não a
abre). `ECHO_PUBLIC_URL` é o endereço que o navegador abre; sem ela a pública é a `SUPABASE_URL` e nada
muda (Supabase hospedado ou local). Tudo passa por `src/lib/publicUrl.ts`, par de
`supabase/functions/_shared/url-publica.ts` (mesmos seis nomes, mesmo comportamento: mudou aqui, muda lá):

- URL que SAI do serviço (`media_url` e avatar gravados no banco, cache de figurinha) = `urlPublicaDoAnexo()`.
  Nunca `supabase.storage…getPublicUrl()`, que usa a `SUPABASE_URL` interna e grava um endereço que o
  navegador não abre.
- Chamada do serviço ao stack (TUS, HEAD do cache de figurinha) = base interna (`baseInterna()`,
  `paraUrlInterna()`).
- `media_url` recebida em `send-media`, `send-voice`, `picture` e `sticker/convert`: `fetchMediaUrl()`
  (`src/lib/url-guard.ts`). Anexo do NOSSO Storage (pública ou interna) é baixado pela URL interna, sem a
  guarda SSRF e sem seguir redirecionamento; qualquer outra URL passa por `assertPublicHttpUrl`, com
  redirecionamento seguido à mão (no máximo 3 saltos, cada destino passa pela guarda; 30x sem `Location`, ciclo
  ou salto demais é recusado). DNS rebinding segue fora do alcance (a guarda resolve o nome uma vez). Rota nova
  que baixa URL do chamador usa `fetchMediaUrl`, nunca `fetch` direto.
- O upload TUS reescreve um `Location` de outra origem para a do `endpoint` (`alinharLocation`): o
  storage-api devolve o endereço que viu. No stack do compose `STORAGE_PUBLIC_URL` não é definida.
- Valor inválido de `ECHO_PUBLIC_URL` derruba o boot (`index.ts`).

## Imagem Docker

`Dockerfile` roda como o usuário `node` (não root) e tem `HEALTHCHECK` em `/health`. O diretório de sessões
nasce do `node`: volume novo herda o dono; volume antigo, criado como root, precisa de um `chown -R 1000:1000`
único (README, "Session persistence"). Base `node:22.22.3-alpine3.24`, a mesma do front e do gateway no
compose da raiz.

## Arquitetura

Rotas (`src/routes/*.ts`) → `SessionManager` (`src/services/SessionManager.ts`) → adapter
`WhatsAppClient` (`src/adapter/`).

- **Rotas:** validam a entrada e chamam o `SessionManager`. A autenticação está em
  `src/middleware/auth.ts`: `requireAuth` (chave de serviço ou JWT de usuário do Supabase) em todos os
  routers e `requirePhoneAccess` via `router.param('phoneNumberId', …)`. Rota nova com o id no corpo
  precisa pôr o `requirePhoneAccess` explicitamente (como o `POST /session/connect`).
- **SessionManager:** concentra a regra de negócio: ciclo das sessões, outbox de webhooks
  (`src/lib/webhookOutbox.ts`), mídia (memória, disco, TUS), resolução de LID, proteções contra
  banimento, fila de fotos de perfil, ligações.
- **Adapter:** cada biblioteca é um provider em `src/adapter/<provider>/` (`baileys`, padrão, e
  `zapo`, só com `ZAPO_PG_URL`). Só essa pasta importa a lib; `npm run check:adapter` fiscaliza. A
  normalização do proto do WhatsApp, comum aos providers, fica em `src/adapter/proto/`. A linha escolhe
  o provider em `phone_numbers.qr_provider`. Como acrescentar um: `src/adapter/README.md`.

## Comandos

Todos rodam em `qr-service/` (`npm ci` antes, na primeira vez).

| Comando | O que faz |
|---|---|
| `npm run build` | `tsc` (o type-check que vale) |
| `npm run -s test:all` | todas as suítes (`node --import tsx --test` e scripts Node, não Vitest). É o que o job `qr-service` do `../.github/workflows/ci.yml` roda depois de `npm ci` e do build, no Node 22 |
| `npm run check:adapter` | ninguém fora de `src/adapter/<provider>/` importa a lib |
| `npm run dev` | `tsx watch src/index.ts` (lê o `.env` da pasta atual) |
| `npm start` | `node dist/index.js` |
| `docker compose up -d --build` | serviço + Postgres da zapo; exige no `.env` as quatro obrigatórias e `ZAPO_PG_PASSWORD` (`openssl rand -hex 24`, definida antes do primeiro `up`: a senha fica gravada no volume `zapo_pg`) |

Boot de fumaça depois do build, sem falar com nada externo (não há sessão guardada para restaurar):

```bash
(cd "$(mktemp -d)" && PORT=3999 WEBHOOK_URL=http://127.0.0.1:9/hook SUPABASE_URL=http://127.0.0.1:9 \
  SUPABASE_SERVICE_KEY=x QR_WEBHOOK_SECRET=x timeout 20 node "$OLDPWD/dist/index.js"; echo "exit=$?")
```

`exit=124` = sobreviveu aos 20 s. Qualquer saída antes é erro de boot (o serviço aborta com `exit=1` sem
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `WEBHOOK_URL` ou `QR_WEBHOOK_SECRET`). O serviço é ESM: import relativo
sem `.js` passa no `tsc` e nos testes (tsx) e derruba o processo com `ERR_MODULE_NOT_FOUND`. Rode o boot
de fumaça (ou o mesmo com a imagem Docker) antes de publicar uma imagem.

## Regras do código

- Todo `.set()` de NodeCache passa por `cacheSet()`: com `maxKeys`, o `set` lança `ECACHEFULL` e
  abortava o handler no meio, perdendo a mensagem.
- Handler de evento da lib passa por `safeHandler()`: nenhum throw escapa; vira linha
  `handler_throw:<evento>` em `qr_message_log`.
- `debugLog` grava em `qr_message_log` e marca `success=false` pelo prefixo da action (`handler_throw`,
  `msg_drop_`, `msg_handler_throw`, `webhook_`, `media_`). Nomeie action nova sabendo disso.
- "Já pareou?" se responde com `creds.me?.id`, nunca com `creds.registered` (que só existe no fluxo
  de código de pareamento).
- Provider declara `capabilities` com honestidade. No `ZapoClient`, método sem implementação real
  **lança** (`unsupported_by_provider`, 501) e fica fora do set. Nunca devolver `[]`/`null` em silêncio.
  Confira a premissa no fonte da lib em `node_modules`, não no comentário.
- Busca de mensagem por wamid sempre filtra a conversa ou a linha: duas linhas conectadas conversando
  entre si gravam o mesmo wamid em duas conversas.
- O EMV do Pix nativo é montado pelo serviço (`src/adapter/proto/messageFallback.ts`; a mensagem só
  traz a chave). O rótulo `pix_key_label` mascara CPF e CNPJ (`CPF ***1234`); o `pix_code` montado leva a chave inteira porque é o copia-e-cola: não copie a chave para outros campos de `metadata` nem para log.
- Mídia abaixo de `MEDIA_STREAM_THRESHOLD_BYTES` faz ida e volta em base64 na memória; acima, vai para
  disco e sobe por TUS. O teto `MAX_MEDIA_BYTES` do serviço e o da edge `whatsapp-send-media` do Echo
  são independentes: suba os dois juntos.
- Mudança de formato entre serviço e Echo: publique primeiro o lado que aceita o formato antigo e o
  novo.

## Proteções contra banimento

Ban e restrição vêm de comportamento: pareamento repetido, prospecção a frio (ack `463`) e volume para
desconhecidos. Trocar a versão da lib não resolve.

- Limites por env, sem rebuild, com os valores em vigor em `GET /session/health` →
  `protection_limits`: `NEW_CONTACT_HOURLY_CAP` (20), `QR_HOURLY_CAP` (5),
  `CONNECT_COOLDOWN_AFTER_FATAL_MS` (30 min), `SEND_MIN_GAP_MS`/`SEND_MAX_GAP_MS` (0 = desligado),
  `RESTORE_STAGGER_MS` (3 s).
- Um QR por `POST /session/connect`: `qr_expired` não reconecta sozinho.
- O ack `463` arma o bloqueio local de contato frio (`reachout_locks` no `/session/health`).
- `403` = conta suspensa: não re-parear em loop; cada QR é um dispositivo novo.
- Adicionar participante em grupo pode derrubar a sessão com `401 conflict`. Prefira convite:
  `GET /groups/:id/:groupJid/invite-code` + `POST /groups/:id/join`.

## Diagnóstico

- `GET /session/health` (Bearer com a chave de serviço) é a verdade sobre as sessões;
  `phone_numbers.qr_session_status` pode estar atrasado. `GET /health` (público) diz `version` e
  `commit` da imagem: confira antes de investigar comportamento estranho.
- O rastro fica no banco do Echo: `qr_message_log` (o que não virou mensagem, falhas de webhook,
  `webhook_dead` com o payload) e `session_connection_log` (por que o número caiu, com o `statusCode`).

## Testes

- Telefone em teste é fictício: `5511999990001`, `5511999990002`… Nada de dado real em fixture.
- A suíte de contrato (`tests/adapter-contract/`) roda contra o `@zapo-js/fake-server`, sem celular.
  Limitações conhecidas do fake estão em `src/adapter/README.md`.
- Nenhum teste fala com WhatsApp ou Supabase de verdade. Teste que sobe o `src/index.ts` (`boot-public-url`)
  roda o filho num diretório temporário vazio e com `ZAPO_PG_URL` vazia: sem `.env` nem `sessions/` do
  desenvolvedor, o restore não tem sessão para reconectar.
- Exceção à regra de Zod em toda entrada externa: o qr-service não depende de `zod` (projeto à parte, com o
  próprio `package-lock.json`). As entradas de ambiente (`SUPABASE_URL`, `ECHO_PUBLIC_URL`) são validadas por
  `new URL` em `src/lib/publicUrl.ts` (erro tipado `PublicUrlConfigError`, boot aborta), e `media_url` passa pela
  guarda SSRF (`src/lib/url-guard.ts`). O corpo de `send-media`/`send-voice` segue sem esquema, como antes.
- Teste que mexe em `SUPABASE_URL`/`ECHO_PUBLIC_URL` restaura o ambiente no `afterEach` (as funções de
  `publicUrl.ts` leem `process.env` a cada chamada, de propósito).
