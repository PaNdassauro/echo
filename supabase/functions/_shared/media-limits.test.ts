// deno test --no-config --allow-env --allow-read supabase/functions/_shared/media-limits.test.ts
import {
  DEFAULT_MAX_MEDIA_BYTES,
  MediaSendError,
  assertMediaSize,
  maxMediaBytes,
  parseByteCount,
  resolveStoredSize,
  storageHeadError,
} from './media-limits.ts';

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('esperava erro');
}

Deno.test('maxMediaBytes: default 50 MB e env válida', () => {
  equal(DEFAULT_MAX_MEDIA_BYTES, 52428800);
  equal(maxMediaBytes(undefined), 52428800);
  equal(maxMediaBytes(''), 52428800);
  equal(maxMediaBytes('abc'), 52428800);
  equal(maxMediaBytes('0'), 52428800);
  equal(maxMediaBytes('-5'), 52428800);
  equal(maxMediaBytes(' 104857600 '), 104857600);
});

Deno.test('assertMediaSize: no limite passa, acima recusa com media_too_large', () => {
  assertMediaSize(52428800, 52428800);
  let err: unknown = null;
  try {
    assertMediaSize(52428801, 52428800);
  } catch (e) {
    err = e;
  }
  if (!(err instanceof MediaSendError)) throw new Error('esperava MediaSendError');
  equal([err.code, err.status], ['media_too_large', 413]);
  equal(err.message, 'Arquivo maior que o limite de 50 MB. Envie um arquivo menor.');
});

Deno.test('storageHeadError: 400/404 viram storage_object_missing; 5xx não', () => {
  for (const status of [400, 404]) {
    const e = storageHeadError(status);
    if (!(e instanceof MediaSendError)) throw new Error(`status ${status}`);
    equal([e.code, e.message], ['storage_object_missing', 'Arquivo não encontrado no armazenamento. Envie de novo.']);
  }
  const transient = storageHeadError(503);
  if (transient instanceof MediaSendError) throw new Error('503 não pode invalidar o cache do front');
});

Deno.test('parseByteCount: só inteiro não negativo', () => {
  equal(parseByteCount('1234'), 1234);
  equal(parseByteCount('0'), 0);
  equal(parseByteCount(77), 77);
  equal(parseByteCount(null), null);
  equal(parseByteCount(''), null);
  equal(parseByteCount('12.5'), null);
  equal(parseByteCount('-1'), null);
  equal(parseByteCount('1e9'), null);
  equal(parseByteCount(-3), null);
});

Deno.test('resolveStoredSize: content-length vence', async () => {
  let listed = false;
  const size = await resolveStoredSize({
    contentLength: '5000',
    listObjectSize: () => { listed = true; return Promise.resolve(1); },
    clientSize: '9',
  });
  equal([size, listed], [5000, false]);
});

Deno.test('resolveStoredSize: sem content-length usa o Storage, depois o front', async () => {
  equal(await resolveStoredSize({ contentLength: null, listObjectSize: () => Promise.resolve(4321), clientSize: '9' }), 4321);
  equal(await resolveStoredSize({ contentLength: null, listObjectSize: () => Promise.resolve(null), clientSize: '9000' }), 9000);
  const original = console.warn;
  console.warn = () => {};
  try {
    equal(
      await resolveStoredSize({ contentLength: null, listObjectSize: () => Promise.reject(new Error('x')), clientSize: '42' }),
      42,
    );
  } finally {
    console.warn = original;
  }
});

Deno.test('resolveStoredSize: sem nenhuma fonte recusa em vez de virar 0', async () => {
  const err = await rejects(() =>
    resolveStoredSize({ contentLength: null, listObjectSize: () => Promise.resolve(undefined), clientSize: 'abc' }),
  );
  equal(err.message, 'Não foi possível conferir o tamanho do arquivo no armazenamento. Tente de novo.');
});

Deno.test('resolveStoredSize: content-length 0 não vale sozinho, confere no Storage', async () => {
  equal(await resolveStoredSize({ contentLength: '0', listObjectSize: () => Promise.resolve(2048), clientSize: null }), 2048);
  // Objeto realmente vazio: o Storage confirma o 0.
  equal(await resolveStoredSize({ contentLength: '0', listObjectSize: () => Promise.resolve(0), clientSize: null }), 0);
});
