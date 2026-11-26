# Echo QR service

[Português](README.pt-BR.md) · **English** · [Echo README](../README.md) ·
[Self-hosting guide](../docs/self-hosting.md#11-qr-service-qr-numbers)

The QR service lives in the `qr-service/` folder of the Echo repository. It connects WhatsApp numbers to
[Echo](#how-it-fits-into-echo) by scanning a QR code
(or typing a pairing code) on the phone, the same way WhatsApp Web does. It keeps those sessions open,
forwards everything that arrives to Echo, and exposes an HTTP API that Echo uses to send messages,
manage groups, read profiles and place voice calls.

It is a Node.js / Express service written in TypeScript. The WhatsApp protocol is handled by
third-party libraries behind an adapter, so each number can run on a different library.

The folder is an npm project of its own (package `echo-qr-service`), with its own `package.json`,
`package-lock.json`, `node_modules`, `Dockerfile` and `Dockerfile.voip`. The repository root is not an
npm workspace: run every command below from `qr-service/` (`cd qr-service` from the repository root).
The root `npm ci` does not install this folder's dependencies, and the root `npm test` does not run its
tests.

> [!WARNING]
> **This service uses unofficial WhatsApp Web libraries.** It is not affiliated with or endorsed by
> WhatsApp or Meta. Automating a personal or business WhatsApp account this way may violate the
> WhatsApp Terms of Service, and WhatsApp can restrict or permanently ban the numbers you connect.
> The service has protections that reduce that risk (see [Ban-risk protections](#ban-risk-protections)),
> but nothing here prevents a ban. Use numbers you can afford to lose, and use the official
> WhatsApp Cloud API (which Echo also supports) for cold outreach and bulk sending.

## Contents

- [How it fits into Echo](#how-it-fits-into-echo)
- [Requirements](#requirements)
- [Quickstart with Docker Compose](#quickstart-with-docker-compose)
- [Running without Docker](#running-without-docker)
- [Connecting it to Echo](#connecting-it-to-echo)
- [Environment variables](#environment-variables)
- [Providers](#providers)
- [Voice calls](#voice-calls)
- [HTTP API](#http-api)
- [Contract with Echo](#contract-with-echo)
- [Session persistence](#session-persistence)
- [Health checks](#health-checks)
- [Ban-risk protections](#ban-risk-protections)
- [Tests](#tests)
- [License](#license)

## How it fits into Echo

Echo is a multi-tenant WhatsApp team inbox built on Supabase (Postgres, Edge Functions, Realtime,
Storage) with a React front end. A phone number in Echo is a row in `phone_numbers`. Numbers with
`connection_type = 'qr'` are served by this service; numbers on the official Cloud API are not.

```
 phone (WhatsApp) ──► QR service ──► Echo edge function whatsapp-webhook (/qr-* routes) ──► Postgres
                        ▲    │
                        │    └──► Supabase: tables, Storage (attachments), Realtime broadcast
 Echo front end ────────┤        (service_role key)
 Echo edge functions ───┘  HTTP API (Bearer token)
```

- **Inbound:** the service downloads media, uploads it to the `attachments` bucket, and POSTs each
  event (message, receipt, reaction, edit, deletion, poll vote, group event) to the `whatsapp-webhook`
  edge function. The edge function writes the rows; the front end receives them over Realtime.
- **Outbound:** Echo's edge functions (`whatsapp-send`, `whatsapp-send-media`, …) and the front end call
  this service's HTTP API.
- The service also reads and writes a few Echo tables directly with the `service_role` key
  (`phone_numbers`, `phone_number_sessions`, `conversations`, `messages`, `qr_message_log`,
  `session_connection_log`, `profiles`, `organization_members`), so it needs a database created from
  Echo's migrations (`../supabase/migrations/`).

One Supabase project must have **exactly one** instance of this service. Two instances pointed at the
same project open the same WhatsApp sessions and disconnect each other with `401 conflict`.

## Requirements

- **Node.js 22** (`qr-service/.nvmrc`, `engines: >=22.0.0`). The `zapo` provider relies on Node 22's global
  `WebSocket`.
- **ffmpeg** on the `PATH`. It is not needed to start the service, but voice notes
  (`/message/send-voice` transcodes any audio to OGG/Opus) and the test tone of voice calls fail
  without it. Both Docker images install it.
- An **Echo** Supabase project (hosted or `npx supabase start` locally, from the repository root) with
  Echo's migrations applied and the `whatsapp-webhook` edge function deployed (or served locally).
- Optional: a **PostgreSQL** database for the `zapo` provider (the Compose file starts one).
- For the Compose quickstart: Docker with **Compose v2.24 or newer** (the file uses
  `env_file` with `required: false`).

## Quickstart with Docker Compose

```bash
cd qr-service
cp .env.example .env
# edit .env: SUPABASE_URL, SUPABASE_SERVICE_KEY, WEBHOOK_URL, QR_WEBHOOK_SECRET, ZAPO_PG_PASSWORD
# (and ALLOWED_ORIGINS for a front end that is not on localhost)
docker compose up -d --build
curl -s localhost:3000/health
```

The build context of `docker-compose.yml`, `Dockerfile` and `Dockerfile.voip` is the `qr-service/`
folder, so run `docker compose` from there. The container and the local image are named
`echo-qr-service` (the npm package name). `docker-compose.yml` starts two containers:

| Service | What it is |
|---|---|
| `echo-qr-service` | this service, built from `Dockerfile` (Alpine, with `ffmpeg` and `tini`; runs as the non-root `node` user and has a `HEALTHCHECK` on `/health`), port `${QR_PORT:-3000}` on the host |
| `zapo-db` | `postgres:16-alpine`, internal to the Compose network, used only by the `zapo` provider |

Compose refuses to start if any of these five variables is missing or empty (the message names one
variable at a time, so fill all five in `.env` first):

| Variable | Why Compose needs it |
|---|---|
| `SUPABASE_URL` | required by the service |
| `SUPABASE_SERVICE_KEY` | required by the service |
| `WEBHOOK_URL` | required by the service |
| `QR_WEBHOOK_SECRET` | required by the service |
| `ZAPO_PG_PASSWORD` | password of the `zapo-db` Postgres, also used in the `ZAPO_PG_URL` it gives the service |

`ZAPO_PG_PASSWORD` is required by `docker-compose.yml`, with no default: `docker compose` refuses to start
without it. Generate it with `openssl rand -hex 24` (hexadecimal, safe inside the connection URL) and put
it in `qr-service/.env`. Compose uses the same value as `POSTGRES_PASSWORD` of the zapo Postgres and in
the service's `ZAPO_PG_URL`. Set it before the first `docker compose up`: Postgres writes the password
into the `zapo_pg` volume when it creates it, and changing it later requires recreating the volume
(`docker compose down -v`, which deletes the zapo sessions) or running `ALTER USER` in the database.
Outside Compose, `ZAPO_PG_URL` stays optional and points to any Postgres of yours:
`postgres://zapo:<password>@host:5432/zapo`.

Compose sets `ZAPO_PG_URL` and `ZAPO_PG_TABLE_PREFIX` itself, so both providers are available. The
`zapo-db` container publishes no port. Sessions live in the `qr_sessions` volume and the zapo database
in `zapo_pg` (see [Session persistence](#session-persistence)).

To build with the version and commit that `/health` reports:

```bash
GIT_SHA=$(git rev-parse --short HEAD) docker compose build
```

`APP_VERSION` is not passed by the Compose file; without it `/health` reports the `package.json`
version.

**Local Supabase:** if Echo runs on `supabase start` on the same machine, `127.0.0.1` inside the
container is the container itself. `docker-compose.yml` already declares
`extra_hosts: host.docker.internal:host-gateway` (needed on Linux), so use
`http://host.docker.internal:54321` in `SUPABASE_URL` and
`http://host.docker.internal:54321/functions/v1/whatsapp-webhook` in `WEBHOOK_URL`. Or run the service
without Docker (next section). Caveat: with a local Supabase, the `media_url` that Echo sends for a QR
number points to the Storage at the address the edge function sees (`http://127.0.0.1:54321`), which is
not the one in `SUPABASE_URL`, so the service refuses it as a private host. Set `ECHO_PUBLIC_URL` to that
address (`http://127.0.0.1:54321`) and the service recognizes the URL as its own Storage and downloads it
through `SUPABASE_URL` (see the `media_url` note under [HTTP API](#http-api)).

## Running without Docker

```bash
cd qr-service
nvm use            # Node 22
npm ci
cp .env.example .env   # fill in the required variables
npm run build
npm start          # node dist/index.js
```

For development, `npm run dev` runs `tsx watch src/index.ts`. The `.env` file is read from the current
directory, and sessions are stored in `./sessions` relative to the current directory, so start the
service from the `qr-service/` folder (`qr-service/.env` and `qr-service/sessions/` are ignored by git).

Without `ZAPO_PG_URL` only the `baileys` provider is registered; the log says
`[Provider] zapo desabilitada (defina ZAPO_PG_URL para registrar)`.

## Connecting it to Echo

Echo needs to know where the service is, and both sides need the same shared secret. On the Echo side
(details in section 11 of the [self-hosting guide](../docs/self-hosting.md#11-qr-service-qr-numbers)):

| Where | Name | Value |
|---|---|---|
| Edge function secret | `QR_SERVICE_URL` | URL of this service as reachable from the edge functions |
| Edge function secret | `QR_WEBHOOK_SECRET` | the same value as `QR_WEBHOOK_SECRET` here |
| Vault secret (used by database cron jobs) | `qr_service_url` | URL of this service as reachable from the database |
| Front end build variable | `VITE_QR_SERVICE_URL` | URL of this service as reachable from the browser |

On this side:

- `WEBHOOK_URL` = `<SUPABASE_URL>/functions/v1/whatsapp-webhook` (no trailing slash).
- `ALLOWED_ORIGINS` must include the origin the Echo front end is served from, because the browser calls
  this service directly.
- `QR_WEBHOOK_SECRET` is required on both sides, with the same value: without it this service does not
  start, and the edge function answers `503` on every `/qr-*` route (a different value gets `401`).
- `SUPABASE_SERVICE_KEY` must be **the same value** your edge functions receive as
  `SUPABASE_SERVICE_ROLE_KEY`, which is the project's legacy `service_role` JWT. Edge functions
  authenticate to this service by sending that key as a Bearer token, and the service compares it byte
  for byte with `SUPABASE_SERVICE_KEY`. If they differ (for example, an `sb_secret_…` key here), every
  call from an edge function gets `401 Invalid token`.

To connect a number: create a QR number in Echo (Configurações > Números; the Echo UI is in
Portuguese). Echo calls
`POST /session/connect` and shows the QR code it receives over `GET /session/qr/:phoneNumberId`. Scan
it with WhatsApp on the phone (Linked devices).

## Environment variables

All variables are read with `process.env` in `src/`. `dotenv` loads `.env` from the current directory.
`.env.example` documents the same list.

### Required

The service exits with code 1 if any of these is missing.

| Variable | Default | Description |
|---|---|---|
| `SUPABASE_URL` | none | URL of the Echo Supabase project. Also the base for the Realtime broadcast (`/realtime/v1/api/broadcast`), the disconnect alert (`/functions/v1/send-disconnect-alert`) and resumable media uploads (`/storage/v1/upload/resumable`). |
| `SUPABASE_SERVICE_KEY` | none | Supabase legacy `service_role` key (JWT). Used by the admin Supabase client and accepted as the server-to-server Bearer token on this service's API. Never expose it to a browser. See [Connecting it to Echo](#connecting-it-to-echo) for which value to use. |
| `WEBHOOK_URL` | none | URL of Echo's `whatsapp-webhook` edge function, without a trailing slash. The service appends `/qr-message`, `/qr-delivery-update`, etc. |
| `QR_WEBHOOK_SECRET` | none | Sent as the `x-qr-secret` header on every POST to `WEBHOOK_URL`. Must equal the `QR_WEBHOOK_SECRET` secret of the `whatsapp-webhook` edge function. The service refuses to boot without it, and the edge function answers 503 on the `/qr-*` routes when it has no secret set. Generate one with `openssl rand -hex 32`. |

### Recommended

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGINS` | `http://localhost:8080,http://localhost:5173` | Comma-separated CORS origins. Add the origin of your Echo front end. Server-to-server calls are not affected by CORS. |
| `PORT` | `3000` | HTTP port. |
| `ECHO_PUBLIC_URL` | `SUPABASE_URL` | Public address of Echo (`https://echo.example.com`, no trailing slash), as the browser opens it. Set it when `SUPABASE_URL` is an internal address (self-hosted Echo in Docker uses `http://gateway:8000`): the public URL of every received media file and profile picture saved in the database is built from it, and a `media_url` of the own Storage at this address is downloaded through `SUPABASE_URL`. The service never calls Supabase through it. Without it the public base is `SUPABASE_URL` and nothing changes. A value that is not an `http(s)` URL makes the service refuse to boot (exit 1, naming the variable). |

### zapo provider

| Variable | Default | Description |
|---|---|---|
| `ZAPO_PG_URL` | none | PostgreSQL connection string for the `zapo` provider's own store (not the Supabase database). Without it the `zapo` provider is not registered. |
| `ZAPO_PG_TABLE_PREFIX` | `wa_zapo_` | Prefix of the zapo tables in that database. |

### Media (bytes)

| Variable | Default | Description |
|---|---|---|
| `MAX_MEDIA_BYTES` | `52428800` (50 MiB) | Largest inbound media the service downloads. Bigger files arrive in Echo as a message without the file (`media_too_large`). Keep the `attachments` bucket `file_size_limit` at least this high. Echo's `whatsapp-send-media` edge function has its own `MAX_MEDIA_BYTES` for outbound media. |
| `MEDIA_STREAM_THRESHOLD_BYTES` | `16777216` (16 MiB) | Above this size inbound media is streamed to a temporary file and uploaded with a resumable (TUS) upload instead of being held in memory. |
| `MEDIA_DISK_RESERVE_BYTES` | `2147483648` (2 GiB) | Free disk space that temporary media files always leave untouched (session credentials live on the same disk). |

### Delivery to Echo

| Variable | Default | Description |
|---|---|---|
| `MAX_PENDING_WEBHOOKS` | `500` | Webhook calls held in memory. Beyond this, new calls are written to `sessions/_outbox/` and delivered later. |

### Ban-risk protections

| Variable | Default | Description |
|---|---|---|
| `SEND_MIN_GAP_MS` / `SEND_MAX_GAP_MS` | `0` / `0` (off) | Random delay between two sends of the same session, in ms. Spacing is on when `SEND_MAX_GAP_MS` is greater than 0 (`SEND_MAX_GAP_MS` is raised to `SEND_MIN_GAP_MS` if lower). Example: `1000` and `3000`. |
| `SEND_MAX_QUEUE_WAIT_MS` | `60000` | With spacing on, a send that would wait longer than this is refused immediately. |
| `NEW_CONTACT_HOURLY_CAP` | `20` | Distinct new contacts (no message ever received from them) one session may message per hour. `0` disables the cap. |
| `QR_HOURLY_CAP` | `5` | Pairings (QR or pairing code) per number per hour. `0` or an invalid value means `5`. |
| `CONNECT_COOLDOWN_AFTER_FATAL_MS` | `1800000` (30 min) | After a `401`/`403` on a session that was already paired, manual reconnects are refused for this long. `0` disables it. |
| `RESTORE_STAGGER_MS` | `3000` | Delay between session restores at boot. |

### Voice calls (zapo only)

| Variable | Default | Description |
|---|---|---|
| `VOIP_ENABLED` | off | `1` loads the `@zapo-js/voip` plugin. Only works in the `Dockerfile.voip` image, which already sets it. |
| `VOIP_MAX_CONCURRENT_CALLS` | `1` | Simultaneous calls per number (minimum 1). |

### Build information

| Variable | Default | Description |
|---|---|---|
| `APP_VERSION` | `dev` | Version reported by `/health` and `/session/health`. When unset or `dev`, the `package.json` version is used. Set by `--build-arg APP_VERSION=…` in both Dockerfiles. |
| `GIT_SHA` | `unknown` | Commit reported by the health endpoints. Set by `--build-arg GIT_SHA=…`. |

### Docker Compose only

| Variable | Default | Description |
|---|---|---|
| `QR_PORT` | `3000` | Host port published by `docker-compose.yml`. |
| `GIT_SHA` | `local` | Passed as a build argument by `docker-compose.yml`. |
| `ZAPO_PG_PASSWORD` | none (**required** by Compose) | Password of the `zapo-db` Postgres; Compose builds `ZAPO_PG_URL` from it. Generate with `openssl rand -hex 24` before the first `docker compose up`. See [Quickstart with Docker Compose](#quickstart-with-docker-compose). |

## Providers

A provider is one WhatsApp library wrapped in the `WhatsAppClient` contract (`src/adapter/`). Each
number picks its provider in `phone_numbers.qr_provider` (default `baileys`). Two providers ship:

| Provider | Library | Where the session lives | Notes |
|---|---|---|---|
| `baileys` (default) | [Baileys](https://github.com/WhiskeySockets/Baileys) `7.0.0-rc14` (npm package `baileys`, installed as `@whiskeysockets/baileys`) | files in `sessions/<phone_number_id>/` | Exports and imports credentials, history sync on demand. No voice calls (the call routes answer 501). |
| `zapo` | [zapo-js](https://www.npmjs.com/package/zapo-js) with `@zapo-js/store-postgres` | its own PostgreSQL database (`ZAPO_PG_URL`) | Registered only when `ZAPO_PG_URL` is set. Supports voice calls with the VoIP image. Cannot export credentials and does not fetch history on demand. |

Each provider declares its capabilities; routes answer `501` for what the number's provider cannot do.
No other provider (for example a whatsmeow sidecar) is included; `src/adapter/README.md` explains how
to add one.

**Switching a number between providers** does not require scanning a new QR code:

```bash
curl -X POST "$QR_SERVICE/session/migrate-provider/<phone_number_id>" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" -H 'content-type: application/json' \
  -d '{"to":"zapo"}'
```

The service closes the session, exports the credentials, keeps a backup in
`sessions/_snapshots/<phone_number_id>/`, imports them into the target provider, updates
`phone_numbers.qr_provider` and reconnects. To go back, call it again with `{"to":"baileys"}`; the
backup is used because zapo cannot export. Echo's operations page (`/ops`) offers the same action. The service allows it for any member of the
number's organization (or a super admin); the admin-only restriction exists only in Echo's UI.

## Voice calls

Voice calls exist only on the `zapo` provider with the `@zapo-js/voip` plugin, which depends on the
native `@roamhq/wrtc` binary. That binary needs glibc 2.34 and does not load on Alpine, so calls need
the Debian image:

```bash
cd qr-service
docker build -f Dockerfile.voip \
  --build-arg APP_VERSION=$(node -p "require('./package.json').version") \
  --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t echo-qr-service:voip .
```

`Dockerfile.voip` sets `VOIP_ENABLED=1`. With Compose, set `dockerfile: Dockerfile.voip` under
`build:` in `docker-compose.yml`. A number has calls only when `GET /call/:phoneNumberId/capability`
returns `{"voice_call": true}`; Echo shows the call UI only then. WhatsApp allows one call at a time per
account, so `VOIP_MAX_CONCURRENT_CALLS` above 1 is only useful for experiments.

## HTTP API

Every route except `GET /health` requires a token, sent as `Authorization: Bearer <token>`. The
Server-Sent Events routes and the call audio WebSocket also accept `?access_token=<token>`, because
`EventSource` and browser WebSockets cannot send headers.

A token is either:

- the service key (`SUPABASE_SERVICE_KEY`), used by Echo's edge functions: full access; or
- a Supabase user access token (JWT) of the Echo project, used by the front end. It is validated with
  Supabase Auth and cached for 60 s.

Routes that take a `:phoneNumberId` (Echo's `phone_numbers.id`, or the Meta phone number id) also check
that a user may operate that number: the user must be a super admin (`profiles.is_super_admin`) or a
member of the organization that owns it. Otherwise they get `403` (`404` if the number does not exist).
The service key skips this check.

### `/session`

| Method and path | Purpose |
|---|---|
| `POST /session/connect` | Start a session. Body: `{ phoneNumberId, forceNew?, usePairingCode?, phoneNumber? }`. The number check uses `phoneNumberId` from the body. Returns `429` when a protection refuses the pairing. |
| `GET /session/qr/:phoneNumberId` | SSE stream with `qr`, `pairing_code` and connection events. |
| `GET /session/qr-code/:phoneNumberId` | Current QR code (polling fallback). |
| `GET /session/pairing-code/:phoneNumberId` | Current pairing code (polling fallback). |
| `GET /session/status/:phoneNumberId` | Session status. |
| `POST /session/lid-map/:phoneNumberId` | Resolve WhatsApp LIDs to phone numbers (up to 500). |
| `POST /session/migrate-provider/:phoneNumberId` | Move the number to another provider. Body: `{ to }`. |
| `POST /session/presence-mode/:phoneNumberId` | Apply `keepDeviceNotifications` to a live session. |
| `POST /session/sync/:phoneNumberId` | Ask the phone for the history of one chat before an anchor message. |
| `POST /session/auto-recover/:phoneNumberId` | Run the after-disconnect recovery sweep now. |
| `POST`, `GET`, `DELETE /session/avatar-backfill/:phoneNumberId` | Start, inspect or cancel a background sweep for missing profile pictures. |
| `DELETE /session/disconnect/:phoneNumberId` | Log out and remove the session. |
| `GET /session/health` | Every session's state, providers, protection limits and outbox. Not tied to a number. Service key only (`SUPABASE_SERVICE_KEY`); a user token gets `403`. |

### `/message` (all `POST /message/<action>/:phoneNumberId`)

`send` (text), `send-media` (multipart upload or `media_url`), `send-voice` (any audio, transcoded to
OGG/Opus with ffmpeg), `send-contact`, `send-location`, `send-poll`, `poll-vote`, `mark-read`, `delete`,
`edit`, `presence` (typing/recording), `presence-subscribe`, `react`.

### `/groups`

| Method and path | Purpose |
|---|---|
| `GET /groups/:phoneNumberId` | List groups. |
| `POST /groups/:phoneNumberId/join` | Join by invite code or `https://chat.whatsapp.com/<code>` link. |
| `GET /groups/:phoneNumberId/invite-info/:code` | Preview a group from an invite code. |
| `POST /groups/:phoneNumberId/create` | Create a group. |
| `GET /groups/:phoneNumberId/:groupJid` | Group metadata and members. |
| `POST`, `DELETE /groups/:phoneNumberId/:groupJid/participants` | Add or remove participants. Adding is refused with `403` unless the number is a group admin or the group lets every member add people. |
| `POST /groups/:phoneNumberId/:groupJid/invite-message` | Send a group invite to a contact who cannot be added directly. |
| `PATCH /groups/:phoneNumberId/:groupJid/subject` | Rename. |
| `PATCH /groups/:phoneNumberId/:groupJid/description` | Change the description. |
| `PUT /groups/:phoneNumberId/:groupJid/picture` | Change the picture (multipart or `media_url`). |
| `POST /groups/:phoneNumberId/:groupJid/promote`, `.../demote` | Make or unmake admins. |
| `DELETE /groups/:phoneNumberId/:groupJid/leave` | Leave the group. |
| `PATCH /groups/:phoneNumberId/:groupJid/settings` | Who can send messages / edit group info. |
| `PATCH /groups/:phoneNumberId/:groupJid/member-add-mode` | Who can add members. |
| `PATCH /groups/:phoneNumberId/:groupJid/join-approval` | Admin approval to join. |
| `PATCH /groups/:phoneNumberId/:groupJid/ephemeral` | Disappearing messages. |
| `GET /groups/:phoneNumberId/:groupJid/invite-code` | Invite code and link. |
| `POST /groups/:phoneNumberId/:groupJid/invite-code/revoke` | Revoke and return a new link. |
| `GET`, `POST /groups/:phoneNumberId/:groupJid/join-requests` | List, approve or reject join requests. |

### `/profile`

| Method and path | Purpose |
|---|---|
| `GET /profile/:phoneNumberId` | The connected number's own name and picture. |
| `PUT /profile/:phoneNumberId/picture` | Change its picture (multipart or `media_url`). |
| `PATCH /profile/:phoneNumberId/name` | Change its display name. |

### `/sticker`

| Method and path | Purpose |
|---|---|
| `POST /sticker/convert` | Convert an image (PNG, JPEG, WebP, GIF, animated or not) into a 512×512 WebP sticker. Any valid token; not tied to a number. |

### `/call` (voice, `zapo` with VoIP only)

| Method and path | Purpose |
|---|---|
| `GET /call/:phoneNumberId/capability` | `{ voice_call: boolean }`. |
| `GET /call/:phoneNumberId/events` | SSE stream of call state (how incoming calls are discovered). |
| `POST /call/:phoneNumberId/start` | Start a call. Body: `{ to, tone? }`. |
| `POST /call/:phoneNumberId/:callId/accept` | Accept an incoming call. |
| `POST /call/:phoneNumberId/:callId/end` | Hang up. |
| `GET /call/:phoneNumberId/:callId` | Call state. |
| WebSocket `/call/:phoneNumberId/:callId/audio?access_token=…` | Live audio. Same token and number checks as the HTTP routes. |

Uploads (`multipart/form-data`, field `file`) are limited to 50 MiB. Routes that accept `media_url`
download it on the server side. Only public http(s) hosts are accepted: loopback, private, link-local,
`.internal` and `.local` addresses are refused (SSRF guard). One exception: a URL of **this installation's own
Storage** (`<ECHO_PUBLIC_URL or SUPABASE_URL>/storage/v1/object/public/attachments/...`, or the same path under
`SUPABASE_URL`) is downloaded through `SUPABASE_URL` without the guard, because the address comes from the
configuration and not from the caller, and redirects are not followed. That is how Echo's edge functions
hand over attachments when everything runs in one Docker network. Anything else, including a private host
that is not the Storage, still goes through the guard.

## Contract with Echo

**Service → Echo (`WEBHOOK_URL`).** Every event is a `POST` with a JSON body to `${WEBHOOK_URL}/<route>`,
with the header `x-qr-secret: <QR_WEBHOOK_SECRET>` and no `Authorization` header. The Echo
`whatsapp-webhook` function must therefore keep `verify_jwt = false`.

| Route | Event |
|---|---|
| `/qr-message` | message received, or sent from the phone itself |
| `/qr-delivery-update` | delivery status of a sent message |
| `/qr-message-receipt` | per-participant read/delivery receipts in groups |
| `/qr-reaction` | reaction |
| `/qr-message-edited` | edit |
| `/qr-message-deleted` | deletion |
| `/qr-poll-vote` | poll vote |
| `/qr-group-event` | group change (participants, subject, …) |

Delivery goes through an outbox: retryable failures (5xx, 408, 429, network, timeout) are retried in
memory (2 s, 8 s, 30 s) and then written to `sessions/_outbox/`, which a sweeper retries every 60 s and
at boot. A permanent 4xx moves the event to `sessions/_outbox_dead/` and logs a `webhook_dead` row in
`qr_message_log`. A 404 is dropped (Echo does not know the referenced message). Echo deduplicates
replays.

**Service → Supabase.** With the service key, the service also:

- uploads media to the `attachments` Storage bucket (supabase-js, or TUS for large files);
- POSTs to `${SUPABASE_URL}/functions/v1/send-disconnect-alert` when a number disconnects (headers
  `apikey` and `Authorization: Bearer <service key>`);
- sends presence updates as Realtime broadcasts on the topic `presence-<phone_number_id>`;
- reads and updates the Echo tables listed in [How it fits into Echo](#how-it-fits-into-echo).
  Diagnostics go to `qr_message_log` and connection open/close events to `session_connection_log`.

**Echo → service.** Edge functions send `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`; the front end
sends the user's access token. See [HTTP API](#http-api).

## Session persistence

Everything the service must keep across restarts is under `sessions/` (relative to the working
directory; `/app/sessions` in the images):

| Path | Contents |
|---|---|
| `sessions/<phone_number_id>/` | Baileys credentials and keys for one number |
| `sessions/_outbox/` | webhook events waiting to be delivered |
| `sessions/_outbox_dead/` | events Echo rejected permanently |
| `sessions/_snapshots/<phone_number_id>/` | credential backups made by `migrate-provider` |

Sessions on the `zapo` provider live in the `ZAPO_PG_URL` database instead.

Mount `sessions/` on a persistent volume (Compose uses `qr_sessions`, plus `zapo_pg` for the zapo
database). If it is lost, every number has to be scanned again, and each new scan registers a new linked
device on the phone, which WhatsApp counts against the number.

**Volume owner.** The `Dockerfile` image runs as the `node` user (uid 1000), not as root, and `/app/sessions`
belongs to it: a **new** volume inherits that owner. A volume created by an older image (which ran as root)
keeps `root` as the owner, and the service then fails to write `sessions/_outbox/` and the credentials
(`Permission denied`, measured). The boot therefore checks that `sessions/` is writable and aborts with
`[FATAL]` and the command below instead of starting "healthy" while saving nothing. Fix it once before starting
the new image:

```bash
docker run --rm -u 0 -v <volume>:/app/sessions --entrypoint chown echo-qr-service -R 1000:1000 /app/sessions
```

`<volume>` is `qr_sessions` prefixed by the Compose project name (`docker volume ls`). `Dockerfile.voip` still
runs as root.

At boot the service restores every stored session whose id still exists in `phone_numbers`, one every
`RESTORE_STAGGER_MS`. **Stored sessions whose id is not in `phone_numbers` are deleted.** Never start the
service with an existing `sessions/` volume and a `SUPABASE_URL` that points to a different project.

On `SIGTERM`/`SIGINT` the service closes the sessions, waits up to 8 s for in-flight webhooks and writes
the rest to `sessions/_outbox/`.

## Health checks

- `GET /health` (public): `status`, `version`, `commit`, uptime, memory, number of sessions, pending
  webhooks and outbox state (`outbox_mem`, `outbox_disk`, `outbox_oldest_disk_age_s`, `outbox_stalled`,
  `outbox_skipped`), and the profile-picture queue (`avatars`). `outbox_stalled: true` means the disk
  queue stopped moving because Echo refuses the event at its head; that is the field to alert on.
- `GET /session/health` (service key only, `SUPABASE_SERVICE_KEY`): state and provider of each session, registered providers,
  `reachout_locks`, `message_capping` and the effective `protection_limits`. Echo's `qr-service-health`
  edge function reads both endpoints.

`phone_numbers.qr_session_status` in the database can lag behind; `/session/health` is the live state.

## Ban-risk protections

WhatsApp restricts accounts mostly because of behavior: repeated pairing, cold outreach, and volume to
people who never wrote to the number. Updating the library does not change that. What the service does:

- **One QR per connect request.** An expired QR does not trigger a new one by itself
  (`qr_expired`); the user has to ask again.
- **Pairing cap:** `QR_HOURLY_CAP` pairings per number per hour.
- **Cooldown after a fatal disconnect:** `CONNECT_COOLDOWN_AFTER_FATAL_MS` after a `401`/`403` on a
  paired session. A `403` usually means the account is suspended; re-pairing in a loop makes it worse.
- **New-contact cap:** `NEW_CONTACT_HOURLY_CAP` distinct new contacts per session per hour.
- **Reach-out lock:** when WhatsApp answers a send with error `463` (reach-out time-locked), the service
  blocks further sends to cold contacts from that number for a while (`reachout_locks` in
  `/session/health`).
- **Optional send spacing:** `SEND_MIN_GAP_MS` / `SEND_MAX_GAP_MS` (off by default, because real-time
  support should not wait).
- **Staggered restore** at boot (`RESTORE_STAGGER_MS`), so a restart does not open every session in the
  same second from the same IP.
- **Profile-picture queue** with a circuit breaker on HTTP 429.

Adding participants to groups can also get a session disconnected (`401 conflict`); invite links
(`invite-code` + `join`) are the safer path.

## Tests

```bash
cd qr-service
npm ci
npm run build          # tsc, must finish with 0 errors
npm run -s test:all    # every suite below
```

The tests run with Node's test runner (`node --import tsx --test`) and plain Node scripts, not with
Vitest. The `qr-service` job of the repository's CI (`../.github/workflows/ci.yml`) runs the same
`npm ci`, `npm run build` and `npm run -s test:all` on Node 22.

| Script | What it covers |
|---|---|
| `test:message-fallback` | fallback text for message types without native rendering (including Pix) |
| `test:outbox-sweep` | webhook outbox retry and disk sweep |
| `check:adapter` | only `src/adapter/<provider>/` may import its library |
| `test:secret-edit`, `test:zapo-parity`, `test:group-self`, `test:group-subject`, `test:group-add`, `test:zapo-wa-version` | unit tests of individual behaviors |
| `test:session-health` | `GET /session/health` only for the service key (user JWT gets `403`), with a fake Supabase Auth |
| `test:own-profile` | own profile picture against a fake WhatsApp server |
| `test:media` | resumable upload (including the `Location` rewrite), temporary media files, media dimensions |
| `test:public-url` | public × internal Storage URL (`ECHO_PUBLIC_URL`) and the SSRF guard letting the own Storage through |
| `test:qr-sse` | the QR SSE sends headers and a first byte at once, then a `: ping` every 25 s |
| `test:boot-public-url` | an invalid `ECHO_PUBLIC_URL` aborts the boot; a valid or absent one boots |
| `test:adapter-contract` | the `WhatsAppClient` contract for both providers, against `@zapo-js/fake-server` (real protocol, no phone) |
| `test:avatar-queue` | profile-picture queue |

No test talks to WhatsApp or to a Supabase project. `test:own-profile` and `test:adapter-contract` set
`NODE_TLS_REJECT_UNAUTHORIZED=0` for the local fake server only. `scripts/tus-smoke.mts` is a manual
smoke test of the resumable upload against a real Storage
(`SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node --import tsx scripts/tus-smoke.mts <bytes>`).

## License

MIT, see the repository's [LICENSE](../LICENSE) (the `license` field of `package.json` is `MIT` too).
Some dependencies use other licenses, including GPL-3.0 (`libsignal`, through Baileys); read
[NOTICE](NOTICE) before redistributing a built Docker image.

Contributions: [CONTRIBUTING.md](../CONTRIBUTING.md#qr-service) (section "QR service"). Changes: the
repository's [CHANGELOG.md](../CHANGELOG.md), which lists the app and the service versions together.
