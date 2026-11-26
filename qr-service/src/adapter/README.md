# Adapter de biblioteca WhatsApp

O serviço fala com o WhatsApp só pelo contrato `WhatsAppClient` (este diretório).
Cada lib entra como um **provider** em `src/adapter/<provider>/`, a única pasta que
pode importar a lib (`npm run check:adapter` fiscaliza). A linha escolhe o provider
em `phone_numbers.qr_provider`; trocar de lib não re-pareia.

| Pasta | Papel |
|---|---|
| `types.ts` | modelo normalizado (mensagens, mídia por referência, grupos, recibos, capabilities, `AuthSnapshot`) |
| `WhatsAppClient.ts` | interface do cliente por sessão, factory, erros tipados |
| `registry.ts` | `ProviderRegistry` — resolve o provider pelo nome da linha |
| `proto/` | normalização do **proto do WhatsApp** (igual em toda lib Node): tipos estruturais, unwrap, conteúdo, fallback |
| `baileys/` | provider `baileys` (default): store em `sessions/<id>`, exporta/importa snapshot |
| `zapo/` | provider `zapo`: store em memória (testes) ou Postgres (`ZAPO_PG_URL`), importa snapshot do Baileys via `wa-store-migrate` |

## Trocar a lib de uma linha

```bash
# 1. Postgres para a zapo (schema próprio, tabelas wa_zapo_*) e reinício do serviço
ZAPO_PG_URL=postgres://...  ZAPO_PG_TABLE_PREFIX=wa_zapo_

# 2. Coluna phone_numbers.qr_provider (já vem no baseline do Echo)

# 3. Migra a linha sem QR: fecha, exporta creds, guarda backup em sessions/_snapshots/<id>/, importa, grava a coluna, reconecta
curl -X POST "$QR_SERVICE/session/migrate-provider/<phone_number_id>" \
  -H "Authorization: Bearer $SERVICE_KEY" -H 'content-type: application/json' \
  -d '{"to":"zapo"}'

# 4. Rollback = o mesmo POST com {"to":"baileys"} (usa o backup gravado no passo 3)
```

`GET /session/health` mostra `providers` (provider + lib por sessão) e `registered_providers`.

## Adicionar um provider

1. `src/adapter/<nome>/` com `XClient implements WhatsAppClient` e `XClientFactory implements WhatsAppClientFactory`
   (`name` = valor da coluna). Se a lib expõe o proto do WhatsApp, reaproveite `proto/content.ts`.
2. Declare `capabilities` honestamente: rotas respondem 501 para o que faltar.
3. Driver de 3 linhas em `tests/adapter-contract/drivers/<nome>.ts` + `<nome>.test.ts`; a suíte
   genérica roda contra `@zapo-js/fake-server` (protocolo real, sem telefone).
4. Registre no `SessionManager.initProviders()` e adicione a regra em `scripts/check-adapter-imports.mjs`.

## Limitações conhecidas

Do lado do provider zapo:

- Não exporta snapshot, não entrega histórico como eventos e não tem LID→PN pelo servidor: só o
  cache `deviceList` e o caminho inverso por `lookup()` com candidatos (ver `SessionManager.resolveLids`).
- Exige `WebSocket` global (Node 22); `src/adapter/zapo/polyfill.ts` injeta o `ws` onde faltar.
- `connect()` só resolve depois do pareamento: o adapter não pode dar `await` nele, senão a rota
  `/connect` trava até alguém escanear o QR.
- Depois do `pair-success` ela reconecta sozinha, sem emitir `connection` close.
- Recibo 1:1 chega só como recibo (o Baileys manda status): o serviço converte em `messages.update`.

Do lado dos testes de contrato (`@zapo-js/fake-server`):

- Reusar o `FakePeer` por JID: criar outro com o mesmo JID zera a sessão Signal do fake e o cliente
  falha com "cannot run recv DR step: no root key". O harness guarda um `Map<jid, FakePeer>`.
- Registrar `expectMessage()` ANTES de `send()`: o peer só captura stanzas a partir da inscrição.
- O fake não força o 515 depois do `pair-success`; o WhatsApp real fecha com `restart_required` e o
  serviço reconecta. O contrato aceita os dois desfechos.
- O USync do fake 1.3.0 não devolve `<lid>`: o Baileys rc14 (LID-first) falha o envio a frio com
  "All encryptions failed". O cenário fica `it.skip`; no WhatsApp real o LID vem do servidor.
- Mídia do Baileys rc14 vai por `fetch` nativo: usar o override `host` de `MediaDownloadOptions` e
  `NODE_TLS_REJECT_UNAUTHORIZED=0` só no teste.
- `close()` precisa esperar o `close` do socket antes de resolver, senão `exportAuthSnapshot()` roda
  com o socket vivo.
- A suíte de contrato não cobre o `SessionManager`: ele só lê campos do contrato (`sent.key.id`), nunca
  `raw`, que serve só para cache e diagnóstico.
- Chave presente com `undefined` sobrescreve default em spread: a suíte precisa de um cenário sem
  override de transport.
