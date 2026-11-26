# Self-hosting Echo (Docker)

This is the complete reference for the installation that `git clone` + `./install.sh` produces: the whole of Echo in
Docker on one machine, with no account, no CLI and no hosted project from anybody. If you want a hosted Supabase
project and a static host for the front end instead, read [alternatives/supabase-cloud.md](./alternatives/supabase-cloud.md).

The user interface is in Brazilian Portuguese, so screen names are given in Portuguese with a translation, for example
"Configurações > Números" (Settings > Numbers). The commands of `./install.sh` and `./echo` print their messages in
Portuguese too.

- [1. What you are installing](#1-what-you-are-installing)
- [2. Requirements](#2-requirements)
- [3. Install](#3-install)
- [4. First access](#4-first-access)
- [5. Files, the `.env` and the override](#5-files-the-env-and-the-override)
- [6. Variable reference](#6-variable-reference)
- [7. Day-to-day operation](#7-day-to-day-operation)
- [8. Backup and upgrade](#8-backup-and-upgrade)
- [9. E-mail](#9-e-mail)
- [10. Reverse proxy and addresses](#10-reverse-proxy-and-addresses)
- [11. QR service (QR numbers)](#11-qr-service-qr-numbers)
- [12. WhatsApp Cloud API (official numbers)](#12-whatsapp-cloud-api-official-numbers)
- [13. Instagram Direct (optional)](#13-instagram-direct-optional)
- [14. Web Push](#14-web-push)
- [15. AI features (optional)](#15-ai-features-optional)
- [16. Cron jobs](#16-cron-jobs)
- [17. Post-install checklist](#17-post-install-checklist)
- [18. When something does not work](#18-when-something-does-not-work)

## 1. What you are installing

Inside, the stack uses open-source components of the Supabase ecosystem (a Postgres image with the extensions Echo
needs, GoTrue for sign-in, PostgREST, Realtime and Storage), packaged in one Compose project, plus Echo's own services.
You do not need a Supabase account, the Supabase CLI or any hosted service. Nothing is published to a registry by this
repository: the four Echo images are built on your machine.

Ten services, eight of them long-running and two that run once and exit:

| Service | What it is | Image |
|---|---|---|
| `db` | Postgres 17 (the Supabase Postgres image: pg_cron, pg_net, Vault, pgsodium) | built from `docker/db/Dockerfile`, on `public.ecr.aws/supabase/postgres:17.6.1.095` |
| `db-init` | Runs once per start: password of the internal roles, the Realtime roles, the `zapo` database. Starts with the guard that refuses example secrets | same image as `db` |
| `auth` | GoTrue `v2.198.0`: sign-in, invitations, password recovery | `public.ecr.aws/supabase/gotrue:v2.198.0` |
| `storage` | Storage API `v1.98.5`, files on the `storage-data` volume | `public.ecr.aws/supabase/storage-api:v1.98.5` |
| `realtime` | Realtime `v2.174.5` | `public.ecr.aws/supabase/realtime:v2.174.5` |
| `migrate` | Runs once per `up`: Vault secrets, the migrations in `supabase/migrations`, Vault again, reload of the REST schema cache | same image as `db` |
| `rest` | PostgREST `v14.3` | `public.ecr.aws/supabase/postgrest:v14.3` |
| `functions` | The 46 edge functions in one Deno process (`denoland/deno:alpine-2.5.6`), see [architecture.md](./architecture.md#self-hosted-stack) | built from `docker/functions/Dockerfile` |
| `qr` | The QR service in [`qr-service/`](../qr-service/README.md), always on | built from `qr-service/Dockerfile` |
| `gateway` | Caddy `2.10.2` serving the front end and routing every API under **one origin** | built from `docker/gateway/Dockerfile` |

Only the `gateway` publishes a port (`8088` by default, or `80` and `443` in domain mode). Nothing else is reachable
from outside, not Postgres, not the QR service. The compose file has no bind mounts and no fixed `container_name`, so
two Echo installations can live on one machine under different project names.

Five named volumes hold everything: `db-data` (database), `storage-data` (files), `qr-sessions` (WhatsApp sessions of
the QR numbers), `caddy-data` (certificates) and `caddy-config`. Docker prefixes them with the project name (`echo_` by
default).

## 2. Requirements

| | Needed | Measured or estimated |
|---|---|---|
| Docker Engine | A recent one | measured with Docker 29.1.5 |
| Docker Compose | **v2.24.7 or newer** (`docker compose`, the plugin) | measured: 2.24.7 and 5.0.2 work; **2.20.3 does not** (it rejects the override file, does not talk to Docker 29 and does not parse `ps --format`); 2.21 to 2.23 were not tested |
| CPU | x86_64 | ARM64 images exist upstream, but building and running on ARM64 **was not tested** (the installer only warns) |
| RAM | 4 GB, or 2 GB plus swap | measured at rest with no WhatsApp number connected: 530 to 760 MiB for the eight running containers. A connected QR number uses more and was not measured. The peak while building is **1.4 GiB**, in the `gateway` image (the Vite build); that is why the installer builds one image at a time and why 2 GB without swap is risky |
| Disk | 10 GB free | measured: about 4.8 GB of images (the sum of the sizes `docker images` reports for the eight images the stack uses, with the layers a derived image shares with its base counted once: `db` 1.67 GB, `storage` 1.48 GB, `qr` 0.63 GB, `realtime` 0.56 GB, `functions` 0.22 GB, `auth` 0.09 GB, `gateway` 0.09 GB, `rest` 0.03 GB), plus the build cache, your data and your backups. The installer warns below 10 GB free |
| Network | Internet during the install and each upgrade | images come from `public.ecr.aws` and Docker Hub; the builds fetch npm packages and one Deno dependency. After the build the functions run from cache with no internet |
| Host tools | `bash`, the usual coreutils (`awk`, `sed`, `grep`), Docker; `git` to clone and to upgrade | Node on the host is optional: without Node 18+ the `.env` is generated in a throwaway `node:22.22.3-alpine3.24` container |
| Linux | Any distribution with Docker | everything was measured on WSL2. WSL serves to evaluate, not to run in production (the clock jumps and WhatsApp sessions drop when Windows sleeps) |

Timings measured: the stack comes up in 35 to 40 seconds when the images are built; building the four images from
scratch takes about 2 minutes once the base images are on the machine (117 seconds in sequence). Downloading the base
images the first time depends on your connection and was not timed.

## 3. Install

```bash
git clone https://github.com/PaNdassauro/echo.git && cd echo
./install.sh
```

With no option, the installer sets up **evaluation mode** at `http://localhost:8088`, reachable only from the machine
itself. `http://localhost` is a secure context, so the service worker, Web Push and microphone recording work.

| Mode | Command | Needs |
|---|---|---|
| Evaluation (default) | `./install.sh` | port 8088 free (`--port N` changes it) |
| Own domain, automatic HTTPS | `./install.sh --domain echo.example.com` | DNS A/AAAA pointing at the machine; ports 80 and 443 free and reachable. Caddy issues and renews the certificate and redirects 80 to 443. **Not tested with a real certificate authority** (only Caddy's internal CA) |
| Behind a proxy on the host | `./install.sh --behind-proxy --url https://echo.example.com --port 8088` | the proxy forwards to `127.0.0.1:8088` |
| Behind a proxy in a container | `./install.sh --behind-proxy --url https://echo.example.com --proxy-network traefik` | an external Docker network that already exists; the proxy points at `http://echo-gateway:80` (`<project>-gateway`) |
| IP address, private network or VPN | `./install.sh --url http://10.0.0.5:8088` | HTTP on an IP is not a secure context: no PWA, no Web Push, no audio recording |
| IP address, public | `./install.sh --url http://203.0.113.10:8088 --insecure-http` | the installer refuses without `--insecure-http`: passwords and conversations would cross the internet in clear text |

Options of `./install.sh` (`./install.sh --help` prints them):

| Option | Meaning |
|---|---|
| `--domain HOST` | own domain with automatic HTTPS (does not combine with `--url`, `--behind-proxy` or `--port`) |
| `--url URL` | the public address, `http(s)://host[:port]`, no path and no trailing slash |
| `--behind-proxy` | a reverse proxy already exists; requires `--url` (the proxy's public address) |
| `--proxy-network NAME` | proxy in a container: connects the gateway to that external Docker network (implies `--behind-proxy`) |
| `--port N` | HTTP port on the host (default 8088; with `--behind-proxy`, the port the proxy forwards to) |
| `--insecure-http` | allows `--url http://` with a public IP |
| `--yes` | asks nothing; warnings about RAM, disk and WSL stay warnings |
| `--env-only` | only generates or completes the `.env` and the override; builds and starts nothing |
| `--help` | the help text |

The environment variable `COMPOSE_PROJECT_NAME` changes the project name of a new installation (default `echo`).

What the installer does, in order:

1. Checks Docker, Compose (minimum 2.24.7), the CPU architecture, RAM, free disk, WSL and that the ports are free.
2. Generates the `.env` with new secrets (mode 600) through `docker/tools/gen-keys.mjs`, or, if a `.env` already exists,
   keeps it and only appends the keys a newer version introduced. It also creates an empty `docker-compose.override.yml`
   (comments only) and lists it in `COMPOSE_FILE`.
3. Pulls the third-party images (three attempts, with waits of 10 and 30 seconds) and builds the four Echo images one at a
   time.
4. Starts everything and waits until every service is healthy (up to 15 minutes).
5. Checks that the gateway serves `/config.js` and asks the functions whether the first access is still open.
6. Prints the address and the first-access link.

```text
[echo] Docker 29.1.5, Compose 5.0.2, x86_64, 7,7 GB RAM: ok
[echo] Gerando .env (segredos novos; modo 600)
...
[echo] Pronto.

  Echo:            http://localhost:8088
  Primeiro acesso: http://localhost:8088/setup?codigo=<code>

  Guarde o arquivo .env: ele tem as chaves do banco e do Vault. Sem ele um backup não restaura.
  Modo avaliação: o endereço fica fixo e só abre nesta máquina (127.0.0.1). Para usar um domínio depois, os dados não migram
  sozinhos: ./echo backup, docker compose -p echo down -v (apaga os volumes), remova o .env e rode ./install.sh --domain …
  Próximos passos: crie o administrador no link acima, depois ...
```

The evaluation mode opens only on `127.0.0.1`: another machine cannot reach it, which is why moving to a domain means installing
again.

**The address is fixed after the install.** The public address is stored in the database (media URLs, links) and in the
`.env`. Running `./install.sh` again on an existing installation ignores the address options and says so; changing
address means installing again, and the data does not migrate. Moving to another machine is a different thing and is
supported: [backup.md](./backup.md).

To change the address, in this order (the data is erased, so keep the backup if there is anything to keep):

```bash
./echo backup                          # keeps the data and the .env, in case you need them
docker compose -p echo down -v         # with the .env still in place; -p is the project name (echo unless you changed it)
rm .env                                # the installer refuses to create a new .env while the old volumes exist
./install.sh --domain echo.example.com
```

Do the `down -v` **before** removing the `.env`. If the `.env` is already gone and the volumes are still there, the installer stops
and lists them (restore the `.env`, `docker volume rm` them, or use another `COMPOSE_PROJECT_NAME`): it never generates new secrets
over old data. If containers of the old project still exist, `docker volume rm` fails with `volume is in use`: run
`docker ps -aq --filter label=com.docker.compose.project=<project> | xargs -r docker rm -f` first (they are still running and hold their
ports, which also matters for `--port`). That check also covers a fresh clone made next to an installation whose volumes remain.

If the install fails, read [section 18](#18-when-something-does-not-work).

## 4. First access

Open the `Primeiro acesso` link printed at the end (or run `./echo setup-link` to print it again while the first access
is still open). The `/setup` screen asks for the administrator's name, e-mail and password (8 characters or more, with
confirmation) and the organization's name. It creates the administrator (a super admin) and the organization, signs you
in and opens the dashboard.

- The code in the link is `ECHO_SETUP_TOKEN` from the `.env`. Without the code nobody can create the first account of an
  installation that is reachable from the network. If you open `/setup` without `?codigo=`, the screen asks for it.
- The screen closes by itself as soon as the installation has an administrator or an organization; opening it again
  answers that the installation is already configured. A second person cannot take over an installation that has an
  organization, even with the code.
- An installation that has an organization but no super admin (for example, one restored from partial data) stays closed
  to `/setup`. There is no command for that case: it is repaired with SQL through `./echo psql`.
- Sign-up is closed everywhere else. The Auth hook `before_user_created` is always on in this installation: only an
  e-mail with a pending invitation can create an account.

Connect a number first ([section 11](#11-qr-service-qr-numbers)): invitations give access per number, and the invitation dialog asks
for a number before it invites anyone. Then add people from "Configurações > Equipe" (Settings > Team). Without e-mail configured the
dialog gives you a link to copy for each number ([section 9](#9-e-mail)).

## 5. Files, the `.env` and the override

| File | Who writes it | What it is |
|---|---|---|
| `.env` | `./install.sh` (never edited by it after the first time, only completed) | every secret and setting of the installation. Mode 600, ignored by git. **Keep it safe and in your backup: without it a backup does not restore** (it holds the key of the Vault and the key that encrypts the organizations' AI keys) |
| `.env.example` | the repository | the model. **Do not copy it to `.env`**: its secrets are placeholders that the database refuses on purpose. The installer generates the real file |
| `docker-compose.override.yml` | you (the installer only creates it empty) | advanced settings for any service, for example protections of the QR service. Ignored by git and never edited by the installer |
| `.env.development.example` | the repository | variables of the front end in development; unrelated to the Docker installation ([development.md](./development.md)) |
| `backups/` | `./echo backup` | cold backups (ignored by git) |

`COMPOSE_FILE` in the `.env` lists the Compose files the stack uses (`docker-compose.yml`, then
`docker/compose/dominio.yml` in domain mode, `docker/compose/proxy-rede.yml` with `--proxy-network`, and
`docker-compose.override.yml`). Both `docker compose` and `./echo` read it from the `.env`, so they bring up the same
stack. `./echo` ignores a `COMPOSE_FILE` exported in your shell. A bare `docker compose` must run inside the repository
folder (the paths are relative to it); `./echo` works from anywhere.

Secrets that cannot be replaced: `./install.sh --env-only` on an existing `.env` appends keys a newer version introduced, but it never
generates `POSTGRES_PASSWORD`, `ZAPO_DB_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `VAULT_ROOT_KEY`, `AI_KEY_SECRET` or the
three Realtime keys. If one is missing it stops with an error and writes nothing: restore the line from `backups/*/.env` or `.env.bak.*`.
(`QR_WEBHOOK_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `INSTAGRAM_OAUTH_STATE_SECRET`, `ECHO_SETUP_TOKEN` and the Web Push pair can be generated
again.)

**Applying a change to the `.env`: run `./echo up`, not `./echo restart`.** `restart` restarts the existing containers
with the environment they were created with; it does not read the `.env` again (measured). `./echo up` recreates the
services whose configuration changed and waits for them to be healthy.

Example of the override (the variable names are the QR service's, documented in its README):

```yaml
services:
  qr:
    environment:
      NEW_CONTACT_HOURLY_CAP: "10"
```

## 6. Variable reference

The installer fills all of these. Optional values stay empty. A variable that does not appear here and is not in
`.env.example` is not read by the stack.

**Installation and address**

| Variable | Meaning |
|---|---|
| `COMPOSE_PROJECT_NAME` | project name; prefix of containers, volumes and images (default `echo`) |
| `COMPOSE_FILE` | the Compose files, separated by `:` (see above) |
| `ECHO_PUBLIC_URL` | the one public address, `http(s)://host[:port]`, no trailing slash. Everything that leaves the server (links in e-mails, media URLs saved in the database, webhooks, the Instagram login return) uses it |
| `ECHO_SITE_ADDRESS` | `:80` for plain HTTP, or the domain for automatic HTTPS |
| `ECHO_BIND` | `127.0.0.1` or `0.0.0.0`: which host interface the gateway port is published on |
| `ECHO_HTTP_PORT` | the host port of the gateway (8088 by default, 80 in domain mode) |
| `ECHO_HTTPS_PORT` | `443`, only in domain mode |
| `ECHO_BEHIND_PROXY` | `true` makes the gateway trust `X-Forwarded-For` from private addresses (see [reverse-proxy.md](./reverse-proxy.md)) |
| `ECHO_PROXY_NETWORK` | name of the external Docker network of your proxy, only with `--proxy-network` |

**Generated secrets.** `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `VAULT_ROOT_KEY`,
`AI_KEY_SECRET`, `REALTIME_SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`, `REALTIME_RELEASE_COOKIE`, `QR_WEBHOOK_SECRET`,
`WHATSAPP_VERIFY_TOKEN`, `INSTAGRAM_OAUTH_STATE_SECRET`, `ZAPO_DB_PASSWORD`, `ECHO_SETUP_TOKEN`, and the Web Push pair
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` with `VAPID_SUBJECT`. **Do not change them on an installation with data**: the
database password and the Vault key are written into the volume, and `AI_KEY_SECRET` encrypts the saved AI keys. The
database refuses to start, and `./echo doctor` reports, a secret that is empty, a placeholder, all zeros, or in the
wrong format.

**E-mail (optional, [section 9](#9-e-mail))**

| Variable | Meaning |
|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | generic SMTP server (the port defaults to 587) |
| `SMTP_SECURE` | `starttls`, `tls` or `none`; empty means `tls` on port 465 and `starttls` otherwise |
| `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME` | the sender address (**required when `SMTP_HOST` is set**) and name (default `Echo`) |
| `RESEND_API_KEY`, `EMAIL_FROM` | alternative to SMTP for the functions only; `EMAIL_FROM` is the sender |
| `FAILURE_ALERT_EMAILS` | comma-separated recipients of pipeline failure alerts (empty: every super admin) |
| `FEEDBACK_EMAILS` | comma-separated recipients of the in-app feedback form |
| `FEEDBACK_WEBHOOK_URL` | URL (`http://` or `https://`) that receives the feedback form as JSON |

**WhatsApp Cloud API and Instagram (optional, sections 12 and 13)**

| Variable | Meaning |
|---|---|
| `WHATSAPP_APP_SECRET` | app secret of your Meta app; used to verify the signature of every webhook from Meta. `./echo doctor` reports an ERROR if there is an official-API number and this is empty |
| `WHATSAPP_APP_SECRET_ENFORCE` | `true` (the installer writes it): refuse unsigned webhooks |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_VERIFY_TOKEN`, `INSTAGRAM_PAGINA_RETORNO`, `INSTAGRAM_GRAPH_VERSION`, `INSTAGRAM_WEBHOOK_REGISTRAR_INVALIDOS` | see [instagram/README.md](./instagram/README.md) |

**Limits and advanced (optional)**

| Variable | Meaning |
|---|---|
| `MAX_MEDIA_BYTES` | size limit of outbound media in bytes, applied to the functions and the QR service together (default 52428800, 50 MiB) |
| `FN_REQUEST_TIMEOUT_MS` | wall-clock timeout of one function call, answered with 504 (default 150000) |
| `EDGE_INTERNAL_AUTH_ENFORCE` | leave empty (enforcing). `0` is only a migration aid: server-to-server functions would log instead of refusing |
| `EDGE_INTERNAL_SECRET_KEYS` | extra `sb_secret_` keys accepted as internal callers |
| `ECHO_OUTBOUND_ALLOW_HOSTS` | exact host names, comma-separated, that organization webhooks and automation webhook nodes may reach on your private network (a CRM, n8n). Every URL chosen by a user passes an SSRF guard that refuses private addresses, loopback and cloud metadata addresses, and follows at most three redirects, checking each hop. `media_url` in the QR service routes (send-media, send-voice, sticker and photo upload) goes through the same guard (redirects followed by hand, three hops at most, each destination checked; DNS rebinding is not covered). Empty means no exception; ports and wildcards are not supported |

Fixed in the compose file, not variables: JWT expiry 1 hour, `GOTRUE_MAILER_AUTOCONFIRM=true`, password minimum length
8, invitation and recovery links valid for 1 hour, no image transformation (`ECHO_IMAGE_TRANSFORM=false`).

## 7. Day-to-day operation

```text
./echo status | logs [service] [-f] [--tail N] | up | down | restart [service]
./echo upgrade [--to vX.Y.Z] [--no-backup] [--force]
./echo backup [--dest DIR] | restore DIR
./echo reset-password EMAIL [--senha-stdin] | recovery-link EMAIL | setup-link
./echo doctor | psql [args] | env check
```

| Command | What it does |
|---|---|
| `status` | state of the services, version and the QR service queue |
| `logs [service] [-f] [--tail N]` | logs (default: the last 200 lines). Logs rotate on their own: 10 MB times 3 files per service |
| `up` | starts everything and applies a changed `.env` |
| `down` | stops everything. It never deletes volumes |
| `restart [service]` | restarts containers, **without** reading the `.env` again |
| `doctor` | read-only diagnosis, lines marked OK, AVISO (warning) or ERRO: Docker and Compose versions, architecture, RAM, disk, WSL, ports, clock, secrets (names only, never values), e-mail settings, address, each service, the Vault, official-API numbers without app secret, failed crons and pg_net responses of the last 15 minutes, and media saved with a different address. Exit 1 if there is any ERRO |
| `psql [args]` | the Postgres console as user `postgres` |
| `env check` | keys missing from or left over in the `.env` compared with `.env.example` (names only) |
| `reset-password EMAIL` | sets a new password (generates one and shows it once; `--senha-stdin` reads it from the first line of stdin, 8 characters or more) |
| `recovery-link EMAIL` | prints a password-reset link, valid for 1 hour and one use; sends no e-mail |
| `setup-link` | prints the first-access link while it is open |
| `backup`, `restore`, `upgrade` | [backup.md](./backup.md), [upgrading.md](./upgrading.md) |

`ECHO_ENV_FILE=/path/.env ./echo ...` acts only on the project of that file, which is how you run `./echo` against a
second installation on the same machine.

## 8. Backup and upgrade

- **Backup**: `./echo backup` stops the stack for a few minutes (it has to be cold to be consistent), saves the four
  data volumes and the `.env`. The backup folder is a secret: it contains the `.env`. Details, scheduling, restoring on
  the same or on a new machine: [backup.md](./backup.md).
- **Upgrade**: `./echo upgrade` makes a backup, checks out the new code, rebuilds the images and starts the stack; new
  migrations run before the REST service is recreated. Details and rollback: [upgrading.md](./upgrading.md). If the build
  fails, do not run `./echo up`: run `./install.sh`, or go back with `git checkout <previous commit> && ./install.sh` (if you follow a branch, the
  checkout stays detached: `git checkout <branch> && ./echo upgrade` to try again). On less than 4 GB of RAM the gateway, functions and qr stay
  stopped after a failed build: [upgrading.md](./upgrading.md) says how to start them.
- **Moving to another machine**: `./echo backup`, then turn the source off, copy the folder and run `./echo restore` on the
  destination ([backup.md](./backup.md)). A backup does not start a stack that was stopped: if it was down, it stays down.

## 9. E-mail

E-mail is optional. SMTP (a server of yours), Resend, or nothing: each choice and what changes on screen is in
[email.md](./email.md). In short, without e-mail the invitation dialog gives a link to copy, the login screen tells the
user to ask the administrator for a password link, and you create that link with `./echo recovery-link EMAIL` or set a
password with `./echo reset-password EMAIL`.

## 10. Reverse proxy and addresses

Recipes for nginx, Caddy, Traefik, Cloudflare Tunnel and panels that run their own proxy are in
[reverse-proxy.md](./reverse-proxy.md), including the two things that are easy to get wrong: the `X-Forwarded-For`
header and response buffering of the QR code stream.

Which address a feature needs:

- Browsers and the QR pairing screen: any address that reaches the gateway.
- **Meta (Cloud API) and Instagram**: a public HTTPS address that Meta can reach. A `localhost` or private-network
  installation cannot receive Meta's webhooks.
- Web Push: HTTPS, or `localhost`. Safari requires HTTPS.

The gateway sets the Content-Security-Policy of the front end, and it is the one in `vercel.json` with **two exceptions**, both only when
`ECHO_PUBLIC_URL` is `http://`: `ECHO_CSP_WS` (`ws://<host>` in `connect-src`, because `'self'` does not cover `ws:` in every browser) and
`ECHO_CSP_HTTP` (`http://<host>` in `img-src`, `media-src` and `connect-src`, so media saved with the canonical address loads). Only
that origin is added: with an `http://` address, media loads only when Echo is opened by the address of `ECHO_PUBLIC_URL`.

Files under `/storage/v1/` are served with their own policy (`sandbox`, no scripts) and `nosniff`. As a consequence, a PDF opened in a
tab by the raw Storage URL does not render; the **Download** button is not affected.

## 11. QR service (QR numbers)

The QR service ([`qr-service/`](../qr-service/README.md)) is part of the stack and always on; there is nothing to
install or wire. The gateway serves it under `/qr`, the functions reach it at `http://qr:3000`, and it reaches the
functions through the internal listener of the gateway. Its secrets (`QR_WEBHOOK_SECRET`, the service key) are generated
and identical on both sides.

To connect a number: "Configurações > Números" (Settings > Numbers), tab "QR Code": type a display name ("Nome de exibição"), click
"Gerar QR" (Generate QR) and scan it with the phone (WhatsApp > Linked devices > Link a device). The "Código" tab pairs with an 8-digit code instead. The page also configures the disconnection e-mail
alert of each number (available only when e-mail is configured). The provider of each number (`phone_numbers.qr_provider`) is
switched in `/ops` (admins only).

Facts to know before connecting a real number:

- QR numbers use unofficial, reverse-engineered WhatsApp clients (Baileys and zapo). This is against WhatsApp's terms,
  can break when WhatsApp changes its protocol, and numbers can be restricted or banned, especially with bulk sends, many
  new contacts per hour or adding many people to groups. The service has limits that reduce the risk and do not remove it.
  For numbers you cannot afford to lose, use the Cloud API ([section 12](#12-whatsapp-cloud-api-official-numbers)).
- The sessions live on the `qr-sessions` volume (and the `zapo` provider's data in the `zapo` database of the same Postgres).
  They are in the backup. Never run two copies of the same installation's sessions at once: the second one desynchronizes
  the encryption and risks a ban. That is why `./echo restore` asks you to confirm that the source is off.
- The tuning variables (`NEW_CONTACT_HOURLY_CAP`, `QR_HOURLY_CAP`, `SEND_MIN_GAP_MS`, `CONNECT_COOLDOWN_AFTER_FATAL_MS` and
  the others in [`qr-service/.env.example`](../qr-service/.env.example)) go in the override file, under `qr:` >
  `environment:`.
- The service image runs as the non-root user `node` (uid 1000). A fresh installation has nothing to do. The container
  refuses to boot with `[FATAL] ... não aceita escrita` if the sessions volume belongs to root: that only happens for a
  volume created by an older image, and the fix is the `chown` in the [CHANGELOG](../CHANGELOG.md).
- If the database stays down for more than about 3 minutes after a host reboot, the zapo numbers stay disconnected until
  `./echo restart qr` or a reconnection from the panel. (This follows from the service's retry window of about 3 minutes; a real host reboot with a slow database was not reproduced in the tests.)
- The pairing screen streams the QR code to the browser with Server-Sent Events (`/qr/session/qr/<id>`); the service
  sends `: conectado` at once and `: ping` every 25 seconds. Behind your own proxy this needs response buffering off
  ([reverse-proxy.md](./reverse-proxy.md)).
- No test of this repository ever opens a WhatsApp session. What was measured is the service starting, its health check,
  media and resumable uploads through the gateway, and the webhook path; connecting a real number was not.

## 12. WhatsApp Cloud API (official numbers)

Requires a public HTTPS address ([section 10](#10-reverse-proxy-and-addresses)). The credentials of the WhatsApp Business
Account (WABA) are stored per **organization**; each number is a row in `phone_numbers`; the verify token and the app
secret belong to the installation's `.env`.

1. **Meta app.** At developers.facebook.com create an app of type Business and add the WhatsApp product. You need a WABA
   and a phone number attached to it.
2. **Collect the credentials.**

   | What | Where in Meta | Where in Echo |
   |---|---|---|
   | WABA ID | WhatsApp > API setup | "Configurações > Integração" (Settings > Integration) |
   | Access token | Business settings > System users > Generate token, with `whatsapp_business_messaging` and `whatsapp_business_management`. The temporary token of the API setup page expires in 24 hours | "Configurações > Integração" |
   | App ID (optional) | App settings > Basic | "Configurações > Integração". Only needed to create or edit templates with a media header |
   | Phone number ID (not the phone number) | WhatsApp > API setup | "Configurações > Números > Business API" |
   | App secret | App settings > Basic | `.env`: `WHATSAPP_APP_SECRET` |
   | Verify token | generated by the installer | `.env`: `WHATSAPP_VERIFY_TOKEN` (read it with `grep WHATSAPP_VERIFY_TOKEN .env`) |

3. **App secret.** Put `WHATSAPP_APP_SECRET` in the `.env` and run `./echo up`. Echo then verifies the
   `X-Hub-Signature-256` of every webhook and, with `WHATSAPP_APP_SECRET_ENFORCE=true` (the default written by the
   installer), refuses the unsigned ones. A comma-separated list is accepted for several Meta apps.
4. **Webhook in Meta.** WhatsApp > Configuration > Webhook:
   - Callback URL: `https://<your-domain>/functions/v1/whatsapp-webhook` (also shown, ready to copy, in
     "Configurações > Integração"). It has to be exactly this path: the public side of the gateway answers 404 for any
     sub-path of `whatsapp-webhook`, because the QR service's internal routes live under it;
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN`;
   - subscribe to the **`messages`** field (incoming messages and status updates).
5. **Credentials in Echo.** As an admin: "Configurações > Integração", fill WABA ID, access token and optionally App ID.
   Then "Configurações > Números > Business API", add the number with a display name, the phone number ID and the phone
   number in international format. Every number of an organization uses the organization's WABA credentials. The access
   token is write-only from the browser: the screen only learns whether one is saved.
6. **Test.** Send a message from a phone to the number: it appears in the inbox within seconds. Reply from Echo and watch the
   status move `sent → delivered → read`.

Common problems: verification fails with 403 when the verify token in Meta and `WHATSAPP_VERIFY_TOKEN` differ (check for
trailing spaces); nothing arrives when the `messages` field is not subscribed or the phone number ID registered in Echo is
not the one that received the message; every webhook is refused with 401 when `WHATSAPP_APP_SECRET` is the wrong value (it
is the app secret, not the access token); outside the 24-hour window only templates can be sent ("Configurações >
Templates", approved by Meta). In Meta's development mode you can message at most five registered test numbers. This path was
not exercised against Meta in the tests of this repository.

## 13. Instagram Direct (optional)

An Instagram professional account can share the inbox of an existing number. It needs its own Meta app configuration, the
`INSTAGRAM_*` variables of the `.env` and a public HTTPS address. In the Docker installation the callback URLs are
`https://<your-domain>/functions/v1/instagram-webhook` and `https://<your-domain>/functions/v1/instagram-oauth`. The
details are in [instagram/README.md](./instagram/README.md) (in Portuguese). If you do not use it, the
`instagram-reprocessar-avisos` job does nothing.

## 14. Web Push

The installer generates a VAPID key pair, so push notifications work with nothing to configure, on `localhost` or on an
HTTPS address (Safari requires HTTPS). Users turn notifications on inside the app; subscriptions are stored in
`push_subscriptions`. To use your own pair, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (an `https:` or
`mailto:` contact) in the `.env` and run `./echo up`. Delivery of a push to a real browser was not exercised by the tests.

## 15. AI features (optional)

There is no global AI key. An organization admin saves the organization's key in Analytics, tab "AI Insights", button
"Configurar IA" (AI settings; it opens the "Configuração de Inteligência Artificial" dialog); it is encrypted with the Vault secret `ai_key_secret` (from
`AI_KEY_SECRET`). The settings screen does not read the key back, and signed-in users cannot read it through the API either:
only the functions can. Keys starting with `sk-ant-` go to Anthropic, any other key to OpenAI. Voice note transcription only works
with an OpenAI key. The reply copilot is enabled per user in the profile settings.

## 16. Cron jobs

The 16 pg_cron jobs come with the migrations and need nothing from you: the migration step creates the Vault secrets they read
(`project_url` = `http://gateway:8000`, `service_role_key`, `qr_service_url` = `http://qr:3000`, `ai_key_secret`). Schedules are in
UTC.

| Job | Schedule | What it does |
|---|---|---|
| `process-scheduled-broadcasts` | every minute | starts broadcasts whose time has come (`broadcast-execute`) |
| `dispatch-broadcast-work` | every minute | reclaims abandoned recipients, finishes broadcasts with no work left and starts workers for the rest |
| `process-scheduled-messages` | every minute | sends due scheduled messages |
| `process-survey-timeouts` | every minute | closes or reminds unanswered automation surveys |
| `aviso-de-mensagem-repetir` | every minute | retries organization webhook notifications that got no OK |
| `check-message-failure-alerts` | every minute | detects failures in the message pipeline and alerts by e-mail (if configured) and push, with a 30-minute cooldown |
| `qr-service-health` | every minute | calls the QR service health endpoint from the database and alerts when it does not answer or its disk queue is stuck |
| `merge-duplicate-conversations` | every 5 min | merges duplicate conversations of the same contact (Brazilian numbers with and without the ninth digit) |
| `instagram-reprocessar-avisos` | every 5 min | renews Instagram tokens and reprocesses failed Instagram webhooks; returns early when there is nothing to do |
| `automation-executions-retencao` | every 10 min | deletes old automation execution records |
| `close-inactive-conversations-daily` | 00:00 | closes conversations with 30 days without activity; conversations with a tag are never closed |
| `fetch-analytics-daily` | 03:00 | copies Cloud API conversation and template analytics from Meta |
| `purge-qr-message-log` | 03:30 | deletes old rows of `qr_message_log` |
| `purge-cron-history` | 04:15 | deletes `cron.job_run_details` older than 7 days |
| `aviso-de-mensagem-limpar` | 04:23 | deletes finished webhook notification records older than 30 days |
| `pipeline-heartbeat` | 01:00, 09:00, 17:00 | sends a summary e-mail of the last 8 hours, as proof that alerting works (needs e-mail) |

Disable one that does not apply, for example `fetch-analytics-daily` without Cloud API numbers:

```bash
./echo psql -c "select cron.alter_job((select jobid from cron.job where jobname = 'fetch-analytics-daily'), active := false)"
```

Use `active := true` to turn it back on. Recent runs:

```bash
./echo psql -c "select j.jobname, d.status, d.return_message, d.start_time from cron.job_run_details d join cron.job j using (jobid) order by d.start_time desc limit 50"
```

pg_net is asynchronous: a job that posts to a function is recorded as `succeeded` even if the function answers 401 or 500.
The HTTP result is in `net._http_response`; `./echo doctor` counts responses of 400 or more in the last 15 minutes. The cron
can fire a few seconds before the stack finishes starting; a failure in that first minute repeats on its own at the next one.

## 17. Post-install checklist

- [ ] `./echo doctor` ends with `Sem erros.` (the WSL warning is expected on WSL).
- [ ] `./echo status` shows every service running and healthy.
- [ ] You opened the `Primeiro acesso` link and created the administrator.
- [ ] You copied the `.env` to a safe place outside this machine.
- [ ] You made a first `./echo backup` and know where it went (and that it contains the `.env`).
- [ ] Domain or proxy modes: the address opens over HTTPS, and a message sent to a number appears without reloading the
      page (that means the WebSocket reached the gateway).
- [ ] A number is connected ([section 11](#11-qr-service-qr-numbers) or [section 12](#12-whatsapp-cloud-api-official-numbers)), a
      message from a phone appears in the inbox and a reply from Echo reaches the phone.
- [ ] E-mail, if you want it, works: invite a person and confirm the message arrives ([email.md](./email.md)).
- [ ] With the browser tab in the background, a new message produces a notification.
- [ ] `./echo psql -c "select jobname, active from cron.job order by 1"` lists the jobs you want active.

## 18. When something does not work

[troubleshooting.md](./troubleshooting.md) lists the errors seen during the tests, with the cause and what to do. Start with
`./echo doctor`, then `./echo logs <service> --tail 100`. Before pasting a log into an issue, check that it contains no key,
no password and no customer phone number.
