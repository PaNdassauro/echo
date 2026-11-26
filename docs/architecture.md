# Architecture

How Echo is put together, and the rules a contributor has to keep. For installation see
[self-hosting.md](./self-hosting.md) (Docker, the recommended way) or
[alternatives/supabase-cloud.md](./alternatives/supabase-cloud.md).

## Principle

Postgres is the brain. Authorization is enforced by RLS policies and `SECURITY DEFINER` RPCs, derived state is kept
by triggers, and scheduled work runs in pg_cron and reaches the edge functions through pg_net with URLs and keys
from the Vault. Edge functions (Deno) are the integration layer: Meta, the QR service, e-mail (SMTP or Resend), Web Push, AI
providers and the public API. The React front end is a view: it reads with supabase-js, writes through RPCs, edge
functions or RLS-checked tables, and receives changes through Realtime.

The same code runs in two settings. In the **Docker installation** (`./install.sh`) Postgres, GoTrue, PostgREST, Realtime
and Storage are open-source components of the Supabase ecosystem packaged in one Compose project, and the edge functions run
in a Deno process of their own; no Supabase account or CLI is involved. In the **alternative setup** the same components come
from a hosted Supabase project (or the Supabase CLI locally) and the functions run on its edge runtime. The code does not fork:
everything that differs between the two is configuration (`ECHO_PUBLIC_URL`, `/config.js`, the Vault secrets) and, in the
Docker installation, a runtime and a gateway that live under `docker/`.

## Components

