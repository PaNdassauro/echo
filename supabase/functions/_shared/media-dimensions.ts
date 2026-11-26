// Leitor de cabeçalho de mídia, puro (só Uint8Array e DataView, sem APIs do Deno
// e sem imports) para a edge e o script de backfill usarem o mesmo código.
// Devolve as dimensões de exibição em pixels (com EXIF e matriz do MP4 aplicados).

export type MediaFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'mp4';
// `orientation` (EXIF já lida antes da retomada) é opcional e só o parser a preenche.
export type ParseState = { format: 'jpeg'; orientation?: number } | { format: 'mp4' } | undefined;
export type ParseResult =
  | { kind: 'ok'; format: MediaFormat; width: number; height: number; seconds?: number }
  | { kind: 'need'; offset: number; length: number; state: ParseState }
  | { kind: 'unknown'; reason: string };

const NEED_LENGTH = 65536;
const MAX_SECONDS = 86400;

const unknown = (reason: string): ParseResult => ({ kind: 'unknown', reason });

function validSide(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function done(
  format: MediaFormat,
  width: number,
  height: number,
  seconds?: number,
): ParseResult {
  if (!validSide(width) || !validSide(height)) {
    return unknown(`dimensões fora do intervalo: ${width}x${height}`);
  }
  // Mesma faixa do MediaDimensionsSchema (> 0 e <= 24 h): duração "desconhecida" do mvhd
  // (0xFFFFFFFF) ou absurda é descartada, senão o front rejeitaria o objeto inteiro.
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_SECONDS
    ? { kind: 'ok', format, width, height, seconds }
    : { kind: 'ok', format, width, height };
}

function ascii(b: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (b[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function startsWith(b: Uint8Array, sig: number[]): boolean {
  if (b.length < sig.length) return false;
  return sig.every((v, i) => b[i] === v);
}

function parsePng(b: Uint8Array): ParseResult {
  if (b.length < 24) return unknown('png truncado');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return done('png', dv.getUint32(16, false), dv.getUint32(20, false));
}

function parseGif(b: Uint8Array): ParseResult {
  if (b.length < 10) return unknown('gif truncado');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return done('gif', dv.getUint16(6, true), dv.getUint16(8, true));
}

function parseWebp(b: Uint8Array): ParseResult {
  if (b.length < 25) return unknown('webp truncado');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (ascii(b, 12, 'VP8 ')) {
    if (b.length < 30) return unknown('webp truncado');
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return unknown('webp vp8 sem start code');
    return done('webp', dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff);
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return unknown('webp vp8l sem assinatura');
    const w = 1 + (b[21] | ((b[22] & 0x3f) << 8));
    const h = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10));
    return done('webp', w, h);
  }
  if (ascii(b, 12, 'VP8X')) {
    if (b.length < 30) return unknown('webp truncado');
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return done('webp', w, h);
  }
  return unknown('webp com chunk desconhecido');
}

// Lê a orientação EXIF (tag 0x0112 da IFD0) de um segmento APP1. 1 se ausente.
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  // start aponta para 'Exif\0\0'
  const tiff = start + 6;
  if (tiff + 8 > end || tiff + 8 > b.length) return 1;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const big = b[tiff] === 0x4d && b[tiff + 1] === 0x4d;
  if (!little && !big) return 1;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ifd = tiff + dv.getUint32(tiff + 4, little);
  if (ifd + 2 > end || ifd + 2 > b.length) return 1;
  const count = dv.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end || e + 12 > b.length) return 1;
    if (dv.getUint16(e, little) === 0x0112) return dv.getUint16(e + 8, little);
  }
  return 1;
}

function isSof(m: number): boolean {
  return (m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) ||
    (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf);
}

function jpegState(orientation: number): ParseState {
  return orientation === 1 ? { format: 'jpeg' } : { format: 'jpeg', orientation };
}

function parseJpeg(b: Uint8Array, base: number, resumed: boolean, prevOrientation = 1): ParseResult {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 0;
  if (!resumed) {
    if (b.length < 2 || b[0] !== 0xff || b[1] !== 0xd8) return unknown('jpeg sem SOI');
    pos = 2;
  }
  let orientation = prevOrientation;
  for (let guard = 0; guard < 4096; guard++) {
    // pula bytes de preenchimento 0xFF
    while (pos < b.length && b[pos] === 0xff && pos + 1 < b.length && b[pos + 1] === 0xff) pos++;
    if (pos + 2 > b.length) {
      return { kind: 'need', offset: base + pos, length: NEED_LENGTH, state: jpegState(orientation) };
    }
    if (b[pos] !== 0xff) return unknown('jpeg com marcador inválido');
    const m = b[pos + 1];
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (m === 0xda || m === 0xd9) return unknown('jpeg sem SOF antes dos dados');
    if (m === 0x00) return unknown('jpeg com marcador inválido');
    if (pos + 4 > b.length) {
      return { kind: 'need', offset: base + pos, length: NEED_LENGTH, state: jpegState(orientation) };
    }
    const len = dv.getUint16(pos + 2, false);
    if (len < 2) return unknown('jpeg com segmento inválido');
    if (isSof(m)) {
      if (pos + 9 > b.length) {
        return { kind: 'need', offset: base + pos, length: NEED_LENGTH, state: jpegState(orientation) };
      }
      const h = dv.getUint16(pos + 5, false);
      const w = dv.getUint16(pos + 7, false);
      if (h === 0) return unknown('jpeg com altura 0 (DNL)');
      return orientation >= 5 && orientation <= 8 ? done('jpeg', h, w) : done('jpeg', w, h);
    }
    if (m === 0xe1 && pos + 10 <= b.length && ascii(b, pos + 4, 'Exif\0\0')) {
      orientation = exifOrientation(b, pos + 4, Math.min(pos + 2 + len, b.length));
    }
    pos += 2 + len;
  }
  return unknown('jpeg com segmentos demais');
}

