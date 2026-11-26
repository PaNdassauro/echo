# Troubleshooting

Every entry below is an error that happened during the tests of the Docker installation (or that a check in the code refuses on
purpose), with what it means and what to do. The messages of `./install.sh`, `./echo` and the services are in Portuguese; they are
quoted as they appear.

**Start here, always:**

```bash
./echo doctor                      # read-only: OK / AVISO / ERRO, with the fix on the ERRO lines
./echo status                      # state of each service, version, QR queue
./echo logs <service> --tail 100   # services: db, db-init, auth, storage, realtime, migrate, rest, functions, qr, gateway
```

**Before pasting any log or `.env` into an issue,** check that it contains no key, no password and no customer phone number. The
`.env` itself must never be pasted. `./echo doctor` prints names of secrets, never values, and is safe to share after a read.

- [Install and start](#install-and-start)
- [Sign-in and first access](#sign-in-and-first-access)
- [Changing settings](#changing-settings)
- [Proxy and addresses](#proxy-and-addresses)
- [QR numbers](#qr-numbers)
- [Functions, cron and e-mail](#functions-cron-and-e-mail)
- [Backup, restore, upgrade](#backup-restore-upgrade)
- [Slow or loaded machines](#slow-or-loaded-machines)

## Install and start

**`o banco recusou os segredos do .env (linhas 'preflight:' no log do db): o .env tem segredo de exemplo.`** The database refuses to
start with a secret that is empty, a placeholder (`__GERE_COM_install.sh__`), all zeros, one repeated character, or in the wrong
format or length. This is what happens if you copy `.env.example` to `.env` and run `docker compose up`: the `db` container
restarts in a loop printing `preflight: POSTGRES_PASSWORD recusada (placeholder)` (only names, never values), `up --wait` exits 1
with `container ... is unhealthy` and nothing that depends on it starts. Run `./install.sh`, which generates real secrets. On a
real installation, restore the `.env` you saved. (Never copy `.env.example`: the guard is there so that an installation can
never come up with secrets everybody knows.)

**`a porta 8088 do host está em uso.`** Another process owns the port. See who: `ss -ltnp 'sport = :8088'`. Choose another with
`--port`, or, if you already run a proxy, use `--behind-proxy`. In domain mode the ports are 80 and 443.

**`Docker Compose X é antigo: o mínimo é 2.24.7.`** Update the Compose plugin. Measured with 2.20.3: the override file is rejected
(`Top-level object must be a mapping`), Docker 29 answers `client version 1.43 is too old`, and `docker compose ps --format` is not
understood. Versions 2.21 to 2.23 were not tested.

**`o Docker não responde.`** The Docker service is not running, or your user may not use it (add it to the `docker` group, or run with
`sudo`).

**`este .env é do desenvolvimento do front (só tem VITE_*)`**: a `.env` of the front end sits at the root. Move it
(`mv .env .env.development.local`) and run `./install.sh` again. For a static host of the front end, the `VITE_*` variables go in the
environment of the build or in `.env.local`: `vite build` does not read `.env.development.local`, and a bundle built without them is a blank page.

**`não há .env, mas o Docker já tem volumes do projeto ...`.** The `.env` is gone (deleted, or a fresh clone) and the data of an earlier
installation is still in Docker volumes. New secrets would not open that data (the database keeps the old password and the Vault would not
decrypt), so the installer refuses and lists the volumes. Choose: restore the `.env` from `backups/*/.env` or `.env.bak.*` and run
`./install.sh` again (keeps the data); or `docker volume rm <the listed volumes>` and install again (**erases the data**: make
`./echo backup` first if there is anything to keep); or install beside it with `COMPOSE_PROJECT_NAME=other-name ./install.sh --port N`.
If containers of the old project still exist, `docker volume rm` fails with `volume is in use`: remove them first with
`docker ps -aq --filter label=com.docker.compose.project=<project> | xargs -r docker rm -f`, then `docker volume rm <the listed volumes>`.
Those old containers are still running and hold their ports, which also applies to the third choice (use `--port`). Without containers the
text above is all there is.

**`./install.sh --env-only` (completing a `.env`) says it will not invent a secret.** `POSTGRES_PASSWORD`, `ZAPO_DB_PASSWORD`, `JWT_SECRET`,
`ANON_KEY`, `SERVICE_ROLE_KEY`, `VAULT_ROOT_KEY`, `AI_KEY_SECRET` and the three Realtime keys are never generated for an installation that
already has data: a new value would lock the data. Restore the line from the backup's `.env` (or `.env.bak.*`). Only the secrets that can be
replaced (`QR_WEBHOOK_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `INSTAGRAM_OAUTH_STATE_SECRET`, `ECHO_SETUP_TOKEN` and the Web Push pair) are
generated when missing. The same hint appears when the Compose file refuses to start with `restaure o .env (backups/*/.env)`.

**Domain mode: the link fails with a TLS error.** The installer waits up to 90 seconds for `https://<domain>/config.js` from the machine itself
and, if it does not answer, prints a warning (never a failure) before the link; `./echo doctor` repeats the test. The usual causes: the DNS
record does not point at this machine yet (`dig +short echo.example.com` must print its public address), ports 80 and 443 are closed in
the firewall or the provider's panel, or the certificate authority refused to issue (limits on repeated issuance). The certificate is
asked at the first request, so read `./echo logs gateway --tail 100` for the reason. The test starts from the same machine, so a router
without hairpin NAT can show a false warning: try the address from a phone on mobile data. Certificate issuance by a real authority was
not tested.

**`upgrade`: `o build falhou. O código já está na versão nova ...`.** The images are mixed (the database image may already be the new one), so
**do not run `./echo up`**: it would apply the new migrations with the old functions and gateway. Fix the cause (usually memory, above) and run
`./install.sh`, which rebuilds and starts; or go back with `git checkout <the commit printed in the message> && ./install.sh`, and
`./echo restore backups/echo-<date>` if the database already migrated. If you follow a branch, the checkout stays detached after going back: to
try again later, `git checkout <branch> && ./echo upgrade`. On a machine with less than 4 GB the gateway, functions and qr were stopped for
the build and stay stopped when it fails: start them with the command in the message (`docker compose -p <project> start gateway functions qr`
in the repo folder) or run `./install.sh`.

**`./echo doctor` warns that ECHO_PUBLIC_URL is `http://` of a host that is not localhost.** Media loads only through that exact address (it is
the only origin the gateway's policy allows besides the page itself). Open Echo by the address in `ECHO_PUBLIC_URL`, or reinstall with the
address you really use.

**`http:// com IP público ... passariam em claro pela internet.`** Use a domain (`--domain`), a private network or VPN. Only if you
accept the risk, add `--insecure-http`.

**`arquitetura ... ARM64 ... não foram testados.`** A warning, not a failure: the images exist for ARM64 but building and running there
was not tested.

**The build is killed, or the machine freezes while building.** Memory. The `gateway` image (the Vite build of the front end)
peaks at 1.4 GiB. The installer builds one image at a time for this reason. On 2 GB of RAM create swap (for example a 2 GB swap file)
and try again; on less than 4 GB `./echo upgrade` also stops the gateway, functions and qr while it builds, and if the build fails they stay stopped (see the `upgrade` entry above for how to start them).

**`./echo status` or `./echo doctor` says the database refused the secrets, or the stack is `restarting`.** Same as the first entry:
`./echo logs db --tail 50` shows the `preflight:` lines.

**A service is `unhealthy` or does not start.** `./echo logs <service> --tail 100`. The ones with a specific message:

| Service | Message | Meaning and fix |
|---|---|---|
| `gateway` | `ANON_KEY e SERVICE_ROLE_KEY são iguais` / `ANON_KEY não tem role anon (as chaves do .env estão trocadas?)` / `não é um JWT de 3 partes` | the two keys in the `.env` are swapped, equal or not JWTs. Restore the `.env` from the backup |
| `gateway` | `SITE_ADDRESS precisa ser ':porta' ou um nome de host` | `ECHO_SITE_ADDRESS` has a space, a scheme or a slash |
| `gateway` | `ECHO_PUBLIC_URL não pode terminar com barra` / `precisa começar com http:// ou https://` | fix the address in the `.env` (then see "The address is fixed") |
| `gateway` | `ECHO_REDE_INTERNA ausente` / `ECHO_REDE_INTERNA inválido` | the gateway reaches the services as `<service>.<network>`. The official Compose sets `ECHO_REDE_INTERNA` to `<project>_default`. If you wrote your own Compose file for the gateway, define it (for example `echo_default`, the name of the network the services share) besides `ECHO_ALIAS_REDE_INTERNA` |
| `gateway` | `<serviço>.<rede> resolveu para <ip>, fora da sub-rede da rede interna` | another container on a network the gateway shares (usually the proxy's) answers to that service name. Remove the alias from that container, or move it off the network; the gateway will not start while a service name leads outside the internal network |
| `gateway` | `FEEDBACK_WEBHOOK_URL precisa começar com http:// ou https:// (ou ficar vazia)` | fix or empty the variable |
| `gateway` | `o gateway está em N redes e ECHO_ALIAS_REDE_INTERNA não está definido` | you wrote your own Compose file that connects the gateway to more than one network. Use `./install.sh --proxy-network NAME`, which sets the alias, or set `ECHO_ALIAS_REDE_INTERNA` yourself |
| `functions` | `[router] 45/46 funções carregadas ... FALHAS: {...}` and the health check failing | a function failed to load; the log names it and why. `/_health` is answered only inside the container (from the gateway it is a 404 on purpose) |
| `qr` | `[FATAL] o diretório de sessões (/app/sessions) não aceita escrita ...` | the sessions volume belongs to root (made by an older, root image). Run the `chown` in the [CHANGELOG](../CHANGELOG.md) / [upgrading.md](./upgrading.md) once |
| `qr` | exits 1 naming `ECHO_PUBLIC_URL` | it is not an `http(s)://` address, or has quotes. Fix it in the `.env` |
| `migrate` | `migrate: <file> já foi aplicada com outro conteúdo ... Migração aplicada não se edita` | someone edited a migration file that was already applied. Restore the file from git; schema changes go in a new file |
| `migrate` | `migrate: banco não respondeu em 60 s` | the database is not up; look at `./echo logs db` |

## Sign-in and first access

**`/setup` says the installation is already configured.** It is, and `/setup` closes for good once an organization or a super admin
exists. Sign in at `/auth`. If you lost the administrator's password: `./echo reset-password EMAIL`, or `./echo recovery-link EMAIL`.

**The first-access link does not exist any more.** `./echo setup-link` prints it while the first access is open. After that, it says
so and exits 1.

**`/setup` asks for a code.** Open the link with `?codigo=<value of ECHO_SETUP_TOKEN in the .env>`.

**Sign-in answers 429.** The sign-in service limits attempts per client address (the 31st wrong password in a window is refused). If
people in different places are limited together, you are behind a proxy that does not send the real client address:
[reverse-proxy.md](./reverse-proxy.md#the-x-forwarded-for-header-login-limit). Also: asking for a password recovery for the same
address twice inside one minute is answered with 429.

**"Esqueci minha senha" is missing.** That is by design without SMTP: the screen tells the person to ask the administrator for a link.
Create it with `./echo recovery-link EMAIL`. See [email.md](./email.md).

**The recovery link says it expired or was already used.** It is valid for 1 hour and works once. Generate another with
`./echo recovery-link EMAIL` (or, with SMTP, ask for a new e-mail and use the most recent one).

**An invitation from before has no e-mail.** Without SMTP or Resend the invitation dialog gives a link to copy; nothing is sent.

## Changing settings

**I edited the `.env` and nothing changed.** `./echo restart` does not read the `.env` again. Run `./echo up`.

**`./echo env check`** lists keys missing from, or left over in, your `.env` compared with `.env.example` (names only). After a
version upgrade the installer appends the new keys to your `.env` by itself; a hand-written `.env` can be completed with
`./install.sh --env-only`.

**The address is fixed.** `./install.sh` on an existing installation ignores `--domain`, `--url` and the other address options and prints
that the address is kept. The address is stored in the database (media URLs, links), so changing it means installing anew. If it was
changed in the `.env` anyway, `./echo doctor` warns that recent media were saved with another address and that they keep pointing
at the old one.

**A bare `docker compose ...` says `stat .../docker-compose.yml: no such file or directory`.** `COMPOSE_FILE` in the `.env` is relative to
the folder you are in. Run it from the repository folder, or use `./echo`, which does that for you.

## Proxy and addresses

**The page loads but the inbox never updates.** The WebSocket (`/realtime/v1/websocket`) is not passing your proxy. See
[reverse-proxy.md](./reverse-proxy.md).

**The QR code stays blank, or appears only after a long time.** Your proxy is buffering the stream under `/qr/`. Turn buffering off
for that path.

**Uploading a big file fails.** A body size limit or a timeout in the proxy (or, with Cloudflare, the plan's limit on one request).

**No push notifications, no voice messages, no "install app" on a server reached by IP.** HTTP on an IP address is not a secure context.
Use a domain with HTTPS, or `localhost`.

**Meta or Instagram cannot reach the webhook.** They need a public HTTPS address. A `localhost` or private-network installation cannot be
reached by them. The Meta webhook path is exactly `/functions/v1/whatsapp-webhook`: the public side answers 404 for any sub-path.

**Browser console: CSP violation.** The Content-Security-Policy is set by the gateway. If you added headers in your proxy, remove them. The
gateway's policy equals the one in `vercel.json` with two exceptions, both only when `ECHO_PUBLIC_URL` is `http://`: `ECHO_CSP_WS` adds
`ws://<host>` to `connect-src` (WebSocket) and `ECHO_CSP_HTTP` adds `http://<host>` to `img-src`, `media-src` and `connect-src`, so media saved
with the canonical address loads. Only that one origin is added. Consequence: with an `http://` address, media loads only when the page is
opened by the address of `ECHO_PUBLIC_URL` (not by `127.0.0.1` or another name of the machine).

**A PDF opened in a new tab by the raw Storage URL shows nothing (or downloads).** Files served from `/storage/v1/` carry their own
policy (`sandbox`, no scripts) and `nosniff`, so an uploaded file can never run code in the address of Echo. A sandboxed PDF does not render
in the browser's viewer. The **Download** button is not affected, and the file opens normally from the download.

**Browser console: two failed requests on the sign-in page** (`rpc/get_unread_counts` and `conversation_reads`, answered 401 or "permission
denied"). The unread-counter listener asks before there is a session, with the public key, and is refused. Harmless and known (it came with the
app); it stops being asked once you are signed in.

**A message arrives in the first second after opening a conversation and does not show up.** The Realtime service applies a filter on a
new channel about a moment after it confirms the subscription; the app fetches missed messages when the channel reconnects, so it
appears. (Observed in the tests, not a defect to chase unless it is permanent.)

## QR numbers

**The pairing says the number is banned or restricted, or the session drops.** That comes from WhatsApp, not from Echo. The QR service uses
unofficial clients and numbers can be restricted, especially with bulk sends, many new contacts per hour, or adding many people to groups.
The limits of the service reduce the risk; they cannot remove it. After a re-pairing, WhatsApp may refuse messages to people you have
never talked to for several hours ("Contato frio recusado"): that is a restriction of the server. See the README of the service.

**A second copy of the sessions is running.** Never run the same sessions twice (a restored backup next to its source, for example). The
second one desynchronizes the encryption and risks a ban.

**`./echo status` says `qr: indisponível`.** The QR service is not answering on its internal address: `./echo logs qr --tail 100`.

## Functions, cron and e-mail

**Cron jobs "succeeded" and nothing happens.** pg_net is asynchronous: look at the HTTP result, not at the job status:
`./echo psql -c "select status_code, content from net._http_response order by created desc limit 10"`. A 401 means the Vault's
`service_role_key` does not match the `.env` (`./echo doctor` checks the four Vault secrets).

**`doctor`: `Vault: só N de 4 segredos decifráveis`.** The `VAULT_ROOT_KEY` of the `.env` is not the one the database was created with.
Restore the `.env` of the backup. Never regenerate it on an installation with data.

**`job startup timeout` in `cron.job_run_details`.** pg_cron started the minute more than 10 seconds late and the job never ran. It happens
on a loaded or slow machine, and in the first minute after the stack comes up, before the gateway and functions are ready. It repeats on
its own at the next minute.

**An e-mail is not sent.** `./echo doctor` has an `e-mail` line that says what is wrong (no sender, invalid `SMTP_SECURE` or `SMTP_PORT`). Then
`./echo logs functions --tail 100`. Remember to run `./echo up` after editing the `.env`. See [email.md](./email.md).

**The sign-in service logs a warning on every internal call about a missing client address header.** Known noise: server-to-server
calls go through the internal listener, which has no client address by design.

**A webhook of an organization to my CRM on the local network is refused** (`URL do webhook bloqueada pela guarda`). Addresses on private
networks, loopback and cloud metadata are refused for URLs a user chooses. Allow the host by name:
`ECHO_OUTBOUND_ALLOW_HOSTS=crm.lan` in the `.env`, then `./echo up`. The same guard (and the same exception) applies to the webhook
of an organization, to the retries of notices, to the webhook node of an automation and to the **action button** of type webhook. All of
them follow at most three redirects and check each hop; the action button used to answer with the `30x` status itself and now follows it.
The first delivery to a blocked URL is saved as `falhou` with the reason, with no retry and no dead-webhook alert; in the retry path a
blocked URL also becomes a final failure. Host names with characters other than letters, digits, hyphen and dot (for example an underscore) are refused (`host_invalido`), and so are names the edge cannot resolve (`dns_sem_endereco`). `ECHO_OUTBOUND_ALLOW_HOSTS` still lets you allow an exact host name.

**After a host reboot the zapo numbers stay disconnected.** If the database is down for more than about 3 minutes while the host starts,
the zapo numbers stay disconnected. Run `./echo restart qr` (or reconnect the number in Settings > Numbers). (This follows from the service's retry window of about 3 minutes; a real host reboot with a slow database was not reproduced in the tests.)

## Backup, restore, upgrade

**`restore`: `o Postgres do backup (...) não é o desta instalação (...)`.** The backup was made with another Postgres base image; the data
directory would not open. Check out the code of the version that made the backup.

**`restore`: `o backup é da versão X, mais nova que este código`.** Update the code first.

**`restore`: `manifest ilegível ou incompleto` / `... está corrompido ou foi alterado`.** The backup folder is not intact. Nothing was changed.
Use another copy.

**`restore`: `o Vault tem N de 4 segredos decifráveis`.** The Vault key of the restored data did not match. It means the `.env` of the backup was
not the one that went with these data.

**`upgrade`: `há alterações locais em arquivos versionados`.** `git status` and commit, stash or discard them. Ignored files (`.env`, the
override) do not count.

**`upgrade`: `salto de versão maior`.** Read the CHANGELOG and confirm with `--force`.

## Slow or loaded machines

The tests of this repository ran on a shared machine, and the symptoms below showed up there:

- **Timeouts that are not real** in `npm test`: run again with `npx vitest run --testTimeout=30000`.
- **Smoke test, `AVISO realtime: global-notifications precisou de N tentativa(s)`** (`scripts/smoke-selfhost.sh`): the Realtime channel needed
  to be re-created. The script retries on its own; seeing it means the machine is slow, not that the check failed.
- **Smoke test, `FALHOU realtime: A recebe o INSERT em até 10 s` on WSL2, with the message arriving a moment later:** the wall clock of that VM was
  measured jumping forward about 16 s for a fraction of a second every 5 s, which makes any 10 s deadline computed with `Date.now()` expire at once.
  The Realtime scripts now count deadlines with a monotonic clock and send the main message up to 3 times (`AVISO realtime: a mensagem principal só
  chegou na tentativa N` means a retry was needed; it is not a failure). In normal use this does not matter: the web app does not depend on
  the wall clock for delivery, and a message the Realtime channel misses is picked up by the periodic refresh (within 60 s) or when the tab
  is focused again.
- **Containers restarting after the machine reboots:** `./echo up` brings the stack back. The long-running services have `restart: unless-stopped`; the
  measured time from a Docker daemon restart to everything healthy was 13 to 14 seconds.
