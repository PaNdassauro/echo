// URL interna × pública do Storage (regra única da SPEC 2.5).
//
//  - Chamada de API de servidor (supabase-js, funções, qr, pg_net) usa a base INTERNA: SUPABASE_URL
//    (no compose, http://gateway:8000).
//  - Toda URL que SAI do servidor (gravada no banco, mandada ao navegador, à Meta, ao serviço de QR, em e-mail)
//    usa a base PÚBLICA: ECHO_PUBLIC_URL. Sem ECHO_PUBLIC_URL (Supabase Cloud/CLI) a pública é a SUPABASE_URL.
//  - Antes de o servidor buscar uma URL que é do nosso Storage, ela é traduzida para a interna (`paraUrlInterna`).
//  - Reconhecer "anexo nosso" aceita as duas bases, para que linhas antigas e de outro acesso continuem lidas. Só a rota
//    pública (`object/public/`): URL assinada (`object/sign/`) é tratada como externa, como no par do qr-service.
//
// Par de: qr-service/src/lib/publicUrl.ts (mesmos seis nomes, mesmo comportamento) e, no front,
// src/lib/runtimeConfig.ts (`publicAttachmentUrl`, `isOwnStorageBase`). Mudou aqui, muda nos outros. Os casos de
// url-publica.test.ts são os de qr-service/tests/public-url.test.ts. Única diferença de propósito: aqui, com a
// configuração ausente ou inválida o reconhecimento devolve "não é nosso" em vez de lançar (o qr aborta o boot antes).

const BUCKET_PADRAO = 'attachments';
const PREFIXO_OBJETO_PUBLICO = '/storage/v1/object/public/';

/** Variável de ambiente de URL (SUPABASE_URL, ECHO_PUBLIC_URL) ausente ou mal formada. */
export class PublicUrlConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicUrlConfigError';
  }
}

/** Base `http(s)://host[:porta][/prefixo]` sem barra final; lança se a variável for inválida, null se vazia. */
function lerBase(nome: 'SUPABASE_URL' | 'ECHO_PUBLIC_URL'): string | null {
  const bruto = (Deno.env.get(nome) ?? '').trim();
  if (!bruto) return null;
  let url: URL;
  try {
    url = new URL(bruto);
  } catch {
    throw new PublicUrlConfigError(`${nome} não é uma URL válida: "${bruto}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicUrlConfigError(`${nome} precisa começar com http:// ou https://`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PublicUrlConfigError(`${nome} não pode ter usuário, senha, query nem fragmento`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Base interna (SUPABASE_URL), sem barra final: de onde o servidor fala com a API. */
export function baseInterna(): string {
  const base = lerBase('SUPABASE_URL');
  if (!base) throw new PublicUrlConfigError('SUPABASE_URL não configurada');
  return base;
}

/** Base pública (ECHO_PUBLIC_URL; sem ela, a SUPABASE_URL), sem barra final: a que sai do servidor. */
export function basePublica(): string {
  return lerBase('ECHO_PUBLIC_URL') ?? baseInterna();
}

/**
 * URL pública de um objeto do bucket, no formato do `getPublicUrl` do storage-js 2.87.1
 * (`StorageFileApi.js:742-762`): `encodeURI(`${base}/storage/v1/object/public/${bucket}/${path}`)`.
 */
export function urlPublicaDoAnexo(path: string, bucket: string = BUCKET_PADRAO): string {
  return encodeURI(`${basePublica()}${PREFIXO_OBJETO_PUBLICO}${bucket}/${path}`);
}

/** Barra invertida ou caractere de controle (U+0000 a U+001F, U+007F). Sem regex: o `no-control-regex` recusa o intervalo. */
function temBarraInvertidaOuControle(texto: string): boolean {
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    if (c === 0x5c || c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

interface AnexoReconhecido {
  /** URL normalizada (origem em minúsculas, `..` resolvido, sem fragmento). */
  normalizada: string;
  /** Base (pública ou interna) que casou, sem barra final. */
  base: string;
  /** Caminho do objeto, ainda codificado, sem a query. */
  caminhoCodificado: string;
}

function reconhecer(url: string, bucket: string): AnexoReconhecido | null {
  let alvo: URL;
  try {
    alvo = new URL(url);
  } catch {
    return null;
  }
  if (alvo.protocol !== 'http:' && alvo.protocol !== 'https:') return null;
  // `http://host-nosso@host-alheio/` casaria por prefixo de texto: usuário e senha nunca.
  if (alvo.username || alvo.password) return null;

  // Sem as variáveis (ou com valor inválido) nada é "nosso": nunca lança por causa de uma URL de terceiro.
  const bases = new Set<string>();
  for (const ler of [basePublica, baseInterna]) {
    try {
      bases.add(ler());
    } catch {
      // variável ausente ou inválida não reconhece nada
    }
  }
  const normalizada = `${alvo.origin}${alvo.pathname}${alvo.search}`;
  for (const base of bases) {
    const prefixo = `${base}${PREFIXO_OBJETO_PUBLICO}${bucket}/`;
    if (!normalizada.startsWith(prefixo)) continue;
    const caminhoCodificado = alvo.pathname.slice(prefixo.length - alvo.origin.length);
    if (caminhoCodificado.length === 0) return null;
    return { normalizada, base, caminhoCodificado };
  }
  return null;
}

/**
 * Caminho (decodificado) do objeto quando `url` aponta para o NOSSO Storage, pela base pública ou pela interna;
 * `null` para qualquer outra coisa. A query (`?v=…`) não faz parte do caminho. Caminho com `..`, `.`, barra
 * invertida ou caractere de controle vira `null`: o `%2f` não é desfeito pela URL e não pode virar subida de
 * diretório depois.
 */
export function caminhoDoAnexoNosso(url: string, bucket: string = BUCKET_PADRAO): string | null {
  const achado = reconhecer(url, bucket);
  if (!achado) return null;
  let caminho: string;
  try {
    caminho = decodeURIComponent(achado.caminhoCodificado);
  } catch {
    return null;
  }
  if (temBarraInvertidaOuControle(caminho)) return null;
  if (caminho.split('/').some((parte) => parte === '..' || parte === '.')) return null;
  return caminho;
}

/** A URL é de um anexo do nosso Storage (qualquer das duas bases)? */
export function ehAnexoNosso(url: string, bucket: string = BUCKET_PADRAO): boolean {
  return caminhoDoAnexoNosso(url, bucket) !== null;
}

/**
 * Para o servidor BUSCAR uma URL: se é um anexo nosso, troca a base pela interna (mantém caminho codificado e
 * query); senão devolve igual. Essa busca não passa pela guarda SSRF: o endereço vem da configuração, não do
 * chamador.
 */
export function paraUrlInterna(url: string, bucket: string = BUCKET_PADRAO): string {
  if (caminhoDoAnexoNosso(url, bucket) === null) return url;
  const achado = reconhecer(url, bucket);
  if (!achado) return url;
  return `${baseInterna()}${achado.normalizada.slice(achado.base.length)}`;
}
