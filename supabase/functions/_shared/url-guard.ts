/**
 * Guarda contra SSRF para URL configurada por tenant (ex.: webhook de botão de
 * ação). A edge roda dentro da rede do Supabase: sem esta guarda, uma URL
 * `http://169.254.169.254/…` ou `http://localhost:…` faz a function bater em
 * serviço interno com o corpo que ela monta.
 *
 * Duas camadas:
 *   1. Host literal (sempre): só http/https; recusa localhost, nomes sem ponto,
 *      `.local`, `.internal`, `.localhost` e IP literal de faixa privada,
 *      loopback, link-local, CGNAT, multicast ou não roteável (IPv4 e IPv6,
 *      incluindo IPv4 mapeado em IPv6). O parser WHATWG já normaliza formas
 *      como `http://2130706433/` e `http://0x7f.1/` para `127.0.0.1`.
 *      Também recusa nome fora de letras, dígitos, hífen e ponto (`host_invalido`):
 *      o `Deno.resolveDns` rejeita `_` sem consultar nada, mas o fetch resolve
 *      pelo sistema e aceita, e o nome interno do compose (`<projeto>_default`)
 *      tem sublinhado. O parser WHATWG já converte IDN em punycode (ASCII).
 *   2. DNS (quando o runtime tem `Deno.resolveDns`): resolve A/AAAA e recusa se
 *      QUALQUER endereço cair numa faixa bloqueada, ou se nenhum dos dois tipos
 *      devolver endereço (`dns_sem_endereco`: falha fechada). Basta um tipo ter
 *      endereço. Se o runtime não oferecer a API, fica só a camada 1.
 *
 * Limite conhecido: entre a resolução e o fetch o DNS pode mudar (rebinding).
 * O chamador deve usar `redirect: 'manual'` para que um 30x não leve a
 * requisição a um host que não passou por aqui.
 */

import { ehAnexoNosso, paraUrlInterna } from './url-publica.ts';

export type UrlGuardResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return null;
  return nums;
}

function isBlockedIPv4(o: number[]): boolean {
  const [a, b] = o;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local / metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 192 && b === 0 && o[2] === 0) || // 192.0.0/24 (IETF)
    (a === 198 && (b === 18 || b === 19)) || // benchmark 198.18/15
    a >= 224 // multicast + reservado + broadcast
  );
}

/** Expande um IPv6 (sem colchetes) em 8 grupos de 16 bits; null se inválido. */
function parseIPv6(host: string): number[] | null {
  let text = host.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  // Sufixo IPv4 (ex.: ::ffff:127.0.0.1) vira dois grupos.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums;
}

function isBlockedIPv6(g: number[]): boolean {
  const allZeroPrefix = g.slice(0, 5).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapeado) e ::a.b.c.d (compatível, obsoleto): vale a regra do IPv4.
  if (allZeroPrefix && (g[5] === 0xffff || g[5] === 0) && !(g[5] === 0 && g[6] === 0)) {
    return isBlockedIPv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  const first = g[0];
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 (ULA)
    (first & 0xffc0) === 0xfe80 || // fe80::/10 (link-local)
    (first & 0xffc0) === 0xfec0 || // fec0::/10 (site-local, obsoleto)
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x64 && g[1] === 0xff9b) || // NAT64 64:ff9b::/96 (embute IPv4)
    (first === 0x2001 && g[1] === 0x0db8) // documentação
  );
}

/** true se o endereço IP (literal, sem colchetes) estiver numa faixa bloqueada. */
export function isBlockedIp(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isBlockedIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return isBlockedIPv6(v6);
  return false;
}

/** Camada 1: protocolo e host literal. Não faz rede. */
export function checkUrlLiteral(raw: string): UrlGuardResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'url_invalida' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'protocolo_nao_permitido' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credencial_na_url' };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'host_vazio' };

  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1);
    return isBlockedIp(inner) || !parseIPv6(inner)
      ? { ok: false, reason: 'ip_bloqueado' }
      : { ok: true, url };
  }
  if (parseIPv4(host)) {
    return isBlockedIp(host) ? { ok: false, reason: 'ip_bloqueado' } : { ok: true, url };
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.')
  ) {
    return { ok: false, reason: 'host_interno' };
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: 'host_invalido' };
  return { ok: true, url };
}

type DnsResolver = (host: string, type: 'A' | 'AAAA') => Promise<string[]>;

function runtimeResolver(): DnsResolver | null {
  const resolve = (Deno as unknown as { resolveDns?: DnsResolver }).resolveDns;
  return typeof resolve === 'function' ? resolve.bind(Deno) : null;
}

/**
 * Camadas 1 e 2. `resolver` existe para teste; em produção usa
 * `Deno.resolveDns` quando o runtime oferece.
 */
export async function checkOutboundUrl(
  raw: string,
  resolver: DnsResolver | null = runtimeResolver(),
): Promise<UrlGuardResult> {
  const literal = checkUrlLiteral(raw);
  if (!literal.ok) return literal;
  const host = literal.url.hostname.replace(/\.$/, '');
  if (host.startsWith('[') || parseIPv4(host) || !resolver) return literal;

  const addresses: string[] = [];
  for (const type of ['A', 'AAAA'] as const) {
    try {
      addresses.push(...(await resolver(host, type)));
    } catch {
      // Sem registro desse tipo (ou API indisponível): segue com o que houver.
    }
  }
  if (addresses.length === 0) return { ok: false, reason: 'dns_sem_endereco' };
  if (addresses.some((ip) => isBlockedIp(ip))) {
    return { ok: false, reason: 'dns_aponta_para_rede_interna' };
  }
  return literal;
}

