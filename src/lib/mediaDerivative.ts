import { getRuntimeFeatures, isOwnStorageBase } from "@/lib/runtimeConfig";

/**
 * URL de exibição da imagem na bolha: uma derivada reduzida pelo Storage em vez
 * do arquivo original.
 *
 * A caixa da bolha tem no máximo 300 px, mas a `media_url` é a foto original
 * (vários megapixels). Em Chrome de mesa com texto LCD o scroller re-rasteriza a
 * cada quadro, e decodificar e reduzir a foto cheia bem na hora em que ela entra
 * na tela é o que engasga a rolagem. A transformação do Storage
 * (`/storage/v1/render/image/public/...?width=…`) devolve um JPEG do tamanho da
 * caixa (2x para telas densas); o original continua valendo para o lightbox e o
 * download. Se a derivada falhar, a bolha cai no original.
 *
 * Só para o bucket público `attachments` desta instalação e para JPEG/PNG/WebP:
 * GIF e figurinhas animadas sairiam estáticas na transformação. Sem o serviço de
 * transformação de imagem (`features.transformacaoImagem = false`, o caso do
 * docker, que não tem imgproxy) não há derivada: o pedido a `/render/image`
 * daria 404 em toda imagem, e a bolha usa o original direto.
 */

export const BUBBLE_IMAGE_PX = 600;

const DERIVABLE_EXT = /\.(jpe?g|png|webp)$/i;

/** Base que serve a URL: a passada pelo chamador (testes) ou a que `isOwnStorageBase` reconhece. */
function baseDaUrl(url: string, baseUrl: string | undefined): string | null {
  const base = baseUrl === undefined ? isOwnStorageBase(url) : baseUrl;
  return base ? base : null;
}

/**
 * Caminho dentro do bucket público `attachments`, ou null se a URL não é dele.
 * Sem `baseUrl`, vale a base atual e também o endereço canônico do site (mídia
 * gravada pelo servidor leva a URL pública).
 */
export function publicAttachmentPath(url: string | null | undefined, baseUrl?: string): string | null {
  if (!url) return null;
  const base = baseDaUrl(url, baseUrl);
  if (!base) return null;
  const prefix = `${base}/storage/v1/object/public/attachments/`;
  if (!url.startsWith(prefix)) return null;
  const path = url.slice(prefix.length);
  if (!path || path.includes("?")) return null;
  return path;
}

/**
 * Derivada reduzida para a bolha, ou null quando não há como (host externo,
 * URL assinada, GIF, figurinha). `maxPx` é o maior lado em pixels.
 */
export function bubbleImageSrc(
  url: string | null | undefined,
  maxPx = BUBBLE_IMAGE_PX,
  baseUrl?: string,
): string | null {
  if (!getRuntimeFeatures().transformacaoImagem) return null;
  if (!url) return null;
  const base = baseDaUrl(url, baseUrl);
  const path = base ? publicAttachmentPath(url, base) : null;
  if (!base || !path || !DERIVABLE_EXT.test(path)) return null;
  return `${base}/storage/v1/render/image/public/attachments/${path}?width=${maxPx}&height=${maxPx}&resize=contain&quality=75`;
}