| Component | Code | Role |
|---|---|---|
| Front end | `src/` | React SPA and PWA. Data hooks in `src/hooks/` and `src/hooks/chat/` |
| Edge functions | `supabase/functions/<name>/index.ts`, shared code in `supabase/functions/_shared/` | Inbound webhooks, outbound sends, executors called by cron, public API, e-mail and push |
| Database | `supabase/migrations/` | Schema, RLS, RPCs, triggers, cron jobs |
| Gateway (Docker) | `docker/gateway/` | Caddy: serves the front end and routes every API under one origin ([below](#self-hosted-stack)) |
| Function runtime (Docker) | `docker/functions/` | One Deno process that loads the 46 functions of `supabase/functions/` |
| Installer and CLI | `install.sh`, `echo`, `docker/tools/gen-keys.mjs` | Generates the `.env`, builds and starts the stack; day-to-day operation |
| QR service | `qr-service/` (npm project of its own, see [qr-service/README.md](../qr-service/README.md)) | One WhatsApp Web session per QR number, through the providers `baileys` and `zapo` |

Each number (`phone_numbers`) has a `connection_type`: `business_api` (Cloud API) or `qr`. Several places treat
"not `qr`" as Cloud API, so a new connection type means reviewing every such branch. Instagram Direct is not a row in
`phone_numbers`: `instagram_connections.phone_number_id` attaches an Instagram account to an existing number, which
then shares its inbox ([instagram/README.md](./instagram/README.md)).

## Inbound messages

1. **Meta** calls `whatsapp-webhook` with a body signed in `X-Hub-Signature-256` (checked against
   `WHATSAPP_APP_SECRET`, see `_shared/meta-webhook.ts`). The **QR service** calls the `/qr-*` routes of the same
   function (`/qr-message`, `/qr-delivery-update`, `/qr-message-receipt`, `/qr-message-deleted`,
   `/qr-message-edited`, `/qr-reaction`, `/qr-poll-vote`, `/qr-group-event`) with the header `x-qr-secret`, which
   must equal `QR_WEBHOOK_SECRET`. The secret is required on both sides: without it the function answers 503 on
   every `/qr-*` route (a wrong value gets 401) and the QR service refuses to start.
2. The webhook normalizes the phone number, finds or creates the conversation, uploads media to the `attachments`
   bucket and writes `messages` with an upsert on `(whatsapp_message_id, conversation_id)` and `ignoreDuplicates`.
   Redeliveries and the echo of a message sent from the phone itself fall into that conflict and are ignored.
3. It then runs automations (`automation-execute`), sends the organization webhooks (`_shared/webhooks.ts`) and Web
   Push (`send-web-push`).
4. The front end receives the new row through Realtime.

Failures are loud. A permanent problem becomes a message of type `unsupported` with `metadata.degraded_reason`. A
transient one answers 503 (the QR service keeps the event in its outbox and retries) or 500 (Meta redelivers).
Every write failure is recorded in `qr_message_log` with `success = false` and a replayable payload
(`_shared/failure-log.ts`); `scripts/replay-write-failures.mjs` replays them. The cron job
`check-message-failure-alerts` turns repeated failures into e-mail and push alerts.

## Outbound messages

1. The front end calls the `whatsapp-send*` functions with the user's JWT (`whatsapp-send`, `whatsapp-send-media`,
   `whatsapp-send-template`, ...). Integrations use the public API (`echo-api`, header `x-api-key`).
2. The function writes the `messages` row **before** talking to the provider. Because of that, the Realtime event
   can reach the browser before the HTTP response; the UI deduplicates.
3. Cloud API numbers go to the Graph API directly with the organization's token. QR numbers go to the QR service at
   `QR_SERVICE_URL` with `Authorization: Bearer <service role key>` (`_shared/qr.ts`).
4. Status moves `sent → delivered → read`, or `failed`, as receipts arrive through the inbound path.
5. Every place that writes an outbound message calls `emitMessageSent` (`_shared/webhooks.ts`). The echo of the same
   message coming back from the phone is dropped by the upsert, so a new writer that forgets this call leaves
   integrations without `message.sent`.
6. Organization webhooks about messages are recorded in `aviso_de_mensagem` and retried by the cron job
   `aviso-de-mensagem-repetir` until the receiver answers OK. The receiver should use `aviso_id` to discard repeats.

Functions that send through WhatsApp refuse Instagram-only conversations (`recusarSeDirect` in `_shared/canal.ts`);
`whatsapp-send` routes them to the Instagram API instead. A contact phone of the form `ig:<id>` is never a phone
number.

## QR service

Code in `qr-service/src/`, rules for contributors in `qr-service/CLAUDE.md`.

Routes → `SessionManager` → `WhatsAppClient` adapter (`baileys` or `zapo`). `SessionManager` holds the rules: an
on-disk outbox with retry and replay, LID (WhatsApp's anonymous id) to phone resolution, and rate limits against
number restrictions. The provider of each number is `phone_numbers.qr_provider`; switching without pairing again is
done in `/ops`. Browsers call the service directly with the user's JWT (`qrFetch` in `src/lib/qrService.ts`); the
service checks that the user belongs to the organization that owns the number.

## Self-hosted stack

`docker-compose.yml` defines ten services (see [self-hosting.md](./self-hosting.md#1-what-you-are-installing)). What a contributor
needs to know about how they fit.

**Start order.** `db` first, then `db-init` (guard against example secrets, role passwords, the Realtime roles, the `zapo`
database), then `auth`, `storage` and `realtime` in parallel (Storage has to migrate its own schema before Echo's migrations
reference it), then `migrate`, then `rest` (it starts with the full schema cache), then `gateway`, then `qr`. `functions` has no
dependency and starts in parallel. A failed migration leaves `rest` and `gateway` down on purpose.

**One origin.** The `gateway` serves the front end and proxies `/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1`,
`/functions/v1` and `/qr`, so the browser never makes a cross-origin request and needs no CORS. The front end gets its settings
at runtime from `/config.js` (`window.__ECHO_CONFIG__`, written by the gateway's entrypoint when it starts), so the same build serves any
installation. Precedence per field is `/config.js`, then `VITE_*`, then the page's own origin (`src/lib/runtimeConfig.ts`).

**Two listeners.** The gateway has a public site (`:80`, plus `:443` in domain mode) and an internal one on `:8000` that is never
published and never visible from the network of an external proxy (it is bound to the address the gateway has in the Compose
network). The internal one is what every server uses (`SUPABASE_URL=http://gateway:8000` for the functions and the QR service, and the
Vault's `project_url` for pg_net). It carries no login limit and none of the blocks of the public site, and its access log and the error log have a
filter that drops the `apikey` and `x-qr-secret` headers and masks `access_token`, `apikey` and `token` in the query string, because
those carry the service role key.

**What the public site blocks or limits.** `/auth/v1/admin/*` (404), every sub-path of `/functions/v1/whatsapp-webhook` (404: the
webhook routes internally by looking for `/qr-` in the path, so only the exact root, which Meta calls, is reachable), `/qr/health`
(404), the root of `/rest/v1/` unless the service role key is sent, and the Realtime tenant and OpenAPI paths (403). The sign-in
service limits attempts per client address (`GOTRUE_RATE_LIMIT_HEADER=X-Echo-Client-IP`, which the public site fills with the real
client address and the internal one deletes). The gateway trusts `X-Forwarded-For` only with `ECHO_BEHIND_PROXY=true`, and then only
from private addresses.

**Internal × public URL (one rule).**

1. A server calling an API (functions, QR service, pg_net) uses the **internal** address, `http://gateway:8000`.
2. Any URL that **leaves the server** (saved in the database, sent to the browser, to a webhook, to Meta, to Instagram, in an e-mail)
   uses the **public** one, `ECHO_PUBLIC_URL`.
3. Before a server fetches a URL that belongs to our own Storage, the URL is translated to the internal one
   (`paraUrlInterna`), and that fetch skips the SSRF guard (the address is fixed by configuration, not by the caller).
4. Recognizing "our attachment" accepts both bases, so old rows and rows written from another address still match.
5. Without `ECHO_PUBLIC_URL` (the Supabase Cloud setup) the public base is `SUPABASE_URL`, and nothing changes.
6. A URL chosen by a tenant or a user (organization webhook and its retries, automation webhook node, action button of type webhook, link preview) always goes through the SSRF guard
   first (`fetchExterno` in `supabase/functions/_shared/url-guard.ts`, which checks every redirect hop). `ECHO_OUTBOUND_ALLOW_HOSTS` is the
   explicit exception.

The helpers come in pairs with the same names: `supabase/functions/_shared/url-publica.ts`, `qr-service/src/lib/publicUrl.ts` and
`src/lib/runtimeConfig.ts`. Change one, change the others, and the shared test tables.

**The function runtime is one process.** `docker/functions/router.ts` loads the 46 functions into a single Deno process, replacing
`Deno.serve` with a registrar before each import, and dispatches by path (`/functions/v1/<name>`). It checks `verify_jwt` per function
from `supabase/config.toml` (a function missing from the map requires a JWT), answers 504 after `FN_REQUEST_TIMEOUT_MS`, drains unread
request bodies up to 16 MiB, and keeps unhandled rejections from killing the process. `JWT_SECRET` is read and **deleted from the
environment** before the first function loads. `/_health` answers 503 if any function failed to load, and only to the container's
own loopback. The dependencies are cached at build time (`deno cache --frozen`, with a versioned `docker/functions/deno.lock`) and the
process runs with `--cached-only`: it does not need the internet and does not fetch code at run time. In this stack they come from the
npm registry (immutable tarballs, integrity in the lock): the sources import from esm.sh for the Supabase Cloud path, and the import map
of `docker/functions/deno.json` redirects those specifiers to `npm:` at run time.

Consequences that a contributor has to respect, and that `tests/processo-unico/` (part of `npm run test:edge`) enforces on
`supabase/functions/**`: no top-level `let` or `var`; no top-level `Map`, `Set`, `Array` or object that the file mutates; no library
configuration call at module top level (`setVapidDetails` and the like); no writes to `globalThis`; no `Deno.env.set` or `delete`; no
dynamic `import(...)` with a non-literal specifier (the build cache does not follow it and `--cached-only` would fail at run time).
The only escape is a `// processo-unico: <reason>` comment on the line before. Also: the CPU of one function delays the others, and memory
is shared.

**What is not a security boundary.**

- The `zapo` database role keeps the QR provider's data apart from the rest, but it is not isolation: it can still connect to the `postgres`
  database (PUBLIC has CONNECT), and the QR service already holds the `SERVICE_ROLE_KEY`. Treat the QR service as holding the keys to
  everything.
- The loopback of the `db` container is `trust`: a password test with `psql -h 127.0.0.1` inside the container accepts any password. Test
  passwords over the network.
- All functions share one process: a bug that reads another function's memory is not prevented by the runtime. The code rules above reduce
  the risk of shared state; they do not make functions isolated.
- The `gateway` container runs as root inside the container (the stock `caddy` image). The QR service image runs as the non-root user `node`.
- The Compose network is trusted: any container on it can reach the internal listener, the database and the other services. Do not put
  unrelated containers on it. An external proxy network does not reach the internal listener.
- The `.env` is the Vault's root key. Whoever reads it, or the `db-data` volume together with it, reads the Vault.

**Migrations and the Vault.** `migrate` creates the four Vault secrets (`project_url`, `service_role_key`, `qr_service_url`,
`ai_key_secret`) **before** running the migrations, so that no cron job finds the Vault empty on the first start; applies each new file
in its own transaction while recording it in `echo_meta.schema_migrations` (version, name, sha256 checksum, time); creates the secrets
again (idempotent) and reloads the PostgREST schema cache. The files come from inside the `db` image (`/echo/migrations`), never from
disk, so code and schema are always from the same build. A migration that was applied is never edited (a different checksum stops the
start). The `echo_meta` schema is not exposed by PostgREST.

**Image transformation is off.** There is no imgproxy: the front end does not ask for resized images (`features.transformacaoImagem` is
false in `/config.js`) and uses the original file, and the edge functions skip the thumbnail hash that needs `render/image`
(`ECHO_IMAGE_TRANSFORM=false`).

## Tenancy and authorization

- Every table has `organization_id` (directly or through its parent) and RLS enabled.
- The role comes from `organization_members.role` (`admin` or `agent`) plus `profiles.is_super_admin`, read in
  `src/contexts/OrganizationContext.tsx`. A super admin acts as admin in every organization.
- Conversation visibility is **per number**, not per owner: `get_my_conversation_phone_ids()` and
  `user_can_access_conversation()`. The policy of `messages` is an `EXISTS` on `conversations` and inherits its rules.
- Optional isolation by sector is a per-number flag (`phone_numbers.sector_isolation_enabled`).
- Use the existing helpers before writing new ones: `user_is_org_admin()`, `auth_is_super_admin()`,
  `user_has_phone_access()`, `get_my_org_role()`, and in the edge functions `_shared/authz.ts` (`requireUser`,
  `requirePhoneAccess`, `checkInternalCaller`). Identity always comes from the verified JWT, never from the request
  body.
- The first administrator is created by the `primeiro-acesso` function (`verify_jwt = false`, guarded by `ECHO_SETUP_TOKEN` and by the
  database function `instalacao_concluir_setup`, which takes an advisory lock and refuses once an organization or a super admin exists).
  Both database functions are `service_role` only.
- Server-to-server functions (called by cron jobs, the QR service or other functions) accept only the service role
  key or a known `sb_secret_` key (`checkInternalCaller`), and reject anything else with 401 by default
  (`EDGE_INTERNAL_AUTH_ENFORCE=0` switches to log-only, as a migration aid). Which functions run with
  `verify_jwt = false`, and why, is documented in `supabase/config.toml`.
- Organization secret columns (`whatsapp_access_token`, `whatsapp_verify_token`, `ai_api_key`,
  `ai_api_key_encrypted`) are not readable through table queries: `organizations` grants `authenticated` column-level
  SELECT without them. The front end learns whether
  they exist through the RPCs `get_org_whatsapp_config` and `get_org_ai_config`, and edge functions read them with the
  service role. AI keys are encrypted with the Vault secret `ai_key_secret`, and `get_decrypted_ai_key` is executable by the service
  role only: an organization admin cannot read the key back through the API.
- A signed-in user can insert a row into `phone_numbers` without sending `organization_id`, and the table accepts it with the column null (measured
  on the stack: HTTP 201; the cause in the policy was not investigated). The screens always send it. This comes from the schema as it was
  inherited; do not write code that relies on it, and send `organization_id` explicitly from any script or client you write.

## Realtime and notifications

- The `supabase_realtime` publication has `conversations`, `messages`, `conversation_assignees`,
  `conversation_tags`, `message_reactions`, `message_receipts`, `scheduled_messages` and `system_alerts`.
- One global channel (`global-notifications` in `src/components/GlobalNotificationListener.tsx`) drives unread
  counts, sound, toast, tab title and favicon. Unread badges are rebuilt from the RPC `get_unread_counts` on focus,
  visibility change and reconnection.
- Web Push: the Workbox service worker imports `public/push-sw.js`; the edge function `send-web-push` sends with
  VAPID. Notifications must work with the tab in the background, not only as a toast.
- The conversation list reads the denormalized preview in `conversations.last_message_*` (kept by a trigger on
  `messages`) with an explicit column list (`LIST_COLUMNS` in `src/lib/conversationListQuery.ts`) and applies
  Realtime events through a pure reducer (`src/lib/conversationListReducer.ts`). An update that moves a conversation
  out of the user's RLS scope does not arrive through Realtime, so the list refetches that row.
- New Realtime channels use `subscribeWithBackoff` (`src/lib/realtimeReconnect.ts`).
- The service worker is registered by hand (`src/lib/serviceWorkerRegistration.ts`, called from `src/main.tsx`) and
  polls for updates every 60 seconds. `index.html` is
  not precached and Storage media (`/storage/`) is not runtime-cached (`vite.config.ts`).

## Scheduled work

pg_cron jobs call SQL functions; the ones that need an edge function read `project_url` and `service_role_key`
through `public._segredo_obrigatorio()` and post with pg_net. Dispatchers fail loudly when one of those secrets is
missing; the detectors (`check_message_failure_alerts`, `check_qr_service_health`, `send_pipeline_heartbeat`) and the
webhook retry (`aviso_de_mensagem_repetir`) only log a warning. `check_qr_service_health` also reads `qr_service_url`
and fails without it.
The list of jobs is in [self-hosting.md](./self-hosting.md#16-cron-jobs).

## Where things live

| Data | Place |
|---|---|
| Organizations, WABA credentials | `organizations` |
| Members and roles | `organization_members`, `profiles.is_super_admin` |
| Numbers and per-number switches | `phone_numbers` (`connection_type`, `qr_provider`, `sector_isolation_enabled`, `typing_indicator_enabled`, `send_read_receipts`, `disconnect_alert_*`, ...) |
| Which agents see which numbers | `user_phone_numbers` |
| Conversations, owners, tags | `conversations`, `conversation_assignees`, `conversation_tags`, `tags` |
| Messages | `messages`, with `metadata` jsonb for per-type data |
| Per-message notification state | `aviso_de_mensagem` |
| Pipeline log and failures | `qr_message_log` |
| Automations | `automation_flows`, `automation_triggers`, `automation_sessions`, `automation_executions` |
| Broadcasts | `broadcasts`, `broadcast_recipients` |
| Scheduled messages | `scheduled_messages` |
| Webhooks and action buttons | `organization_webhooks`, `organization_action_buttons`, `action_button_phone_numbers` |
| API keys | `api_keys` (only the hash is stored) |
| Instagram | `instagram_connections` (token readable only by the service role), `instagram_webhook_events` |
| Files | Storage bucket `attachments` (upload prefixes are restricted by policy, see `20260101000100_auth_e_storage.sql`) |

Per-number behavior is configured on screen: a column in `phone_numbers`, an action button linked to numbers, or an
Instagram connection. Behavior that changes per number must appear in the settings UI, never in a hard-coded
condition on a specific number or organization.

## Invariants for contributors

**Messages**
- `messages.message_type` has a CHECK with a fixed list (note: `contact`, singular). A new type needs a migration
  (drop and add the constraint) and the type added to the whitelist of `whatsapp-webhook`; otherwise the insert fails
  with 23514 and the message is lost.
- Look up a message by `whatsapp_message_id` always together with `conversation_id`: two connected numbers that talk
  to each other store the same id in two conversations.
- `messages.created_at` is the arrival time on purpose (unread logic compares it with the last read time). The real
  send time is `metadata.sent_at`, which the 24-hour window uses (`src/lib/deliveryTiming.ts`).
- `sent_by IS NULL` can be inbound, automation or an echo from the phone. Echo from the phone is
  `direction = 'outbound' AND sent_by IS NULL AND origin IS NULL`.
- `metadata.contact` has the singular fields and an optional `contacts[]`. The fallback `contacts ?? [singular]` is
  permanent.
- `metadata.media` (`width`, `height`, optional `seconds`, `source`) is optional forever. Read it only through
  `parseMediaDimensions` (`src/lib/mediaBox.ts`) or `MediaDimensionsSchema` (`_shared/media-probe.ts`). Writers merge,
  never overwrite a valid value.

**Conversations**
- `closed_at`, `close_reason` and `closed_by` belong to the trigger `trg_conversation_close_lifecycle`; no writer
  sets them.
- `last_message_*` are maintained by the trigger on `messages` and only move forward. Imported rows
  (`is_imported`) do not reopen a closed conversation.

**Phone numbers (Brazil)**
- `extract_br_phone_parts` assumes the mobile ninth digit without checking. Code that generates variants needs the
  guard `substring(digits, 5, 1) = '9'` and must not expand numbers from other countries. Keep it in parity with
  `getLookupVariations` (`src/lib/phone.ts`).
- `merge_duplicate_conversations` rewrites `contact_phone` to the form with the ninth digit. Exact equality on phone
  numbers is a trap; use the variants only as lookup keys.
- In groups, `contact_phone` is the group JID.

**Database changes**
- A new table in `public` gets RLS disabled and full grants for `anon` and `authenticated` by default. In the same
  migration: `enable row level security` and `revoke all ... from anon, authenticated`.
- A new function in `public` gets EXECUTE for `anon`, and `REVOKE ... FROM PUBLIC` does not remove it. For
  `SECURITY DEFINER` or tenant-by-parameter functions:
  `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;`.
- Exception: a function used by an RLS policy of a table in the `supabase_realtime` publication needs EXECUTE for
  `supabase_realtime_admin`, `authenticated` and `anon`. Without it Realtime stops delivering silently while the
  channel still reports `SUBSCRIBED`.
- In policies and `WHERE` clauses write user predicates as `(SELECT auth.uid())` / `(SELECT fn())` so they run once
  per query, not once per row.
- Before `CREATE OR REPLACE` of an existing function, start from the current definition (`pg_get_functiondef`), not
  from an older file.
- Prefer existing columns or `metadata` jsonb (with a partial index on `(expr) IS NOT NULL`) over a new table for a
  single feature.
- Indexes on `messages` should be created `CONCURRENTLY` on a populated database.
- A new upload prefix in the `attachments` bucket needs a Storage policy before the front end uses it.
- A new column of `organizations` that the browser must read needs an explicit `GRANT SELECT (<column>)` to
  `authenticated`; `select('*')` on that table fails with 42501.

**PostgREST and the front end**
- A response stops at 1000 rows and a larger `.limit()` is ignored: paginate with `.range()`.
- URLs above roughly 30 KB fail with 400: no `.in()` with hundreds of ids.
- Commas and parentheses in user input are syntax inside `.or()`: sanitize.
- An `UPDATE` that matches no row is not an error: add `.select('id')` and check the result.
- External payloads (Realtime rows, RPC results, QR service responses) are validated with zod, for example
  `src/lib/conversationRealtime.ts`.
- Edge function errors are read with `checkEdgeFunctionResponseAsync` (`src/lib/utils.ts`), which opens
  `error.context`.
- `npm run build` does not type-check; `npm run typecheck` does. Edge functions are only checked by `deno check`.
