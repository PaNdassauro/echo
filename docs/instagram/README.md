# Instagram Direct no Echo

O Direct entra na caixa de uma linha de WhatsApp existente, com um card por contato e o selo do canal em cada
mensagem. O Instagram é **um tipo de conexão**, não uma linha nova em `phone_numbers`: cada conta fica pendurada
numa linha QR Code ou Business API (`instagram_connections.phone_number_id`) e **divide a caixa** com ela. As
conversas do Direct ficam gravadas nessa linha, com o ícone do Instagram.

## Como funciona

- Tela: Configurações > Números > aba **Instagram**. Cada conta é um card "Divide a caixa com <linha>", com
  Ligada/Desligada, Renomear, Trocar a caixa, Reconectar e Desconectar. Só admin mexe; o servidor confere.
- Conectar: "Conectar conta" → escolhe a linha → a função `instagram-conexao` (JWT, só admin) assina o `state`
  e devolve o link de login do Instagram → `instagram-oauth` grava a conexão e redireciona para
  `/settings?tab=appearance&instagram=<resultado>`. Linha que já tem outra conta responde `linha-ocupada`.
  A conexão nasce desligada.
- Modos (`instagram_connections.inbox_mode`):
  - `off`: só o registro cru do aviso em `instagram_webhook_events`, nada vira conversa;
  - `on`: todo Direct vira conversa na linha da conexão.

  O botão Ligada/Desligada da tela alterna entre `on` e `off`. Uma conta só divide a caixa com **uma** linha:
  ligar uma conta numa linha de teste manda todo Direct real para ela, então confira o modo e a linha antes.
- Trocar a caixa leva junto as conversas só do Direct. Se houver card juntado ao WhatsApp na linha atual, a troca
  é recusada.
- Conversa só do Direct: `conversations.channel = 'instagram'` e `contact_phone = 'ig:<IGSID>'` (não é telefone).
  Card juntado ao WhatsApp do contato (`instagram_juntar_conversa`, ação manual): `channel = 'whatsapp'` com
  `instagram_user_id` preenchido, e cada mensagem do Direct leva `metadata.canal = 'instagram'`.
- Resposta pelo painel: o composer é o mesmo. `whatsapp-send` detecta a conversa do Instagram e envia pela API do
  Instagram com o token da conexão. Só texto, até 1000 bytes, e só até 24 horas depois da última mensagem da pessoa
  (regra do Meta). O Direct não é telefone: nenhuma função de envio do WhatsApp aceita uma conversa do Instagram
  (`recusarSeDirect`, em `_shared/canal.ts`), e o front esconde o que é só do WhatsApp com `ehDirect()`/`temDirect()`
  (`src/lib/directDoInstagram.ts`).
- Lista de conversas: filtro Canal (WhatsApp / Instagram), só quando a linha tem conversa com Direct. "Instagram" =
  só Direct e card juntado; "WhatsApp" = conversa de WhatsApp, inclusive o card juntado.
- Token: a rotina `instagram-reprocessar` (cron de 5 minutos) renova o token longo quando faltam 10 dias, no máximo a
  cada 12 horas (`token_refresh_tried_at`); falha vira nota em `last_error`, que a tela mostra. A mesma rotina
  reprocessa avisos que falharam, porque o Meta não reentrega.
- RPCs: `instagram_listar_conexoes`, `instagram_configurar_conexao` e `instagram_desconectar` (nenhuma devolve o token).

## Funções e tabelas

- Tabelas: `instagram_connections` (conta ↔ linha; o token só existe no servidor) e `instagram_webhook_events`
  (aviso cru, com `signature_valid`). As duas têm RLS ligada e nenhuma policy: só a service role lê.
- `instagram-webhook`: GET = aperto de mão (`INSTAGRAM_VERIFY_TOKEN`); POST assinado = grava cada evento
  (`message`, `echo`, `deleted`, `postback`, `referral`, `read`, `reaction`, `edit`, `other`), deduplicado pelo
  sha256 do evento (`event_hash`), e depois o entrega à caixa conforme o `inbox_mode`. O resultado de cada aviso
  fica em `instagram_webhook_events.process_note`. Assinatura que não confere → 401 e, no máximo 60 vezes por hora,
  só uma impressão (sha256, bytes, cabeçalho presente) com `event_type = 'unsigned'`;
  `INSTAGRAM_WEBHOOK_REGISTRAR_INVALIDOS=false` desliga até isso.
- `instagram-oauth`: volta do login do Instagram. Troca o código por token longo (60 dias), lê a conta, assina os
  avisos (`messages, messaging_postbacks, messaging_referral, messaging_seen, message_reactions, message_edit`) e
  guarda a conexão. Responde com 302 para o `instagram-conexao.html` publicado junto do front (o domínio
  `*.supabase.co` entrega HTML de GET como texto cru). Toda chamada ao Meta passa por `buscar()`, que não deixa a
  URL (com token e segredo) ir para o log quando a rede falha.
- `instagram-conexao`: gera o link de login (JWT, só admin).
- `instagram-reprocessar`: cron; renova token e reprocessa avisos.

