# Adapter Baileys

Única pasta do serviço autorizada a importar `@whiskeysockets/baileys`
(`npm run check:adapter` falha se outro arquivo importar).

| Arquivo | Papel |
|---|---|
| `BaileysClient.ts` | implementa `WhatsAppClient`: ciclo de vida, envio, mídia, grupos, perfil, presença, snapshot |
| `inbound.ts` | `WAMessage`/eventos do Baileys → modelo normalizado (`InboundMessage`, `GroupInfo`, `DisconnectCause`) |
| `outbound.ts` | `OutboundContent` → `AnyMessageContent` |
| `FileSessionStore.ts` | pasta `sessions/<id>` (useMultiFileAuthState) + export/import de `AuthSnapshot` |
| `index.ts` | `BaileysClientFactory` (`name = 'baileys'`) |

Testes: `npm run test:adapter-contract` roda a suíte genérica de `tests/adapter-contract/`
contra o `@zapo-js/fake-server` usando o driver `drivers/baileys.ts`.
