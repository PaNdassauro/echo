<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/echo-logo-dark.png">
    <img src="./public/echo-logo.png" alt="Echo" width="260">
  </picture>
</h1>

<p align="center"><strong>Português</strong> · <a href="./README.md">English</a></p>

O Echo é uma caixa de entrada de WhatsApp multi-tenant para equipes: vários números de WhatsApp dividem uma caixa por organização, com
atribuição de conversas, automações em fluxo, disparos, analytics, API REST pública e webhooks de saída. Os números se conectam por QR
code (um cliente não oficial, na pasta [`qr-service/`](./qr-service/README.pt-BR.md) deste repositório) ou pela Cloud API oficial do
WhatsApp, e uma conta de Instagram Direct pode dividir a caixa de um número.

> A interface do usuário está só em português do Brasil. Os comentários do código e as mensagens de commit também, assim como as mensagens do
> `./install.sh` e do `./echo`; os guias de `docs/` estão em inglês.
>
> O Echo é um projeto independente, sem afiliação, endosso ou patrocínio da Meta Platforms, do WhatsApp ou do Instagram. WhatsApp, Instagram
> e Meta são marcas de seus respectivos donos.

## Instalação

Você precisa de uma máquina com Docker. Sem conta, sem CLI e sem projeto hospedado de ninguém.

```bash
git clone https://github.com/PaNdassauro/echo.git && cd echo
./install.sh
```

Ele gera um `.env` com segredos novos, constrói as imagens na sua máquina, sobe tudo, espera ficar saudável e imprime o endereço e o link da
tela de primeiro acesso:

```text
  Echo:            http://localhost:8088
  Primeiro acesso: http://localhost:8088/setup?codigo=<código>
```

Sem opção, o Echo escuta só nesta máquina (127.0.0.1): serve para experimentar no seu computador. Num servidor, instale já com `--domain`,
`--url` ou `--behind-proxy` (abaixo), porque o endereço não muda depois sem reinstalar.

Guarde o `.env`: ele tem as chaves do banco e do Vault, e **um backup não restaura sem ele**.

### Requisitos

| | |
|---|---|
| Docker | Docker Engine (medido com o 29.1.5) e o plugin Compose **v2.24.7 ou mais novo** (o 2.20.3 não funciona) |
| CPU | x86_64. ARM64 não foi testado |
| RAM | 4 GB, ou 2 GB mais swap. Em repouso, sem número de WhatsApp conectado, o stack usa de 530 a 760 MiB; o build do front chega a 1,4 GiB, e por isso o instalador constrói uma imagem de cada vez |
| Disco | 10 GB livres. As imagens mediram cerca de 4,8 GB (os tamanhos que o `docker images` informa, com camadas compartilhadas contadas uma vez); o resto é folga para o cache de build, os seus dados e os backups |
| Rede | Internet na instalação e nas atualizações (imagens e pacotes são baixados) e saída para a internet em funcionamento (WhatsApp, Meta e o provedor de e-mail ou de IA que você configurar). As funções não baixam nada em funcionamento |
| Tempo | o stack sobe em 35 a 40 segundos; construir as quatro imagens leva cerca de 2 minutos com as imagens base já na máquina |
| Sistema | Linux. As medições foram feitas no WSL2, que serve para experimentar o Echo e não para produção; a fumaça também passa no runner Ubuntu do GitHub |

### Primeiro acesso

Abra o link `Primeiro acesso`. A tela pede nome, e-mail, uma senha (8 caracteres ou mais) e o nome da organização, cria o administrador e entra
com ele. O link só funciona enquanto a instalação não tem administrador; `./echo setup-link` o imprime de novo. Sem e-mail configurado, a senha
esquecida se redefine com `./echo reset-password <e-mail>`.

### Conectar um número

