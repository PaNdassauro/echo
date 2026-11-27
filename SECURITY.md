# Security

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security problem.

Use GitHub's private vulnerability reporting on this repository (tab "Security", button "Report a vulnerability").
If that option is not available, open an issue that only asks the maintainers for a private contact, without any
detail of the problem.

Include what is affected (front end, an edge function, a SQL function or policy, the QR service in `qr-service/`),
how to reproduce it and the impact you expect. There is no bug bounty and no guaranteed response time.

Only the latest release is supported with fixes.

## Threat model (summary)

Echo runs in two setups: the Docker installation (`./install.sh`, the recommended one) and a hosted or CLI Supabase project with a static
host for the front end. The boundaries below apply to both; the next section adds what is specific to the Docker installation.

| Boundary | Who is on the other side | What protects it |
|---|---|---|
| Browser → Supabase (REST, Realtime, Storage) | Any user with the public anon key | RLS on every table, `SECURITY DEFINER` RPCs with their own checks, Storage policies |
| Browser → edge functions | Signed-in users | JWT checked by the gateway (`verify_jwt`) or in the handler (`_shared/authz.ts`) |
| Meta → `whatsapp-webhook` | Anyone on the internet | `X-Hub-Signature-256` with `WHATSAPP_APP_SECRET`, enforced with `WHATSAPP_APP_SECRET_ENFORCE=true` |
| QR service → `whatsapp-webhook` `/qr-*` | Anyone on the internet | Shared secret `QR_WEBHOOK_SECRET` in the `x-qr-secret` header, required on both sides: without it the routes answer 503 and the QR service does not start |
| Integrations → `echo-api` | Holders of an organization API key | `x-api-key`, stored only as a hash, scoped to one organization |
| pg_cron → edge functions | The database | Service role key (legacy JWT) from the Vault |
| Edge functions → QR service | The edge functions | Service role key (legacy JWT) as bearer token, compared byte for byte with the service's `SUPABASE_SERVICE_KEY` |
| Browser → QR service | Signed-in users | User JWT, checked against the organization that owns the number |
| Instagram → `instagram-webhook`, `instagram-oauth` | Anyone on the internet | Meta signature; signed `state` with a 30-minute expiry |

Highest-value assets: message contents and media, contact phone numbers, WhatsApp and Instagram access tokens,
organization AI keys, the service role key and, in the Docker installation, the `.env`.

The secret columns of `organizations` are not readable through table queries: the table grants column-level SELECT
to signed-in users without the WhatsApp token and the AI key columns, and the settings screens only learn whether a secret is
saved, through the RPCs `get_org_whatsapp_config` and `get_org_ai_config`. The Instagram tokens live in a table that
only the service role reads.

The **QR service holds the service role key** and the WhatsApp sessions. Anyone who controls that host has full
access to the database and to every QR number. Treat it like the database.

## The Docker installation

What the installation does for you, and the limits of each measure.

- **One origin, one door.** Only the `gateway` (Caddy) publishes a port. Postgres, the QR service, GoTrue, PostgREST, Realtime, Storage and the
  functions are reachable only inside the Compose network. The browser talks to a single origin, so there is no CORS to loosen.
- **The service role key stays on the internal network.** Functions and the QR service call the API through an internal listener of the
  gateway (`:8000`) that is never published and is bound so that it cannot be reached from the Docker network of an external proxy. Its access log
  and the gateway's error log drop the `apikey` and `x-qr-secret` headers and masks `access_token`, `apikey` and `token` in query strings, because the service role key
  travels in them (measured: zero occurrences of the key, the webhook secret and the JWT secret in the logs of a full run).
- **Uploaded files cannot run code at Echo's address.** `/storage/v1/` is served with its own policy (`sandbox`, no scripts) and `nosniff`; as a
  side effect a PDF opened by its raw URL does not render in the tab (the Download button is not affected).
- **Blocked on the public side:** `/auth/v1/admin/*`, every sub-path of `/functions/v1/whatsapp-webhook` (the QR service's routes live under it; only
  the exact path that Meta calls is reachable), `/qr/health`, the root of `/rest/v1/` without the service role key, and the Realtime tenant paths.
