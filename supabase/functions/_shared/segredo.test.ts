// deno test --no-config --allow-env --allow-read supabase/functions/_shared/segredo.test.ts
import { iguaisEmTempoConstante, segredoConfere } from './segredo.ts';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

Deno.test('segredoConfere: igual confere', async () => {
  assert(await segredoConfere('s3gr3do-longo', 's3gr3do-longo'), 'igual deveria conferir');
});

Deno.test('segredoConfere: diferente, prefixo ou tamanho diferente não confere', async () => {
  assert(!(await segredoConfere('s3gr3do-longX', 's3gr3do-longo')), 'último caractere');
  assert(!(await segredoConfere('s3gr3do', 's3gr3do-longo')), 'prefixo');
  assert(!(await segredoConfere('s3gr3do-longo-mais', 's3gr3do-longo')), 'maior');
});

Deno.test('segredoConfere: header ausente ou vazio nunca confere', async () => {
  assert(!(await segredoConfere(null, 'x')), 'null');
  assert(!(await segredoConfere(undefined, 'x')), 'undefined');
  assert(!(await segredoConfere('', '')), 'vazio');
});

Deno.test('iguaisEmTempoConstante: mesma semântica de ===', () => {
  assert(iguaisEmTempoConstante('abc', 'abc'), 'igual');
  assert(!iguaisEmTempoConstante('abc', 'abd'), 'diferente');
  assert(!iguaisEmTempoConstante('abc', 'ab'), 'tamanho');
});
