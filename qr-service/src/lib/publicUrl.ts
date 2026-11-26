/**
 * URL pública × URL interna do Storage (regra única do Echo auto-hospedado).
 *
 * No Docker o serviço fala com o stack por `SUPABASE_URL=http://gateway:8000` (a URL
 * interna, que o navegador não abre). Toda URL que SAI do servidor (gravada no banco,
 * mandada ao navegador) usa a pública, `ECHO_PUBLIC_URL`. Sem `ECHO_PUBLIC_URL` a
 * pública é a própria `SUPABASE_URL`: no Supabase hospedado nada muda.
 *
 * Este arquivo é o par de `supabase/functions/_shared/url-publica.ts` (mesmos seis
 * nomes, mesmo comportamento): mudou aqui, muda lá.
 *
 * O formato da URL pública de anexo é o do `getPublicUrl` do storage-js:
 * `encodeURI(`${base}/storage/v1/object/public/${bucket}/${path}`)`.
 */

const BUCKET_PADRAO = 'attachments';
const PREFIXO_OBJETO_PUBLICO = '/storage/v1/object/public/';

export class PublicUrlConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PublicUrlConfigError';
    }
}

/** Base `http(s)://host[:porta][/prefixo]` sem barra final; lança se a variável for inválida. */
function lerBase(nome: 'SUPABASE_URL' | 'ECHO_PUBLIC_URL', valor: string | undefined): string | null {
    const bruto = valor?.trim();
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

/** Base da URL INTERNA (`SUPABASE_URL`), usada por tudo que o serviço chama no stack. */
export function baseInterna(): string {
    const base = lerBase('SUPABASE_URL', process.env.SUPABASE_URL);
    if (!base) throw new PublicUrlConfigError('SUPABASE_URL não configurada');
    return base;
}

/** Base da URL PÚBLICA: `ECHO_PUBLIC_URL`; sem ela, a própria `SUPABASE_URL`. */
export function basePublica(): string {
    return lerBase('ECHO_PUBLIC_URL', process.env.ECHO_PUBLIC_URL) ?? baseInterna();
}

/** URL pública de um objeto do bucket (idêntica à do `getPublicUrl` do storage-js, sem opções). */
export function urlPublicaDoAnexo(caminho: string, bucket: string = BUCKET_PADRAO): string {
    return encodeURI(`${basePublica()}${PREFIXO_OBJETO_PUBLICO}${bucket}/${caminho}`);
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

    const normalizada = `${alvo.origin}${alvo.pathname}${alvo.search}`;
    const bases = new Set([basePublica(), baseInterna()]);
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
 * Caminho (decodificado) do objeto quando `url` aponta para o NOSSO Storage, pela base
 * pública ou pela interna; `null` para qualquer outra coisa. A query (`?v=…`) não faz
 * parte do caminho. Caminho com `..`, barra invertida ou caractere de controle vira
 * `null`: o `%2f` não é desfeito pela URL e não pode virar subida de diretório depois.
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
    if (/[\\\u0000-\u001f\u007f]/.test(caminho)) return null;
    if (caminho.split('/').some((parte) => parte === '..' || parte === '.')) return null;
    return caminho;
}

export function ehAnexoNosso(url: string): boolean {
    return caminhoDoAnexoNosso(url) !== null;
}

/**
 * Se `url` é do nosso Storage, troca a base pela interna (o que o servidor alcança);
 * senão devolve `url` igual. Mantém o caminho codificado e a query.
 */
export function paraUrlInterna(url: string, bucket: string = BUCKET_PADRAO): string {
    if (caminhoDoAnexoNosso(url, bucket) === null) return url;
    const achado = reconhecer(url, bucket);
    if (!achado) return url;
    return `${baseInterna()}${achado.normalizada.slice(achado.base.length)}`;
}
