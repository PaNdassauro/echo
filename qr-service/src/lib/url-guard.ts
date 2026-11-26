import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { baseInterna, basePublica, caminhoDoAnexoNosso, paraUrlInterna } from './publicUrl.js';

/**
 * SSRF guard for caller-supplied URLs (e.g. `media_url`). Allows only http(s) to a
 * public host and rejects any hostname that resolves to a loopback / private /
 * link-local / cloud-metadata / carrier-NAT / ULA address, or a Fly `.internal`
 * host. Throws on rejection (caught by the route to return a 400).
 *
 * Limite conhecido: a guarda resolve o nome uma vez e o fetch resolve de novo, então
 * DNS rebinding não é coberto (a edge tem o mesmo limite). Cobre o SSRF direto e o por
 * redirecionamento: `fetchMediaUrl` passa cada salto por esta guarda.
 */

function isPrivateIp(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254)
  const addr = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip;

  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 0) return true;                       // "this" network
    if (a === 10) return true;                      // private
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;        // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
    return false;
  }

  const v6 = addr.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;     // loopback / unspecified
  if (v6.startsWith('fe80')) return true;           // link-local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique local
  return false;
}

export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid media_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('media_url must use http or https');
  }

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('media_url host is not allowed');
  }

  // Literal IP: check directly. Hostname: resolve every A/AAAA record.
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((entry) => entry.address);

  if (addresses.length === 0) {
    throw new Error('media_url host did not resolve');
  }

  for (const address of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('media_url resolves to a blocked address');
    }
  }
}

/**
 * Se `raw` é um objeto do NOSSO Storage (URL pública ou interna), devolve a URL
 * INTERNA para buscar; senão `null`. No Docker a URL pública do anexo é o endereço
 * do próprio gateway, que o guarda acima recusaria (host privado, `localhost`), e o
 * servidor só alcança o Storage pela interna. Não precisa de guarda: o endereço vem
 * da configuração (`SUPABASE_URL`), não de quem chamou. Qualquer outra URL: `null`,
 * e o chamador segue com `assertPublicHttpUrl`.
 */
export function resolveOwnStorageUrl(raw: string): string | null {
  if (caminhoDoAnexoNosso(raw) === null) return null;
  return paraUrlInterna(raw);
}

/** Máximo de redirecionamentos seguidos numa `media_url` externa (igual ao `fetchExterno` da edge). */
export const MAX_REDIRECIONAMENTOS = 3;
const REDIRECIONAMENTOS = new Set([301, 302, 303, 307, 308]);

/**
 * Busca a mídia de `media_url`.
 *
 * Com `ECHO_PUBLIC_URL` (Docker: a URL pública do anexo é o gateway, que o guarda recusaria): anexo nosso
 * vai pela URL interna, sem guarda e SEM seguir redirecionamento (o destino de um 30x não passou por
 * guarda nenhuma); o resto passa por `assertPublicHttpUrl` como sempre.
 *
 * URL externa (com ou sem `ECHO_PUBLIC_URL`): o redirecionamento é seguido À MÃO, até
 * `MAX_REDIRECIONAMENTOS` saltos, e o destino de cada salto passa pela guarda antes do fetch. Sem isso
 * um 302 do servidor do chamador levava o fetch ao IMDS da nuvem, ao host ou aos serviços do compose.
 * 30x sem `Location`, ciclo ou salto demais é recusado. A mídia é sempre GET, então não há corpo a reenviar.
 *
 * Lança como o guarda quando a URL é recusada.
 */
export async function fetchMediaUrl(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (basePublica() !== baseInterna()) {
    const interna = resolveOwnStorageUrl(raw);
    if (interna !== null) return fetchImpl(interna, { redirect: 'manual' });
  }
  let atual = raw;
  const vistas = new Set<string>();
  for (let salto = 0; ; salto++) {
    await assertPublicHttpUrl(atual);
    vistas.add(atual);
    const resposta = await fetchImpl(atual, { redirect: 'manual' });
    if (!REDIRECIONAMENTOS.has(resposta.status)) return resposta;
    await resposta.body?.cancel().catch(() => undefined);
    const destino = resposta.headers.get('location');
    if (!destino) throw new Error('media_url redirect without Location');
    if (salto >= MAX_REDIRECIONAMENTOS) throw new Error('media_url has too many redirects');
    let proximo: string;
    try {
      proximo = new URL(destino, atual).toString();
    } catch {
      throw new Error('media_url redirect to an invalid URL');
    }
    if (vistas.has(proximo)) throw new Error('media_url redirect loop');
    atual = proximo;
  }
}
