// npx -y deno@2 test --no-config --allow-env --allow-read tests/grupos
import { atualizacaoDoNomeDoGrupo } from '../../supabase/functions/_shared/nome-do-grupo.ts';

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

Deno.test('sem apelido: o nome exibido acompanha a troca de nome no WhatsApp', () => {
  equal(
    atualizacaoDoNomeDoGrupo({ contact_name: 'Equipe Projeto X', group_subject: 'Equipe Projeto X' }, 'Equipe Projeto X 2027'),
    { group_subject: 'Equipe Projeto X 2027', contact_name: 'Equipe Projeto X 2027' },
  );
});

Deno.test('com apelido: só o nome do WhatsApp muda, o apelido fica', () => {
  equal(
    atualizacaoDoNomeDoGrupo({ contact_name: 'Equipe Projeto X (Suporte)', group_subject: 'Equipe Projeto X' }, 'Equipe Projeto X 2027'),
    { group_subject: 'Equipe Projeto X 2027' },
  );
});

Deno.test('mesmo nome de novo: nada a gravar (sem UPDATE por mensagem)', () => {
  equal(atualizacaoDoNomeDoGrupo({ contact_name: 'Equipe Projeto X', group_subject: 'Equipe Projeto X' }, 'Equipe Projeto X'), null);
  equal(atualizacaoDoNomeDoGrupo({ contact_name: 'Apelido', group_subject: 'Equipe Projeto X' }, 'Equipe Projeto X'), null);
});

Deno.test('grupo antigo (group_subject NULL): nome igual só preenche a coluna', () => {
  equal(atualizacaoDoNomeDoGrupo({ contact_name: 'Equipe Projeto X', group_subject: null }, 'Equipe Projeto X'), {
    group_subject: 'Equipe Projeto X',
  });
});

Deno.test('grupo antigo (group_subject NULL) renomeado no WhatsApp: o exibido acompanha', () => {
  // Antes da coluna group_subject o webhook sobrescrevia contact_name a cada mensagem: não há apelido antigo.
  equal(atualizacaoDoNomeDoGrupo({ contact_name: 'Equipe Projeto X', group_subject: null }, 'Equipe Projeto X 2027'), {
    group_subject: 'Equipe Projeto X 2027',
    contact_name: 'Equipe Projeto X 2027',
  });
});

Deno.test('espaço nas pontas não vira apelido', () => {
  equal(atualizacaoDoNomeDoGrupo({ contact_name: 'Grupo Vendas Acme ', group_subject: null }, 'Grupo Vendas Acme'), {
    group_subject: 'Grupo Vendas Acme',
    contact_name: 'Grupo Vendas Acme',
  });
  equal(atualizacaoDoNomeDoGrupo({ contact_name: 'Carla e Daniel ', group_subject: 'Carla e Daniel' }, 'Carla e Daniel'), {
    contact_name: 'Carla e Daniel',
  });
});

Deno.test('apelido posto depois da coluna continua de pé na troca seguinte', () => {
  equal(atualizacaoDoNomeDoGrupo({ contact_name: 'Apelido', group_subject: 'Equipe Projeto X' }, 'Equipe Projeto X 2027'), {
    group_subject: 'Equipe Projeto X 2027',
  });
});

Deno.test('apelido igual ao novo nome do WhatsApp: volta a acompanhar', () => {
  equal(atualizacaoDoNomeDoGrupo({ contact_name: 'Novo', group_subject: 'Antigo' }, 'Novo'), { group_subject: 'Novo' });
});

Deno.test('sem nome exibido, ou nome vazio no payload', () => {
  equal(atualizacaoDoNomeDoGrupo({ contact_name: '', group_subject: null }, 'Grupo'), {
    group_subject: 'Grupo',
    contact_name: 'Grupo',
  });
  equal(atualizacaoDoNomeDoGrupo({ contact_name: 'X', group_subject: 'X' }, '  '), null);
  equal(atualizacaoDoNomeDoGrupo({ contact_name: 'X', group_subject: 'X' }, undefined), null);
});
