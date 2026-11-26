import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { chavesDoEnv, lerEnv } from "../docker/tools/gen-keys.mjs";

const RAIZ = resolve(import.meta.dirname, "..");

/**
 * Variáveis que o compose usa e que NÃO ficam no .env (3.2): a versão e o commit são exportados pelo
 * ./install.sh e pelo ./echo antes de toda chamada ao compose, e valem só como argumento de build.
 */
const EXPORTADAS = ["ECHO_VERSION", "GIT_SHA"];

function arquivosDoCompose() {
  const lista = [join(RAIZ, "docker-compose.yml")];
  const pasta = join(RAIZ, "docker/compose");
  if (existsSync(pasta)) {
    for (const nome of readdirSync(pasta).sort()) {
      if (/\.ya?ml$/.test(nome)) lista.push(join(pasta, nome));
    }
  }
  return lista.filter((f) => existsSync(f));
}

/** Nomes usados como `${NOME` (com `:-`, `:?` ou `}`) e `$NOME` simples; `$$` é escape do compose e não conta. */
function variaveisUsadas(bruto) {
  // Comentário YAML (`#` no começo ou depois de espaço) não é uso: os cabeçalhos citam `${VAR:?…}` como exemplo.
  const texto = bruto.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
  const nomes = new Set();
  for (const m of texto.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) nomes.add(m[1]);
  for (const m of texto.matchAll(/(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)/g)) nomes.add(m[1]);
  return nomes;
}

const exemplo = lerEnv(readFileSync(join(RAIZ, ".env.example"), "utf8"));
const temCompose = existsSync(join(RAIZ, "docker-compose.yml"));

describe(".env.example x gen-keys", () => {
  it("tem exatamente as chaves que o gen-keys emite, na mesma ordem", () => {
    expect([...exemplo.keys()]).toEqual(chavesDoEnv());
  });

  it("não tem chave repetida", () => {
    const linhas = readFileSync(join(RAIZ, ".env.example"), "utf8")
      .split("\n")
      .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1])
      .filter(Boolean);
    expect(new Set(linhas).size).toBe(linhas.length);
  });
});

describe.skipIf(!temCompose)("compose x .env.example", () => {
  const arquivos = arquivosDoCompose();

  it("o docker-compose.yml e os complementos por modo existem", () => {
    expect(arquivos.map((f) => f.slice(RAIZ.length + 1))).toEqual(
      expect.arrayContaining(["docker-compose.yml", "docker/compose/dominio.yml", "docker/compose/proxy-rede.yml"]),
    );
  });

  it("toda variável ${VAR} do compose está no .env.example ou na lista de exportadas", () => {
    const desconhecidas = [];
    for (const arquivo of arquivos) {
      for (const nome of variaveisUsadas(readFileSync(arquivo, "utf8"))) {
        if (!exemplo.has(nome) && !EXPORTADAS.includes(nome)) desconhecidas.push(`${arquivo.slice(RAIZ.length + 1)}: ${nome}`);
      }
    }
    expect(desconhecidas).toEqual([]);
  });

  it("toda chave do .env.example é usada por algum arquivo do compose (senão o instalador gera o que o stack ignora)", () => {
    const usadas = new Set();
    for (const arquivo of arquivos) for (const n of variaveisUsadas(readFileSync(arquivo, "utf8"))) usadas.add(n);
    // COMPOSE_PROJECT_NAME e COMPOSE_FILE são lidos pelo próprio Compose, não por ${VAR} nos arquivos.
    const orfas = [...exemplo.keys()].filter((k) => !usadas.has(k) && k !== "COMPOSE_FILE");
    expect(orfas).toEqual([]);
  });
});

describe("gitignore", () => {
  const gitDisponivel = existsSync(join(RAIZ, ".git"));

  it.skipIf(!gitDisponivel).each([".env.development.example", ".env.example", "docker/functions/deno.lock"])(
    "%s NÃO é ignorado (precisa entrar no git)",
    (arquivo) => {
      // `git check-ignore -q` sai 0 se ignorado, 1 se não. (Com mais de um caminho o -q é recusado: um por vez.)
      const r = spawnSync("git", ["check-ignore", "-q", "--no-index", arquivo], { cwd: RAIZ });
      expect(r.status).toBe(1);
    },
  );

  it.skipIf(!gitDisponivel).each([".env", ".env.bak.20260101000000", "docker-compose.override.yml", "backups/echo-x/db-data.tar", "deno.lock"])(
    "%s é ignorado (segredo ou arquivo do usuário)",
    (arquivo) => {
      const r = spawnSync("git", ["check-ignore", "-q", "--no-index", arquivo], { cwd: RAIZ });
      expect(r.status).toBe(0);
    },
  );
});
