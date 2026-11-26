// deno test --no-config --allow-env --allow-read supabase/functions/_shared/media-probe.test.ts
import { assertEquals, assertMatch } from 'jsr:@std/assert@1';
import { encode as encodeJpeg } from 'https://esm.sh/jpeg-js@0.4.4';
import {
  bufferReader,
  type ByteReader,
  probeMediaDimensions,
  probeUrlDimensions,
  rangeReader,
  MediaDimensionsSchema,
  thumbHashFromUrl,
  withMediaDims,
  withThumbHash,
} from './media-probe.ts';

/** Roda `fn` com o ambiente dado (undefined apaga a variável) e restaura no fim. */
async function comEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const antes = Object.keys(vars).map((k) => [k, Deno.env.get(k)] as const);
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await fn();
  } finally {
    for (const [k, v] of antes) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const u8 = (...n: number[]) => new Uint8Array(n);
const be16 = (n: number) => u8((n >> 8) & 255, n & 255);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const seg = (m: number, body: Uint8Array) => cat(u8(0xff, m), be16(body.length + 2), body);
const sof = (w: number, h: number) => seg(0xc0, cat(u8(8), be16(h), be16(w), u8(3), new Uint8Array(9)));
const jpegWithPadding = (pad: number) => cat(u8(0xff, 0xd8), seg(0xe2, new Uint8Array(pad)), sof(800, 600));

Deno.test('bufferReader lê direto e dá null fora do arquivo', async () => {
  const r = bufferReader(u8(1, 2, 3, 4));
  assertEquals(await r(1, 2), u8(2, 3));
  assertEquals(await r(10, 2), null);
});

Deno.test('sonda JPEG simples com uma leitura', async () => {
  let calls = 0;
  const buf = jpegWithPadding(10);
  const read: ByteReader = (o, l) => { calls++; return bufferReader(buf)(o, l); };
  assertEquals(await probeMediaDimensions(read), { width: 800, height: 600 });
  assertEquals(calls, 1);
});

Deno.test('sonda segue o need e respeita maxSteps', async () => {
  const buf = jpegWithPadding(60000);
  let calls = 0;
  const read: ByteReader = (o, l) => { calls++; return bufferReader(buf)(o, l); };
  assertEquals(await probeMediaDimensions(read, { firstBytes: 1000 }), { width: 800, height: 600 });
  assertEquals(calls, 2);
  calls = 0;
  assertEquals(await probeMediaDimensions(read, { firstBytes: 1000, maxSteps: 1 }), null);
  assertEquals(calls, 1);
});

Deno.test('sonda respeita maxTotal', async () => {
  const buf = jpegWithPadding(60000);
  let total = 0;
  const read: ByteReader = async (o, l) => {
    const r = await bufferReader(buf)(o, l);
    total += r?.length ?? 0;
    return r;
  };
  assertEquals(await probeMediaDimensions(read, { firstBytes: 1000, maxTotal: 1000 }), null);
  assertEquals(total <= 1000, true);
});

Deno.test('leitor que devolve null ou lança dá null', async () => {
  assertEquals(await probeMediaDimensions(() => Promise.resolve(null)), null);
  assertEquals(await probeMediaDimensions(() => Promise.reject(new Error('x'))), null);
});

const fakeFetch = (fn: (init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch =>
  ((_u: unknown, init?: RequestInit) => Promise.resolve(fn(init))) as unknown as typeof fetch;

Deno.test('rangeReader: 206 com Content-Range correto', async () => {
  let range = '';
  const f = fakeFetch((init) => {
    range = new Headers(init?.headers).get('range') ?? '';
    return new Response(u8(9, 9), { status: 206, headers: { 'content-range': 'bytes 10-11/100' } });
  });
  assertEquals(await rangeReader('http://x/a', { fetchImpl: f })(10, 2), u8(9, 9));
  assertEquals(range, 'bytes=10-11');
});
Deno.test('rangeReader: 206 com início errado dá null', async () => {
  const f = fakeFetch(() => new Response(u8(9), { status: 206, headers: { 'content-range': 'bytes 0-0/100' } }));
  assertEquals(await rangeReader('http://x/a', { fetchImpl: f })(10, 1), null);
});
Deno.test('rangeReader: 200 em offset 0 lê no máximo len e cancela', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(new Uint8Array(1000)); },
    cancel() { cancelled = true; },
  });
  const f = fakeFetch(() => new Response(stream, { status: 200 }));
  const out = await rangeReader('http://x/a', { fetchImpl: f })(0, 2500);
  assertEquals(out?.length, 2500);
  assertEquals(cancelled, true);
});
Deno.test('rangeReader: 200 em offset > 0, 404 e fetch rejeitado dão null', async () => {
  assertEquals(await rangeReader('http://x', { fetchImpl: fakeFetch(() => new Response(u8(1), { status: 200 })) })(5, 1), null);
  assertEquals(await rangeReader('http://x', { fetchImpl: fakeFetch(() => new Response('', { status: 404 })) })(0, 1), null);
  const rej = (() => Promise.reject(new Error('rede'))) as unknown as typeof fetch;
  assertEquals(await rangeReader('http://x', { fetchImpl: rej })(0, 1), null);
});

