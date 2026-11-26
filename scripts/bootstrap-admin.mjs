#!/usr/bin/env node
/**
 * Cria o primeiro administrador do Echo: usuário, perfil de super admin, organização e vínculo de admin.
 *
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/bootstrap-admin.mjs --email admin@example.com --password '<senha>' --org "Acme"
 *
 * Variáveis de ambiente (obrigatórias; não existe projeto padrão):
 *   SUPABASE_URL                URL da API do projeto (no `supabase start`, o API_URL do `supabase status`).
 *   SUPABASE_SERVICE_ROLE_KEY   Chave service_role. Fica só no ambiente: o script nunca a imprime.
 *   BOOTSTRAP_ADMIN_PASSWORD    Opcional: senha por ambiente, para não aparecer na lista de processos.
 *                               Vale só quando --password não é passado.
 *
 * O que faz, nesta ordem, e é idempotente (rodar de novo não duplica nada e não falha):
 *   1. Usuário: reaproveita o e-mail se já existe (a senha dele NÃO é alterada); senão cria pelo auth admin com
 *      e-mail confirmado. O trigger on_auth_user_created cria a linha em public.profiles.
 *   2. Perfil: is_super_admin = true (só o service_role pode mudar essa coluna, ver
 *      profiles_guard_protected_columns).
 *   3. Organização: reaproveita a de mesmo nome, senão cria (slug por public.generate_org_slug).
 *   4. Vínculo: organization_members com role = 'admin'.
 *
 * Por que inserir direto e não chamar create_onboarding_organization: a RPC lê auth.uid() do JWT do usuário e a
 * chave de serviço não tem uid. O resultado é o mesmo que a RPC grava (organizations + vínculo admin).
 *
 * Auth Hook before_user_created: o admin API do Auth (createUser) não passa por ele, então o script funciona com o
 * hook ligado ou desligado. Se uma versão do Auth passar a barrar, o erro é explicado na saída.
 *
 * Saída: 0 ok; 2 argumento ou ambiente inválido; 1 falha ao falar com o Supabase.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const USO = `Uso: node scripts/bootstrap-admin.mjs --email <email> --password <senha> --org "<nome>"

Ambiente obrigatório: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.
Opcional: BOOTSTRAP_ADMIN_PASSWORD no lugar de --password.`;

export const ArgumentosSchema = z.object({
  email: z.string().trim().toLowerCase().email("--email não é um e-mail válido"),
  password: z.string().min(8, "--password precisa de pelo menos 8 caracteres").max(72, "--password aceita no máximo 72 caracteres"),
  org: z
    .string()
    .trim()
    .min(2, "--org precisa de pelo menos 2 caracteres")
    .max(100, "--org aceita no máximo 100 caracteres"),
});

export const AmbienteSchema = z.object({
  SUPABASE_URL: z
    .string({ required_error: "SUPABASE_URL não definida" })
    .trim()
    .url("SUPABASE_URL não é uma URL válida")
    .refine((u) => /^https?:\/\//.test(u), "SUPABASE_URL precisa começar com http:// ou https://"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string({ required_error: "SUPABASE_SERVICE_ROLE_KEY não definida" })
    .trim()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY está vazia"),
});

const FLAGS = new Set(["email", "password", "org"]);

/**
 * Lê `--chave valor` e `--chave=valor`. Devolve { valores, erros }; não lança e não toca em process.
 * Flag desconhecida, flag sem valor e flag repetida são erro: melhor falhar do que ignorar em silêncio.
 */
export function parseArgs(argv) {
  const valores = {};
  const erros = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      erros.push(`argumento inesperado: ${token}`);
      continue;
    }
    const igual = token.indexOf("=");
    const nome = igual === -1 ? token.slice(2) : token.slice(2, igual);
    if (!FLAGS.has(nome)) {
      erros.push(`opção desconhecida: --${nome}`);
      // Consome o valor da opção desconhecida para não virar um segundo erro.
      if (igual === -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    let valor;
    if (igual !== -1) {
      valor = token.slice(igual + 1);
    } else {
      const proximo = argv[i + 1];
      if (proximo === undefined || proximo.startsWith("--")) {
        erros.push(`--${nome} precisa de um valor`);
        continue;
      }
      valor = proximo;
      i++;
    }
    if (nome in valores) {
      erros.push(`--${nome} foi passada mais de uma vez`);
      continue;
    }
    valores[nome] = valor;
  }
  return { valores, erros };
}

