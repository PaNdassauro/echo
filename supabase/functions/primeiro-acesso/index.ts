// Primeiro acesso (/setup). verify_jwt = false: quem chama ainda não tem conta; o que protege é o código de
// instalação (ECHO_SETUP_TOKEN, do terminal do ./install.sh) e o estado do banco (só vale com a instalação vazia).
// A lógica e o contrato estão em _shared/primeiro-acesso.ts; aqui só se ligam as dependências reais.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { criarHandler, type DepsPrimeiroAcesso } from '../_shared/primeiro-acesso.ts';

const ConcluirSchema = z.object({ organization_id: z.string().uuid() });

function ambiente(nome: string): string {
  const valor = (Deno.env.get(nome) ?? '').trim();
  if (!valor) throw new Error(`${nome} não configurada`);
  return valor;
}

const SEM_SESSAO = { auth: { persistSession: false, autoRefreshToken: false } } as const;

/** Cliente com a service role, um por chamada (nenhum estado de sessão compartilhado entre pedidos). */
function admin() {
  return createClient(ambiente('SUPABASE_URL'), ambiente('SUPABASE_SERVICE_ROLE_KEY'), SEM_SESSAO);
}

const deps: DepsPrimeiroAcesso = {
  async precisaSetup() {
    const { data, error } = await admin().rpc('instalacao_precisa_setup');
    if (error) throw new Error(`instalacao_precisa_setup falhou (${error.code})`);
    return z.boolean().parse(data);
  },

  async criarUsuario({ email, senha, nome }) {
    const { data, error } = await admin().auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true,
      user_metadata: { full_name: nome },
    });
    if (error) {
      const codigo = error.code ?? '';
      console.warn(`[primeiro-acesso] createUser recusado (${codigo || error.status})`);
      if (codigo === 'weak_password') return { ok: false, motivo: 'senha_fraca' };
      if (codigo === 'email_exists' || codigo === 'user_already_exists') return { ok: false, motivo: 'email_existe' };
      if (codigo === 'email_address_invalid' || codigo === 'validation_failed') {
        return { ok: false, motivo: 'email_invalido' };
      }
      return { ok: false, motivo: 'erro' };
    }
    return { ok: true, id: data.user.id };
  },

  async entrarComSenha(email, senha) {
    // Cliente próprio, com a chave anon: o signIn grava a sessão no cliente e não pode ser o da service role.
    const anonimo = createClient(ambiente('SUPABASE_URL'), ambiente('SUPABASE_ANON_KEY'), SEM_SESSAO);
    const { data, error } = await anonimo.auth.signInWithPassword({ email, password: senha });
    if (error || !data.user) return null;
    return { id: data.user.id };
  },

  async concluirSetup(userId, organizacao) {
    const { data, error } = await admin().rpc('instalacao_concluir_setup', {
      p_user_id: userId,
      p_organizacao: organizacao,
    });
    if (error) return { ok: false, codigo: error.code, mensagem: error.message };
    const lido = ConcluirSchema.safeParse(data);
    if (!lido.success) return { ok: false, codigo: 'resposta_invalida', mensagem: 'a RPC não devolveu organization_id' };
    return { ok: true, organization_id: lido.data.organization_id };
  },

  async apagarUsuario(userId) {
    const { error } = await admin().auth.admin.deleteUser(userId);
    if (error) throw new Error(`deleteUser falhou (${error.code ?? error.status})`);
  },

  tokenConfigurado() {
    return (Deno.env.get('ECHO_SETUP_TOKEN') ?? '').trim();
  },
};

Deno.serve(criarHandler(deps));
