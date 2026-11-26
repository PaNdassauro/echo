# E-mail

E-mail is **optional**. Echo works fully without it. You choose one of three setups in the `.env`; after editing it run
`./echo up` (not `restart`: only `up` reads the `.env` again).

| Setup | Variables | What works |
|---|---|---|
| **No e-mail** (default) | none of the below | everything except messages by e-mail. Invitations become links you copy; passwords are reset by the administrator with `./echo` |
| **SMTP** | `SMTP_HOST` with a sender (`SMTP_ADMIN_EMAIL`, and optionally `EMAIL_FROM`) | everything, including "forgot my password" on the login screen |
| **Resend** | `RESEND_API_KEY` and `EMAIL_FROM` | invitations, alerts and feedback e-mail. **Not** the "forgot my password" screen, because the sign-in service (GoTrue) only speaks SMTP |

If `SMTP_HOST` is set, SMTP is used even when Resend variables are also filled. A variable left empty counts as absent.

## SMTP

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=echo@example.com
SMTP_PASS=<password>
SMTP_SECURE=            # starttls | tls | none ; empty = tls on port 465, otherwise starttls
SMTP_ADMIN_EMAIL=echo@example.com    # the sender address: REQUIRED when SMTP_HOST is set
SMTP_SENDER_NAME=Echo
```

- `SMTP_ADMIN_EMAIL` is the sender that the sign-in service uses and the one the functions use when `EMAIL_FROM` is empty
  (`"<SMTP_SENDER_NAME> <SMTP_ADMIN_EMAIL>"`). With `SMTP_HOST` but no sender nothing is sent: `./echo doctor` reports an ERRO.
  With `EMAIL_FROM` and no `SMTP_ADMIN_EMAIL`, invitations and alerts go out but the password-recovery e-mail does not
  (the sign-in service only reads `SMTP_ADMIN_EMAIL`): `./echo doctor` warns about it.
- `SMTP_SECURE` outside `starttls`, `tls` and `none` (any letter case) is a configuration error: the functions refuse to
  send, answer `email: "falhou"` and log it, and `./echo doctor` reports an ERRO. `SMTP_PORT` must be between 1 and 65535.
- **What was tested:** sending with a local test server (Mailpit) over **plain SMTP without TLS and without authentication**.
  **SMTP over TLS (port 465 or STARTTLS on 587) with authentication, against a real provider, was not tested.** The client is
  the `nodemailer` library, which supports them, but treat the first real setup as a test: invite yourself and check
  `./echo logs functions --tail 100` and `./echo logs auth --tail 100`.
- The password-recovery e-mail is sent by the sign-in service, with its own template in Portuguese, served by the gateway; the link
  returns to `<ECHO_PUBLIC_URL>/auth`. The service allows one recovery request for the same address per minute (a second one inside the
  minute is answered with 429).

## Resend

```env
RESEND_API_KEY=re_...
EMAIL_FROM=Echo <noreply@example.com>    # a sender on a domain verified in Resend
```

## What the e-mails are

| E-mail | Function | Recipients |
|---|---|---|
| Team invitation | `send-invitation` | the invited person |
| Number disconnected (QR) | `send-disconnect-alert` | per number, set on the QR connection screen |
| Pipeline failure, QR service down, heartbeat | `send-failure-alert` | `FAILURE_ALERT_EMAILS`; empty means every super admin |
| In-app feedback form | `send-feedback-email` | `FEEDBACK_EMAILS` |
| Password recovery, sign-up confirmation | the sign-in service | the person asking (SMTP only) |

## What changes on screen without e-mail

The front end learns what is available from the gateway's `/config.js`, which is rebuilt every time the gateway starts. The rule
is the same one the functions and `./echo doctor` use: e-mail counts as available with SMTP (`SMTP_HOST` plus a sender) or with
Resend (`RESEND_API_KEY` plus `EMAIL_FROM`); password recovery counts as available only with `SMTP_HOST` **and** `SMTP_ADMIN_EMAIL`.

| Where | Without e-mail |
|---|---|
| Invite a person ("Configurações > Equipe") | once at least one number is connected (before that the dialog only asks you to connect the first number), it shows the invitation link of each number, with a "Copiar" (Copy) button, and says that no e-mail was sent. You send the link yourself |
| "Esqueci minha senha" (Forgot my password) on the login screen | replaced by the text telling the person to ask the installation's administrator for a password link |
| The administrator resets a password | `./echo reset-password EMAIL` sets a new one (generated and shown once, or read from stdin with `--senha-stdin`), or `./echo recovery-link EMAIL` prints a link (valid for 1 hour, one use) that the person opens to choose their own. Neither sends anything |
| "Alterar senha" (Change password) | always in the profile settings, so a person given a generated password can change it. It does not ask for the current password |
| Disconnection alert by e-mail on a QR number | the switch, the list of recipients and the save button are disabled with an explanation. If an alert is triggered anyway the function answers `nao_configurado` and records `email_nao_configurado` in `disconnect_alert_log` (which also drives the cooldown) |
| Feedback form | hidden, unless `FEEDBACK_WEBHOOK_URL` is set (then it posts there) or `FEEDBACK_EMAILS` is set with e-mail working |
| Failure alerts and the heartbeat | the push notification of a failure alert still goes out; the e-mail part (including the heartbeat summary) answers `nao_configurado` without an error |

No function answers a 5xx because e-mail is missing: they answer 200 with `email: "nao_configurado"`, or `"falhou"` when sending
was tried and failed. Invitations always exist in the database and always return a link, whatever the e-mail did.

## An account that exists in the sign-in service but has no profile

Inviting an address that has an account in the sign-in service but **no profile row in the database** (an orphan, for example from a
half-done manual creation) no longer repairs it: the invitation is created as for a new person, and accepting it hits the
"e-mail already exists" case. The previous version walked the whole list of users to find such accounts, which does not scale. If
you hit it, give the account a profile row (or delete the orphan account) with `./echo psql`.
