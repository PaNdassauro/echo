// deno test --no-config --allow-env --allow-read supabase/functions/_shared/media-dimensions.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import { parseMediaHeader } from './media-dimensions.ts';

const u8 = (...n: number[]) => new Uint8Array(n);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const txt = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const be32 = (n: number) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const be16 = (n: number) => u8((n >> 8) & 255, n & 255);
const le16 = (n: number) => u8(n & 255, (n >> 8) & 255);
const zeros = (n: number) => new Uint8Array(n);

function ok(b: Uint8Array, format: string, width: number, height: number, seconds?: number) {
  const r = parseMediaHeader(b, 0);
  if (r.kind !== 'ok') throw new Error(`esperava ok, veio ${JSON.stringify(r)}`);
  assertEquals([r.format, r.width, r.height], [format, width, height]);
  if (seconds !== undefined) assertEquals(r.seconds, seconds);
}
const isUnknown = (b: Uint8Array) => assertEquals(parseMediaHeader(b, 0).kind, 'unknown');

const png = (w: number, h: number) =>
  cat(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), be32(13), txt('IHDR'), be32(w), be32(h), zeros(10));

Deno.test('png 640x480', () => ok(png(640, 480), 'png', 640, 480));
Deno.test('lado 70000 é desconhecido', () => isUnknown(png(70000, 10)));

Deno.test('gif 87a e 89a', () => {
  ok(cat(txt('GIF87a'), le16(320), le16(200), zeros(4)), 'gif', 320, 200);
  ok(cat(txt('GIF89a'), le16(17), le16(33), zeros(4)), 'gif', 17, 33);
});

const riff = (chunk: Uint8Array) => cat(txt('RIFF'), zeros(4), txt('WEBP'), chunk);

Deno.test('webp VP8 com máscara de 14 bits', () => {
  // bits altos (escala) ligados em 0xC000 devem ser ignorados
  const c = cat(txt('VP8 '), zeros(4), zeros(3), u8(0x9d, 0x01, 0x2a), le16(800 | 0xc000), le16(600 | 0x4000), zeros(4));
  ok(riff(c), 'webp', 800, 600);
});
Deno.test('webp VP8L 1000x750 e máximo 16384', () => {
  const enc = (w: number, h: number) => {
    const wm = w - 1, hm = h - 1;
    return cat(txt('VP8L'), zeros(4), u8(0x2f), u8(wm & 255, ((wm >> 8) & 0x3f) | ((hm & 3) << 6), (hm >> 2) & 255, (hm >> 10) & 15), zeros(4));
  };
  ok(riff(enc(1000, 750)), 'webp', 1000, 750);
  ok(riff(enc(16384, 16384)), 'webp', 16384, 16384);
});
Deno.test('webp VP8X 24 bits', () => {
  const le24 = (n: number) => u8(n & 255, (n >> 8) & 255, (n >> 16) & 255);
  const c = cat(txt('VP8X'), zeros(4), zeros(4), le24(4999), le24(2999), zeros(4));
  ok(riff(c), 'webp', 5000, 3000);
});

const seg = (marker: number, body: Uint8Array) => cat(u8(0xff, marker), be16(body.length + 2), body);
const sof = (marker: number, w: number, h: number) => seg(marker, cat(u8(8), be16(h), be16(w), u8(3), zeros(9)));
const SOI = u8(0xff, 0xd8);
const exif = (little: boolean, orientation: number) => {
  const o16 = little ? le16 : be16;
  const o32 = (n: number) => (little ? u8(n & 255, (n >> 8) & 255, 0, 0) : be32(n));
  const tiff = cat(txt(little ? 'II' : 'MM'), o16(42), o32(8), o16(1), o16(0x0112), o16(3), o32(1), o16(orientation), zeros(2), o32(0));
  return seg(0xe1, cat(txt('Exif'), zeros(2), tiff));
};

