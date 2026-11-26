// Trava: nenhum writer de messages.metadata pode ler a linha, mesclar no TS e gravar o objeto inteiro
// (read-modify-write). A transcrição escreve `leitura` e o voto de enquete escreve `poll.votes` na mesma
// linha, e um writer que leu antes apagaria o que foi gravado depois. O caminho é `_shared/metadata-merge.ts`
// (RPCs messages_mesclar_metadata / messages_registrar_edicao). O teste imprime arquivo:linha do que achou.
//
// Rodar: deno test --no-config --allow-env --allow-read tests/metadata

import { assertEquals } from 'jsr:@std/assert@1';

const RAIZ = new URL('../../supabase/functions/', import.meta.url);

/** Exceções explícitas: `arquivo` (relativo a supabase/functions) + trecho que identifica a linha. Cada uma com o motivo. */
const EXCECOES: Array<{ arquivo: string; trecho: string; motivo: string }> = [
  { arquivo: 'whatsapp-send-media/index.ts', trecho: 'insertMetadata', motivo: 'INSERT de linha nova: não há metadata anterior para perder' },
  { arquivo: '_shared/instagram-caixa.ts', trecho: 'metadataBase', motivo: 'INSERT de linha nova (bolha do Direct)' },
  { arquivo: 'whatsapp-forward/index.ts', trecho: "metadata: { forwarded: true", motivo: 'upsert de inserção; a linha só é enriquecida depois, por mesclarMetadata' },
  { arquivo: 'whatsapp-webhook/index.ts', trecho: 'messageInsert.metadata', motivo: 'INSERT de linha nova (messageInsert)' },
];

const PADRAO_A =
  /metadata\s*:\s*\{\s*\.\.\.\s*\(?\s*(?:metadata|existingMeta|currentMeta|row\??\.metadata|eco\.metadata|\(eco\.metadata)\b/;

async function* arquivosTs(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const u = new URL(e.name + (e.isDirectory ? '/' : ''), dir);
    if (e.isDirectory) yield* arquivosTs(u);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) yield u;
  }
}

/** Texto do `.update(` até o `)` correspondente (conta parênteses; ignora os que estão em strings simples). */
export function corpoDoUpdate(src: string, abre: number): string {
  let prof = 0;
  let aspas: string | null = null;
  for (let i = abre; i < src.length; i++) {
    const c = src[i];
    if (aspas) {
      if (c === '\\') i++;
      else if (c === aspas) aspas = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') aspas = c;
    else if (c === '(') prof++;
    else if (c === ')') {
      prof--;
      if (prof === 0) return src.slice(abre, i + 1);
    }
  }
  return src.slice(abre);
}

interface Achado { arquivo: string; linha: number; regra: 'A' | 'B'; texto: string }

function linhaDe(src: string, idx: number): number {
  return src.slice(0, idx).split('\n').length;
}

export function varrer(arquivo: string, src: string): Achado[] {
  const achados: Achado[] = [];
  const linhas = src.split('\n');

  linhas.forEach((l, i) => {
    if (PADRAO_A.test(l)) achados.push({ arquivo, linha: i + 1, regra: 'A', texto: l.trim() });
  });

  for (const m of src.matchAll(/\.update\s*\(/g)) {
    const abre = (m.index ?? 0) + m[0].length - 1;
    const corpo = corpoDoUpdate(src, abre);
    if (/\bmetadata\s*:/.test(corpo)) {
      achados.push({ arquivo, linha: linhaDe(src, m.index ?? 0), regra: 'B', texto: corpo.replace(/\s+/g, ' ').slice(0, 140) });
    }
  }
  return achados;
}

function excecao(a: Achado): string | null {
  for (const e of EXCECOES) {
    if (a.arquivo === e.arquivo && a.texto.includes(e.trecho)) return e.motivo;
  }
  return null;
}

Deno.test('nenhum writer faz read-modify-write de metadata (use _shared/metadata-merge.ts)', async () => {
  const proibidos: Achado[] = [];
  for await (const u of arquivosTs(RAIZ)) {
    const rel = u.pathname.slice(RAIZ.pathname.length);
    const src = await Deno.readTextFile(u);
    for (const a of varrer(rel, src)) {
      if (!excecao(a)) proibidos.push(a);
    }
  }
  if (proibidos.length) {
    console.error(
      'read-modify-write de metadata encontrado:\n' +
        proibidos.map((a) => `  ${a.arquivo}:${a.linha} [regra ${a.regra}] ${a.texto}`).join('\n'),
    );
  }
  assertEquals(proibidos.length, 0, 'use mesclarMetadata/registrarEdicao de _shared/metadata-merge.ts');
});

Deno.test('o detector enxerga os padrões proibidos (autoteste)', () => {
  const a = varrer('x.ts', "await db.from('messages').update({ metadata: { ...(row?.metadata ?? {}), k: 1 } }).eq('id', i);");
  assertEquals(a.map((x) => x.regra).sort(), ['A', 'B']);
  const b = varrer('x.ts', "const ok = { metadata: { ...(eco.metadata ?? {}) } };");
  assertEquals(b.map((x) => x.regra), ['A']);
  const c = varrer('x.ts', "await db.from('messages').update({ is_deleted: true }).eq('id', i);");
  assertEquals(c.length, 0);
  const d = varrer('x.ts', "await db.from('messages').update({ content: f(a, (b)), metadata: patch }).eq('id', i);");
  assertEquals(d.map((x) => x.regra), ['B']);
});

Deno.test('as exceções declaradas ainda existem (sem exceção morta)', async () => {
  for (const e of EXCECOES) {
    const src = await Deno.readTextFile(new URL(e.arquivo, RAIZ));
    if (!src.includes(e.trecho)) throw new Error(`exceção morta: ${e.arquivo} não contém "${e.trecho}"`);
  }
});