type Box = { type: string; start: number; header: number; size: number };

// Lê o cabeçalho de caixa em `pos`. size 0 vai até o fim do arquivo (Infinity).
function readBox(b: Uint8Array, dv: DataView, pos: number, limit: number): Box | null {
  if (pos + 8 > limit) return null;
  let size = dv.getUint32(pos, false);
  const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
  let header = 8;
  if (size === 1) {
    if (pos + 16 > limit) return null;
    size = dv.getUint32(pos + 8, false) * 4294967296 + dv.getUint32(pos + 12, false);
    header = 16;
  } else if (size === 0) {
    size = Infinity;
  }
  if (size < header) return null;
  return { type, start: pos, header, size };
}

function parseMp4(b: Uint8Array, base: number): ParseResult {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 0;
  while (pos + 8 <= b.length) {
    const box = readBox(b, dv, pos, b.length);
    if (!box) return unknown('mp4 com caixa inválida');
    if (box.type === 'moov') {
      const end = box.size === Infinity ? b.length : pos + box.size;
      // moov maior que o buffer: mvhd e tkhd ficam no começo dele, então lê o trecho
      // que veio (parseTrak recusa um tkhd cortado).
      return parseMoov(b, dv, pos + box.header, Math.min(end, b.length));
    }
    if (box.size === Infinity) return unknown('mp4 sem moov');
    pos += box.size;
    if (pos + 8 > b.length) {
      return { kind: 'need', offset: base + pos, length: NEED_LENGTH, state: { format: 'mp4' } };
    }
  }
  return { kind: 'need', offset: base + pos, length: NEED_LENGTH, state: { format: 'mp4' } };
}

function parseMoov(b: Uint8Array, dv: DataView, from: number, end: number): ParseResult {
  let seconds: number | undefined;
  let dims: { w: number; h: number } | null = null;
  let pos = from;
  while (pos + 8 <= end) {
    const box = readBox(b, dv, pos, end);
    if (!box) break;
    const boxEnd = box.size === Infinity ? end : Math.min(pos + box.size, end);
    const body = pos + box.header;
    if (box.type === 'mvhd' && seconds === undefined) {
      const version = b[body];
      if (version === 1 && body + 32 <= boxEnd) {
        const ts = dv.getUint32(body + 20, false);
        const dur = dv.getUint32(body + 24, false) * 4294967296 + dv.getUint32(body + 28, false);
        if (ts > 0) seconds = dur / ts;
      } else if (version === 0 && body + 20 <= boxEnd) {
        const ts = dv.getUint32(body + 12, false);
        const dur = dv.getUint32(body + 16, false);
        if (ts > 0) seconds = dur / ts;
      }
    } else if (box.type === 'trak' && !dims) {
      dims = parseTrak(b, dv, body, boxEnd);
    }
    pos = boxEnd;
  }
  if (!dims) return unknown('mp4 sem trilha de vídeo');
  return done('mp4', dims.w, dims.h, seconds);
}

function parseTrak(b: Uint8Array, dv: DataView, from: number, end: number): { w: number; h: number } | null {
  let pos = from;
  while (pos + 8 <= end) {
    const box = readBox(b, dv, pos, end);
    if (!box) return null;
    const boxEnd = box.size === Infinity ? end : Math.min(pos + box.size, end);
    if (box.type === 'tkhd') {
      if (box.size !== Infinity && pos + box.size > end) return null; // tkhd cortado
      const body = pos + box.header;
      const tail = boxEnd - 8;
      if (tail < body + 4 || boxEnd > b.length) return null;
      let w = Math.floor(dv.getUint32(tail, false) / 65536);
      let h = Math.floor(dv.getUint32(tail + 4, false) / 65536);
      const mA = tail - 36;
      if (mA >= body && dv.getInt32(mA, false) === 0 && dv.getInt32(mA + 16, false) === 0) {
        [w, h] = [h, w];
      }
      return w > 0 && h > 0 ? { w, h } : null;
    }
    pos = boxEnd;
  }
  return null;
}

export function parseMediaHeader(bytes: Uint8Array, base: number, state?: ParseState): ParseResult {
  try {
    if (state?.format === 'jpeg') return parseJpeg(bytes, base, true, state.orientation ?? 1);
    if (state?.format === 'mp4') return parseMp4(bytes, base);
    if (bytes.length < 4) return unknown('poucos bytes');
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return parsePng(bytes);
    if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return parseGif(bytes);
    if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return parseWebp(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return parseJpeg(bytes, base, false);
    if (bytes.length >= 12 && ascii(bytes, 4, 'ftyp')) {
      if (ascii(bytes, 8, 'heic') || ascii(bytes, 8, 'heix') || ascii(bytes, 8, 'mif1') ||
        ascii(bytes, 8, 'avif') || ascii(bytes, 8, 'avis')) {
        return unknown('formato não suportado (heic/avif)');
      }
      return parseMp4(bytes, base);
    }
    return unknown('formato desconhecido');
  } catch (e) {
    return unknown(`erro ao ler cabeçalho: ${e instanceof Error ? e.message : String(e)}`);
  }
}