Deno.test('jpeg APP0 + SOF0', () => {
  ok(cat(SOI, seg(0xe0, txt('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')), sof(0xc0, 1200, 800), zeros(8)), 'jpeg', 1200, 800);
});
Deno.test('jpeg SOF2 progressivo', () => ok(cat(SOI, sof(0xc2, 300, 400)), 'jpeg', 300, 400));
Deno.test('jpeg com bytes FF de preenchimento', () => {
  ok(cat(SOI, u8(0xff, 0xff, 0xff), sof(0xc0, 50, 60)), 'jpeg', 50, 60);
});
Deno.test('jpeg: C4 e CC antes do SOF não são SOF', () => {
  ok(cat(SOI, seg(0xc4, zeros(20)), seg(0xcc, zeros(5)), sof(0xc0, 111, 222)), 'jpeg', 111, 222);
});
Deno.test('jpeg EXIF orientação 6 troca (MM e II)', () => {
  ok(cat(SOI, exif(false, 6), sof(0xc0, 400, 300)), 'jpeg', 300, 400);
  ok(cat(SOI, exif(true, 8), sof(0xc0, 400, 300)), 'jpeg', 300, 400);
});
Deno.test('jpeg EXIF orientação 1 não troca', () => {
  ok(cat(SOI, exif(false, 1), sof(0xc0, 400, 300)), 'jpeg', 400, 300);
  ok(cat(SOI, exif(true, 3), sof(0xc0, 400, 300)), 'jpeg', 400, 300);
});
Deno.test('jpeg com APP2 de 60 KB: need e depois ok', () => {
  const full = cat(SOI, exif(false, 6), seg(0xe2, zeros(60000)), sof(0xc0, 400, 300));
  const first = full.slice(0, 16384);
  const r = parseMediaHeader(first, 0);
  if (r.kind !== 'need') throw new Error(`esperava need: ${JSON.stringify(r)}`);
  assertEquals(r.length, 65536);
  const next = parseMediaHeader(full.slice(r.offset, r.offset + r.length), r.offset, r.state);
  if (next.kind !== 'ok') throw new Error(`esperava ok: ${JSON.stringify(next)}`);
  // a orientação do EXIF lido no primeiro trecho sobrevive à retomada
  assertEquals([next.width, next.height], [300, 400]);
});
Deno.test('jpeg: need sem EXIF mantém o estado simples', () => {
  const full = cat(SOI, seg(0xe2, zeros(60000)), sof(0xc0, 400, 300));
  const r = parseMediaHeader(full.slice(0, 1000), 0);
  assertEquals(r, { kind: 'need', offset: 60006, length: 65536, state: { format: 'jpeg' } });
});
Deno.test('jpeg SOS antes do SOF e altura 0 são desconhecidos', () => {
  isUnknown(cat(SOI, seg(0xda, zeros(10)), zeros(10)));
  isUnknown(cat(SOI, sof(0xc0, 100, 0)));
});

Deno.test('vazio, lixo e brand heic são desconhecidos', () => {
  isUnknown(new Uint8Array(0));
  isUnknown(txt('isto não é uma imagem de jeito nenhum'));
  isUnknown(cat(be32(24), txt('ftypheic'), zeros(16)));
});

Deno.test('fuzz de 500 buffers aleatórios nunca lança', () => {
  let seed = 123456789;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const heads = [u8(0xff, 0xd8), u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), txt('RIFF'), txt('GIF89a'), be32(32), cat(be32(32), txt('ftypmp42')), cat(be32(40), txt('ftypisom'), zeros(8), be32(20), txt('moov'))];
  for (let i = 0; i < 500; i++) {
    const body = new Uint8Array(Math.floor(rnd() * 300));
    for (let j = 0; j < body.length; j++) body[j] = Math.floor(rnd() * 256);
    const b = i % 2 ? cat(heads[i % heads.length], body) : body;
    const r = parseMediaHeader(b, 0);
    assertEquals(['ok', 'need', 'unknown'].includes(r.kind), true);
    parseMediaHeader(b, 100, { format: 'jpeg' });
    parseMediaHeader(b, 100, { format: 'mp4' });
  }
});

const box = (type: string, body: Uint8Array) => cat(be32(body.length + 8), txt(type), body);
const fixed = (n: number) => be32(n * 65536);
const matrix = (a: number, d: number) =>
  cat(be32(a), zeros(4), zeros(4), zeros(4), be32(d), zeros(4), zeros(4), zeros(4), be32(0x40000000));
const tkhd0 = (w: number, h: number, a = 0x10000, d = 0x10000) =>
  box('tkhd', cat(u8(0, 0, 0, 3), zeros(8), be32(1), zeros(4), be32(0), zeros(8), zeros(8), matrix(a, d), fixed(w), fixed(h)));
const tkhd1 = (w: number, h: number) =>
  box('tkhd', cat(u8(1, 0, 0, 3), zeros(16), be32(1), zeros(4), zeros(8), zeros(8), zeros(8), matrix(0x10000, 0x10000), fixed(w), fixed(h)));
