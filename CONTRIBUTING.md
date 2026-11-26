# Contributing

Thanks for helping. Issues and pull requests can be written in English or Portuguese. Read
[docs/architecture.md](./docs/architecture.md) before changing the database, the webhook or the send path: it lists
the invariants that are easy to break.

This repository holds the app (front end, edge functions, database) at the root, the Docker installation (`install.sh`, `echo`,
`docker-compose.yml`, `docker/`) and the QR service in `qr-service/`. The QR service is a separate npm project: see
[QR service](#qr-service) below for its setup and checks. The whole development workflow, including the rules of the Docker
installation, is in [docs/development.md](./docs/development.md).

## Setup

- Node 22 (`.nvmrc`), npm, Docker.
- Deno 2.5.6 (https://deno.com) for the edge function checks and tests. Install it and keep it on the `PATH`: the npm
  scripts `check:edge`, `test:edge`, `test:router` and `check:verify-jwt` call `deno` directly (the CI uses `v2.5.6`). Only when
  you run a command by hand can you use `npx -y deno@2.5.6 <command>` instead of a global install.

```bash
npm ci
npx supabase start                      # local database with the migrations and the local seed
cp .env.development.example .env.development.local   # VITE_SUPABASE_URL and the ANON_KEY from `npx supabase status -o env`
npm run dev
```

Do not copy `.env.example` for this: it is the model of the Docker stack's `.env`, with placeholders on purpose. The steps in
[docs/development.md](./docs/development.md#front-end-against-a-local-supabase) also create the first administrator.

## Checks

Run these before opening a pull request. The CI (`.github/workflows/ci.yml`, at the root) has four jobs:
`web` (typecheck, Vitest, build with no `VITE_*` in the environment, and non-blocking lint), `edge` (Deno 2.5.6: `check:edge`,
`test:edge`, `test:router`, `check:verify-jwt`), `qr-service` (in `qr-service/`: Node 22, `npm ci`, `npm run build` and
`npm run -s test:all`, with the npm cache keyed on `qr-service/package-lock.json`) and `selfhost` (shellcheck, the Compose
files, the infrastructure tests and the Docker smoke test; it runs on pull requests that touch the stack and on pushes to
`main`). The QR service has its own npm project: run `npm ci` inside `qr-service/` to work on it. The root lint ignores
`qr-service/` (the root has a baseline of errors and warnings, mostly `no-explicit-any`), and a static-host deploy of the front
end (for example on Vercel, through `.vercelignore`) does not upload `qr-service/`.

| Command | What it checks |
|---|---|
| `npm run typecheck` | `tsc -b` over `src/`. This is the type check that counts; `npm run build` does not check types |
| `npm test` | Vitest (`src/**/*.test.{ts,tsx}`, `scripts/*.test.mjs`) |
| `npm run build` | Production build (it must not need any `VITE_*`) |
| `npm run check:edge` | `deno check` on every edge function, the function runtime and `echo-admin` |
| `npm run test:edge` | Deno tests in `tests/` and `supabase/functions/_shared`, including the single-process scanner |
| `npm run test:router` | Deno tests of the function runtime (`docker/functions/tests`) |
| `npm run check:verify-jwt` | every function in `supabase/config.toml` has a folder, and every folder has an entry |
| `npm run test:infra` | tests of the secret guard, the entrypoint, the Caddyfile and the Compose files (needs Docker; a minute) |
| `npm run smoke:selfhost` | the end-to-end smoke test of the Docker installation (needs Docker; about 5 minutes). Run it when you touch `docker/`, `install.sh`, `echo`, `supabase/` or a service's Dockerfile |
| `npm run lint` | ESLint. Not blocking in CI because of a legacy baseline of errors and warnings (mostly `no-explicit-any`): do not add new ones |

Useful variants:

```bash
npx vitest run src/lib/phone.test.ts              # one file
npx vitest run src/lib/phone.test.ts -t "LID"     # tests whose name contains a string
npx vitest run --testTimeout=30000                # on a slow or busy machine, to avoid false timeouts (hooks already get 30 s from vite.config.ts)
deno check --no-config supabase/functions/<name>/index.ts   # an edge function not covered by check:edge
deno test --no-config --allow-env --allow-read tests/<folder>
```

Notes:

- Front end tests live next to the code (`src/**/*.test.ts[x]`). Vitest runs without `globals`, so component tests
  call `afterEach(cleanup)` explicitly.
- Edge function tests are `Deno.test` files under `tests/<area>/` or next to the module in
  `supabase/functions/_shared/`. They import the functions' modules directly and do not need a running stack.
- Only `src/` is type-checked by `tsc`; edge functions are checked only by `deno check`. If you touch a function
  outside the `check:edge` list, run `deno check` on it.
- After a schema change, regenerate the types with `npm run gen:types:local` (against the local database) and commit
  `src/integrations/supabase/types.ts`.

## Database changes

Add a new file in `supabase/migrations/` named `YYYYMMDDHHMMSS_description.sql`; never edit an existing migration (in the
Docker installation the checksum of an applied file is recorded and a changed file stops the start). Test it with
`npx supabase db reset`, which rebuilds the local database from all migrations and the seed, and run the smoke test. The
rules for grants, RLS and Realtime are in [docs/architecture.md](./docs/architecture.md#invariants-for-contributors).

## The Docker installation

If you change `docker/`, `install.sh`, `echo`, a Dockerfile or the Compose files: keep the stack free of bind mounts and `container_name`; new
variables go in `.env.example`, the compose service, `docker/tools/gen-keys.mjs` when generated, and the table in
[docs/self-hosting.md](./docs/self-hosting.md#6-variable-reference); shell scripts pass `shellcheck -S warning`; edge functions run in one
process, so module-level mutable state, global library configuration, `Deno.env.set` and non-literal dynamic imports are rejected by
`tests/processo-unico/`; the Content-Security-Policy lives in `vercel.json` **and** `docker/gateway/Caddyfile`, and both change together.
Never put a real secret, a customer phone number or a log you have not read in a commit, an issue or a pull request.

## QR service

The QR service (`qr-service/`) is an npm project of its own, with its own `package.json`, `package-lock.json`,
`node_modules`, `Dockerfile` and `Dockerfile.voip`. The root is not a workspace: the root `npm ci` does not install
its dependencies and the root `npm test` does **not** run its tests. Its tests use Node's test runner
(`node --import tsx --test`) and plain Node scripts, not Vitest.

```bash
cd qr-service
nvm use                 # Node 22 (qr-service/.nvmrc)
npm ci
npm run build           # tsc, must finish with 0 errors
npm run -s test:all     # every suite, the same command as the qr-service CI job
```

You do not need a phone or a Supabase project to run these tests: the adapter contract suite uses
`@zapo-js/fake-server`, and no test talks to WhatsApp or Supabase.

Before opening a pull request that touches `qr-service/`:

- `npm run build` finishes with 0 TypeScript errors and `npm run -s test:all` passes.
- The service still boots after the build. It is ESM, so a relative import without the `.js` extension passes `tsc`
  and the tests but crashes at runtime. The boot smoke test is in [qr-service/CLAUDE.md](./qr-service/CLAUDE.md).
- New behavior has a test next to the existing ones in `qr-service/tests/`, wired into a `test:*` script in
  `qr-service/package.json` and into `test:all`.
- Only `qr-service/src/adapter/<provider>/` imports a WhatsApp library (`npm run check:adapter`).
- Keep changes to the contract between the service and the app (webhook routes and payloads, HTTP API) backward
  compatible, or describe in the pull request which side must be deployed first.
- Changes that increase traffic to WhatsApp (bulk lookups, bulk group operations, profile-picture sweeps) need a
  clear reason: they raise the ban risk for every user of the service.
- Never commit anything from `qr-service/sessions/` or a `qr-service/.env` (both are ignored by git).

How to run and configure the service: [qr-service/README.md](./qr-service/README.md).

## Style

- **Language:** the UI, code comments and commit messages are in Brazilian Portuguese. Identifiers follow the
  surrounding code (there is a mix of Portuguese and English names; do not rename existing ones without a reason).
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/), in Portuguese, for example
  `feat(chat): ...`, `fix(webhook): ...`, `docs: ...`.
- **Types:** no new `any`. Validate external input (HTTP bodies, Realtime rows, RPC results) with zod.
- **Comments** explain why, not what.
- A feature applies to every organization and number. Per-number behavior is a setting visible in the UI, never a
  condition on a specific number or organization.
- Keep changes focused: no drive-by refactors in the same pull request.
- Test data is fictional: phone numbers like `5511999990001`, names like `Ana` or `Acme`. Never commit real phone
  numbers, message contents, keys or `.env` files.

## Security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the MIT License of this repository
([LICENSE](./LICENSE)), which covers `qr-service/` too.
