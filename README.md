<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/echo-logo-dark.png">
    <img src="./public/echo-logo.png" alt="Echo" width="260">
  </picture>
</h1>

<p align="center"><a href="./README.pt-BR.md">Português</a> · <strong>English</strong></p>

Echo is a multi-tenant WhatsApp inbox for teams: several WhatsApp numbers share one inbox per organization, with
conversation assignment, flow-based automations, bulk sends, analytics, a public REST API and outbound webhooks. Numbers connect
by QR code (an unofficial client, in the [`qr-service/`](./qr-service/README.md) folder of this repository) or through the official
WhatsApp Cloud API, and an Instagram Direct account can share a number's inbox.

> The user interface is in Brazilian Portuguese only. Code comments and commit messages are in Portuguese too, and so are the messages
> printed by `./install.sh` and `./echo`; the guides in `docs/` are in English.
>
> Echo is an independent project, not affiliated with, endorsed or sponsored by Meta Platforms, WhatsApp or Instagram. WhatsApp, Instagram
> and Meta are trademarks of their respective owners.

## Install

You need a machine with Docker. No account, no CLI and no hosted project of anybody's.

```bash
git clone https://github.com/PaNdassauro/echo.git && cd echo
./install.sh
```

It generates a `.env` with new secrets, builds the images on your machine, starts everything, waits until it is healthy and prints
the address and the link of the first-access screen:

```text
  Echo:            http://localhost:8088
  Primeiro acesso: http://localhost:8088/setup?codigo=<code>
```

With no option, Echo listens only on this machine (127.0.0.1): use it to try Echo on your own computer. On a server, install with
`--domain`, `--url` or `--behind-proxy` from the start (see below), because the address cannot change later without reinstalling.

Keep the `.env`: it holds the keys of the database and of the Vault, and **a backup does not restore without it**.

### Requirements

| | |
|---|---|
| Docker | Docker Engine (measured with 29.1.5) and the Compose plugin **v2.24.7 or newer** (2.20.3 does not work) |
| CPU | x86_64. ARM64 was not tested |
| RAM | 4 GB, or 2 GB plus swap. At rest, with no WhatsApp number connected, the stack uses 530 to 760 MiB; building the front end peaks at 1.4 GiB, which is why the installer builds one image at a time |
| Disk | 10 GB free. The images measured about 4.8 GB (the sizes `docker images` reports, shared layers counted once); the rest is margin for the build cache, your data and backups |
| Network | Internet during the install and upgrades (images and packages are downloaded), and outbound access at run time to WhatsApp, Meta and whatever e-mail or AI provider you configure. The functions themselves need no download at run time |
| Time | the stack starts in 35 to 40 seconds; building the four images takes about 2 minutes once the base images are on the machine |
| OS | Linux. The measurements were made on WSL2, which is fine to try Echo and not for production; the smoke test also passes on the GitHub Ubuntu runner |

### First access

Open the `Primeiro acesso` link. The screen asks for your name, e-mail, a password (8 characters or more) and the organization name,
creates the administrator and signs you in. The link only works while the installation has no administrator; `./echo setup-link` prints
it again. Without e-mail configured, forgotten passwords are reset with `./echo reset-password <e-mail>`.

### Connect a number

