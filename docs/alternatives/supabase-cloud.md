# Alternative: Supabase Cloud (or the Supabase CLI) plus a static host

> **This is not the recommended way to install Echo.** The recommended way is `git clone` and `./install.sh`, which runs
> everything with Docker and needs no Supabase account or CLI: see [../self-hosting.md](../self-hosting.md). This guide
> is for people who prefer a hosted Supabase project, a managed Postgres they already pay for, or who want the front end
> on Vercel or another static host. It was the original way to run Echo and still works, with the invariant that
> **without `ECHO_PUBLIC_URL`, without a filled `/config.js` and without `ECHO_SETUP_TOKEN` the behavior is the same
> as before the Docker installation existed** (public URL = `SUPABASE_URL`; the front end reads its `VITE_*`
> variables; `/setup` is off).

This guide takes you from an empty Supabase project to a working installation. Follow the sections in order. Every
name below (secrets, functions, scripts, cron jobs) is the exact name used by the code.

What changed since the first version of this guide:

- `supabase/migrations/` now has **five** files (section 4). The new one, `20260102000000_primeiro_acesso.sql`, adds the
  functions behind the first-access screen and revokes `get_decrypted_ai_key` from signed-in users.
- The front end reads its settings from `.env.development.local` in development (`.env.development.example`), and
  `.env.example` at the root is now the Docker stack's model: do not copy it for the front end (section 10).
- Three optional edge secrets are new: `ECHO_SETUP_TOKEN` (turns on `/setup`, section 9), `SMTP_*` (generic SMTP for the
  Echo e-mails, section 15) and `ECHO_OUTBOUND_ALLOW_HOSTS` (section 6). `ECHO_PUBLIC_URL` is optional here (section 6).

The UI is in Brazilian Portuguese, so screen names are given in Portuguese with a translation, for example
"Configurações > Números" (Settings > Numbers).