Deno.test('probeUrlDimensions: fetch que nunca resolve dá null pelo timeout', async () => {
  const never = ((_u: unknown, init?: RequestInit) =>
    new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('abort')));
    })) as unknown as typeof fetch;
  assertEquals(await probeUrlDimensions('http://x/a', { timeoutMs: 50, fetchImpl: never }), null);
});

Deno.test('probeUrlDimensions: anexo nosso é buscado pela base interna; URL alheia fica como está', async () => {
  const visto: string[] = [];
  const f = ((url: string) => {
    visto.push(url);
    return Promise.resolve(new Response('', { status: 404 }));
  }) as unknown as typeof fetch;
  await comEnv({ SUPABASE_URL: 'http://gateway:8000', ECHO_PUBLIC_URL: 'https://echo.example.com' }, async () => {
    await probeUrlDimensions('https://echo.example.com/storage/v1/object/public/attachments/a/b%20c.jpg', { fetchImpl: f });
    await probeUrlDimensions('https://cdn.example.org/foto.jpg', { fetchImpl: f });
  });
  assertEquals(visto, [
    'http://gateway:8000/storage/v1/object/public/attachments/a/b%20c.jpg',
    'https://cdn.example.org/foto.jpg',
  ]);
});

Deno.test('withMediaDims', () => {
  const valid = { media: { width: 10, height: 20 }, x: 1 };
  assertEquals(withMediaDims(valid, { width: 1, height: 2 }, 'bytes'), valid);
  assertEquals(
    withMediaDims({ media: { width: 'a' }, x: 1 }, { width: 3, height: 4, seconds: 5 }, 'bytes'),
    { x: 1, media: { width: 3, height: 4, seconds: 5, source: 'bytes' } },
  );
  assertEquals(withMediaDims(null, { width: 3, height: 4 }, 'proto'), { media: { width: 3, height: 4, source: 'proto' } });
  assertEquals(withMediaDims({ a: 1 }, null, 'bytes'), { a: 1 });
});

// ---- ThumbHash ----
const SB = 'https://abcdefghij.supabase.co';
const OWN = `${SB}/storage/v1/object/public/attachments/outbound/u/foto.jpg`;

function tinyJpeg(w = 16, h = 12): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 7) % 256; data[i * 4 + 1] = 90; data[i * 4 + 2] = 200; data[i * 4 + 3] = 255;
  }
  return new Uint8Array(encodeJpeg({ data, width: w, height: h }, 80).data);
}
const imgFetch = (body: Uint8Array, type: string, status = 200): typeof fetch =>
  (() => Promise.resolve(new Response(body as BodyInit, { status, headers: { 'content-type': type } }))) as typeof fetch;

