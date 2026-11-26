// Primeiro acesso (/setup): cria o primeiro administrador e a organização de uma instalação vazia.
//
//   GET  /functions/v1/primeiro-acesso -> 200 { precisa_setup: boolean }
//        precisa_setup = ECHO_SETUP_TOKEN não vazio && instalacao_precisa_setup()
//   POST /functions/v1/primeiro-acesso -> ver RespostaSetup
//
// Quem decide a corrida é o banco: `instalacao_concluir_setup` pega um advisory lock e a segunda chamada recebe
// PT409; a edge apaga o usuário que criou nesta chamada. O Auth e o Postgres são transações diferentes, então não
// existe atomicidade entre os dois: o desenho é "o banco decide, o perdedor compensa".
//
// Regras que não podem mudar sem rever a segurança:
//  - sem ECHO_SETUP_TOKEN (vazio) o /setup está desligado; com ele, o código do terminal é conferido em tempo
//    constante antes de qualquer consulta ao banco;
//  - a senha de um usuário que já existe NUNCA é trocada aqui: e-mail repetido só segue se o `signIn` com a mesma
//    senha der certo (retentativa de quem caiu no meio), senão 422 `email_em_uso`;
//  - segredo, senha e e-mail não vão para o log.
//
// A lógica vive aqui (`criarHandler`, com as dependências injetáveis) para ser testada sem Auth nem banco; o
// `index.ts` só liga as dependências reais.
import { z } from 'https://esm.sh/zod@3.23.8';
import { segredoConfere } from './segredo.ts';

/** Tamanho em pontos de código, como o `length()` do Postgres (o `.length` do JS conta unidades UTF-16: emoji = 2). */
export function pontosDeCodigo(texto: string): number {
  return Array.from(texto).length;
}

// Par de src/lib/primeiroAcesso.ts (mesmos limites). A senha mínima é a do Auth (GOTRUE_PASSWORD_MIN_LENGTH=8); o teto
// de 72 é o do bcrypt, que ignora o que passa disso. O nome da organização (2 a 100) é conferido pelo banco com
// `length()`, que conta pontos de código: aqui também, senão um nome com emoji passaria na edge e o banco o recusaria.
export const SetupSchema = z.object({
  codigo: z.string().trim().min(1).max(128),
  nome: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  senha: z.string().min(8).max(72),
  organizacao: z.string().trim()
    .refine((v) => pontosDeCodigo(v) >= 2, 'mínimo de 2 caracteres')
    .refine((v) => pontosDeCodigo(v) <= 100, 'máximo de 100 caracteres'),
}).strict();

export type PedidoSetup = z.infer<typeof SetupSchema>;

export type RespostaSetup =
  | { ok: true; organization_id: string } // 201
  | { ok: false; erro: 'payload_invalido'; issues: z.ZodIssue[] } // 400
  | { ok: false; erro: 'codigo_invalido' | 'setup_desligado' } // 403
  | { ok: false; erro: 'ja_configurado' } // 409
  | { ok: false; erro: 'senha_fraca' | 'email_invalido' | 'email_em_uso' } // 422
  | { ok: false; erro: 'falha_interna' }; // 500

export type ResultadoCriarUsuario =
  | { ok: true; id: string }
  | { ok: false; motivo: 'senha_fraca' | 'email_invalido' | 'email_existe' | 'erro' };

export type ResultadoConcluir =
  | { ok: true; organization_id: string }
  | { ok: false; codigo: string; mensagem: string };

