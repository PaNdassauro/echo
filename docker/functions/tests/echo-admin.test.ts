import { type DepsAdmin, executar, lerEmail, validarSenha } from "../echo-admin.ts";
import { igual } from "./helpers.ts";

interface Chamadas {
  saida: string;
  erro: string;
  senhasAplicadas: Array<[string, string]>;
  buscas: string[];
  hashes: string[];
  precisaSetup: number;
}

function montar(
  sobre: Partial<DepsAdmin> & { stdin?: string; usuarios?: Record<string, string> } = {},
): { deps: DepsAdmin; c: Chamadas } {
  const c: Chamadas = { saida: "", erro: "", senhasAplicadas: [], buscas: [], hashes: [], precisaSetup: 0 };
  const usuarios = sobre.usuarios ?? { "admin@example.com": "00000000-0000-4000-8000-000000000001" };
  const deps: DepsAdmin = {
    env: { SITE_URL: "https://echo.example.com/", ECHO_SETUP_TOKEN: "t".repeat(32) },
    lerLinhaStdin: () => Promise.resolve(sobre.stdin ?? "NovaSenha123"),
    escrever: (t) => void (c.saida += t),
    escreverErro: (t) => void (c.erro += t),
    acharUsuarioPorEmail: (email) => {
      c.buscas.push(email);
      const id = usuarios[email];
      return Promise.resolve(id ? { id } : null);
    },
    atualizarSenha: (id, senha) => {
      c.senhasAplicadas.push([id, senha]);
      return Promise.resolve();
    },
    gerarHashRecuperacao: (email) => {
      c.hashes.push(email);
      return Promise.resolve("a".repeat(56));
    },
    precisaSetup: () => {
      c.precisaSetup++;
      return Promise.resolve(true);
    },
    ...sobre,
  };
  return { deps, c };
}

Deno.test("reset-password: troca a senha lida do stdin, imprime ok, exit 0, senha nunca impressa", async () => {
  const { deps, c } = montar({ stdin: "NovaSenha123" });
  const codigo = await executar(["reset-password", "--email", "Admin@Example.com"], deps);
  igual(codigo, 0, "exit");
  igual(c.saida, "ok\n", "saída");
  igual(c.senhasAplicadas, [["00000000-0000-4000-8000-000000000001", "NovaSenha123"]], "senha aplicada ao id achado");
  igual(c.buscas, ["admin@example.com"], "e-mail normalizado em minúsculas");
  igual((c.saida + c.erro).includes("NovaSenha123"), false, "a senha não aparece na saída");
});

Deno.test("reset-password: usuário inexistente -> exit 3, sem trocar nada", async () => {
  const { deps, c } = montar();
  const codigo = await executar(["reset-password", "--email", "ninguem@example.com"], deps);
  igual(codigo, 3, "exit");
  igual(c.senhasAplicadas, [], "nenhuma senha trocada");
  igual(c.saida, "", "nada em stdout");
});

Deno.test("reset-password: entrada inválida -> exit 2 sem consultar nem trocar", async () => {
  for (const [args, stdin, motivo] of [
    [["reset-password"], "NovaSenha123", "sem --email"],
    [["reset-password", "--email", "isso-nao-e-email"], "NovaSenha123", "e-mail inválido"],
    [["reset-password", "--email", "admin@example.com"], "curta", "senha com 5 caracteres"],
    [["reset-password", "--email", "admin@example.com"], "1234567", "senha com 7 caracteres"],
    [["reset-password", "--email", "admin@example.com"], "x".repeat(73), "senha com 73 bytes"],
    [["reset-password", "--email", "admin@example.com", "--senha", "abc"], "NovaSenha123", "opção desconhecida (senha por argv)"],
  ] as Array<[string[], string, string]>) {
    const { deps, c } = montar({ stdin });
    igual(await executar(args, deps), 2, motivo);
    igual(c.senhasAplicadas, [], `${motivo}: nada trocado`);
  }
});

Deno.test("reset-password: --email=valor e senha de 8 e de 72 caracteres são aceitas", async () => {
  for (const senha of ["12345678", "x".repeat(72)]) {
    const { deps, c } = montar({ stdin: senha });
    igual(await executar(["reset-password", "--email=admin@example.com"], deps), 0, `senha de ${senha.length}`);
    igual(c.senhasAplicadas[0][1], senha, "senha aplicada");
  }
});

Deno.test("reset-password: falha do Auth -> exit 1 com mensagem, sem vazar a senha", async () => {
  const { deps, c } = montar({
    stdin: "NovaSenha123",
    atualizarSenha: () => Promise.reject(new Error("o Auth recusou a nova senha: weak_password")),
  });
  igual(await executar(["reset-password", "--email", "admin@example.com"], deps), 1, "exit");
  igual(c.erro.includes("weak_password"), true, "mensagem do Auth em stderr");
  igual(c.erro.includes("NovaSenha123"), false, "senha fora do stderr");
});

Deno.test("recovery-link: imprime a URL com token_hash e type=recovery, sem barra dupla", async () => {
  const { deps, c } = montar();
  igual(await executar(["recovery-link", "--email", "admin@example.com"], deps), 0, "exit");
  igual(c.saida, `https://echo.example.com/auth?token_hash=${"a".repeat(56)}&type=recovery\n`, "URL");
  igual(c.hashes, ["admin@example.com"], "hash pedido para o e-mail");
});

Deno.test("recovery-link: usuário inexistente -> 3; sem SITE_URL -> 1; sem --email -> 2", async () => {
  const a = montar();
  igual(await executar(["recovery-link", "--email", "ninguem@example.com"], a.deps), 3, "inexistente");
  igual(a.c.hashes, [], "não gera hash para quem não existe");
  const b = montar({ env: {} });
  igual(await executar(["recovery-link", "--email", "admin@example.com"], b.deps), 1, "sem SITE_URL");
  const c = montar();
  igual(await executar(["recovery-link"], c.deps), 2, "sem --email");
});

Deno.test("setup-status: espelha o GET da edge (token vazio = false sem consultar o banco)", async () => {
  const semToken = montar({ env: { ECHO_SETUP_TOKEN: "  " } });
  igual(await executar(["setup-status"], semToken.deps), 0, "exit");
  igual(semToken.c.saida, '{"precisa_setup":false}\n', "token vazio");
  igual(semToken.c.precisaSetup, 0, "não consultou o banco");

  const comToken = montar();
  igual(await executar(["setup-status"], comToken.deps), 0, "exit");
  igual(comToken.c.saida, '{"precisa_setup":true}\n', "token e banco vazio");

  const jaConfigurado = montar({ precisaSetup: () => Promise.resolve(false) });
  await executar(["setup-status"], jaConfigurado.deps);
  igual(jaConfigurado.c.saida, '{"precisa_setup":false}\n', "banco já configurado");
});

Deno.test("subcomando desconhecido ou ausente -> exit 2 com o uso", async () => {
  for (const argv of [[], ["nao-existe"], ["setup-status", "--x"]]) {
    const { deps, c } = montar();
    igual(await executar(argv, deps), 2, JSON.stringify(argv));
    igual(c.saida, "", "nada em stdout");
  }
});

Deno.test("lerEmail e validarSenha", () => {
  igual(lerEmail(["--email", " A@B.CO "]), "a@b.co", "normaliza");
  igual(validarSenha("ççççççç").length, 7, "7 caracteres de 2 bytes = 14 bytes passa (limite é em bytes)");
});
