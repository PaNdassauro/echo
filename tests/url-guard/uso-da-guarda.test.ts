// deno test --no-config --allow-env --allow-read tests/url-guard
// Regra 6 da SPEC 2.5: toda URL escolhida por organização ou usuário passa pela guarda SSRF. Um `fetch(` cru nesses
// pontos falha aberto (a edge alcança rest:3000, gateway:8000, qr:3000 e o IMDS). Este teste fixa os pontos conhecidos:
// cada arquivo importa o helper certo, o usa na chamada e não tem `fetch(` cru com a URL do tenant.
const RAIZ = new URL("../../supabase/functions/", import.meta.url);

interface Ponto {
  arquivo: string;
  /** Helper de `_shared/url-guard.ts` que o arquivo tem de importar e chamar. */
  helper: "fetchExterno" | "fetchMidia";
  /** Expressão da URL escolhida por tenant ou usuário: nunca pode ir a um `fetch(` cru. */
  urls: string[];
}

const PONTOS: Ponto[] = [
  { arquivo: "_shared/webhooks.ts", helper: "fetchExterno", urls: ["webhookConfig.url"] },
  { arquivo: "note-webhook/index.ts", helper: "fetchExterno", urls: ["webhookConfig.url"] },
  { arquivo: "conversation-webhook/index.ts", helper: "fetchExterno", urls: ["hook.url"] },
  { arquivo: "survey-timeout-execute/index.ts", helper: "fetchExterno", urls: ["url"] },
  { arquivo: "automation-execute/index.ts", helper: "fetchExterno", urls: ["url"] },
  { arquivo: "_shared/aviso-unico.ts", helper: "fetchExterno", urls: ["url"] },
  { arquivo: "action-button-webhook/index.ts", helper: "fetchExterno", urls: ["actionButtonConfig.url", "target.url"] },
  { arquivo: "_shared/og.ts", helper: "fetchExterno", urls: ["url", "atual"] },
  { arquivo: "whatsapp-create-template/index.ts", helper: "fetchMidia", urls: ["opts.fileUrl"] },
  { arquivo: "whatsapp-edit-template/index.ts", helper: "fetchMidia", urls: ["opts.fileUrl"] },
];

async function ler(arquivo: string): Promise<string> {
  return await Deno.readTextFile(new URL(arquivo, RAIZ));
}

function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const ponto of PONTOS) {
  Deno.test(`${ponto.arquivo}: URL de tenant passa por ${ponto.helper}, nunca por fetch cru`, async () => {
    const fonte = await ler(ponto.arquivo);
    const importa = new RegExp(`import\\s*\\{[^}]*\\b${ponto.helper}\\b[^}]*\\}\\s*from\\s*['"][^'"]*url-guard\\.ts['"]`);
    if (!importa.test(fonte)) throw new Error(`${ponto.arquivo}: falta importar ${ponto.helper} de url-guard.ts`);
    if (!new RegExp(`\\b${ponto.helper}\\(`).test(fonte)) throw new Error(`${ponto.arquivo}: ${ponto.helper} importado e não usado`);
    for (const url of ponto.urls) {
      // `fetch(` que não seja parte de outro identificador (fetchExterno, prefetch, doFetch…) com a URL como 1º argumento.
      const cru = new RegExp(`(?<![\\w.])fetch\\(\\s*${escapar(url)}\\s*[,)]`);
      if (cru.test(fonte)) throw new Error(`${ponto.arquivo}: fetch( cru com ${url}`);
    }
  });
}

Deno.test("as edges de webhook tratam a recusa da guarda com aviso, sem 5xx e sem detalhe ao chamador", async () => {
  for (const arquivo of ["note-webhook/index.ts", "conversation-webhook/index.ts", "survey-timeout-execute/index.ts", "action-button-webhook/index.ts"]) {
    const fonte = await ler(arquivo);
    if (!/instanceof UrlExternaBloqueadaError/.test(fonte)) throw new Error(`${arquivo}: não trata UrlExternaBloqueadaError`);
    if (!/console\.warn\([^)]*(guarda|bloqueada)/.test(fonte)) throw new Error(`${arquivo}: sem console.warn da recusa`);
  }
  // O note-webhook devolve o status do destino ao chamador: a recusa tem de sair genérica (sem o motivo da guarda).
  const note = await ler("note-webhook/index.ts");
  if (!/webhook_error:\s*bloqueada \? 'URL do webhook não permitida'/.test(note)) {
    throw new Error("note-webhook: a resposta ao chamador não pode trazer o motivo da guarda");
  }
  // O corpo da resposta de um servidor escolhido pelo tenant não vai para o log.
  const pesquisa = await ler("survey-timeout-execute/index.ts");
  if (/response\.text\(\)/.test(pesquisa)) throw new Error("survey-timeout-execute: não logar o corpo da resposta do webhook");
});

Deno.test("os templates não devolvem ao chamador a URL nem o motivo da recusa da amostra", async () => {
  for (const arquivo of ["whatsapp-create-template/index.ts", "whatsapp-edit-template/index.ts"]) {
    const fonte = await ler(arquivo);
    if (/new Error\(`Failed to fetch header sample[^`]*\$\{opts\.fileUrl\}/.test(fonte)) {
      throw new Error(`${arquivo}: o erro devolvido ao chamador traz a URL da amostra`);
    }
    if (!/instanceof UrlExternaBloqueadaError/.test(fonte)) throw new Error(`${arquivo}: não trata UrlExternaBloqueadaError`);
  }
});