- **First access.** `/setup` creates the first administrator only with `ECHO_SETUP_TOKEN` (the code in the link the installer prints), only while the
  installation has no super admin and no organization, and under a database lock. After that it answers 409. An empty `ECHO_SETUP_TOKEN` turns it off.
- **Sign-up is invitation-only**: the Auth hook `before_user_created` is always on.
- **Login limit per client address**, from the real address the gateway sees: 30 wrong passwords are answered 400 and from the 31st on 429, and a forged
  `X-Forwarded-For`, `X-Real-IP` or `X-Echo-Client-IP` does not change the count. The gateway trusts `X-Forwarded-For` only with `--behind-proxy`, and
  only from private addresses; a proxy that does not send the client address makes all users share one bucket.
- **Secrets are checked at start.** The database refuses to start with a secret that is empty, a placeholder, all zeros, one repeated character, or the
  wrong format; the Vault key script refuses a key of zeros; the gateway refuses malformed or swapped API keys. So `cp .env.example .env` cannot bring up an
  installation with secrets that everybody knows. `./echo doctor` repeats the check and prints names only.
- **SSRF guard on URLs a user chooses.** Organization webhooks (first delivery and retries), automation webhook nodes, action buttons of type webhook, link previews and media URLs given to the API go through a guard
  that refuses private addresses, loopback, the cloud metadata address and internal service names, checks every redirect (three at most) and resolves names.
  Our own Storage is fetched through its internal address without the guard, because that address comes from configuration, not from the caller.
  Host names with characters other than letters, digits, hyphen and dot (for example an underscore) are refused (`host_invalido`), and so are names the edge cannot resolve (`dns_sem_endereco`).
  DNS rebinding is not covered: the name is resolved once for the check and again by the fetch.
  `ECHO_OUTBOUND_ALLOW_HOSTS` is the explicit exception, by exact host name.
- **The `.env` is the keys to the Vault.** It holds the Vault root key, the key that encrypts the organizations' AI keys, the database password and the
  JWT secret. It is created with mode 600, ignored by git and copied into every backup (mode 700 folder, mode 600 files). Whoever reads the `.env`
  together with the `db-data` volume reads the Vault. Protect the file, the backups and the machine accordingly.
- **Plain HTTP on a public IP is refused** by the installer unless you pass `--insecure-http`, and `./echo doctor` keeps warning about it. Use a
  domain (automatic HTTPS) or a private network.
- **Image supply chain.** The versions of the third-party images are pinned in the compose file; the Deno dependencies of the functions are pinned and
  verified by a committed lock file (`docker/functions/deno.lock`, frozen at build). The build fetches only from the npm registry (the function sources import from esm.sh for the Supabase Cloud path, and an import map redirects those specifiers to `npm:` in the Docker runtime; a test fails if the lock holds any remote module). There are no published Echo images, so
  you build what you read. No part of this repository's CI publishes an image or uses a secret.

