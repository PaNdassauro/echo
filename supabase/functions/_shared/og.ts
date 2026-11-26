// Busca OpenGraph de um link para preencher metadata.link_preview das NOSSAS
// mensagens (o eco do Baileys é dedupado, então o inbound nunca cobre o que o
// painel envia; na Cloud API não há eco nenhum).
//
// Guard-rails: só http(s), 3s de timeout, só text/html, lê no máximo 256KB. O link vem do texto que o usuário
// escreveu, então a busca passa pela guarda SSRF (fetchExterno: host interno, IP privado e redirecionamento para
// eles são recusados). Nunca lança — preview é acessório.
import { fetchExterno, UrlExternaBloqueadaError } from './url-guard.ts';

const FETCH_TIMEOUT_MS = 3_000;
const MAX_HTML_BYTES = 256 * 1024;

export interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  image_url: string | null;
  site_name: string | null;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

/** Primeira URL http(s) do texto, ou null. */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  return match ? match[0] : null;
}

function metaContent(html: string, property: string): string | null {
  // property/name em qualquer ordem de atributos; conteúdo entre aspas
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1].trim());
  }
  return null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

export async function fetchLinkPreview(url: string): Promise<LinkPreviewData | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let html: string;
    try {
      const response = await fetchExterno(url, {
        signal: controller.signal,
        headers: { 'Accept': 'text/html', 'User-Agent': 'WhatsApp/2' },
      });
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html')) return null;

      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < MAX_HTML_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      await reader.cancel().catch(() => undefined);
      const merged = new Uint8Array(Math.min(total, MAX_HTML_BYTES));
      let offset = 0;
      for (const chunk of chunks) {
        const slice = chunk.subarray(0, Math.min(chunk.length, merged.length - offset));
        merged.set(slice, offset);
        offset += slice.length;
        if (offset >= merged.length) break;
      }
      html = new TextDecoder('utf-8', { fatal: false }).decode(merged);
    } finally {
      clearTimeout(timer);
    }

    const title =
      metaContent(html, 'og:title') ??
      (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || null);
    const description =
      metaContent(html, 'og:description') ?? metaContent(html, 'description');
    let imageUrl = metaContent(html, 'og:image');
    if (imageUrl) {
      try {
        imageUrl = new URL(imageUrl, url).toString();
      } catch {
        imageUrl = null;
      }
    }
    const siteName = metaContent(html, 'og:site_name');

    if (!title && !description) return null;
    return { url, title, description, image_url: imageUrl, site_name: siteName };
  } catch (e) {
    if (e instanceof UrlExternaBloqueadaError) console.warn(`[og] prévia de link bloqueada pela guarda (${e.reason})`);
    return null;
  }
}