const mvhd0 = (ts: number, dur: number) => box('mvhd', cat(u8(0, 0, 0, 0), zeros(8), be32(ts), be32(dur), zeros(80)));
const mvhd1 = (ts: number, dur: number) => box('mvhd', cat(u8(1, 0, 0, 0), zeros(16), be32(ts), be32(0), be32(dur), zeros(80)));
const ftyp = box('ftyp', cat(txt('isom'), zeros(4), txt('isom')));

Deno.test('mp4 tkhd v0 1920x1080 com 10 s', () => {
  ok(cat(ftyp, box('moov', cat(mvhd0(1000, 10000), box('trak', tkhd0(1920, 1080))))), 'mp4', 1920, 1080, 10);
});
Deno.test('mp4 tkhd v1 e mvhd v1', () => {
  ok(cat(ftyp, box('moov', cat(mvhd1(600, 3000), box('trak', tkhd1(1280, 720))))), 'mp4', 1280, 720, 5);
});
Deno.test('mp4 com matriz de 90 graus troca os lados', () => {
  ok(cat(ftyp, box('moov', cat(mvhd0(1000, 2000), box('trak', tkhd0(1920, 1080, 0, 0))))), 'mp4', 1080, 1920, 2);
});
Deno.test('mp4 com mdat antes do moov pede o offset seguinte', () => {
  const mdat = box('mdat', zeros(5000));
  const head = cat(ftyp, mdat.slice(0, 8));
  const r = parseMediaHeader(head, 0);
  assertEquals(r, { kind: 'need', offset: ftyp.length + mdat.length, length: 65536, state: { format: 'mp4' } });
  const moov = box('moov', cat(mvhd0(1000, 1000), box('trak', tkhd0(640, 360))));
  const next = parseMediaHeader(moov, ftyp.length + mdat.length, r.kind === 'need' ? r.state : undefined);
  assertEquals(next.kind, 'ok');
});
Deno.test('mp4 com largesize (size 1)', () => {
  const mdatBody = zeros(100);
  const big = cat(be32(1), txt('mdat'), be32(0), be32(16 + mdatBody.length), mdatBody);
  const full = cat(ftyp, big, box('moov', cat(mvhd0(1000, 1000), box('trak', tkhd0(640, 360)))));
  const r = parseMediaHeader(full.slice(0, ftyp.length + 16), 0);
  assertEquals(r.kind, 'need');
  if (r.kind === 'need') assertEquals(r.offset, ftyp.length + 116);
  ok(full, 'mp4', 640, 360);
});
Deno.test('mp4 só de áudio (w = 0) é desconhecido', () => {
  isUnknown(cat(ftyp, box('moov', cat(mvhd0(1000, 1000), box('trak', tkhd0(0, 0))))));
});

Deno.test('mp4 com moov de 80 KB: lê as dimensões do trecho já lido (tkhd no começo)', () => {
  const moov = box('moov', cat(mvhd0(1000, 120000), box('trak', tkhd0(1280, 720)), box('free', zeros(80_000))));
  const file = cat(ftyp, moov);
  // Só os primeiros 64 KB, como o probe lê.
  const r = parseMediaHeader(file.subarray(0, 65536), 0);
  if (r.kind !== 'ok') throw new Error(`esperava ok, veio ${JSON.stringify(r)}`);
  assertEquals([r.width, r.height, r.seconds], [1280, 720, 120]);
});
Deno.test('mp4 com moov cortado no meio do tkhd é desconhecido, não dimensão errada', () => {
  const moov = box('moov', cat(mvhd0(1000, 1000), box('trak', tkhd0(640, 360)), box('free', zeros(500))));
  const cut = cat(ftyp, moov).subarray(0, ftyp.length + 8 + 108 + 20);
  assertEquals(parseMediaHeader(cut, 0).kind, 'unknown');
});
Deno.test('duração fora de (0, 24 h] é descartada e as dimensões ficam', () => {
  for (const dur of [0xffffffff, 0]) {
    const r = parseMediaHeader(cat(ftyp, box('moov', cat(mvhd0(1000, dur), box('trak', tkhd0(640, 360))))), 0);
    if (r.kind !== 'ok') throw new Error(`esperava ok, veio ${JSON.stringify(r)}`);
    assertEquals([r.width, r.height, r.seconds], [640, 360, undefined]);
  }
});
