## What changes and why

<!-- The problem this solves and the choice you made. English or Portuguese; commits follow Conventional Commits, in Portuguese. -->

## How it was verified

<!-- The command and its result, not just "it passes". Tick what applies to what you touched. -->

- [ ] `npm run typecheck` (`npm run build` does not check types)
- [ ] `npm test` (Vitest; on a slow machine, `npx vitest run --testTimeout=30000`)
- [ ] `npm run check:edge`, `npm run test:edge`, `npm run test:router` and `npm run check:verify-jwt` (touched `supabase/functions/` or `docker/functions/`)
- [ ] `cd qr-service && npm run build && npm run -s test:all` (touched `qr-service/`)
- [ ] `npm run test:infra` and `npm run smoke:selfhost` (touched `docker/`, `install.sh`, `echo`, `supabase/` or a Dockerfile)
- [ ] `npm run lint` did not increase the number of errors

## Checklist

- [ ] A new test for the new behavior, next to the code
- [ ] No new `any`; external input validated with zod
- [ ] It works for every organization and number: nothing decided by a fixed id, organization or number
- [ ] Schema changes in a new migration (never edit an applied one); a new table has RLS and `revoke` in the same file; a new function has its grants checked
- [ ] A new variable is in `.env.example`, in the compose file, in `docker/tools/gen-keys.mjs` (if generated) and in the table of `docs/self-hosting.md`
- [ ] Documentation and `CHANGELOG.md` updated when the behavior changes for people who install Echo
- [ ] No secret, customer phone number, unread log or `.env` file in the diff

<!-- Does this change the contract between the QR service and the app (routes, payloads)? Say which side has to be deployed first. -->
