# Support

Echo is maintained by volunteers. There is no support contract and no guaranteed response time, but most problems have an answer in the
documentation, and a good report gets looked at.

## Before you ask

1. **Run `./echo doctor`.** It reads the state of the installation and prints OK, AVISO (warning) or ERRO lines, with the fix on the ERRO lines.
2. **Look in [docs/troubleshooting.md](./docs/troubleshooting.md).** It lists the errors seen during the tests of the Docker installation, with the cause
   and what to do. The messages of `./install.sh` and `./echo` are in Portuguese and are quoted as they appear.
3. Read the page for what you are doing: [docs/self-hosting.md](./docs/self-hosting.md) (the reference),
   [docs/reverse-proxy.md](./docs/reverse-proxy.md), [docs/email.md](./docs/email.md), [docs/backup.md](./docs/backup.md),
   [docs/upgrading.md](./docs/upgrading.md). The README lists [what was not tested](./README.md#what-was-not-tested).

## Where to ask

- **A bug or something that does not work as documented:** open an issue with the "Bug report" form. It asks for the version, the machine, the output of
  `./echo doctor` and `./echo logs <service> --tail 100`. **Never paste the `.env`**, and read every log before you paste it: remove keys, passwords,
  tokens and customer phone numbers or message text.
- **An idea or a missing feature:** open an issue with the "Feature request" form. A feature applies to every organization and number.
- **A security problem:** do not open an issue. Use the private channel in [SECURITY.md](./SECURITY.md).
- **A question about how to use Echo** that the documentation does not answer: open an issue too, and say what you read. The answer will become documentation.

Issues can be written in English or Portuguese.

## What is out of scope

- Problems that come from WhatsApp itself: a number that was restricted or banned, a session that dropped, a message the server refused. QR numbers use
  unofficial clients ([README](./README.md#known-limitations)); the Cloud API is the supported way for numbers you cannot afford to lose.
- Your Meta app, your Meta Business account and your WhatsApp Business Account. [docs/self-hosting.md](./docs/self-hosting.md#12-whatsapp-cloud-api-official-numbers)
  says what Echo needs from them; the rest is between you and Meta.
- Your own proxy, firewall, DNS and certificates, beyond the contract described in [docs/reverse-proxy.md](./docs/reverse-proxy.md).
- Setups that the documentation says were not tested (ARM64, Podman, rootless Docker, SELinux): reports are useful, with the output of `./echo doctor`, and
  they are treated as discoveries rather than regressions.

## Em português

Peça ajuda abrindo uma issue (em português ou em inglês). Antes, rode `./echo doctor` e leia o
[guia de problemas](./docs/troubleshooting.md). Nunca cole o `.env`, e confira todo log antes de colar: tire chaves, senhas, tokens e telefones ou textos de
clientes. Vulnerabilidade não vai em issue: use o canal privado do [SECURITY.md](./SECURITY.md). Números que usam QR dependem de clientes não oficiais do
WhatsApp, e restrição ou banimento vem do WhatsApp, não do Echo.
