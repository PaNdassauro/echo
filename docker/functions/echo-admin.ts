// CLI de administração dentro da imagem `functions` (usada pelo ./echo; o host não precisa de Node).
//
//   echo-admin reset-password --email E   lê a senha nova da 1ª linha do stdin (mín. 8, máx. 72); imprime `ok`
//   echo-admin recovery-link --email E    imprime ${SITE_URL}/auth?token_hash=<hash>&type=recovery (não envia e-mail)
//   echo-admin setup-status               imprime {"precisa_setup":true|false} (mesma regra do GET da edge primeiro-acesso)
//
// Códigos de saída: 0 ok; 2 entrada inválida; 3 usuário não existe; 1 falha interna (mensagem em stderr).
// Fala com o Auth e o PostgREST pelo SUPABASE_URL interno com a service role (variáveis do container `functions`).
import { createClient } from "@supabase/supabase-js";
import { z } from "https://esm.sh/zod@3.23.8";

export const SENHA_MIN = 8;
// O bcrypt do Auth só considera os 72 primeiros bytes: o mesmo teto do /setup.
export const SENHA_MAX = 72;

const EmailSchema = z.string().trim().toLowerCase().email().max(254);

export class UsoInvalido extends Error {}
export class UsuarioNaoExiste extends Error {}

export interface DepsAdmin {
  env: Record<string, string | undefined>;
  /** Primeira linha do stdin, sem o fim de linha. */
  lerLinhaStdin(): Promise<string>;
  escrever(texto: string): void;
  escreverErro(texto: string): void;
  acharUsuarioPorEmail(email: string): Promise<{ id: string } | null>;
  atualizarSenha(id: string, senha: string): Promise<void>;
  gerarHashRecuperacao(email: string): Promise<string>;
  precisaSetup(): Promise<boolean>;
}

/** `--email E` ou `--email=E`; qualquer outra opção é erro. */
export function lerEmail(args: string[]): string {
  let bruto: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--email") {
      bruto = args[++i];
    } else if (a.startsWith("--email=")) {
      bruto = a.slice("--email=".length);
    } else {
      throw new UsoInvalido(`opção desconhecida: ${a}`);
    }
  }
  const lido = EmailSchema.safeParse(bruto ?? "");
  if (!lido.success) throw new UsoInvalido("informe um e-mail válido: --email usuario@exemplo.com");
  return lido.data;
}

export function validarSenha(senha: string): string {
  const bytes = new TextEncoder().encode(senha).length;
  if (bytes < SENHA_MIN) throw new UsoInvalido(`a senha precisa ter pelo menos ${SENHA_MIN} caracteres`);
  if (bytes > SENHA_MAX) throw new UsoInvalido(`a senha pode ter no máximo ${SENHA_MAX} bytes`);
  return senha;
}

/** Roda um subcomando e devolve o código de saída. Nunca lança. */
export async function executar(argv: string[], deps: DepsAdmin): Promise<number> {
  const [comando, ...resto] = argv;
  try {
    switch (comando) {
      case "reset-password": {
        const email = lerEmail(resto);
        const senha = validarSenha(await deps.lerLinhaStdin());
        const usuario = await deps.acharUsuarioPorEmail(email);
        if (!usuario) throw new UsuarioNaoExiste(`usuário não encontrado: ${email}`);
        await deps.atualizarSenha(usuario.id, senha);
        deps.escrever("ok\n");
        return 0;
      }
      case "recovery-link": {
        const email = lerEmail(resto);
        const base = (deps.env.SITE_URL ?? "").trim().replace(/\/+$/, "");
        if (!base) throw new Error("SITE_URL não configurada no container functions");
        const usuario = await deps.acharUsuarioPorEmail(email);
        if (!usuario) throw new UsuarioNaoExiste(`usuário não encontrado: ${email}`);
        const hash = await deps.gerarHashRecuperacao(email);
        deps.escrever(`${base}/auth?token_hash=${encodeURIComponent(hash)}&type=recovery\n`);
        return 0;
      }
      case "setup-status": {
        if (resto.length > 0) throw new UsoInvalido(`opção desconhecida: ${resto[0]}`);
        const tokenConfigurado = (deps.env.ECHO_SETUP_TOKEN ?? "").trim() !== "";
        const precisa = tokenConfigurado && await deps.precisaSetup();
        deps.escrever(`${JSON.stringify({ precisa_setup: precisa })}\n`);
        return 0;
      }
      default:
        throw new UsoInvalido(
          "uso: echo-admin reset-password --email E | recovery-link --email E | setup-status",
        );
    }
  } catch (e) {
    if (e instanceof UsoInvalido) {
      deps.escreverErro(`${e.message}\n`);
      return 2;
    }
    if (e instanceof UsuarioNaoExiste) {
      deps.escreverErro(`${e.message}\n`);
      return 3;
    }
    deps.escreverErro(`falha: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

async function lerPrimeiraLinha(): Promise<string> {
  const decoder = new TextDecoder();
  let texto = "";
  for await (const pedaco of Deno.stdin.readable) {
    texto += decoder.decode(pedaco, { stream: true });
    if (texto.includes("\n") || texto.length > 1024) break;
  }
  return texto.split("\n")[0].replace(/\r$/, "");
}

const PerfilSchema = z.array(z.object({ id: z.string().uuid() }));

function depsReais(env: Record<string, string | undefined>): DepsAdmin {
  const url = (env.SUPABASE_URL ?? "").trim();
  const chave = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const cliente = () => {
    if (!url || !chave) throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configuradas no container");
    return createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });
  };
  const encoder = new TextEncoder();
  return {
    env,
    lerLinhaStdin: lerPrimeiraLinha,
    escrever: (t) => void Deno.stdout.writeSync(encoder.encode(t)),
    escreverErro: (t) => void Deno.stderr.writeSync(encoder.encode(t)),
    async acharUsuarioPorEmail(email) {
      const { data, error } = await cliente().from("profiles").select("id").eq("email", email).limit(1);
      if (error) throw new Error(`consulta de perfil falhou: ${error.message}`);
      const linhas = PerfilSchema.parse(data);
      return linhas.length > 0 ? { id: linhas[0].id } : null;
    },
    async atualizarSenha(id, senha) {
      const { error } = await cliente().auth.admin.updateUserById(id, { password: senha });
      if (error) throw new Error(`o Auth recusou a nova senha: ${error.message}`);
    },
    async gerarHashRecuperacao(email) {
      const { data, error } = await cliente().auth.admin.generateLink({ type: "recovery", email });
      if (error) throw new Error(`o Auth não gerou o link: ${error.message}`);
      const hash = z.string().min(1).safeParse(data?.properties?.hashed_token);
      if (!hash.success) throw new Error("o Auth não devolveu hashed_token");
      return hash.data;
    },
    async precisaSetup() {
      const { data, error } = await cliente().rpc("instalacao_precisa_setup");
      if (error) throw new Error(`instalacao_precisa_setup falhou: ${error.message}`);
      return z.boolean().parse(data);
    },
  };
}

if (import.meta.main) {
  Deno.exit(await executar(Deno.args, depsReais(Deno.env.toObject())));
}
