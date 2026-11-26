# Backup and restore

`./echo backup` and `./echo restore DIR` copy and bring back the whole installation: database, files, WhatsApp sessions,
certificates and the `.env`. The backup is **cold**: the stack is stopped while the data is copied, so the copy is consistent
(no file deleted during the window leaves a database row without its file).

## What goes into a backup

A folder `backups/echo-<YYYYMMDD-HHMMSS>/` inside the repository (ignored by git; use `--dest DIR` for another place), mode 700,
with these files (all mode 600):

| File | Content |
|---|---|
| `db-data.tar` | the Postgres volume: every table, the Vault, the `zapo` database |
| `storage-data.tar` | the files of the Storage (media, stickers, headers) |
| `qr-sessions.tar` | the WhatsApp sessions of the QR numbers |
| `caddy-data.tar` | certificates and the ACME account (domain mode) |
| `.env` | **the installation's secrets**, copied from the repository folder |
| `manifest.json` | Echo version, the Postgres base image, the time, and the size and sha256 of each file |

**The `.env` is part of the backup on purpose and a backup does not restore without it.** It holds the key of the Vault
(`VAULT_ROOT_KEY`), the key that encrypts the organizations' AI keys (`AI_KEY_SECRET`), the database password and the JWT
secret. It also means the backup folder is as sensitive as the `.env` itself: encrypt it before it leaves the machine, and do not
leave it on a shared disk.

Not in the backup: the code (your clone), `docker-compose.override.yml` (copy it yourself if you use one) and the Docker images (they
are rebuilt by `./install.sh`).

## Making a backup

```bash
./echo backup                       # backups/echo-<date>/
./echo backup --dest /mnt/disk/echo-2026-11-25      # the folder must not exist or must be empty
```

What it does: stops every service, saves the four volumes one by one with the database image, starts the stack again (only if something
was running: a stack that was stopped stays stopped, and the command says so) and waits for it to be healthy, copies the `.env`, sets the permissions and writes the manifest. **The installation is down while the volumes
are copied.** On a small installation that took 43 seconds in the test (a database of about 76 MB); it grows with your data, so
schedule it for a quiet hour.

Scheduling from the host's cron (the folder name must be new each time):

```cron
0 4 * * * cd /opt/echo && ./echo backup --dest /var/backups/echo/$(date +\%Y\%m\%d) >> /var/log/echo-backup.log 2>&1
```

Then copy the folder off the machine (and prune old ones). A backup that lives only on the disk that failed is not a backup. The
repository does not rotate or upload backups for you.

## Restoring

`./echo restore DIR` works on the same machine **and** on a new server.

1. **Turn the source off.** The installation that made the backup must be stopped (or gone) before you restore anywhere else.
   Two copies of the WhatsApp sessions running at the same time desynchronize the encryption and risk a ban. The command makes
   you confirm this.
2. On a new server: clone the repository at the same version (or newer) than the one that made the backup, then run `./install.sh`
   with the modes you want there (it generates a new `.env` and builds the images; you can ignore the first-access link). The images must exist,
   because `restore` uses the database image to unpack the volumes.
3. Copy the backup folder to the server and run:

   ```bash
   ./echo restore /path/to/echo-20261125-040000
   ```

What `restore` does:

1. Checks the sha256 of every file against the manifest. A manifest that is empty, reformatted or lacking a file stops it before
   anything is touched. It refuses a backup made with a different Postgres base image (the data directory would not open) and a
   backup from a **newer** Echo version than the code you have.
2. Asks you to type the project name (`echo` by default). Anything else cancels with nothing changed. It warns that the data of the
   project (database, files, sessions, certificates) is deleted.
3. Stops the stack (without deleting volumes), recreates the four volumes and unpacks the backup into them.
4. **Puts the secrets of the backup into the current `.env`** (`POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`,
   `VAULT_ROOT_KEY`, `AI_KEY_SECRET`, the Realtime keys, `ZAPO_DB_PASSWORD`, `QR_WEBHOOK_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
   `INSTAGRAM_OAUTH_STATE_SECRET`, `ECHO_SETUP_TOKEN` and the VAPID keys), saving the previous file as `.env.bak.<time>`. The
   address, ports, mode, `COMPOSE_FILE` and the optional settings (e-mail, Cloud API, Instagram) stay those of the current `.env`.
5. Starts everything and checks that the four Vault secrets decrypt. If not, it exits with an error: the Vault key did not match.

If the address of the backup differs from the address of the new `.env`, the restore warns you: media saved earlier keeps the old
address in the database and in the files' links. Prefer to restore under the same address.

Restoring only the database, or only the sessions, is not supported and there is no command for it: at boot the QR service deletes
the sessions of numbers the database does not know about.

## Moving to another machine

1. `./echo backup` on the source. If the stack was stopped, the backup is made all the same and it stays stopped.
2. **Turn the source off** after the backup (`./echo down`, or the whole machine). Anything written there after the backup is not in it,
   and two copies of the WhatsApp sessions must never run at once.
3. Copy the backup folder to the destination (it holds the `.env`: transport it encrypted).
4. On the destination, clone the same version of the code (or newer), run `./install.sh` with the modes you want, and
   `./echo restore <folder>` as described above. Prefer the same address; if it differs, the media saved earlier keeps the old one.

If you run `./install.sh` on the destination after the `.env` of the old installation is gone but volumes of a previous attempt remain,
the installer refuses and lists them: see [troubleshooting.md](./troubleshooting.md).

**A `--dest` inside the repository** is fine: the tar files, the manifest and the `.env` of the backup are excluded from the build
context of the images.

## Test your backups

The commands above were tested on the same folder and on a new folder with a different, freshly generated `.env` (login, a message, a file with the same sha256, an AI key and the Vault
all came back). That does not tell you your backup of last week is good. Restore one on a spare machine now and then, and run
`./echo doctor` afterwards.