/** Junta os argumentos (e a senha por ambiente, se faltar --password) e valida com Zod. */
export function validarArgumentos(argv, env = {}) {
  const { valores, erros } = parseArgs(argv);
  const candidato = { ...valores };
  if (candidato.password === undefined && env.BOOTSTRAP_ADMIN_PASSWORD) {
    candidato.password = env.BOOTSTRAP_ADMIN_PASSWORD;
  }
  for (const nome of FLAGS) {
    if (candidato[nome] === undefined) erros.push(`--${nome} é obrigatório`);
  }
  if (erros.length > 0) return { ok: false, erros };

  const r = ArgumentosSchema.safeParse(candidato);
  if (!r.success) return { ok: false, erros: r.error.issues.map((i) => i.message) };
  return { ok: true, dados: r.data };
}

/** Valida SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY. Sem valor padrão. */
export function validarAmbiente(env) {
  const r = AmbienteSchema.safeParse({
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!r.success) return { ok: false, erros: r.error.issues.map((i) => i.message) };
  return { ok: true, dados: r.data };
}

/** Falha de uma chamada ao Supabase, com o passo no texto. Nunca carrega senha nem chave. */
export class FalhaSupabase extends Error {
  constructor(passo, causa) {
    super(`${passo}: ${causa?.message ?? String(causa)}`);
    this.name = "FalhaSupabase";
    this.passo = passo;
    this.causa = causa;
  }
}

function conferir(passo, error) {
  if (error) throw new FalhaSupabase(passo, error);
}

async function acharUsuarioPorEmail(supabase, email) {
  // 1) Perfil (o trigger grava profiles.email): uma consulta só.
  const { data: perfil, error } = await supabase.from("profiles").select("id").eq("email", email).maybeSingle();
  conferir("buscar perfil por e-mail", error);
  if (perfil) return perfil.id;

  // 2) Sem perfil: usuário órfão no Auth (ou perfil apagado). Procura na lista do Auth, página a página.
  const porPagina = 200;
  for (let pagina = 1; ; pagina++) {
    const { data, error: erroLista } = await supabase.auth.admin.listUsers({ page: pagina, perPage: porPagina });
    conferir("listar usuários do Auth", erroLista);
    const achado = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (achado) return achado.id;
    if (data.users.length < porPagina) return null;
  }
}

async function garantirUsuario(supabase, { email, password }) {
  const existente = await acharUsuarioPorEmail(supabase, email);
  if (existente) {
    const { data, error } = await supabase.auth.admin.getUserById(existente);
    conferir("ler usuário existente", error);
    if (!data.user.email_confirmed_at) {
      const { error: erroConfirma } = await supabase.auth.admin.updateUserById(existente, { email_confirm: true });
      conferir("confirmar e-mail do usuário existente", erroConfirma);
    }
    return { id: existente, criado: false };
  }

  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    if (error.code === "email_exists") {
      // Corrida com outra execução: o usuário apareceu entre a busca e a criação.
      const id = await acharUsuarioPorEmail(supabase, email);
      if (id) return { id, criado: false };
    }
    const dica =
      error.status === 403 || /hook|convite/i.test(error.message ?? "")
        ? " O Auth Hook before_user_created parece estar barrando o admin API. Desligue-o em supabase/config.toml" +
          " ([auth.hook.before_user_created]) ou em Authentication > Hooks, rode o script e religue."
        : "";
    throw new FalhaSupabase("criar usuário no Auth", { message: `${error.message}.${dica}` });
  }
  return { id: data.user.id, criado: true };
}

async function garantirPerfilSuperAdmin(supabase, { id, email }) {
  // O trigger on_auth_user_created cria o perfil na mesma transação do usuário. Se faltar (perfil apagado à mão),
  // recria; ON CONFLICT DO NOTHING via upsert com ignoreDuplicates.
  const { data: perfil, error } = await supabase
    .from("profiles")
    .select("id, is_super_admin")
    .eq("id", id)
    .maybeSingle();
  conferir("ler perfil", error);

  if (!perfil) {
    const { error: erroInsert } = await supabase.from("profiles").upsert({ id, email }, { onConflict: "id", ignoreDuplicates: true });
    conferir("criar perfil ausente", erroInsert);
  }

  const jaEra = Boolean(perfil?.is_super_admin);
  if (!jaEra) {
    const alteracoes = { is_super_admin: true };
    const { data: atualizados, error: erroUpdate } = await supabase
      .from("profiles")
      .update(alteracoes)
      .eq("id", id)
      .select("id");
    conferir("promover perfil a super admin", erroUpdate);
    if (!atualizados || atualizados.length !== 1) {
      throw new FalhaSupabase("promover perfil a super admin", { message: "nenhuma linha de profiles foi atualizada" });
    }
  }
  return { jaEraSuperAdmin: jaEra };
}