// ---------------------------------------------------------------- fetch de URL escolhida por tenant ou usuário

/** A guarda recusou a URL (ou um salto de redirecionamento). `reason` é o motivo para o log. */
export class UrlExternaBloqueadaError extends Error {
  constructor(public readonly reason: string, public readonly url: string) {
    super(`url externa bloqueada (${reason}): ${url}`);
    this.name = 'UrlExternaBloqueadaError';
  }
}

export interface OpcoesFetchExterno {
  /** Saltos de 30x seguidos (cada um passa pela guarda de novo). Padrão 3. */
  maxRedirecionamentos?: number;
  /** Hosts exatos liberados (padrão: ECHO_OUTBOUND_ALLOW_HOSTS). Só para teste. */
  permitidos?: string[];
  /** Só para teste. */
  resolver?: DnsResolver | null;
  fetchImpl?: typeof fetch;
}

/** ECHO_OUTBOUND_ALLOW_HOSTS: hosts exatos separados por vírgula; vazio = nenhum. Sem curinga, sem porta. */
export function hostsExternosPermitidos(valor: string | undefined): string[] {
  return (valor ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''))
    .filter(Boolean);
}

function hostDaUrl(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

const REDIRECIONAMENTOS = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch` para URL escolhida por tenant ou usuário (webhook da organização, nó de webhook da automação, prévia
 * de link): cada salto passa por `checkOutboundUrl` e o redirecionamento é manual (30x com `Location` é checado de
 * novo), então um host público não leva a edge a `rest:3000`, ao gateway ou ao IMDS da nuvem.
 *
 * Exceção configurável: host exato em ECHO_OUTBOUND_ALLOW_HOSTS (CRM ou n8n na rede local) passa sem a camada de
 * host/IP; protocolo http/https e ausência de credencial na URL continuam valendo.
 *
 * Lança `UrlExternaBloqueadaError` quando a guarda recusa ou os redirecionamentos passam do limite; erro de rede
 * do fetch segue como veio.
 */
export async function fetchExterno(
  url: string | URL,
  init: RequestInit = {},
  opcoes: OpcoesFetchExterno = {},
): Promise<Response> {
  const max = opcoes.maxRedirecionamentos ?? 3;
  const permitidos = opcoes.permitidos ?? hostsExternosPermitidos(Deno.env.get('ECHO_OUTBOUND_ALLOW_HOSTS'));
  const chamar = opcoes.fetchImpl ?? fetch;
  let atual = typeof url === 'string' ? url : url.toString();
  let metodo = init.method ?? 'GET';
  let corpo = init.body;
  let cabecalhos = new Headers(init.headers);

  for (let salto = 0; ; salto++) {
    let parsed: URL;
    try {
      parsed = new URL(atual);
    } catch {
      throw new UrlExternaBloqueadaError('url_invalida', atual);
    }
    const liberado = permitidos.includes(hostDaUrl(parsed));
    if (liberado) {
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new UrlExternaBloqueadaError('protocolo_nao_permitido', atual);
      }
      if (parsed.username || parsed.password) throw new UrlExternaBloqueadaError('credencial_na_url', atual);
    } else {
      const guarda = opcoes.resolver === undefined
        ? await checkOutboundUrl(atual)
        : await checkOutboundUrl(atual, opcoes.resolver);
      if (!guarda.ok) throw new UrlExternaBloqueadaError(guarda.reason, atual);
    }

    const resposta = await chamar(parsed.toString(), { ...init, method: metodo, body: corpo, headers: cabecalhos, redirect: 'manual' });
    const destino = resposta.headers.get('location');
    if (!REDIRECIONAMENTOS.has(resposta.status) || !destino) return resposta;
    await resposta.body?.cancel().catch(() => undefined);
    if (salto >= max) throw new UrlExternaBloqueadaError('redirecionamentos_demais', atual);

    let proximo: URL;
    try {
      proximo = new URL(destino, parsed);
    } catch {
      throw new UrlExternaBloqueadaError('url_invalida', destino);
    }
    // Regras do fetch: 303, ou 301/302 de POST, viram GET sem corpo; 307/308 repetem método e corpo.
    if (resposta.status === 303 || ((resposta.status === 301 || resposta.status === 302) && metodo === 'POST')) {
      metodo = 'GET';
      corpo = undefined;
      cabecalhos = new Headers(cabecalhos);
      cabecalhos.delete('content-type');
      cabecalhos.delete('content-length');
    }
    if (proximo.origin !== parsed.origin) {
      cabecalhos = new Headers(cabecalhos);
      for (const h of ['authorization', 'cookie', 'proxy-authorization']) cabecalhos.delete(h);
    }
    atual = proximo.toString();
  }
}

/**
 * `fetch` de uma mídia por URL. Anexo do NOSSO Storage (a URL gravada é a pública) é buscado pela base interna,
 * sem a guarda: o endereço vem da configuração, não do chamador (SPEC 2.5, regra 3). Qualquer outra URL foi
 * escolhida por um usuário ou tenant e passa por `fetchExterno` (guarda SSRF + redirecionamento manual).
 */
export function fetchMidia(
  url: string,
  init: RequestInit = {},
  opcoes: OpcoesFetchExterno = {},
): Promise<Response> {
  if (ehAnexoNosso(url)) return (opcoes.fetchImpl ?? fetch)(paraUrlInterna(url), init);
  return fetchExterno(url, init, opcoes);
}