- [1. What you are installing](#1-what-you-are-installing)
- [2. Prerequisites](#2-prerequisites)
- [3. Supabase project](#3-supabase-project)
- [4. Apply the migrations](#4-apply-the-migrations)
- [5. Vault secrets](#5-vault-secrets)
- [6. Edge function secrets](#6-edge-function-secrets)
- [7. Deploy the edge functions](#7-deploy-the-edge-functions)
- [8. Auth settings](#8-auth-settings)
- [9. First administrator](#9-first-administrator)
- [10. Front end](#10-front-end)
- [11. QR service (QR numbers)](#11-qr-service-qr-numbers)
- [12. WhatsApp Cloud API (official numbers)](#12-whatsapp-cloud-api-official-numbers)
- [13. Instagram Direct (optional)](#13-instagram-direct-optional)
- [14. Web Push](#14-web-push)
- [15. E-mail](#15-e-mail)
- [16. AI features (optional)](#16-ai-features-optional)
- [17. Cron jobs](#17-cron-jobs)
- [18. Post-install checklist](#18-post-install-checklist)
- [19. Upgrading](#19-upgrading)

## 1. What you are installing

| Component | Where it runs | Required |
|---|---|---|
| Database, Auth, Realtime, Storage, edge functions | A Supabase project (hosted on supabase.com, or the local CLI stack) | Yes |
| Front end (`dist/` after `npm run build`) | Any static host (a `vercel.json` is included) | Yes |
| QR service (`qr-service/` folder) | A container or Node 22 process with a persistent disk, reachable over HTTPS | Only for QR numbers |
| Meta app with WhatsApp | developers.facebook.com | Only for Cloud API numbers |
| SMTP server or Resend account | Yours, or resend.com | Only for e-mail (invitations, alerts, feedback) |

You need at least one channel (QR service or Cloud API) to send and receive messages.

## 2. Prerequisites

- Node 22 (`.nvmrc`) and npm.
- Docker, for the local Supabase stack and, if you use it, for the QR service image.
- The Supabase CLI. It is a dev dependency of this repository, so `npx supabase ...` uses the pinned version after
  `npm ci`. The commands below were written for that version (2.x; the migration commands were exercised against 2.84.4).
- `openssl` (or any way to generate random strings) for the shared secrets.
- A domain with HTTPS for the front end and, if used, for the QR service.

```bash
git clone https://github.com/PaNdassauro/echo.git echo && cd echo
npm ci
```

## 3. Supabase project

**Hosted (supabase.com).** Create a project and note:

- the project ref (the `<ref>` in `https://<ref>.supabase.co`);
- the anon key (or publishable key), for the front end;
- the **legacy JWT `service_role` key** (Project Settings > API Keys, legacy keys tab). Use this JWT, not an
  `sb_secret_` key, wherever this guide asks for the service role key: the cron jobs call functions that are behind
  `verify_jwt = true`, where the gateway only accepts JWTs, and the QR service compares the key byte for byte with
  what the edge functions send;
- the database password (asked by `supabase link` / `db push`).

Then link the repository:

```bash
npx supabase login
npx supabase link --project-ref <ref>
```

**Local (development).** `npx supabase start` runs the whole stack in Docker, applies the migrations and runs
`supabase/seed.sql`. `npx supabase status -o env` prints `API_URL`, `ANON_KEY` and `SERVICE_ROLE_KEY`. The
default ports are API 54321, database 54322, Studio 54323 and the local mail viewer 54324. Sections 4 and 5 are
already done for you locally; continue at section 6.

The Docker distribution of Supabase itself has not been tested with Echo. If you want to run everything on your own
machine, use the Docker installation in [../self-hosting.md](../self-hosting.md), which is the tested one.

## 4. Apply the migrations

`supabase/migrations/` has five files, applied in order:

| File | Content |
|---|---|
| `20260101000000_baseline.sql` | Extensions (pg_cron, pg_net, pg_trgm, pgcrypto, supabase_vault, uuid-ossp), types, functions, tables, indexes, triggers, RLS policies, the Realtime publication and grants |
| `20260101000100_auth_e_storage.sql` | Trigger on `auth.users` that creates `public.profiles`; bucket `attachments` (public, 1 GiB per file, any MIME type) and its policies |
| `20260101000200_dados_de_referencia.sql` | System notice templates (`system_alerts`), all inactive |
| `20260101000300_cron.sql` | The 16 pg_cron jobs (section 17). They read URLs and keys from the Vault, so they need section 5 |
| `20260102000000_primeiro_acesso.sql` | `instalacao_precisa_setup()` and `instalacao_concluir_setup()` (first-access screen, `service_role` only) and `REVOKE EXECUTE ON FUNCTION public.get_decrypted_ai_key(uuid) FROM authenticated` (only the edge functions, which use the service role, read the AI key) |

Hosted:

```bash
npx supabase db push
```

Do **not** use `--include-seed`: `supabase/seed.sql` writes local-only values (the local gateway URL and a service
role key signed with the default local JWT secret) into the Vault.

**A project that already has the first four files applied** (an installation made before the fifth file existed, or
one whose history the CLI does not know) needs the history aligned first, otherwise `db push` tries to apply the
baseline again:

```bash
npx supabase migration repair 20260101000000 20260101000100 20260101000200 20260101000300 --status applied
npx supabase db push --dry-run     # must list only 20260102000000_primeiro_acesso.sql
npx supabase db push
```

With a local Postgres without TLS, `--db-url '...?sslmode=disable'` only works together with `--debug` in CLI 2.84.4:
without it the CLI drops the parameter and fails with `tls error (server refused TLS connection)`. This was measured, not
read in the CLI documentation.

The bucket allows files up to 1 GiB, but the project-wide upload limit (Storage settings in the dashboard, and your
plan's limit) still applies. Set it to the largest file you want to accept.

## 5. Vault secrets

SQL functions and cron jobs read four secrets through `public._segredo_obrigatorio(name)`. There are no fallbacks: a
missing secret raises error `55000` with a hint, visible in `cron.job_run_details`.

Run in the SQL editor (hosted) as `postgres`:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<legacy service_role JWT>', 'service_role_key');
select vault.create_secret('https://<your-qr-service-host>', 'qr_service_url');
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'ai_key_secret');
```

| Secret | Used by | Without it |
|---|---|---|
| `project_url` | Every job that calls an edge function through pg_net | The dispatchers (scheduled broadcasts, broadcast workers, scheduled messages, survey timeouts, the daily analytics snapshot, and Instagram reprocessing when there is work) fail on every run. Webhook retries and the detectors (failure alerts, QR health notifications, heartbeat) log a warning and send nothing |
| `service_role_key` | Same jobs (sent as `Authorization: Bearer`) | Same as above. The value must be the legacy JWT (it starts with `eyJ`): any other value is rejected with the same error code and a hint |
| `qr_service_url` | `check_qr_service_health` (job `qr-service-health`) | The `qr-service-health` job fails every minute with `Segredo "qr_service_url" ausente no Vault`. Disable the job if you have no QR service (section 17) |
| `ai_key_secret` | `set_ai_api_key`, `get_decrypted_ai_key` | Organizations cannot save an AI key, so copilot, transcription and AI insights are unavailable. Changing this value later makes the keys already saved unreadable |

pg_net is asynchronous: a job that posts to an edge function is recorded as `succeeded` in `cron.job_run_details`
even when the function answers 401 or 500. The HTTP result is in `net._http_response` (checklist in section 18).

To change a value later:

```sql
select vault.update_secret((select id from vault.secrets where name = 'project_url'), '<new value>');
```

## 6. Edge function secrets

The runtime injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and, on projects with the new
API keys, `SUPABASE_SECRET_KEYS`. Do not set them. Everything else comes from the table below.
[`supabase/functions/.env.example`](../../supabase/functions/.env.example) is the complete list (this table plus the
injected ones, commented out), with what each function does without it: copy it and fill it in.

Hosted: put the values in a file outside git and run
`npx supabase secrets set --env-file <file> --project-ref <ref>` (or `secrets set NAME=value`). Local: copy the
example to `supabase/functions/.env` (ignored by git) and run
`npx supabase functions serve --env-file supabase/functions/.env`.

| Variable | Required | What it is for |
|---|---|---|
| `SITE_URL` | **Yes** | Public URL of the front end, no trailing slash (`https://echo.example.com`). Without it creating an invitation fails with 500 `SITE_URL not configured` (except when the call comes from `localhost`), e-mails are not sent (they use it for links and the logo) and `instagram-oauth` answers 500 |
| `ECHO_PUBLIC_URL` | Optional | The one public address of an installation where the API and the front end share an origin (the Docker installation sets it). **Leave it unset here.** Unset, the public address is `SUPABASE_URL`, which is what a hosted project needs. Set it only if you put your own gateway in front of Supabase |
| `ECHO_SETUP_TOKEN` | Optional | At least 32 hexadecimal characters. Turns on the `/setup` first-access screen (the `primeiro-acesso` edge function): the person who knows the code creates the first administrator. Empty means `/setup` is off, which is the safe default. It is an alternative to `npm run bootstrap:admin` (section 9) and has only been exercised on the Docker installation |
| `ECHO_OUTBOUND_ALLOW_HOSTS` | Optional | Exact host names, comma-separated, that organization webhooks and automation webhook nodes may reach even though they resolve to a private address (for a CRM or n8n instance on your network). Empty means none. Every URL chosen by a tenant is checked by an SSRF guard (private ranges, loopback, cloud metadata, 3 redirects at most) whether this is set or not. In the QR service, `media_url` goes through the same guard (redirects followed by hand, three hops at most, each destination checked; DNS rebinding is not covered) |
| `QR_SERVICE_URL` | With QR numbers | Base URL of the QR service (`qr-service/`). Every send, edit, delete, reaction, read receipt and group action on a QR number, automations and surveys on QR numbers, and the `/ops` panel fail with `QR_SERVICE_URL not configured` without it |
| `QR_WEBHOOK_SECRET` | With QR numbers | Shared secret sent by the QR service in the `x-qr-secret` header. Required on both sides and identical: without it every `/qr-*` route of `whatsapp-webhook` answers 503 (a different value gets 401), so nothing from QR numbers is received, and the QR service refuses to start without its own copy |
| `WHATSAPP_VERIFY_TOKEN` | With Cloud API numbers | Any long random string; you type the same value in the Meta dashboard. Without it the Meta verification request gets 403 |
| `WHATSAPP_APP_SECRET` | Recommended with Cloud API | App secret of the Meta app, used to check `X-Hub-Signature-256`. Accepts a comma-separated list (one per Meta app). Without it the signature is not checked (a warning is logged) |
| `WHATSAPP_APP_SECRET_ENFORCE` | Optional | `true` rejects (401) Meta webhooks without a valid signature, but only when `WHATSAPP_APP_SECRET` is set. Turn it on after the logs show `Assinatura da Meta conferida` for your numbers |
| `EDGE_INTERNAL_AUTH_ENFORCE` | Optional | Server-to-server functions (called by cron jobs, the QR service and other functions) reject callers without a service credential with 401. `0` switches to log-only mode, meant only for migrating an installation with old callers |
| `EDGE_INTERNAL_SECRET_KEYS` | Optional | Extra `sb_secret_` keys (comma-separated) accepted as internal callers, besides the service role key |
| `MAX_MEDIA_BYTES` | Optional | Outbound media size limit in bytes for `whatsapp-send-media` and scheduled messages. Default 52428800 (50 MiB) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME` | For e-mail (option 1) | Generic SMTP for the Echo e-mails. `SMTP_SECURE` is `starttls`, `tls` or `none` (empty: `tls` on port 465, otherwise `starttls`). The sender is `EMAIL_FROM` if set, otherwise `"<SMTP_SENDER_NAME> <SMTP_ADMIN_EMAIL>"`. Section 15 |
| `RESEND_API_KEY` | For e-mail (option 2) | Resend API key. Used only when `SMTP_HOST` is empty. Without any transport no e-mail is sent (invitations are still created, with a link to copy; alerts still go out as push) |
| `EMAIL_FROM` | With Resend | Sender on a domain verified in Resend, for example `Echo <noreply@example.com>`. With SMTP it is optional. Without a sender e-mails are not sent and the logs say so |
| `FAILURE_ALERT_EMAILS` | Recommended | Comma-separated recipients of infrastructure alerts (`send-failure-alert`). Without it the alerts go to every super admin |
| `FEEDBACK_EMAILS` | Optional | Comma-separated recipients of the in-app feedback form. Without it `send-feedback-email` answers 500; the form still works if `VITE_FEEDBACK_WEBHOOK_URL` is set in the front end |
| `VAPID_PUBLIC_KEY` | For Web Push | Public VAPID key (same value as the front end's `VITE_VAPID_PUBLIC_KEY`) |
| `VAPID_PRIVATE_KEY` | For Web Push | Private VAPID key |
| `VAPID_SUBJECT` | For Web Push | `mailto:` or `https:` contact for the push services. `send-web-push` refuses to send without the three VAPID values |
| `INSTAGRAM_APP_ID` | For Instagram | See [docs/instagram/README.md](../instagram/README.md) |
| `INSTAGRAM_APP_SECRET` | For Instagram | Same. Without it every POST to `instagram-webhook` answers 401 |
| `INSTAGRAM_VERIFY_TOKEN` | For Instagram | Same |
| `INSTAGRAM_OAUTH_STATE_SECRET` | For Instagram | Same. At least 32 characters, otherwise connecting an account answers 503 |
| `INSTAGRAM_OAUTH_REDIRECT_URI` | Optional | Default `<public address>/functions/v1/instagram-oauth` (`ECHO_PUBLIC_URL`, or `SUPABASE_URL` when it is unset) |
| `INSTAGRAM_GRAPH_VERSION` | Optional | Default `v25.0` |
| `INSTAGRAM_PAGINA_RETORNO` | Optional | Default `<SITE_URL>/instagram-conexao.html` |
| `INSTAGRAM_WEBHOOK_REGISTRAR_INVALIDOS` | Optional | `false` stops recording a fingerprint of unsigned Instagram webhooks |

Generate the shared secrets with `openssl rand -hex 32`.

## 7. Deploy the edge functions

```bash
npx supabase functions deploy --project-ref <ref>
```

Without a function name the CLI deploys every folder in `supabase/functions/`. The `verify_jwt` of each function is
read from `supabase/config.toml`, which declares all of them: keep that file as it is unless you know why a value
changes (the comments there explain each group). Secrets set after a deploy are picked up by the functions without a
redeploy.

## 8. Auth settings

Hosted, in Authentication settings:

- **Site URL:** the front end URL.
- **Redirect URLs:** `https://<front-end-host>/**`. Password recovery returns to `/auth`, and the sign-up
  confirmation of an invited user returns to `/auth?invite=<token>`.
- **Password recovery template (recommended):** the app expects the link format of
  [`supabase/templates/recovery.html`](../../supabase/templates/recovery.html), which does not spend the one-time token
  when an e-mail scanner opens the link. Apply it with
  `node scripts/aplicar-template-recuperacao.mjs --ref <ref>` (dry run, shows the diff) and then the same command
  with `--aplicar`; it needs `SUPABASE_ACCESS_TOKEN` or a `supabase login`. You can also paste the HTML into the
  "Reset password" template in the dashboard. The local stack loads it from `config.toml`.
- **SMTP:** the built-in sender of Supabase Auth is rate limited and meant for testing. Configure your own SMTP for
  sign-up confirmation and password recovery e-mails.
- **Invite-only sign-up (hook `before_user_created`):** `public.hook_before_user_created` (in the baseline) rejects
  any sign-up without a pending invitation in `user_invitations`. It is **off** by default because on a new database
  nobody can invite the first administrator. Turn it on **after** section 9: hosted, Authentication > Hooks >
  "Before User Created" > Postgres function `public.hook_before_user_created`; local, set `enabled = true` under
  `[auth.hook.before_user_created]` in `supabase/config.toml` and restart the stack. With the hook off, anyone who
  can reach your Auth endpoint can create a user. Such a user belongs to no organization and sees nothing, but you
  should still turn the hook on.

The `/auth` page only shows the sign-up form when the URL carries an invitation, so team members join through
invitations (section 9).

## 9. First administrator

`scripts/bootstrap-admin.mjs` creates (or reuses) a confirmed user, marks it as super admin, creates the
organization and the admin membership. It is idempotent: running it again changes nothing and does not reset the
password of an existing user.

```bash
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
  npm run bootstrap:admin -- --email admin@example.com --password '<password>' --org "Acme"
```

`npm run bootstrap:admin -- …` and `node scripts/bootstrap-admin.mjs …` are the same command.

**Alternative: the `/setup` screen.** Set the edge secret `ECHO_SETUP_TOKEN` (32 or more hexadecimal characters, for
example `openssl rand -hex 16`), redeploy nothing (secrets apply without a redeploy) and open
`https://<front-end-host>/setup?codigo=<ECHO_SETUP_TOKEN>`. The screen creates the administrator and the organization in
one step, and stops working as soon as the installation has an organization. The Docker installation uses this path; on
a hosted project it was not exercised, so prefer `bootstrap:admin` if you want the measured one. Remove the secret
afterwards: an installation that already has an organization ignores it anyway.

- `--password` takes 8 to 72 characters. To keep it out of the process list, omit `--password` and set
  `BOOTSTRAP_ADMIN_PASSWORD` instead.
- Exit codes: 0 success, 2 invalid argument or environment, 1 error talking to Supabase.
- Locally, use `SUPABASE_URL=http://127.0.0.1:54321` and the `SERVICE_ROLE_KEY` from `npx supabase status -o env`.

After that, sign in at `/auth`. A super admin is treated as admin in every organization and can create more
organizations at `/super-admin`. To add people: "Configurações > Equipe" (Settings > Team) sends an invitation by
e-mail (section 15) or gives a link to copy. An invitation is tied to a number, so add a number first (sections 11
and 12). Now turn on the hook from section 8.

## 10. Front end

### Variables

Vite inlines the `VITE_*` variables at build time: set them in the build environment, and rebuild after any change.
For a static host, set them in the environment of the build (or in `.env.local`): `vite build` does not read `.env.development.local`.
For development, copy [`.env.development.example`](../../.env.development.example) to `.env.development.local` (the
file at the root named `.env.example` belongs to the Docker stack, not to the front end). Precedence, per field:
`/config.js` (`window.__ECHO_CONFIG__`, empty on a static host unless you write it) over `VITE_*` over the page's own
origin.

| Variable | Required | What it is for |
|---|---|---|
| `VITE_SUPABASE_URL` | **Yes** | Supabase API URL. The app refuses to start without it |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | **Yes** | Anon (or publishable) key. The app refuses to start without it |
| `VITE_QR_SERVICE_URL` | With QR numbers | Public URL of the QR service (`qr-service/`). Empty: `<origin of the page>/qr`, which only exists behind the Docker gateway, so set it here |
| `VITE_VAPID_PUBLIC_KEY` | For Web Push | Same value as the edge secret `VAPID_PUBLIC_KEY`. Without it push subscription is skipped |
| `VITE_FEEDBACK_WEBHOOK_URL` | Optional | URL that receives the feedback form as JSON |
| `VITE_SITE_URL` | Optional | Public address of the front end: base of the invitation links, on any host (empty: the origin of the page). It is also the address shown to the administrator for the webhook and API URLs, but only when `VITE_SUPABASE_URL` is empty; with `VITE_SUPABASE_URL` set those URLs always show the Supabase address |
| `VITE_SCROLL_SKIP_RAF`, `VITE_SCROLL_WHEEL_LIMITER` | No | Debug switches of the message list (`off` disables each behavior). Leave unset |

### Build

```bash
npm run build      # output in dist/
```

### Vercel

Import the repository, keep the Vite preset (build `npm run build`, output `dist`) and set the variables above.
[`vercel.json`](../../vercel.json) adds the Content Security Policy, `X-Content-Type-Options`, `X-Frame-Options`,
long-lived caching for `/assets/*`, `max-age=0` for everything else, and the single-page app rewrite to
`/index.html`.

### Any other static host

Reproduce what `vercel.json` does:

- serve `dist/`, and rewrite unknown paths to `/index.html` (client-side routing);
- do not cache `index.html` or the service worker (`/sw.js`) for long; files under `/assets/` are content-hashed and
  can be cached for a year;
- copy the `Content-Security-Policy` header.

About the CSP in `vercel.json`:

- `connect-src` allows `'self' https: wss:`, so the Supabase API and Realtime on any domain and a QR service on
  HTTPS work as they are. A QR service on plain `http://` is blocked in the browser: put it behind HTTPS. If you
  narrow the policy, keep the Supabase URL (`https://` and `wss://`), the QR service URL and the feedback webhook
  URL, if you use one.
- `img-src` allows any `https:` origin plus `data:` and `blob:`; `media-src` allows any `https:` origin plus `blob:`
  (media is served from Supabase Storage).
- `script-src` allows the inline theme script of `index.html` by its hash. If you change that script, recompute the
  hash and replace the `sha256-...` value:

  ```bash
  node -e "const h=require('fs').readFileSync('index.html','utf8');const s=h.match(/<script>([\s\S]*?)<\/script>/)[1];console.log(require('crypto').createHash('sha256').update(s).digest('base64'))"
  ```

## 11. QR service (QR numbers)

The QR service lives in the `qr-service/` folder of this repository (Node 22, Express, Baileys and zapo). It is an
npm project of its own (its own `package.json`, lockfile, `node_modules` and Dockerfiles; the root is not a
workspace). [`qr-service/.env.example`](../../qr-service/.env.example) documents every variable,
[`qr-service/README.md`](../../qr-service/README.md) documents the variables, HTTP API, providers and voice calls, and
`qr-service/docker-compose.yml` starts the service plus the Postgres used by the zapo provider. Read the warning about
unofficial libraries in the [README](../../README.md#known-limitations) first.

With Docker Compose, from the repository root:

```bash
cd qr-service
cp .env.example .env      # fill in the variables below
docker compose up -d --build
curl -s localhost:3000/health
```

The build context of `docker-compose.yml`, `Dockerfile` and `Dockerfile.voip` is `qr-service/`, so run these commands
from there. The container and the local image are named `echo-qr-service`. For voice calls, build
`Dockerfile.voip` instead (see the service README).

Service side (minimum; `docker compose` refuses to start without the five required ones):

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | The legacy JWT service role key: the same value the edge functions receive as `SUPABASE_SERVICE_ROLE_KEY`. The edge functions call the service with `Authorization: Bearer <that key>` and the service compares it byte for byte, so an `sb_secret_` key here makes every call from the edge functions fail with 401 |
| `WEBHOOK_URL` | `https://<ref>.supabase.co/functions/v1/whatsapp-webhook` (no trailing slash; the service appends `/qr-message`, `/qr-delivery-update`, ...) |
| `QR_WEBHOOK_SECRET` | Same value as the edge secret `QR_WEBHOOK_SECRET`. Required: the service refuses to start without it, and `docker compose` refuses to run without it |
| `ZAPO_PG_PASSWORD` | Compose only, required: password of the Postgres that the compose file starts for the zapo provider. Generate it with `openssl rand -hex 24` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins. Include the front end origin, e.g. `https://echo.example.com`. Default: only localhost |

`ZAPO_PG_PASSWORD` is required by `docker-compose.yml`, with no default: `docker compose` refuses to start without
it. Generate it with `openssl rand -hex 24` (hexadecimal, safe inside the connection URL) and put it in
`qr-service/.env`. Compose uses the same value as `POSTGRES_PASSWORD` of the zapo Postgres and in the service's
`ZAPO_PG_URL`. Set it before the first `docker compose up`: Postgres writes the password into the `zapo_pg` volume
when it creates it, and changing it later requires recreating the volume (`docker compose down -v`, which deletes the
zapo sessions) or running `ALTER USER` in the database. Outside Compose, `ZAPO_PG_URL` stays optional and points to
any Postgres of yours: `postgres://zapo:<password>@host:5432/zapo`.

Rules:

- The service must be reachable over HTTPS by the browsers (pairing, status, groups and calls go straight from the
  front end, with the user's JWT), by the edge functions and by pg_net.
- Keep `/app/sessions` (the `qr_sessions` volume in the compose file) on persistent storage. Losing it means pairing
  every number again.
- Run **exactly one** service per Supabase project. Two services on the same project open the same WhatsApp sessions
  and disconnect each other.
- `GET /health` is public and reports version, sessions and outbox state.

Echo side:

| Where | Name | Value |
|---|---|---|
| Edge secrets | `QR_SERVICE_URL` | Service URL |
| Edge secrets | `QR_WEBHOOK_SECRET` | Shared secret |
| Vault | `qr_service_url` | Service URL (used by the `qr-service-health` job) |
| Front end build | `VITE_QR_SERVICE_URL` | Service URL |

Then connect a number: "Configurações > Números > QR Code" (Settings > Numbers > QR Code), scan the QR code with the
phone (WhatsApp > Linked devices) or use the pairing code. The same screen configures the disconnection e-mail
alert of each number. The provider of each number (`phone_numbers.qr_provider`) is switched in `/ops` (admins only).

**Local development.** Run the service on your machine (`cd qr-service && npm ci && npm run dev`, with a
`qr-service/.env`) with
`SUPABASE_URL=http://127.0.0.1:54321`, `SUPABASE_SERVICE_KEY=<SERVICE_ROLE_KEY>`,
`WEBHOOK_URL=http://127.0.0.1:54321/functions/v1/whatsapp-webhook` and the same `QR_WEBHOOK_SECRET` you put in
`supabase/functions/.env`. Its default `ALLOWED_ORIGINS` already includes `http://localhost:8080`, and the
`vercel.json` CSP does not apply to the Vite dev server, so the front end can reach it at `http://localhost:3000`.
The edge functions run inside Docker, so set
`QR_SERVICE_URL=http://host.docker.internal:3000` in `supabase/functions/.env`; `supabase/seed.sql` already uses that
address for the Vault secret `qr_service_url`. If you run the service with `qr-service/docker-compose.yml` instead,
it cannot reach `127.0.0.1` of your machine: use `http://host.docker.internal:54321` in `SUPABASE_URL` and
`WEBHOOK_URL` (the compose file already maps `host.docker.internal` to the host, also on Linux).

The service image runs as the non-root user `node` (uid 1000). A `qr_sessions` volume created by an older image is owned
by root and the service then refuses to boot with `[FATAL] ... não aceita escrita`: run the `chown` from the
[CHANGELOG](../../CHANGELOG.md) once before starting the new image. When the edge functions see the Storage at an address
that is not the `SUPABASE_URL` of the service (a local Supabase with the service in Docker), set `ECHO_PUBLIC_URL` on the
service so it recognizes media URLs of its own Storage: see the variable in the
[service README](../../qr-service/README.md).

## 12. WhatsApp Cloud API (official numbers)

Credentials of the WhatsApp Business Account (WABA) are stored per **organization**; each number is a row in
`phone_numbers`; the verify token and app secret are **edge function secrets**.

1. **Meta app.** At developers.facebook.com create an app of type Business and add the WhatsApp product. You need a
   WABA and a phone number attached to it.
2. **Collect the credentials.**

   | What | Where in Meta | Where in Echo |
   |---|---|---|
   | WABA ID | WhatsApp > API setup | "Configurações > Integração" (Settings > Integration) |
   | Access token | Business settings > System users > Generate token, with `whatsapp_business_messaging` and `whatsapp_business_management`. The temporary token of the API setup page expires in 24 hours | "Configurações > Integração" |
   | App ID (optional) | App settings > Basic | "Configurações > Integração". Only needed to create or edit templates with a media header |
   | Phone number ID (not the phone number) | WhatsApp > API setup | "Configurações > Números > Business API" |
   | App secret | App settings > Basic | Edge secret `WHATSAPP_APP_SECRET` |
   | Verify token | You make it up | Edge secret `WHATSAPP_VERIFY_TOKEN` |

3. **Secrets.** Set `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` (section 6). `whatsapp-webhook` is deployed
   with `verify_jwt = false` (from `config.toml`) because Meta does not send a JWT.
4. **Webhook in Meta.** WhatsApp > Configuration > Webhook:
   - Callback URL: `https://<ref>.supabase.co/functions/v1/whatsapp-webhook` (also shown, ready to copy, in
     "Configurações > Integração");
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN`;
   - subscribe to the **`messages`** field. It carries incoming messages and status updates (sent, delivered, read,
     failed); no other field is used.
5. **Credentials in Echo.** As an admin: "Configurações > Integração", fill WABA ID, access token and optionally App
   ID. Then "Configurações > Números > Business API", add the number with a display name (e.g. `Vendas`), the phone
   number ID and the phone number in international format (e.g. `+5511999990001`). Every number of an organization
   uses the organization's WABA credentials; there is no token per number. Numbers saved without a
   `connection_type` are `business_api` (the column default). The access token is write-only from the browser: the
   screen only learns whether one is saved (RPC `get_org_whatsapp_config`) and shows "Já configurado" (already set);
   type a new one to replace it.
6. **Test.** Send a message from a phone to the number: it should appear in the inbox within seconds. Reply from
   Echo and watch the status move `sent → delivered → read`.
7. **Signature enforcement.** Look at the `whatsapp-webhook` logs (Supabase dashboard > Edge Functions > Logs). When
   they show `Assinatura da Meta conferida` (signature verified) and the `Received webhook` lines carry
   `"signature_valid":true`, set `WHATSAPP_APP_SECRET_ENFORCE=true`. If they show `SIGNATURE MISMATCH`, the app secret
   is wrong (it is the app secret, not the access token): fix it before enforcing, or every Cloud API webhook will be
   rejected with 401.

The column `organizations.whatsapp_verify_token` exists in the schema but no code reads it: the verify token is the
edge secret. The WhatsApp functions call the Graph API at `v18.0`.

Troubleshooting:

- Verification fails with 403: the verify token in Meta and the `WHATSAPP_VERIFY_TOKEN` secret differ (check trailing
  spaces). A 401 means `whatsapp-webhook` was deployed with JWT verification: redeploy it from this repository, whose
  `config.toml` sets `verify_jwt = false`, or with `--no-verify-jwt`.
- Nothing arrives: the `messages` field is not subscribed, or the phone number ID registered in Echo is not the one
  receiving the message (the webhook finds the organization by it).
- Sending fails with "WhatsApp não configurado": WABA ID or token missing in "Configurações > Integração", or the
  token expired.
- Outside the 24-hour window after the customer's last message, only templates can be sent. Templates are managed in
  "Configurações > Templates" and need Meta approval.
- A number saved without the country code, or with an inconsistent Brazilian ninth digit, produces duplicate
  conversations.
- In Meta's development mode you can only message up to five registered test numbers. Production use requires Meta
  Business verification.

## 13. Instagram Direct (optional)

An Instagram professional account can share the inbox of an existing number. It needs its own Meta app
configuration, the `INSTAGRAM_*` secrets and `SITE_URL`. Everything is in
[docs/instagram/README.md](../instagram/README.md). If you do not use it, the `instagram-reprocessar-avisos` job does
nothing (it returns before calling anything when there is no pending work).

## 14. Web Push

Generate a VAPID key pair:

```bash
npx web-push generate-vapid-keys
```

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (e.g. `mailto:admin@example.com`) as edge secrets,
and the same public key as `VITE_VAPID_PUBLIC_KEY` in the front end build. Users enable notifications in the app;
subscriptions are stored in `push_subscriptions`. Push needs HTTPS (or `localhost`).

## 15. E-mail

Echo sends e-mail through generic SMTP (`SMTP_HOST` set) or, when there is no SMTP, the Resend HTTP API. With neither it
sends nothing and keeps working (invitations become links to copy). The mechanics, and what changes on screen, are in
[../email.md](../email.md); the table below is the list of e-mails:

| E-mail | Function | Recipients |
|---|---|---|
| Team invitation | `send-invitation` | The invited person |
| Number disconnected (QR) | `send-disconnect-alert` (called by the QR service) | Per number, configured in the QR connection screen |
| Pipeline failure, QR service down, heartbeat | `send-failure-alert` (called by cron jobs) | `FAILURE_ALERT_EMAILS`, or every super admin |
| In-app feedback | `send-feedback-email` | `FEEDBACK_EMAILS` |

Set `SITE_URL` plus either `SMTP_HOST` with a sender (`EMAIL_FROM` or `SMTP_ADMIN_EMAIL`), or `RESEND_API_KEY` with
`EMAIL_FROM` (a sender on a domain verified in Resend). Without them the functions log the reason, answer 200 with
`email: "nao_configurado"` and skip the e-mail. Auth e-mails (sign-up confirmation, password recovery) are sent by
Supabase Auth, not by these functions (section 8).

## 16. AI features (optional)

There is no global AI key. An organization admin saves the organization's key in Analytics, tab "AI Insights",
button "Configurar IA" (AI settings; it opens the "Configuração de Inteligência Artificial" dialog); it is encrypted with the Vault secret
`ai_key_secret`. The settings screen does not read the key back: the RPC `get_org_ai_config` only says whether one
is saved. Keys starting with `sk-ant-` go to Anthropic, any other key to OpenAI. Voice note transcription only works
with an OpenAI key. The reply copilot is enabled per user in the profile settings.

## 17. Cron jobs

Created by `20260101000300_cron.sql`. Schedules are in UTC (pg_cron's time zone on Supabase).

| Job | Schedule | What it does | Needs |
|---|---|---|---|
| `process-scheduled-broadcasts` | every minute | Starts broadcasts whose scheduled time has come (`broadcast-execute`) | Vault URL and key |
| `dispatch-broadcast-work` | every minute | Reclaims abandoned recipients, finishes broadcasts with no work left and starts workers for the rest | Vault URL and key |
| `process-scheduled-messages` | every minute | Sends due scheduled messages (`scheduled-message-execute`) | Vault URL and key |
| `process-survey-timeouts` | every minute | Calls `survey-timeout-execute`, which closes or reminds unanswered automation surveys. It calls the function every minute even when there is nothing to do | Vault URL and key |
| `aviso-de-mensagem-repetir` | every minute | Retries organization webhook notifications that did not get an OK (`aviso-repetir`); only calls the function when a retry is due | Vault URL and key |
| `check-message-failure-alerts` | every minute | Detects failures in the message pipeline (`qr_message_log`) and alerts by e-mail and push (`send-failure-alert`), with a 30-minute cooldown | Vault URL and key |
| `qr-service-health` | every minute | Calls the QR service health endpoint from the database and alerts when it does not answer or its disk queue gets stuck | Vault URL, key and `qr_service_url` |
| `merge-duplicate-conversations` | every 5 min | Merges duplicate conversations of the same contact (e.g. Brazilian numbers with and without the ninth digit). Pure SQL | - |
| `instagram-reprocessar-avisos` | every 5 min | Renews Instagram tokens and reprocesses failed Instagram webhooks (`instagram-reprocessar`); returns early when there is nothing to do | Vault URL and key |
| `automation-executions-retencao` | every 10 min | Deletes old automation execution records (30 or 90 days, by status) | - |
| `close-inactive-conversations-daily` | 00:00 | Closes conversations with 30 days without activity; conversations with a tag are never closed | - |
| `fetch-analytics-daily` | 03:00 | Copies Cloud API conversation and template analytics from Meta into `analytics_daily_metrics` and `analytics_daily_templates` (`fetch-analytics-data`) | Vault URL and key, organizations with WABA credentials |
| `purge-qr-message-log` | 03:30 | Deletes old rows of `qr_message_log` (14 to 90 days by type) | - |
| `purge-cron-history` | 04:15 | Deletes `cron.job_run_details` older than 7 days | - |
| `aviso-de-mensagem-limpar` | 04:23 | Deletes finished webhook notification records older than 30 days | - |
| `pipeline-heartbeat` | 01:00, 09:00, 17:00 | Sends a summary e-mail of the last 8 hours (`send-failure-alert`), as proof that alerting works | Vault URL and key, e-mail (section 15) |

Disable a job that does not apply to you, for example `qr-service-health` without a QR service, or
`fetch-analytics-daily` without Cloud API numbers:

```sql
select cron.alter_job((select jobid from cron.job where jobname = 'qr-service-health'), active := false);
```

Use `active := true` to turn it back on. Check recent runs with:

```sql
select j.jobname, d.status, d.return_message, d.start_time
from cron.job_run_details d join cron.job j using (jobid)
order by d.start_time desc limit 50;
```

## 18. Post-install checklist

- [ ] `select name from vault.secrets order by 1;` lists `ai_key_secret`, `project_url`, `qr_service_url`,
      `service_role_key`.
- [ ] `select jobname, active from cron.job order by 1;` shows the jobs you want active, and `cron.job_run_details`
      (query above) has no repeated failures after a few minutes.
- [ ] `select count(*) from net._http_response where status_code >= 400 and created > now() - interval '15 minutes';`
      is 0 (pg_net responses from the edge functions).
- [ ] The front end loads, and you can sign in with the administrator from section 9.
- [ ] "Configurações > Integração" shows the webhook URL of your project.
- [ ] QR: `curl https://<qr-host>/health` answers; a number pairs; a message sent from a phone appears in the inbox
      within seconds; a reply from Echo reaches the phone.
- [ ] Cloud API: the Meta webhook is verified; a message arrives; a reply is delivered; the `Received webhook` log
      lines show `"signature_valid":true` and `WHATSAPP_APP_SECRET_ENFORCE=true` is set.
- [ ] An invitation e-mail arrives (or the invitation link can be copied) and the invited person can create an
      account.
- [ ] With the browser tab in the background, a new message produces a push notification.
- [ ] The hook `before_user_created` is on, and a sign-up without invitation is rejected.

## 19. Upgrading

1. Read [CHANGELOG.md](../../CHANGELOG.md) for the version you are moving to.
2. Pull the new code and run `npm ci`.
3. Apply new migrations: `npx supabase db push` (hosted; see the `migration repair` note in section 4 if the CLI does
   not know the history). New migrations are added as new files after the baseline; the baseline itself does not change.
4. Set any new edge secrets, then redeploy: `npx supabase functions deploy --project-ref <ref>`.
5. Rebuild and redeploy the front end. Installed PWAs pick up the new version on their own (the service worker checks
   for updates every minute).
6. Update the QR service when the changelog lists a new QR service version: `cd qr-service && docker compose up -d
   --build` (or `npm ci && npm run build` and a restart outside Docker). Database first, then edge functions, then
   front end and QR service is the safe order.