"Configurações > Números", aba "QR Code": digite um "Nome de exibição", clique em "Gerar QR" e leia o código com o celular (WhatsApp > Aparelhos
conectados > Conectar um aparelho). A aba "Código" pareia por um código de 8 dígitos. Número por QR usa
clientes de WhatsApp feitos por engenharia reversa: isso vai contra os termos do WhatsApp e o número pode ser restringido ou banido (leia as
[Limitações conhecidas](#limitações-conhecidas)). Para números oficiais use a Cloud API, que pede um endereço público com HTTPS e um app da Meta:
[docs/self-hosting.md](./docs/self-hosting.md#12-whatsapp-cloud-api-official-numbers) (em inglês).

### Outras formas de instalar

O mesmo instalador, com outros endereços. Os detalhes de cada uma estão em [docs/self-hosting.md](./docs/self-hosting.md#3-install) (em inglês).

- **Domínio próprio, HTTPS automático:** `./install.sh --domain echo.exemplo.com`. DNS apontando para a máquina, portas 80 e 443 livres. O Caddy obtém e renova o certificado (testado só com a autoridade interna do Caddy, não com uma real).
- **Atrás de um proxy que você já tem:** `./install.sh --behind-proxy --url https://echo.exemplo.com --port 8088`, ou `--proxy-network NOME` para um proxy em contêiner. Receitas para nginx, Caddy, Traefik e Cloudflare Tunnel: [docs/reverse-proxy.md](./docs/reverse-proxy.md).
- **Por endereço IP:** `./install.sh --url http://10.0.0.5:8088` (rede privada ou VPN). IP público exige `--insecure-http`, e HTTP puro em IP não é contexto seguro: sem instalar como app, sem notificações push, sem gravação de áudio.

O endereço fica fixo depois da instalação: para mudar, instale de novo (os dados não se movem).

## No dia a dia

```text
./echo status | logs [serviço] [-f] [--tail N] | up | down | restart [serviço]
./echo upgrade [--to vX.Y.Z] [--no-backup] [--force]
./echo backup [--dest DIR] | restore DIR
./echo reset-password EMAIL [--senha-stdin] | recovery-link EMAIL | setup-link
./echo doctor | psql | env check
```

`./echo doctor` é a primeira coisa a rodar quando algo parece errado: ele lê o estado e imprime linhas OK, AVISO ou ERRO com a correção. Depois de
editar o `.env`, aplique com `./echo up` (o `restart` não lê o arquivo de novo). Os logs giram sozinhos (10 MB vezes 3 arquivos por serviço).

**Atualização:** `./echo upgrade` faz um backup, pega o código novo, reconstrói as imagens e sobe o stack; as migrações novas rodam antes de o serviço
REST ser recriado. Leia o [CHANGELOG](./CHANGELOG.md) antes. Um `git pull` sozinho não atualiza nada, porque as migrações ficam dentro da imagem do
banco. [docs/upgrading.md](./docs/upgrading.md) (em inglês).

**Backup:** `./echo backup` para o stack por alguns minutos e salva o banco, os arquivos, as sessões do WhatsApp, os certificados e o `.env` em
`backups/echo-<data>/` (trate essa pasta como segredo). `./echo restore <pasta>` traz tudo de volta na mesma máquina ou, depois de um `./install.sh` lá, num servidor novo,
depois de você confirmar que a origem está desligada. [docs/backup.md](./docs/backup.md) (em inglês).

Mais: [e-mail](./docs/email.md) (SMTP, Resend ou nenhum), [solução de problemas](./docs/troubleshooting.md), [arquitetura](./docs/architecture.md). Os
guias de `docs/` estão em inglês; as mensagens do `./install.sh` e do `./echo` estão em português.

## O que não foi testado

A instalação foi medida de ponta a ponta (uma fumaça de 156 checagens, backup frio e restauração numa pasta nova, uma atualização com migração
nova, os três modos de instalação), e algumas coisas não foram:

- **ARM64** (build e execução), **Podman**, Docker rootless e **SELinux**.
- **Uma autoridade certificadora de verdade** no modo domínio (o HTTPS automático e o `wss` foram testados só com a autoridade interna do gateway) e um proxy real na frente: as receitas de `docs/reverse-proxy.md` não foram executadas uma a uma.
- **SMTP com TLS e autenticação** num provedor real (só SMTP simples contra um servidor de teste local). O Resend também não foi exercitado.
- **Linux nativo além da fumaça**: as medições rodaram no WSL2. Em Linux nativo só a fumaça do CI rodou (runner Ubuntu do GitHub).
- **Um número de WhatsApp de verdade**: nenhum teste abre sessão. Uso de memória com números conectados, a Cloud API contra a Meta, o Instagram e a entrega de Web Push a um navegador não foram exercitados.
- Firefox e Safari.
- `./echo upgrade` sem `--to` contra um remoto de verdade, e uma atualização cuja migração falha no meio.

Se você esbarrar em um desses pontos, abra uma issue com a saída de `./echo doctor`.

## O que tem por dentro

O Echo é construído sobre o Postgres, e a instalação com Docker empacota componentes de código aberto do ecossistema Supabase (a imagem de Postgres
do Supabase, o GoTrue para o login, o PostgREST, o Realtime e o Storage) ao lado dos serviços do próprio Echo. Você não precisa de conta no Supabase
nem da CLI dele: as imagens vêm de um registro público e tudo roda na sua máquina.

```
                Meta (Cloud API)                    Serviço de QR (qr-service/)
                webhook, assinado                   Node, Baileys / zapo, uma sessão por número
                       │                              │  /qr-*  (header x-qr-secret)
                       ▼                              ▼
  Navegador ──► gateway (Caddy: front + uma origem para todas as APIs, TLS no modo domínio)
                       │
        ┌──────────────┼───────────────────────────────────────────────┐
        ▼              ▼              ▼              ▼                 ▼
      auth           rest          realtime       storage          functions
     (GoTrue)    (PostgREST)                                    (46 edge functions,
        └──────────────┴──────┬───────┴──────────────┘            um processo Deno)
                              ▼
              Postgres 17: RLS em toda tabela, RPCs, triggers, pg_cron + pg_net, Vault
```

O Postgres é a fonte da verdade: a autorização mora nas policies de RLS e nas RPCs, o trabalho agendado roda no pg_cron e chega às funções pelo
pg_net. As funções integram com a Meta e com o serviço de QR. O front lê pelo supabase-js e recebe as mudanças pelo Realtime. Detalhes:
[docs/architecture.md](./docs/architecture.md).

| Camada | Tecnologia |
|---|---|
| Front | React 18, TypeScript, Vite 5, Tailwind CSS 3, shadcn/ui (Radix), TanStack Query, React Router 6, react-virtuoso, Recharts, @xyflow/react, zod, vite-plugin-pwa |
| Back | Postgres 17 com RLS, GoTrue, PostgREST, Realtime, Storage, edge functions em Deno, pg_cron, pg_net, Vault |
| Canais | WhatsApp Cloud API; o serviço de QR em `qr-service/` (Node 22, Express, Baileys e zapo); Instagram Messaging API (opcional) |
| E-mail e push | SMTP ou Resend (opcionais), Web Push com VAPID |
| Testes | Vitest + Testing Library, Deno test (funções), `node --test` com tsx (serviço de QR), uma fumaça em Docker |

## Funcionalidades

**Caixa de entrada**
- Caixa compartilhada por organização, com contadores de não lidas, filtros e busca global.
- Atribuição: dono principal mais co-donos, transferência entre atendentes, encerramento com motivo.
- Visibilidade por número (o atendente vê as conversas dos números a que tem acesso), isolamento por setor opcional por número.
- Texto, imagens, vídeo, documentos, áudios (gravados no navegador), figurinhas, localização, contatos, enquetes, reações, respostas, menções, edição e exclusão.
- Grupos de WhatsApp em números QR: participantes, convites, pedidos de entrada, criação de grupo.
- Notas internas, tags, respostas rápidas, contatos, mensagens agendadas, importação de histórico por exportação de conversa em CSV.
- Ajudas de IA opcionais, com a chave de API de cada organização (OpenAI, ou Anthropic em alguns recursos): copiloto de respostas, transcrição de áudio (só chave OpenAI) e insights de analytics.
- Ligações de voz em números QR do provider `zapo`, quando o serviço de QR é construído com suporte a voz (fora do stack Docker).

**Automação e campanhas**
- Construtor visual de fluxos com gatilhos, mensagens, mídia, botões, listas, condições, atrasos, horário comercial, webhooks e pesquisas.
- Disparos a partir de planilha, com templates da Cloud API, agendamento e status por destinatário; o disparo continua rodando com a aba fechada.
- Botões de ação no chat (`webhook`, `link`, `import_history`), opcionalmente por número.

**Integrações**
- API REST pública (`echo-api`) com a chave de API da organização no header `x-api-key`; documentação interativa em `/api-docs`.
- Webhooks de saída por organização (`message.received`, `message.sent`, `message.status`, `note.created`, `conversation.read`, `action_button.clicked`), com reenvio.
- Templates da Cloud API (criar, editar, excluir, enviar) e WhatsApp Flows (listar e enviar).

**Plataforma**
- PWA instalável e Web Push, som, título da aba e selo no favicon, para a notificação funcionar com a aba em segundo plano.
- Analytics (volume, atendentes, tempos de resposta, mapa de calor por hora, motivos de encerramento, templates, estimativa de custo) e relatório de atendimentos com exportação `.xlsx`.
- Alertas por e-mail quando um número desconecta ou o pipeline de mensagens falha (com e-mail configurado), e um batimento periódico.
- Área de super admin (`/super-admin`) e painel de operações (`/ops`) com a saúde da conexão dos números QR.

## Limitações conhecidas

- **Um nó só.** Sem alta disponibilidade, sem Realtime em vários nós, sem Postgres externo nem S3 para o Storage, sem serviço de transformação de imagem
  (o front usa as imagens originais; miniaturas e variantes reduzidas ficam desligadas). Carga além dos números medidos nos testes não foi explorada.
- **O endereço fica fixo depois da instalação**, porque está gravado no banco. Trocá-lo numa instalação com dados não é suportado.
- **Nada é publicado**: não há imagens prontas; as quatro imagens do Echo são construídas na sua máquina (cerca de 2 minutos, mais o primeiro download).
- **Fuso horário fixo.** Analytics, relatório de atendimentos, e-mail de batimento e parte da formatação usam `America/Sao_Paulo`.
- **Só português do Brasil**, e a normalização de telefone tem tratamento especial para números brasileiros (o "nono dígito" do celular).
- **Números QR usam bibliotecas não oficiais.** O serviço de QR conversa com o WhatsApp por clientes feitos por engenharia reversa (Baileys, zapo). Isso não é
  permitido pelos termos do WhatsApp, pode parar de funcionar quando o WhatsApp muda o protocolo, e o número pode ser restringido ou banido, principalmente
  com disparos, muitos contatos novos por hora ou adição de muita gente em grupos. O serviço tem limites que reduzem esse risco, mas não o eliminam. Use a
  Cloud API para números que você não pode perder.
- **Os arquivos de mídia são públicos para quem tem a URL deles (não adivinhável)**, e o isolamento entre organizações depende das policies de RLS. Leia o
  [SECURITY.md](./SECURITY.md) antes de expor uma instalação a gente em quem você não confia.
- **O `xlsx` 0.18.5 do npm tem vulnerabilidades conhecidas** (CVE-2023-30533, CVE-2024-22363); as versões corrigidas só saem pela CDN da SheetJS. A biblioteca só
  lê planilhas que um usuário logado envia ao importador de disparos, e grava a planilha de exemplo e as exportações de relatório. Se esse risco importa,
  troque pela versão da CDN da SheetJS.
- **O `npm audit` ainda aponta vulnerabilidades, e o motivo muda por pacote.** Na raiz (o app) são 9 pacotes (4 com `--omit=dev`). No código de produção: `xlsx`
  (acima); `zod` 3.x, cujo acúmulo de erros sem teto quando um array falha na validação (medido: 200.001 erros para um array de 200.000 elementos) só foi
  corrigido no Zod 4, e o app usa o zod para validar respostas do próprio backend (realtime, RPC, serviço de QR), então o pior caso é a aba do próprio
  usuário; e `react-router` 6 (corrigido só na 7.18; o app é uma aplicação de página única e só monta caminhos internos). O resto é ferramenta de
  desenvolvimento que nunca roda em produção (`vite`, `vitest`, `tinypool`, `esbuild`). As edge functions importam o `zod` 3.23.8 pelo lado do Deno, fora do
  `npm audit`, e validam entrada externa com ele. No serviço de QR são 4 pacotes (os mesmos 4 com `--omit=dev`): o `link-preview-js` não tem correção dentro
  da faixa que o Baileys aceita, e o `baileys` só aparece na lista por depender dele; o `music-metadata` tem correção dentro da faixa (11.16.0), mas é
  dependência direta do Baileys; o `sharp` só tem correção na 0.35 e também é usado pelo Baileys nas miniaturas e na foto de perfil. Nenhum dos três foi
  mexido de propósito, porque trocar uma biblioteca que o Baileys carrega muda o comportamento de um número. Tudo o mais que tinha correção publicada foi
  atualizado (veja o CHANGELOG). Revise a saída antes de expor uma instalação.

## Alternativa: Supabase Cloud ou a CLI do Supabase, mais um host estático

Se você prefere um projeto Supabase hospedado, ou quer o front na Vercel ou em qualquer host estático, o Echo continua rodando assim: aplique as migrações com a
CLI do Supabase, faça o deploy das funções, defina os segredos e hospede o `dist/` do `npm run build`. Não é o caminho recomendado e tem mais passos. O guia é
[docs/alternatives/supabase-cloud.md](./docs/alternatives/supabase-cloud.md) (em inglês). O serviço de QR também roda sozinho a partir do
[`qr-service/docker-compose.yml`](./qr-service/README.pt-BR.md) nesse arranjo.

## Desenvolvimento

```bash
git clone https://github.com/PaNdassauro/echo.git && cd echo
npm ci
npx supabase start                                    # Supabase local, aplica as migrações
cp .env.development.example .env.development.local    # as VITE_* do front, e não o .env.example
# preencha VITE_SUPABASE_PUBLISHABLE_KEY com o ANON_KEY de: npx supabase status -o env
# primeiro administrador: npm run bootstrap:admin (veja docs/development.md)
npm run dev                                           # http://localhost:8080
```

Comandos, as regras da instalação com Docker, a fumaça e as verificações antes de um pull request estão em
[docs/development.md](./docs/development.md) e [CONTRIBUTING.md](./CONTRIBUTING.md). Os mais usados:

| Comando | O que faz |
|---|---|
| `npm run typecheck` | `tsc -b`, o type-check que vale (o `npm run build` não checa tipos) |
| `npm test` | Vitest: `src/**/*.test.{ts,tsx}` e `scripts/*.test.mjs` |
| `npm run check:edge` · `npm run test:edge` · `npm run test:router` · `npm run check:verify-jwt` | as edge functions e o runtime delas (Deno 2.5.6) |
| `npm run smoke:selfhost` | fumaça ponta a ponta da instalação com Docker (cerca de 5 minutos) |
| `cd qr-service && npm ci && npm run build && npm run -s test:all` | build e testes do serviço de QR (projeto npm à parte) |

## Estrutura do repositório

```
src/                     front: páginas, componentes, hooks (supabase-js + Realtime), lib (com testes ao lado do código)
supabase/
  migrations/            o esquema: baseline, Auth/Storage, dados de referência, crons, primeiro acesso
  functions/             edge functions, uma pasta cada, código compartilhado em _shared/
  config.toml            verify_jwt de cada função, configuração do stack da CLI do Supabase
docker/                  a instalação com Docker: db, migrate, gateway, runtime das funções, compose por modo, gen-keys
docker-compose.yml       o stack
install.sh  echo         o instalador e a CLI de operação
qr-service/              serviço de QR (projeto npm próprio): src/, tests/, Dockerfile, docker-compose.yml, README, NOTICE
scripts/                 scripts operacionais, a fumaça (smoke-selfhost.sh, smoke/)
tests/                   testes Deno e SQL
docs/                    self-hosting, reverse-proxy, backup, upgrading, email, troubleshooting, architecture, development, alternatives/
.github/                 CI, modelos de issue e de pull request
```

## Contribuir, segurança, suporte

- [CONTRIBUTING.md](./CONTRIBUTING.md): preparo, verificações, estilo de commit. [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- [SECURITY.md](./SECURITY.md): como reportar uma vulnerabilidade e o que o operador precisa configurar.
- [SUPPORT.md](./SUPPORT.md): onde pedir ajuda.
- [CHANGELOG.md](./CHANGELOG.md): um changelog só para o app e o serviço de QR.

## Licença

MIT, veja [LICENSE](./LICENSE), para o código próprio do Echo (o repositório inteiro, `qr-service/` incluído). Os arquivos e dependências de
terceiros listados nos avisos mantêm as próprias licenças. Os avisos de terceiros (som de notificação, worker do codificador de áudio,
decodificador ThumbHash, componentes de interface, dados de emoji, as imagens que o Compose referencia, licenças de dependências) estão em [NOTICE](./NOTICE); as dependências do serviço de QR,
incluindo a `libsignal` GPL-3.0 via Baileys, estão detalhadas em [qr-service/NOTICE](./qr-service/NOTICE).
