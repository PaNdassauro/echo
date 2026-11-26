# Development

How to work on Echo: run the front end against a local Supabase stack, run the checks, and test the Docker installation. If you
only want to **use** Echo, you do not need any of this: see [self-hosting.md](./self-hosting.md).

There are two development setups, and they are different on purpose:

| | Local Supabase (CLI) | The Docker installation |
|---|---|---|
| For | working on the front end, the edge functions and the migrations with hot reload | testing what users get: the gateway, the installer, the function runtime, `./echo` |
| Back end | `npx supabase start` (the Supabase CLI is a dev dependency) | `./install.sh` (the Compose stack) |
| Front end | `npm run dev` on port 8080, configured by `.env.development.local` | built into the `gateway` image, configured by `/config.js` |
| Functions | `npx supabase functions serve` (the Supabase edge runtime) | one Deno process (`docker/functions`) |

The code is the same in both. A change that works in one and not in the other is usually about the address rule (the internal and
public URLs of [architecture.md](./architecture.md#self-hosted-stack)) or about the single-process rules of the functions.

## Requirements

- Node 22 (`.nvmrc`) and npm.
- Docker, for the local Supabase stack and for the Docker installation.
- Deno 2.5.6 for the function checks and tests. Keep it on the `PATH`: the npm scripts `check:edge`, `test:edge`, `test:router` and
  `check:verify-jwt` call `deno` directly (the CI pins `v2.5.6`). Running a command by hand, `npx -y deno@2.5.6 <command>` also works.

```bash
git clone https://github.com/PaNdassauro/echo.git echo && cd echo
npm ci
```

## Front end against a local Supabase

```bash
# 1. Local Supabase: applies supabase/migrations and supabase/seed.sql (which creates the Vault secrets of the local stack)
npx supabase start
npx supabase status -o env        # prints API_URL, ANON_KEY, SERVICE_ROLE_KEY, ...

# 2. Edge functions with local secrets (separate terminal)
cp supabase/functions/.env.example supabase/functions/.env   # fill in what you need
npx supabase functions serve --env-file supabase/functions/.env

# 3. First administrator
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY> \
  npm run bootstrap:admin -- --email admin@example.com --password '<at least 8 chars>' --org "Acme"

# 4. Front end
cp .env.development.example .env.development.local   # VITE_SUPABASE_URL=http://127.0.0.1:54321, VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY>
npm run dev                                          # http://localhost:8080
```

Sign in at `http://localhost:8080/auth` with the administrator you created. Local e-mails (password recovery) are caught by the local mail
viewer of the Supabase stack (`http://127.0.0.1:54324`).

- **The `.env.example` at the root is not for the front end.** It is the model of the Docker stack's `.env`. The front end reads
  `.env.development.local`, copied from `.env.development.example`. Every `VITE_*` variable is inlined in the JavaScript at build time and
  is public: never put a service role key in it. Precedence per field: `window.__ECHO_CONFIG__` (`/config.js`) over `VITE_*` over the origin of
  the page. `public/config.js` is empty in the repository, so in development only `VITE_*` applies.
- For a **static host** of the front end (Vercel, Netlify...), `vite build` runs in `production` mode and does **not** read
  `.env.development.local`: set the `VITE_*` variables in the environment of the build, or in `.env.local` (read in dev and in build). A bundle
  built without them is a blank page.
- `npm run dev` talks to the project in `.env.development.local`. Check where it points before opening conversations: opening one marks its
  messages as read.
- `supabase/seed.sql` is for the local stack only (it writes the local gateway URL and a service role key signed with the default local JWT
  secret into the Vault). Never apply it to a hosted project.
- The QR service for local work: `cd qr-service && npm ci && npm run dev`, with a `qr-service/.env` (see
  [alternatives/supabase-cloud.md](./alternatives/supabase-cloud.md#11-qr-service-qr-numbers), "Local development", and the service README).
  Do not open WhatsApp sessions in tests, and do not generate bulk traffic on real numbers.

## Checks

| Command | What it checks |
|---|---|
| `npm run typecheck` | `tsc -b` over `src/` and `vite.config.ts`. This is the type check that counts; `npm run build` does not check types, and `npx tsc --noEmit` at the root checks nothing (the root `tsconfig.json` has `files: []`) |
| `npm test` | Vitest: `src/**/*.test.{ts,tsx}` and `scripts/*.test.mjs` (this includes the tests of the installer, `gen-keys` and the `.env` parity) |
| `npm run build` | production build, with no `VITE_*` in the environment: the build must not depend on any |
| `npm run check:edge` | `deno check` on all 46 functions, the function runtime and `echo-admin` |
| `npm run test:edge` | Deno tests in `tests/` and `supabase/functions/_shared` (includes the single-process scanner) |
| `npm run test:router` | Deno tests of the function runtime (`docker/functions/tests`) |
| `npm run check:verify-jwt` | every function declared in `supabase/config.toml` has a folder and every folder an entry |
| `npm run test:infra` | tests of the guard of secrets, the Vault key script, the gateway entrypoint, the Caddyfile and the Compose files, in Docker, without starting the stack (about one minute) |
| `npm run smoke:selfhost` | **the end-to-end smoke test** of the Docker installation, see below |
| `npm run test:sql` | SQL tests of the first-access functions; needs an **empty** running stack (see below) |
| `npm run lint` | ESLint, not blocking in CI because of a legacy baseline of errors (mostly `no-explicit-any`): do not add new ones |
| `cd qr-service && npm ci && npm run build && npm run -s test:all` | build and tests of the QR service (a separate npm project; the root `npm test` does not run them) |
| `docker compose --env-file .env.example config -q` | the Compose files are valid |

Useful variants:

```bash
npx vitest run src/lib/phone.test.ts              # one file
npx vitest run src/lib/phone.test.ts -t "LID"     # tests whose name contains a string
npx vitest run --testTimeout=30000 --maxWorkers=3 # slow or shared machine: avoids false timeouts
deno check --no-config supabase/functions/<name>/index.ts
deno test --no-config --allow-env --allow-read tests/<folder>
```

Vitest runs without `globals`, so component tests call `afterEach(cleanup)` explicitly. Never conclude that a command passed from a
piped command line: `cmd | tail && echo OK` tests `tail`. Use `; echo "EXIT=${PIPESTATUS[0]}"`.

## The Docker installation

The pieces, by folder:

| Path | What |
|---|---|
| `docker-compose.yml`, `docker/compose/` | the stack; `dominio.yml` (443) and `proxy-rede.yml` (external proxy network) per mode |
| `docker/db/` | the database image: Vault key script (`getkey.sh`), guard against example secrets (`preflight.sh`), idempotent init (`db-init.sh`) |
| `docker/migrate/migrate.sh` | Vault, migrations with checksum control, Vault, schema reload |
| `docker/gateway/` | Caddyfile, entrypoint (validates the environment and writes `/config.js`), and the Dockerfile that also builds the front end |
| `docker/functions/` | the single-process runtime, its lock file, its tests and `echo-admin` (the administration CLI that `./echo` uses inside the container) |
| `docker/tools/gen-keys.mjs` | generates the `.env`; no dependencies, so it also runs in a bare `node:alpine` |
| `install.sh`, `echo` | installer and CLI (bash). `echo` loads `install.sh` with `source` to share functions |
| `scripts/smoke-selfhost.sh`, `scripts/smoke/` | the end-to-end smoke test and its helpers |

Rules to keep:

- **No bind mounts, no `container_name`.** Scripts, migrations, the Caddyfile and the front end go inside images. (A bind-mounted script without
  the executable bit takes the database down, measured; SELinux refuses unlabeled mounts.)
- **Migrations are inside the `db` image.** Rebuild after adding one. Never edit an applied migration (the checksum stops the start). A new table
  in `public` needs RLS and revoked grants in the same migration, and a new function needs its grants checked: the rules are in
  [architecture.md](./architecture.md#invariants-for-contributors). Index creation on `messages` is `CONCURRENTLY`.
- **Functions run in one process**, so the scanner in `tests/processo-unico/` rejects module-level mutable state, global configuration calls,
  `Deno.env.set` and non-literal dynamic imports. In the Docker stack the dependencies of the functions come from the
  npm registry with a frozen lock. The sources import from esm.sh (that is what the Supabase Cloud path uses) and the `imports` map of
  `docker/functions/deno.json` redirects each `https://esm.sh/<package>@<version>` to `npm:<package>@<version>` at run time, so the build
  never fetches code from esm.sh (it once served different bytes for the same versioned URL, which breaks a frozen lock). A new dependency
  of the functions has to be added to that map and the lock regenerated:
  `deno cache --frozen=false --config docker/functions/deno.json docker/functions/main.ts supabase/functions/*/index.ts docker/functions/echo-admin.ts`
  (commit `docker/functions/deno.lock`; the build fails on an integrity mismatch, never the running stack).
  `docker/functions/tests/mapa-imports.test.ts` (part of `npm run test:router`) fails on an `https://` import missing from the map, on any
  remote module in the lock, and on an `npm:` target whose version is not exactly the one in the esm.sh URL it replaces (a range would let
  each lock regeneration pick the version of the day, and Docker and Cloud would drift apart); its message says what to add.
  Known gap: the optional `zod` peer of `@anthropic-ai/sdk@0.110.0` (`^3.25.0 || ^4.0.0`) resolves in the lock to `zod@3.23.8`, outside
  that range. It has no effect today (only the SDK's `helpers/zod` import `zod/v4`, and no function uses them), but using those helpers
  requires raising `zod` in both paths (the sources and the map) first.
- **The Content-Security-Policy lives in two places**: `vercel.json` (static hosting) and `docker/gateway/Caddyfile`. The hash of the inline theme
  script of `index.html` has to match in both, and `src/hooks/themePresets.test.ts` checks both files. If you change that script or the policy, change both.
  The Caddy policy has two exceptions, only when the public URL is `http://`: `ECHO_CSP_WS` (`ws://<host>` in `connect-src`) and
  `ECHO_CSP_HTTP` (`http://<host>` in `img-src`, `media-src` and `connect-src`).
- **A new environment variable of the stack** goes in `.env.example`, in the compose service that reads it, in `docker/tools/gen-keys.mjs` if it is
  generated, and in the reference table of [self-hosting.md](./self-hosting.md#6-variable-reference). `scripts/env-paridade.test.mjs` fails if
  `.env.example` and the compose files disagree.
- **An `.env` change is applied with `./echo up`**, not `./echo restart`.
- Shell scripts pass `shellcheck -S warning`.

### The smoke test

```bash
npm ci
bash scripts/smoke-selfhost.sh              # builds the 4 images, starts a stack named echo-smoke, runs the checks, tears everything down
bash scripts/smoke-selfhost.sh --manter     # leaves the stack running afterwards (and prints where its .env is)
```

It needs Docker, Node 20 or newer and `npm ci` at the root. It uses the project `echo-smoke` and the host ports 58290 to 58292, so it
does not collide with your own installation. It never opens a WhatsApp session: the QR service is exercised through its webhook
and its upload routes. Each check prints `OK <name>` or `FALHOU <name>: <detail>`; the run ends with `SMOKE OK (<n> checagens)` or exits 1 at
the first failure. In order, it covers: the guard that refuses example secrets, the start, the surface of the gateway and its
headers, first access, sign-in, row-level security between two organizations, Realtime, media with the public URL, Storage and a
20 MiB resumable upload, a function with a JWT, cron through pg_net, e-mail with and without SMTP, the `./echo` commands, logs with no
secrets, a cold restart, TLS, redirect and `wss` with the gateway's internal certificate authority, backup and restore into a new folder with
another `.env`, and the limit per client address. At the time of writing it takes about 5 minutes with the images cached (270 to 380 seconds across the runs) and ends with 156 checks.

The smoke test calls `set_ai_api_key` with the administrator's token, because that function checks the signed-in user (an admin of the
organization or a super admin) and answers `Unauthorized` to the service role; it reads the key back with `get_decrypted_ai_key` as the
service role, which is what the edge functions do. Cron jobs can fire a few seconds before the stack finishes starting; the assertion on
cron results counts from the end of `up --wait`, and earlier responses are only logged.

The smoke test is the proof that `git clone` plus `./install.sh` works. Run it before changing anything in `docker/`, `install.sh`,
`echo`, `supabase/` or the services' Dockerfiles.

### `npm run test:sql`

`tests/sql/rodar.sh` tests `instalacao_precisa_setup()` and `instalacao_concluir_setup()` (first access) against a **running, empty** stack, because
it creates and deletes an organization to test the race between two sessions. It refuses to run if an organization already exists
(exit 2). Start a stack, do not create the administrator, then `ECHO_PROJECT=<project> npm run test:sql`.

### Testing the installer without a second machine

Use another project name and port so it does not touch your installation: `COMPOSE_PROJECT_NAME=echo-dev ./install.sh --port 8099` in a
copy of the repository (the `.env` is per folder), and `down -v` when you are done. Do not run `./install.sh` for the same project twice with
different address options: the address of an existing `.env` is kept.

## Database changes

Add a file in `supabase/migrations/` named `YYYYMMDDHHMMSS_description.sql`; never edit an existing one. Test it with `npx supabase db reset` (local
Supabase) and, for the Docker installation, with the smoke test. After a schema change regenerate the types with `npm run gen:types:local` and
commit `src/integrations/supabase/types.ts`. On a hosted project, a project that already has the baseline applied needs
`supabase migration repair` first ([alternatives/supabase-cloud.md](./alternatives/supabase-cloud.md#4-apply-the-migrations)).

## Pull requests

[CONTRIBUTING.md](../CONTRIBUTING.md) has the checklist and the style. The CI (`.github/workflows/ci.yml`) runs `web`, `edge`, `qr-service` and, when the
change touches the stack, `selfhost`.