async function garantirOrganizacao(supabase, nome) {
  const buscar = async () => {
    const { data, error } = await supabase
      .from("organizations")
      .select("id, name, slug")
      .eq("name", nome)
      .order("created_at", { ascending: true });
    conferir("buscar organização por nome", error);
    return data;
  };

  const existentes = await buscar();
  if (existentes.length > 0) {
    return { org: existentes[0], criada: false, homonimas: existentes.length };
  }

  // O slug sai de generate_org_slug (o mesmo que a RPC de onboarding usa). Se duas execuções disputarem o mesmo
  // slug, a UNIQUE recusa (23505) e a segunda tentativa reaproveita a organização que a outra criou.
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const { data: slug, error: erroSlug } = await supabase.rpc("generate_org_slug", { p_name: nome });
    conferir("gerar slug da organização", erroSlug);
    const { data, error } = await supabase.from("organizations").insert({ name: nome, slug }).select("id, name, slug").single();
    if (!error) return { org: data, criada: true, homonimas: 1 };
    if (error.code !== "23505") throw new FalhaSupabase("criar organização", error);
    const apareceu = await buscar();
    if (apareceu.length > 0) return { org: apareceu[0], criada: false, homonimas: apareceu.length };
  }
  throw new FalhaSupabase("criar organização", { message: "slug em disputa; rode de novo" });
}

async function garantirVinculoAdmin(supabase, { organizationId, userId }) {
  const { data: atual, error } = await supabase
    .from("organization_members")
    .select("id, role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  conferir("ler vínculo", error);
  if (atual?.role === "admin") return { acao: "mantido" };

  const { error: erroUpsert } = await supabase
    .from("organization_members")
    .upsert({ organization_id: organizationId, user_id: userId, role: "admin" }, { onConflict: "organization_id,user_id" });
  conferir("gravar vínculo de admin", erroUpsert);
  return { acao: atual ? "promovido a admin" : "criado" };
}

/**
 * Executa o bootstrap. `log` recebe cada linha do relatório; nunca recebe senha nem chave.
 * Devolve o resumo estruturado (útil para teste).
 */
export async function bootstrapAdmin({ supabase, dados, log = console.log }) {
  const usuario = await garantirUsuario(supabase, dados);
  log(`Usuário ${dados.email}: ${usuario.criado ? "criado" : "já existia (senha mantida)"} (${usuario.id}).`);

  const perfil = await garantirPerfilSuperAdmin(supabase, { id: usuario.id, email: dados.email });
  log(`Perfil: super admin ${perfil.jaEraSuperAdmin ? "já estava ligado" : "ligado"}.`);

  const { org, criada, homonimas } = await garantirOrganizacao(supabase, dados.org);
  log(`Organização "${org.name}": ${criada ? "criada" : "já existia"} (${org.id}, slug ${org.slug}).`);
  if (homonimas > 1) log(`Aviso: ${homonimas} organizações têm esse nome; usada a mais antiga.`);

  const vinculo = await garantirVinculoAdmin(supabase, { organizationId: org.id, userId: usuario.id });
  log(`Vínculo admin em organization_members: ${vinculo.acao}.`);

  return { usuario, perfil, organizacao: { ...org, criada }, vinculo };
}

async function main() {
  const ambiente = validarAmbiente(process.env);
  if (!ambiente.ok) {
    console.error(["Ambiente inválido:", ...ambiente.erros.map((e) => `  - ${e}`), "", USO].join("\n"));
    process.exit(2);
  }
  const args = validarArgumentos(process.argv.slice(2), process.env);
  if (!args.ok) {
    console.error(["Argumentos inválidos:", ...args.erros.map((e) => `  - ${e}`), "", USO].join("\n"));
    process.exit(2);
  }

  const supabase = createClient(ambiente.dados.SUPABASE_URL, ambiente.dados.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    await bootstrapAdmin({ supabase, dados: args.dados });
    console.log("Pronto. Entre no painel com o e-mail informado.");
  } catch (erro) {
    console.error(`Falhou em ${erro instanceof Error ? erro.message : String(erro)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
