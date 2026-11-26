// deno test --no-config --allow-env --allow-read supabase/functions/_shared/conversation-touch.test.ts
import {
  FILTRO_NAO_ATIVO_OU_NAO_ORGANICO,
  FILTRO_STATUS_NAO_ATIVO,
  planoDeReativacao,
  reativarConversa,
} from './conversation-touch.ts';

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

type Call = [string, ...unknown[]];

function fakeSupabase(result: { error: unknown } = { error: null }) {
  const calls: Call[] = [];
  const builder = {
    update(campos: unknown) { calls.push(['update', campos]); return builder; },
    eq(col: string, val: unknown) { calls.push(['eq', col, val]); return builder; },
    or(filtro: string) { calls.push(['or', filtro]); return Promise.resolve(result); },
  };
  return {
    calls,
    client: { from(t: string) { calls.push(['from', t]); return builder; } },
  };
}

Deno.test('planoDeReativacao: envio só mexe em status, com NULL coberto', () => {
  equal(planoDeReativacao(), { campos: { status: 'active' }, filtro: 'status.is.null,status.neq.active' });
});

Deno.test('planoDeReativacao: resposta do cliente promove a organic', () => {
  equal(planoDeReativacao({ promoverOrganica: true }), {
    campos: { status: 'active', source: 'organic' },
    filtro: 'status.is.null,status.neq.active,source.is.null,source.neq.organic',
  });
});

Deno.test('reativarConversa: UPDATE escopado pelo id e condicional', async () => {
  const { calls, client } = fakeSupabase();
  await reativarConversa(client, 'c-1');
  equal(calls, [
    ['from', 'conversations'],
    ['update', { status: 'active' }],
    ['eq', 'id', 'c-1'],
    ['or', FILTRO_STATUS_NAO_ATIVO],
  ]);
});

Deno.test('reativarConversa: inbound leva source no corpo e no filtro', async () => {
  const { calls, client } = fakeSupabase();
  await reativarConversa(client, 'c-2', { promoverOrganica: true });
  equal(calls[1], ['update', { status: 'active', source: 'organic' }]);
  equal(calls[3], ['or', FILTRO_NAO_ATIVO_OU_NAO_ORGANICO]);
});

Deno.test('reativarConversa: nunca escreve last_message_at (é do trigger)', async () => {
  const { calls, client } = fakeSupabase();
  await reativarConversa(client, 'c-3', { promoverOrganica: true });
  const campos = calls.find((c) => c[0] === 'update')?.[1] as Record<string, unknown>;
  if ('last_message_at' in campos) throw new Error('last_message_at não pode estar no UPDATE');
});

Deno.test('reativarConversa: erro do banco é logado, não lançado', async () => {
  const { client } = fakeSupabase({ error: { code: '57014', message: 'timeout' } });
  const original = console.error;
  let logged = false;
  console.error = () => { logged = true; };
  try {
    await reativarConversa(client, 'c-4');
  } finally {
    console.error = original;
  }
  if (!logged) throw new Error('esperava log do erro');
});
