# Upgrading

```bash
./echo upgrade                 # the latest commit of the branch you are on (git pull --ff-only)
./echo upgrade --to v2.14.0    # a specific release tag
```

Read the [CHANGELOG](../CHANGELOG.md) of the version you are going to before you run it. `./echo upgrade` prints the changelog
section of the new version when it finishes.

## What `./echo upgrade` does

1. Refuses to start if tracked files have local changes (`git status`), if `git fetch` fails, if the tag does not exist, if you are on
   a detached checkout without `--to`, or if the branch does not follow a remote.
2. Refuses a jump to a **new major version** unless you add `--force`.
3. Makes a [cold backup](./backup.md) (the stack is down for a few minutes). `--no-backup` skips it and prints a warning: do not skip it
   unless you have your own.
4. Checks out the tag (or pulls the branch, fast-forward only).
5. Completes the `.env` with the keys the new version introduced. It never rewrites an existing value. If this fails, the message says the code
   is already the new version, that the images and containers did not change, and how to go back: fix the `.env` and run `./install.sh`, or go back.
6. Rebuilds the four images one at a time (`db`, `gateway`, `functions`, `qr`). On a machine with less than 4 GB of RAM it stops
   the gateway, functions and qr during the build to keep the memory peak down.
7. Runs `up -d --wait`. The new migrations run in the `migrate` step, **before** the REST service is recreated.
8. Prints the CHANGELOG section of the new version.

Measured: an upgrade to a test tag that carried one new migration, on an installation with data, took 2 minutes 10 seconds
including the backup. Login worked before and after, a 300 KB file kept its sha256, the numbers of users and organizations
did not change and `echo_meta.schema_migrations` went from 5 to 6 rows. The path without `--to` (`git pull --ff-only`) was only
tested with a fake git; an upgrade whose migration fails halfway was not tested.

## Why a plain `git pull` is not an upgrade

The migrations are copied **into the database image**, not read from your disk, so that the schema and the code are always from the
same build. `git pull` on its own changes nothing in the running installation. Only the rebuild plus `up` applies the new
migrations. (The same is true for the front end, the functions and the QR service: they are all inside images.)

## Migrations

The `migrate` service records every file it applies in `echo_meta.schema_migrations` (version, name, sha256, time) and applies only the
new ones, each in its own transaction. **A migration that was already applied is never edited**: if the checksum of an applied file
changes, `migrate` stops with an error and the REST service and the gateway do not start. A failing migration also stops the
start, loudly, before anything depends on it.

## Rolling back

There is no downgrade command, because migrations are not reversible in general. The way back is the backup that `upgrade` made:

```bash
git checkout vOLD.VERSION          # the tag you were on
./install.sh                       # rebuilds the images of that version (keeps the .env)
./echo restore backups/echo-<date-before-the-upgrade>
```

Rebuild before restoring: `restore` starts the images that are on the machine, and the newer database image would apply its new
migrations to the restored data again.

`restore` refuses a backup that is newer than the code, so check out the old tag first. It also replaces the data with the data of the
backup: whatever was written after the backup is lost.

## Notes for specific upgrades

- **QR service, non-root image.** The `qr` image now runs as the user `node` (uid 1000) instead of root. A new installation is
  unaffected. A volume of sessions created by the old root image must be given to that user once, before starting the new image, or
  the service refuses to boot with `[FATAL] ... não aceita escrita`:

  ```bash
  docker run --rm -u 0 -v <project>_qr-sessions:/app/sessions --entrypoint chown <image> -R 1000:1000 /app/sessions
  ```

  (`<project>` is `echo` unless you changed it; `<image>` is the image of the QR service, for example `echo-qr:local`.) This only
  applies to someone who ran the QR service from an older image, such as the standalone `qr-service/docker-compose.yml`, and
  reuses its volume.
- **Moving from the Supabase Cloud installation to the Docker one is not supported** by any command. They are different installations;
  data does not migrate between them.
- **Changing the address** of an installation (`ECHO_PUBLIC_URL`) is not an upgrade and is not supported on an installation with data: the
  old address stays inside media URLs, avatars, stickers and template and flow metadata. Install anew, or move the machine
  with [restore](./backup.md) keeping the address.

## If the build fails halfway

`./echo upgrade` builds the images before it recreates anything: the containers that were running are not replaced, with one exception. On a
machine with less than 4 GB of RAM it stops the gateway, functions and qr before the build, and if the build fails they stay **stopped**: Echo is
down. The message printed by `./echo` gives the command to start them again, `docker compose --project-directory <the repo folder> --env-file <.env>
-p <project> start gateway functions qr` (in the repo folder the usual case is just `docker compose -p <project> start gateway functions qr`;
`start` recreates nothing and runs no migration), or run `./install.sh`, which rebuilds. The code on disk
is already the new version and the images are **mixed** (the database image, which carries the migrations, may already be the new one).
**Do not run `./echo up`**: it would apply the new migrations with the old functions and gateway. Fix the cause (usually memory: see
[troubleshooting.md](./troubleshooting.md)) and run `./install.sh`, which rebuilds the four images and starts the stack. To go back to the
previous version instead, `git checkout <the commit the command printed> && ./install.sh` (it rebuilds the old images), and
`./echo restore backups/echo-<date>` if the database had already migrated. If you follow a branch (`./echo upgrade` without `--to`), the checkout is
left detached after going back: to try the upgrade again later, `git checkout <branch> && ./echo upgrade`. The backup is made before the build, so an `./echo upgrade`
repeated afterwards makes another one unless you pass `--no-backup`.

That the database image is the first to be re-tagged is an inference from how Compose builds, not something measured. (Tagging the four
images with a temporary name and moving them to `:local` only after all four build would avoid the mix; it was not done because it
doubles the disk used by the images.)