Deno.test('schema: thumbhash válido passa e inválido é rejeitado', () => {
  const base = { width: 10, height: 10 };
  assertEquals(MediaDimensionsSchema.safeParse({ ...base, thumbhash: 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==' }).success, true);
  assertEquals(MediaDimensionsSchema.safeParse({ ...base, thumbhash: 'curto' }).success, false);
  assertEquals(MediaDimensionsSchema.safeParse({ ...base, thumbhash: 'tem espaço e <html>!!' }).success, false);
});

Deno.test('withThumbHash: só junta quando já existe media com dimensões', () => {
  const th = 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==';
  assertEquals(withThumbHash({ a: 1 }, th), { a: 1 });
  assertEquals(withThumbHash(null, th), null);
  assertEquals(withThumbHash({ media: { width: 4, height: 3, source: 'proto' } }, null), { media: { width: 4, height: 3, source: 'proto' } });
  assertEquals(withThumbHash({ a: 1, media: { width: 4, height: 3, source: 'proto' } }, th), {
    a: 1,
    media: { width: 4, height: 3, source: 'proto', thumbhash: th },
  });
  assertEquals(withThumbHash({ media: { width: 4, height: 3 } }, 'inválido!'), { media: { width: 4, height: 3 } });
});

Deno.test('withMediaDims carrega o thumbhash enviado nas dims', () => {
  const th = 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==';
  assertEquals(withMediaDims({}, { width: 2, height: 2, thumbhash: th }, 'proto'), {
    media: { width: 2, height: 2, thumbhash: th, source: 'proto' },
  });
});

Deno.test('thumbHashFromUrl: JPEG da transformação vira base64', async () => {
  let called = '';
  const f = ((url: string) => {
    called = url;
    return Promise.resolve(new Response(tinyJpeg() as BodyInit, { headers: { 'content-type': 'image/jpeg' } }));
  }) as unknown as typeof fetch;
  await comEnv({ SUPABASE_URL: SB, ECHO_PUBLIC_URL: undefined }, async () => {
    const th = await thumbHashFromUrl(OWN, SB, { fetchImpl: f });
    assertMatch(th ?? '', /^[A-Za-z0-9+/=]{8,64}$/);
    assertEquals(called, `${SB}/storage/v1/render/image/public/attachments/outbound/u/foto.jpg?width=32&height=32&resize=contain&quality=60`);
  });
});

Deno.test('thumbHashFromUrl: ECHO_IMAGE_TRANSFORM=false não faz o pedido; ausente ou outro valor, sim', async () => {
  for (const [valor, pede] of [['false', false], [' FALSE ', false], [undefined, true], ['', true], ['true', true]] as const) {
    let pedidos = 0;
    const f = (() => {
      pedidos++;
      return Promise.resolve(new Response(tinyJpeg() as BodyInit, { headers: { 'content-type': 'image/jpeg' } }));
    }) as unknown as typeof fetch;
    await comEnv({ SUPABASE_URL: SB, ECHO_PUBLIC_URL: undefined, ECHO_IMAGE_TRANSFORM: valor }, async () => {
      const th = await thumbHashFromUrl(OWN, SB, { fetchImpl: f });
      assertEquals(pedidos, pede ? 1 : 0, `ECHO_IMAGE_TRANSFORM=${JSON.stringify(valor)}: pedidos`);
      assertEquals(th === null, !pede, `ECHO_IMAGE_TRANSFORM=${JSON.stringify(valor)}: resultado`);
    });
  }
});

Deno.test('thumbHashFromUrl: URL gravada na base pública é buscada pela base interna, com o caminho codificado', async () => {
  let called = '';
  const f = ((url: string) => {
    called = url;
    return Promise.resolve(new Response(tinyJpeg() as BodyInit, { headers: { 'content-type': 'image/jpeg' } }));
  }) as unknown as typeof fetch;
  await comEnv({ SUPABASE_URL: 'http://gateway:8000', ECHO_PUBLIC_URL: 'https://echo.example.com' }, async () => {
    const th = await thumbHashFromUrl(
      'https://echo.example.com/storage/v1/object/public/attachments/outbound/u/foto%20%231.jpg',
      'http://gateway:8000',
      { fetchImpl: f },
    );
    assertMatch(th ?? '', /^[A-Za-z0-9+/=]{8,64}$/);
    assertEquals(called, 'http://gateway:8000/storage/v1/render/image/public/attachments/outbound/u/foto%20%231.jpg?width=32&height=32&resize=contain&quality=60');
  });
});

Deno.test('thumbHashFromUrl: content-type não JPEG, status ruim, host alheio, outro bucket e extensão -> null', async () => {
  await comEnv({ SUPABASE_URL: SB, ECHO_PUBLIC_URL: undefined }, async () => {
    assertEquals(await thumbHashFromUrl(OWN, SB, { fetchImpl: imgFetch(tinyJpeg(), 'image/png') }), null);
    assertEquals(await thumbHashFromUrl(OWN, SB, { fetchImpl: imgFetch(tinyJpeg(), 'image/jpeg', 404) }), null);
    assertEquals(await thumbHashFromUrl('https://outro.com/storage/v1/object/public/attachments/a.jpg', SB, { fetchImpl: imgFetch(tinyJpeg(), 'image/jpeg') }), null);
    assertEquals(await thumbHashFromUrl(`${SB}/storage/v1/object/public/outro/a.jpg`, SB, { fetchImpl: imgFetch(tinyJpeg(), 'image/jpeg') }), null);
    assertEquals(await thumbHashFromUrl(OWN.replace('.jpg', '.mp4'), SB, { fetchImpl: imgFetch(tinyJpeg(), 'image/jpeg') }), null);
    assertEquals(await thumbHashFromUrl(OWN, '', { fetchImpl: imgFetch(tinyJpeg(), 'image/jpeg') }), null);
  });
});

Deno.test('thumbHashFromUrl: imagem decodificada maior que 100px -> null', async () => {
  await comEnv({ SUPABASE_URL: SB, ECHO_PUBLIC_URL: undefined }, async () => {
    assertEquals(await thumbHashFromUrl(OWN, SB, { fetchImpl: imgFetch(tinyJpeg(120, 40), 'image/jpeg') }), null);
  });
});

Deno.test('thumbHashFromUrl: timeout -> null', async () => {
  const hang = ((_u: string, init?: RequestInit) =>
    new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abortado'))))) as unknown as typeof fetch;
  await comEnv({ SUPABASE_URL: SB, ECHO_PUBLIC_URL: undefined }, async () => {
    assertEquals(await thumbHashFromUrl(OWN, SB, { fetchImpl: hang, timeoutMs: 30 }), null);
  });
});

Deno.test('schema: thumb base64 válido passa; inválido ou grande demais é rejeitado', () => {
  const base = { width: 4, height: 3 };
  assertEquals(MediaDimensionsSchema.safeParse({ ...base, thumb: '/9j/4AAQSkZJRgABAQ==' }).success, true);
  assertEquals(MediaDimensionsSchema.safeParse({ ...base, thumb: 'data:image/jpeg;base64,AAAA' }).success, false);
  assertEquals(MediaDimensionsSchema.safeParse({ ...base, thumb: 'tem espaço' }).success, false);
  assertEquals(MediaDimensionsSchema.safeParse({ ...base, thumb: 'A'.repeat(12000) }).success, true);
  assertEquals(MediaDimensionsSchema.safeParse({ ...base, thumb: 'A'.repeat(12001) }).success, false);
});

Deno.test('withMediaDims copia o thumb quando presente', () => {
  assertEquals(withMediaDims({}, { width: 2, height: 2, thumb: '/9j/4AAQ' }, 'proto'), {
    media: { width: 2, height: 2, thumb: '/9j/4AAQ', source: 'proto' },
  });
  assertEquals(withMediaDims({}, { width: 2, height: 2 }, 'proto'), { media: { width: 2, height: 2, source: 'proto' } });
});
