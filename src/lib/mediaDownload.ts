/**
 * Helpers de download de mídia.
 *
 * As mídias moram no bucket público `attachments` do Storage. Quando a API fica
 * em outra origem que a do app (front estático com `VITE_*`), o atributo HTML
 * `download` é IGNORADO em URL cross-origin — o navegador abre/reproduz em vez
 * de salvar. O Storage aceita `?download=<nome>` e responde com
 * `Content-Disposition: attachment`, que é o que realmente faz o arquivo baixar
 * (e com o nome certo), na mesma origem ou fora dela.
 */

/** Deriva um nome de arquivo a partir do path da URL. */
export function mediaFilenameFromUrl(url: string, fallbackExt: string, fallbackPrefix = "audio"): string {
  try {
    // base só para aceitar path relativo; blob:/data: caem no catch ou no fallback.
    const { pathname } = new URL(url, window.location.origin);
    const base = decodeURIComponent(pathname.split("/").pop() ?? "");
    // Precisa ter extensão: um basename tipo "public" ou um uuid pelado viraria
    // um arquivo sem tipo, que o SO não sabe abrir.
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
  } catch {
    // URL malformada (blob:, data:, string vazia) — cai no fallback.
  }
  return `${fallbackPrefix}-${Date.now()}.${fallbackExt}`;
}

/** Prefixo e extensão do nome quando nem a mensagem nem a URL dão um nome com extensão. */
const FALLBACK_BY_TYPE: Record<string, { prefix: string; ext: string }> = {
  image: { prefix: "imagem", ext: "jpg" },
  video: { prefix: "video", ext: "mp4" },
  audio: { prefix: "audio", ext: "ogg" },
  ptt: { prefix: "audio", ext: "ogg" },
  sticker: { prefix: "figurinha", ext: "webp" },
  document: { prefix: "arquivo", ext: "bin" },
};

/**
 * Nome do arquivo baixado: o nome original da mensagem (`media_filename`) quando
 * existe, senão o do path da URL, senão `<tipo>-<timestamp>.<ext>`.
 */
export function mediaDownloadName(url: string, filename: string | null | undefined, messageType: string | null | undefined): string {
  const name = filename?.trim();
  if (name) return name;
  const fallback = FALLBACK_BY_TYPE[messageType ?? ""] ?? FALLBACK_BY_TYPE.document;
  return mediaFilenameFromUrl(url, fallback.ext, fallback.prefix);
}

/** URL que baixa de fato, quando ela aponta para o Storage da instalação. */
export function toDownloadUrl(url: string, filename: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    if (!parsed.pathname.includes("/storage/v1/object/")) return url;
    // set (não append): preserva os params existentes e não duplica o nosso.
    parsed.searchParams.set("download", filename);
    return parsed.toString();
  } catch {
    return url;
  }
}