"Configurações > Números" (Settings > Numbers), tab "QR Code": type a display name ("Nome de exibição"), click "Gerar QR" (Generate QR)
and scan it with the phone (WhatsApp > Linked devices > Link a device). The "Código" tab pairs with an 8-digit code instead. QR numbers use reverse-engineered WhatsApp clients: that is against WhatsApp's terms and numbers can be
restricted or banned (read [Known limitations](#known-limitations)). For official numbers use the Cloud API, which needs a public HTTPS
address and a Meta app: [docs/self-hosting.md](./docs/self-hosting.md#12-whatsapp-cloud-api-official-numbers).

### Other ways to install

Same installer, other addresses. Each one has its details in [docs/self-hosting.md](./docs/self-hosting.md#3-install).

- **Own domain, automatic HTTPS:** `./install.sh --domain echo.example.com`. DNS pointing at the machine, ports 80 and 443 free. Caddy gets and renews the certificate (tested with Caddy's internal authority only, not with a real one).
- **Behind a proxy you already run:** `./install.sh --behind-proxy --url https://echo.example.com --port 8088`, or `--proxy-network NAME` for a proxy in a container. Recipes for nginx, Caddy, Traefik and Cloudflare Tunnel: [docs/reverse-proxy.md](./docs/reverse-proxy.md).
- **By IP address:** `./install.sh --url http://10.0.0.5:8088` (private network or VPN). A public IP needs `--insecure-http`, and plain HTTP on an IP is not a secure context: no app install, no push notifications, no audio recording.

The address is fixed after the install: to change it, install again (the data does not move).

## Day to day

```text
./echo status | logs [service] [-f] [--tail N] | up | down | restart [service]
./echo upgrade [--to vX.Y.Z] [--no-backup] [--force]
./echo backup [--dest DIR] | restore DIR
./echo reset-password EMAIL [--senha-stdin] | recovery-link EMAIL | setup-link
./echo doctor | psql | env check
```

`./echo doctor` is the first thing to run when something looks wrong: it reads the state and prints OK, AVISO (warning) or ERRO lines
with the fix. After editing the `.env`, apply it with `./echo up` (`restart` does not read the file again). Logs rotate by themselves
(10 MB times 3 files per service).

**Upgrade:** `./echo upgrade` makes a backup, gets the new code, rebuilds the images and starts the stack; new migrations run before the
REST service is recreated. Read the [CHANGELOG](./CHANGELOG.md) first. A plain `git pull` upgrades nothing, because the migrations live inside
the database image. [docs/upgrading.md](./docs/upgrading.md).

**Backup:** `./echo backup` stops the stack for a few minutes and saves the database, the files, the WhatsApp sessions, the certificates and the
`.env` into `backups/echo-<date>/` (treat that folder as a secret). `./echo restore <folder>` brings them back on the same machine or, after `./install.sh` there, on a new
server, once you confirm that the source is off. [docs/backup.md](./docs/backup.md).

More: [e-mail](./docs/email.md) (SMTP, Resend or none), [troubleshooting](./docs/troubleshooting.md), [architecture](./docs/architecture.md).

## What was not tested

The installation was measured end to end (a smoke test of 156 checks, a cold backup and restore into a new folder, an upgrade with a new
migration, the three install modes), and some things were not:

- **ARM64** (build and run), **Podman**, rootless Docker and **SELinux**.
- **A real certificate authority** in domain mode (automatic HTTPS and `wss` were tested with the gateway's internal authority only), and a real proxy in front: the recipes in `docs/reverse-proxy.md` were not each run.
- **SMTP over TLS with authentication** against a real provider (only plain SMTP to a local test server). Resend was not exercised either.
- **Native Linux beyond the smoke test**: the measurements ran on WSL2. On native Linux only the CI smoke test ran (GitHub Ubuntu runner).
- **A real WhatsApp number**: no test opens a session. Memory use with connected numbers, the Cloud API against Meta, Instagram and Web Push delivery to a browser were not exercised.
- Firefox and Safari.
- `./echo upgrade` without `--to` against a real remote, and an upgrade whose migration fails halfway.

If you hit one of these, please open an issue with the output of `./echo doctor`.

## What is inside

Echo is built on Postgres, and the Docker installation packages open-source components of the Supabase ecosystem (the Supabase Postgres image,
GoTrue for sign-in, PostgREST, Realtime and Storage) next to Echo's own services. You do not need a Supabase account or its CLI: the images are
pulled from a public registry and everything runs on your machine.

```
                Meta (Cloud API)                    QR service (qr-service/)
                webhook, signed                     Node, Baileys / zapo, one session per number
                       │                              │  /qr-*  (header x-qr-secret)
                       ▼                              ▼
  Browser ──► gateway (Caddy: front end + one origin for every API, TLS in domain mode)
                       │
        ┌──────────────┼───────────────────────────────────────────────┐
        ▼              ▼              ▼              ▼                 ▼
      auth          rest           realtime       storage          functions
     (GoTrue)    (PostgREST)                                    (46 edge functions,
        └──────────────┴──────┬───────┴──────────────┘            one Deno process)
                              ▼
              Postgres 17: RLS on every table, RPCs, triggers, pg_cron + pg_net, Vault
```

Postgres is the source of truth: authorization lives in RLS policies and RPCs, scheduled work runs in pg_cron and reaches the functions through
pg_net. The functions integrate with Meta and the QR service. The front end reads through supabase-js and receives changes through Realtime. Details:
[docs/architecture.md](./docs/architecture.md).

| Layer | Technology |
|---|---|
| Front end | React 18, TypeScript, Vite 5, Tailwind CSS 3, shadcn/ui (Radix), TanStack Query, React Router 6, react-virtuoso, Recharts, @xyflow/react, zod, vite-plugin-pwa |
| Back end | Postgres 17 with RLS, GoTrue, PostgREST, Realtime, Storage, edge functions in Deno, pg_cron, pg_net, Vault |
| Channels | WhatsApp Cloud API; the QR service in `qr-service/` (Node 22, Express, Baileys and zapo); Instagram Messaging API (optional) |
| E-mail and push | SMTP or Resend (optional), Web Push with VAPID |
| Tests | Vitest + Testing Library, Deno test (functions), `node --test` with tsx (QR service), a Docker smoke test |

## Features

**Inbox**
- Shared inbox per organization with unread counters, filters and global search.
- Assignment: main owner plus co-owners, transfer between agents, closing with a reason.
- Visibility per number (agents see the conversations of the numbers they have access to), optional isolation by sector per number.
- Text, images, video, documents, voice notes (recorded in the browser), stickers, location, contacts, polls, reactions, replies, mentions, edit and delete.
- WhatsApp groups on QR numbers: participants, invites, join requests, group creation.
- Internal notes, tags, quick replies, contacts, scheduled messages, history import from CSV chat exports.
- Optional AI helpers that use each organization's own API key (OpenAI, or Anthropic for some features): reply copilot, voice note transcription (OpenAI key only) and analytics insights.
- Voice calls on QR numbers that use the `zapo` provider, when the QR service is built with voice support (not part of the Docker stack).

**Automation and campaigns**
- Visual flow builder with triggers, messages, media, buttons, lists, conditions, delays, business hours, webhooks and surveys.
- Bulk sends from a spreadsheet, with Cloud API templates, scheduling and per-recipient status; a broadcast keeps running after the tab is closed.
- Action buttons in the chat (`webhook`, `link`, `import_history`), optionally per number.

**Integrations**
- Public REST API (`echo-api`) with an organization API key in the `x-api-key` header; interactive docs at `/api-docs`.
- Outbound webhooks per organization (`message.received`, `message.sent`, `message.status`, `note.created`, `conversation.read`, `action_button.clicked`), with retries.
- Cloud API templates (create, edit, delete, send) and WhatsApp Flows (list and send).

**Platform**
- Installable PWA and Web Push, sound, tab title and favicon badges, so notifications work with the tab in the background.
- Analytics (volume, agents, response times, hourly heatmap, close reasons, templates, cost estimate) and an attendance report with `.xlsx` export.
- E-mail alerts when a number disconnects or the message pipeline fails (when e-mail is configured), and a periodic heartbeat.
- Super admin area (`/super-admin`) and an operations panel (`/ops`) for QR connection health.

## Known limitations

- **One node.** No high availability, no Realtime across several nodes, no external Postgres or S3 for Storage, no image transformation service (the
  front end uses original images; thumbnails and resized variants are off). Load beyond the measured numbers of the tests was not explored.
- **The address is fixed after the install**, because it is stored in the database. Changing it on an installation with data is not supported.
- **Nothing is published**: there are no ready-made images; the four Echo images are built on your machine (about 2 minutes, plus the first download).
- **Fixed time zone.** Analytics, the attendance report, the heartbeat e-mail and some formatting use `America/Sao_Paulo`.
- **Brazilian Portuguese only**, and phone normalization has special handling for Brazilian numbers (the mobile "ninth digit").
- **QR numbers use unofficial libraries.** The QR service talks to WhatsApp through reverse-engineered clients (Baileys, zapo). This is not allowed by
  WhatsApp's terms, can stop working when WhatsApp changes its protocol, and numbers can be restricted or banned, especially with bulk sends, many new
  contacts per hour or adding many people to groups. The service has limits that reduce, but do not remove, that risk. Use the Cloud API for numbers you
  cannot afford to lose.
- **Media files are public to anyone who has their (unguessable) URL**, and isolation between organizations relies on RLS policies. Read
  [SECURITY.md](./SECURITY.md) before exposing an installation to people you do not trust.
- **`xlsx` 0.18.5 from npm has known vulnerabilities** (CVE-2023-30533, CVE-2024-22363); fixed releases are published only on the SheetJS CDN. The library only
  parses spreadsheets that a signed-in user uploads to the broadcast importer, and writes the example sheet and the report exports. If that risk matters,
  replace it with the SheetJS CDN build.
- **`npm audit` reports vulnerabilities** in development dependencies (the Vitest UI server, `tar`, `tinypool`, never run in production) and in `zod` 3.x
  and `yaml`. Review it before you expose an installation.

## Alternative: Supabase Cloud or the Supabase CLI, plus a static host

If you prefer a hosted Supabase project, or you want the front end on Vercel or any static host, Echo still runs that way: apply the migrations with the
Supabase CLI, deploy the functions, set the secrets and host the `dist/` of `npm run build`. It is not the recommended path and it has more steps. The
guide is [docs/alternatives/supabase-cloud.md](./docs/alternatives/supabase-cloud.md). The QR service can also run alone from
[`qr-service/docker-compose.yml`](./qr-service/README.md) for that setup.

## Development

```bash
git clone https://github.com/PaNdassauro/echo.git && cd echo
npm ci
npx supabase start                                    # local Supabase, applies the migrations
cp .env.development.example .env.development.local    # the front end's VITE_* variables, not .env.example
# fill VITE_SUPABASE_PUBLISHABLE_KEY with ANON_KEY from: npx supabase status -o env
# first admin: npm run bootstrap:admin (see docs/development.md)
npm run dev                                           # http://localhost:8080
```

Commands, the Docker-installation rules, the smoke test and the checks to run before a pull request are in
[docs/development.md](./docs/development.md) and [CONTRIBUTING.md](./CONTRIBUTING.md). The most used ones:

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc -b`, the type check that counts (`npm run build` does not check types) |
| `npm test` | Vitest: `src/**/*.test.{ts,tsx}` and `scripts/*.test.mjs` |
| `npm run check:edge` · `npm run test:edge` · `npm run test:router` · `npm run check:verify-jwt` | the edge functions and their runtime (Deno 2.5.6) |
| `npm run smoke:selfhost` | end-to-end smoke test of the Docker installation (about 5 minutes) |
| `cd qr-service && npm ci && npm run build && npm run -s test:all` | build and tests of the QR service (a separate npm project) |

## Repository layout

```
src/                     front end: pages, components, hooks (supabase-js + Realtime), lib (with tests next to the code)
supabase/
  migrations/            the schema: baseline, Auth/Storage, reference data, cron jobs, first access
  functions/             edge functions, one folder each, shared code in _shared/
  config.toml            verify_jwt of every function, settings of the Supabase CLI stack
docker/                  the Docker installation: db, migrate, gateway, functions runtime, compose per mode, gen-keys
docker-compose.yml       the stack
install.sh  echo         the installer and the operation CLI
qr-service/              QR service (own npm project): src/, tests/, Dockerfile, docker-compose.yml, README, NOTICE
scripts/                 operational scripts, the smoke test (smoke-selfhost.sh, smoke/)
tests/                   Deno and SQL tests
docs/                    self-hosting, reverse-proxy, backup, upgrading, email, troubleshooting, architecture, development, alternatives/
.github/                 CI, issue and pull request templates
```

## Contributing, security, support

- [CONTRIBUTING.md](./CONTRIBUTING.md): setup, checks, commit style. [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- [SECURITY.md](./SECURITY.md): how to report a vulnerability, and what the operator has to configure.
- [SUPPORT.md](./SUPPORT.md): where to ask for help.
- [CHANGELOG.md](./CHANGELOG.md): one changelog for the app and the QR service.

## License

MIT, see [LICENSE](./LICENSE), for Echo's own code (the whole repository, `qr-service/` included). The third-party files and dependencies
listed in the notices keep their own licenses. Third-party notices (notification sound, audio encoder worker, ThumbHash decoder, UI
components, emoji data, the images the Compose file references, dependency licenses) are in [NOTICE](./NOTICE); the QR service's dependencies, including GPL-3.0
`libsignal` through Baileys, are detailed in [qr-service/NOTICE](./qr-service/NOTICE).