export interface DepsPrimeiroAcesso {
  /** `instalacao_precisa_setup()`: nenhum super admin e nenhuma organização. */
  precisaSetup(): Promise<boolean>;
  /** Usuário no Auth pelo admin API (já confirmado, não passa pelo hook de convite). */
  criarUsuario(dados: { email: string; senha: string; nome: string }): Promise<ResultadoCriarUsuario>;
  /** Id do usuário se o e-mail e a senha entram; null se não. */
  entrarComSenha(email: string, senha: string): Promise<{ id: string } | null>;
  /** `instalacao_concluir_setup(p_user_id, p_organizacao)`. `PT409` = outra chamada ganhou. */
  concluirSetup(userId: string, organizacao: string): Promise<ResultadoConcluir>;
  apagarUsuario(userId: string): Promise<void>;
  /** ECHO_SETUP_TOKEN aparado; vazio = /setup desligado. */
  tokenConfigurado(): string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(corpo: unknown, status: number): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function resposta(r: RespostaSetup, status: number): Response {
  return json(r, status);
}

export function criarHandler(deps: DepsPrimeiroAcesso): (req: Request) => Promise<Response> {
  async function precisaSetup(): Promise<boolean> {
    return deps.tokenConfigurado() !== '' && await deps.precisaSetup();
  }

  async function descartar(userId: string, criado: boolean): Promise<void> {
    if (!criado) return;
    try {
      await deps.apagarUsuario(userId);
    } catch (e) {
      console.error('[primeiro-acesso] não foi possível apagar o usuário criado nesta chamada:', e instanceof Error ? e.message : e);
    }
  }

  async function post(req: Request): Promise<Response> {
    let bruto: unknown;
    try {
      bruto = await req.json();
    } catch {
      return resposta({ ok: false, erro: 'payload_invalido', issues: [] }, 400);
    }
    const lido = SetupSchema.safeParse(bruto);
    if (!lido.success) return resposta({ ok: false, erro: 'payload_invalido', issues: lido.error.issues }, 400);
    const { codigo, nome, email, senha, organizacao } = lido.data;

    const token = deps.tokenConfigurado();
    if (token === '') return resposta({ ok: false, erro: 'setup_desligado' }, 403);
    if (!await segredoConfere(codigo, token)) return resposta({ ok: false, erro: 'codigo_invalido' }, 403);

    if (!await deps.precisaSetup()) return resposta({ ok: false, erro: 'ja_configurado' }, 409);

    let userId: string;
    let criado = true;
    const novo = await deps.criarUsuario({ email, senha, nome });
    if (novo.ok) {
      userId = novo.id;
    } else if (novo.motivo === 'senha_fraca') {
      return resposta({ ok: false, erro: 'senha_fraca' }, 422);
    } else if (novo.motivo === 'email_invalido') {
      return resposta({ ok: false, erro: 'email_invalido' }, 422);
    } else if (novo.motivo === 'email_existe') {
      // Retentativa de quem caiu no meio: só continua provando que é a mesma pessoa. Nunca troca a senha.
      const entrou = await deps.entrarComSenha(email, senha);
      if (!entrou) return resposta({ ok: false, erro: 'email_em_uso' }, 422);
      userId = entrou.id;
      criado = false;
    } else {
      console.error('[primeiro-acesso] o Auth não criou o usuário');
      return resposta({ ok: false, erro: 'falha_interna' }, 500);
    }

    const fim = await deps.concluirSetup(userId, organizacao);
    if (fim.ok) return resposta({ ok: true, organization_id: fim.organization_id }, 201);
    await descartar(userId, criado);
    if (fim.codigo === 'PT409') return resposta({ ok: false, erro: 'ja_configurado' }, 409);
    // 22023 = parâmetro inválido para o banco (nome fora de 2-100 caracteres, usuário inexistente): erro de quem
    // chamou, não do servidor.
    if (fim.codigo === '22023') return resposta({ ok: false, erro: 'payload_invalido', issues: [] }, 400);
    console.error(`[primeiro-acesso] instalacao_concluir_setup falhou (${fim.codigo}): ${fim.mensagem}`);
    return resposta({ ok: false, erro: 'falha_interna' }, 500);
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    try {
      if (req.method === 'GET') return json({ precisa_setup: await precisaSetup() }, 200);
      if (req.method === 'POST') return await post(req);
      return json({ ok: false, erro: 'metodo_nao_permitido' }, 405);
    } catch (e) {
      console.error('[primeiro-acesso] erro inesperado:', e instanceof Error ? e.message : e);
      return resposta({ ok: false, erro: 'falha_interna' }, 500);
    }
  };
}