What is **not** a security boundary in the Docker installation (also in [docs/architecture.md](./docs/architecture.md#self-hosted-stack)):

- The `zapo` database role. It keeps the QR provider's data apart, but it can still connect to the `postgres` database, and the QR service already holds the
  service role key. Treat the QR service as holding the keys to everything.
- The functions. All 46 share one process, so there is no isolation between them (the repository enforces rules against shared state, which reduces
  accidents and does not prevent a determined bug), and the CPU of one delays the others.
- The Compose network. Any container attached to it reaches the internal listener, the database and the other services. Do not attach unrelated
  containers, and do not run untrusted code next to the stack.
- The `gateway` container runs as root inside the container. The QR service image runs as a non-root user.
- The loopback of the `db` container is `trust`: a password check from inside that container proves nothing.

Not tested: ACME with a real certificate authority, `wss` with a public certificate, ARM64, Podman, rootless Docker and SELinux, and a real proxy in front of the
gateway (the proxy mode was measured with a second Caddy in a Docker network). Review them yourself before relying on them.

## What the operator must configure

**Docker installation:** keep the `.env` and every backup folder private and off shared disks; leave `EDGE_INTERNAL_AUTH_ENFORCE` empty; fill
`WHATSAPP_APP_SECRET` before connecting an official number (`./echo doctor` reports an error if you do not); publish only what you mean to (do not add `ports:`
for the database or the QR service in `docker-compose.override.yml`); keep the host and Docker updated; and put a firewall in front of anything that is not
the gateway. **Supabase Cloud setup:** the list below.

- Set `WHATSAPP_APP_SECRET` and, after the logs show verified signatures, `WHATSAPP_APP_SECRET_ENFORCE=true`.
  Without it, anyone who knows the webhook URL can inject fake Cloud API events.
- Set `QR_WEBHOOK_SECRET` (long and random) with the same value in the edge functions and in the QR service. It is
  required on both sides.
- Use the legacy JWT `service_role` key for the Vault secret `service_role_key` and for the QR service's
  `SUPABASE_SERVICE_KEY`; an `sb_secret_` key there is rejected.
- Turn on the Auth hook `before_user_created` right after creating the first administrator. While it is off, anyone
  who can reach your Auth endpoint can create an account. (Always on in the Docker installation.)
- Keep `EDGE_INTERNAL_AUTH_ENFORCE` unset (enforcing). `0` is only a migration aid.
- Keep the service role key out of the front end. Only `VITE_*` variables reach the browser, and they are public.
- Set `ALLOWED_ORIGINS` on the QR service to your front end origin.
- With `qr-service/docker-compose.yml`, generate `ZAPO_PG_PASSWORD` with `openssl rand -hex 24` (there is no default
  and Compose refuses to start without it). The zapo Postgres publishes no port, but it stores the WhatsApp sessions
  of the numbers on the `zapo` provider: keep the password and the `zapo_pg` volume as protected as the
  `qr_sessions` volume.
- Serve the front end with the security headers of `vercel.json` (CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`) on whatever host you use.
- Do not apply `supabase/seed.sql` to a hosted project: it writes local-only values into the Vault.
- Keep `ai_key_secret` stable and backed up; it encrypts the organizations' AI keys.

## Known limitations

- **Media is public by URL.** The `attachments` bucket is public: anyone who has the URL of a file can download it.
  Uploads are restricted by policy, reads are not.
- **Isolation between organizations depends on RLS.** Many tables grant privileges to `anon` and `authenticated` and
  rely on RLS alone, and some `SECURITY DEFINER` functions rely on checks inside the function rather than on narrow
  grants. A mistake in one policy or function is therefore directly exploitable. Review grants and policies
  (`\dp`, `information_schema`, `pg_policies`) before exposing an installation to people you do not trust and before
  adding tables or functions, and follow the rules in
  [docs/architecture.md](./docs/architecture.md#invariants-for-contributors).
- **QR numbers use unofficial WhatsApp clients** (Baileys, zapo). Besides the risk of the number being banned, these
  libraries process untrusted data from WhatsApp in the QR service process.
- **`xlsx` 0.18.5** has known vulnerabilities (CVE-2023-30533, CVE-2024-22363). It only parses spreadsheets uploaded
  by signed-in users. See the README for why it was kept.
- **`npm audit` still reports vulnerabilities**: `xlsx`, `zod` 3.x (fixed only in Zod 4; the app uses it on responses from its own backend) and
  `react-router` 6 in the app, development tooling (`vite`, `vitest`, `tinypool`, `esbuild`), and in the QR service `link-preview-js` (no fix inside the
  range Baileys accepts; `baileys` is listed only because it depends on it), `music-metadata` (a fix exists inside its range, but it is a direct dependency
  of Baileys). Those two were left unchanged on purpose; `sharp`, also used by Baileys, was updated to 0.35 after a manual check. See the README (Known
  limitations). Do not run `npm run dev` or the Vitest UI server on a public host.
- Logs of the edge functions can contain message text. Restrict access to your Supabase project logs, or to `./echo logs`
  and the Docker logs of the host, accordingly. Redact keys and customer phone numbers before pasting a log anywhere.
- The Docker installation inherits the limitations above and adds: one node and no high availability, and the address
  fixed at install time.