Todas, menos `instagram-conexao` e `instagram-reprocessar`, são chamadas sem JWT de usuário (`verify_jwt = false`
em `supabase/config.toml`): a prova de origem do webhook é a assinatura `X-Hub-Signature-256`, e a da volta do
login é o `state` assinado (organização + linha, vence em 30 minutos).

## Segredos do servidor

| Nome | O que é |
| --- | --- |
| `INSTAGRAM_APP_ID` | ID do app do Instagram (painel do Meta, produto Instagram) |
| `INSTAGRAM_APP_SECRET` | Segredo do app do Instagram. Aceita lista separada por vírgula; o **primeiro** é o par do `INSTAGRAM_APP_ID` (o login usa ele). Sem ele, todo POST ao `instagram-webhook` responde 401 |
| `INSTAGRAM_VERIFY_TOKEN` | Texto aleatório digitado também no painel do Meta (Webhooks) |
| `INSTAGRAM_OAUTH_STATE_SECRET` | Aleatório, com pelo menos 32 caracteres; assina o link de conexão. Sem ele (ou curto), conectar conta responde 503 |
| `INSTAGRAM_OAUTH_REDIRECT_URI` | Opcional. Padrão: `<endereço público>/functions/v1/instagram-oauth`, em que o endereço público é o `ECHO_PUBLIC_URL` (instalação com Docker) ou, sem ele, o `SUPABASE_URL` (só no caminho Supabase; na instalação com Docker o compose não a repassa e vale o padrão) |
| `INSTAGRAM_GRAPH_VERSION` | Opcional. Padrão `v25.0` |
| `SITE_URL` | **Obrigatória** (na instalação com Docker o compose a define sozinho, igual ao `ECHO_PUBLIC_URL`). URL pública do front, sem barra final (ex.: `https://<seu-dominio>`). A volta do login redireciona para ela (`<SITE_URL>/settings` e `<SITE_URL>/instagram-conexao.html`); sem ela o `instagram-oauth` responde 500 |
| `INSTAGRAM_PAGINA_RETORNO` | Opcional. URL pública do `instagram-conexao.html` do seu front. Padrão: `<SITE_URL>/instagram-conexao.html` |
| `INSTAGRAM_WEBHOOK_REGISTRAR_INVALIDOS` | Opcional. `false` não guarda nem a impressão de aviso sem assinatura |

**Instalação com Docker (`./install.sh`):** escreva estas variáveis (menos `INSTAGRAM_OAUTH_REDIRECT_URI` e `SITE_URL`) no `.env` da raiz (as chaves já estão lá, vazias; o `INSTAGRAM_OAUTH_STATE_SECRET` já vem gerado) e rode `./echo up`; o
`SITE_URL` e o endereço de retorno saem do `ECHO_PUBLIC_URL`. O Meta só alcança um endereço **público com HTTPS**: uma instalação em
`localhost` ou em rede privada não recebe os avisos do Instagram. Nas URLs do painel abaixo, troque `https://<project-ref>.supabase.co`
por `https://<seu-dominio>`. Esta rota não foi exercitada contra o Meta nos testes da instalação com Docker.

**Supabase hospedado ou local:** defina com `npx supabase secrets set NOME=valor --project-ref <seu-ref>` (ou em `supabase/functions/.env`, passado com
`--env-file` ao `npx supabase functions serve`, para as funções locais). A lista completa de segredos das edges, com o
que acontece sem cada um, está em `supabase/functions/.env.example`.

## Painel do Meta (app próprio do Direct, separado do app do WhatsApp)

1. Produto **Instagram** → "Configuração da API com login da empresa do Instagram".
2. Webhooks: URL de retorno `https://<project-ref>.supabase.co/functions/v1/instagram-webhook`, token de
   verificação = `INSTAGRAM_VERIFY_TOKEN`; assinar `messages`, `messaging_postbacks`, `messaging_referral`,
   `messaging_seen`, `message_reactions`, `message_edit` (os mesmos campos que o `instagram-oauth` assina na conta).
3. Login da empresa: URI de redirecionamento = `https://<project-ref>.supabase.co/functions/v1/instagram-oauth`.
4. App em modo **Ao vivo** (o Meta só manda aviso para app ao vivo).
5. O Meta exige uma URL de política de privacidade no app. O Echo não traz uma página pronta: publique a sua.
6. Link de conexão: sai da tela (aba Instagram, "Conectar conta"). O formato, para referência:
   `https://www.instagram.com/oauth/authorize?client_id=<INSTAGRAM_APP_ID>&redirect_uri=<URI>&response_type=code&scope=instagram_business_basic,instagram_business_manage_messages&state=<state assinado>`
   (state = organização + linha + validade de 30 minutos, assinado com `INSTAGRAM_OAUTH_STATE_SECRET`).

## Acesso padrão × acesso avançado

Uma pessoa **sem papel** no app nem no negócio manda 1 mensagem no Direct. Se ela aparecer em
`instagram_webhook_events` com `signature_valid = true`, o acesso padrão basta. Se só chegar mensagem de quem tem
papel, é preciso o acesso avançado (análise do app pelo Meta e verificação do negócio). A documentação do Meta se
contradiz nesse ponto.
