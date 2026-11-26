// Varredor do "processo único" das funções (docker/functions/router.ts roda as 45+ funções num mesmo processo Deno).
//
// No runtime hospedado cada função tem o próprio isolate; aqui elas dividem módulos, `globalThis` e o ambiente.
// Estado de módulo mutável, configuração global de biblioteca, escrita em `globalThis`/ambiente e `import(variável)`
// (que o `deno cache` não segue e o `--cached-only` recusa) passam a valer para todas as funções, então o CI falha
// com qualquer um deles. Escape único: comentário `// processo-unico: <motivo>` na linha anterior ao trecho
// (cache que não depende de organização nem de usuário, por exemplo).
//
// Análise pela AST do TypeScript (a mesma versão que o Deno 2.5.6 embute), não por expressão regular: o código real
// tem template literals, regex e strings com chaves.
import ts from "npm:typescript@5.9.2";

export type Regra =
  | "let-var-de-topo"
  | "estado-mutavel-de-topo"
  | "configuracao-global-de-biblioteca"
  | "escrita-em-globalthis"
  | "env-mutado"
  | "import-dinamico-nao-literal";

export interface Ocorrencia {
  arquivo: string;
  linha: number;
  regra: Regra;
  detalhe: string;
  /** true quando a linha anterior tem `// processo-unico: <motivo>`. */
  escapada: boolean;
  motivo: string | null;
}

const METODOS_QUE_MUTAM = new Set([
  "set",
  "add",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "delete",
  "clear",
  "assign",
]);

const CONSTRUTORES_DE_ESTADO = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);
const RAIZES_GLOBAIS = new Set(["globalThis", "self", "window"]);
const CONFIG_GLOBAL = /^(set[A-Z]\w*|configure\w*|config|init\w*|use|register\w*|addEventListener)$/;
const ESCAPE = /^\s*\/\/\s*processo-unico:\s*(\S.*)$/;

function ehFuncao(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessor(n) ||
    ts.isSetAccessor(n) ||
    ts.isClassStaticBlockDeclaration(n)
  );
}

function dentroDeFuncao(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) if (ehFuncao(p)) return true;
  return false;
}

function nomesDeBinding(nome: ts.BindingName, saida: Set<string>): void {
  if (ts.isIdentifier(nome)) {
    saida.add(nome.text);
    return;
  }
  for (const el of nome.elements) {
    if (ts.isBindingElement(el)) nomesDeBinding(el.name, saida);
  }
}

/** Nomes declarados dentro de `fn` (parâmetros e variáveis locais, em qualquer profundidade). */
function declaradosEm(fn: ts.Node): Set<string> {
  const nomes = new Set<string>();
  const visitar = (n: ts.Node): void => {
    if (ts.isParameter(n)) nomesDeBinding(n.name, nomes);
    if (ts.isVariableDeclaration(n)) nomesDeBinding(n.name, nomes);
    ts.forEachChild(n, visitar);
  };
  visitar(fn);
  return nomes;
}

/** O identificador `nome` usado em `n` é uma variável local que esconde a de topo? */
function sombreado(n: ts.Node, nome: string): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ehFuncao(p) && declaradosEm(p).has(nome)) return true;
  }
  return false;
}

/** Raiz de uma cadeia `a.b[c].d` (o `a`), ou null se não começa num identificador. */
function raizDaCadeia(e: ts.Expression): string | null {
  let atual: ts.Expression = e;
  for (;;) {
    if (ts.isIdentifier(atual)) return atual.text;
    if (ts.isPropertyAccessExpression(atual) || ts.isElementAccessExpression(atual)) {
      atual = atual.expression;
    } else if (ts.isParenthesizedExpression(atual) || ts.isNonNullExpression(atual)) {
      atual = atual.expression;
    } else if (ts.isAsExpression(atual)) {
      atual = atual.expression;
    } else return null;
  }
}

function textoDoCallee(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return `${textoDoCallee(e.expression)}.${e.name.text}`;
  return "?";
}

function nomeFinalDoCallee(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
}

function inicializadorDeEstado(init: ts.Expression | undefined): boolean {
  if (!init) return false;
  let e: ts.Expression = init;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) return true;
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) return CONSTRUTORES_DE_ESTADO.has(e.expression.text);
  return false;
}

const ATRIBUICOES = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function ehAtribuicao(n: ts.Node): n is ts.BinaryExpression {
  return ts.isBinaryExpression(n) && ATRIBUICOES.has(n.operatorToken.kind);
}

/** O nó muda o conteúdo de `nome`? (`nome.push(`, `nome[k] =`, `nome.campo =`, `delete nome.k`, `Object.assign(nome,`). */
function mutaNome(n: ts.Node, nome: string): boolean {
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
    const alvo = n.expression;
    if (METODOS_QUE_MUTAM.has(alvo.name.text) && raizDaCadeia(alvo.expression) === nome) {
      // `Object.assign(nome, ...)` é tratado abaixo; aqui `nome.set(...)`, `nome.a.push(...)`.
      return !(ts.isIdentifier(alvo.expression) && alvo.expression.text === "Object");
    }
    if (
      ts.isIdentifier(alvo.expression) &&
      alvo.expression.text === "Object" &&
      alvo.name.text === "assign" &&
      n.arguments.length > 0 &&
      raizDaCadeia(n.arguments[0]) === nome
    ) {
      return true;
    }
  }
  if (ehAtribuicao(n)) {
    const esq = n.left;
    if (
      (ts.isPropertyAccessExpression(esq) || ts.isElementAccessExpression(esq)) &&
      raizDaCadeia(esq) === nome
    ) {
      return true;
    }
  }
  if (ts.isDeleteExpression(n)) {
    const alvo = n.expression;
    if ((ts.isPropertyAccessExpression(alvo) || ts.isElementAccessExpression(alvo)) && raizDaCadeia(alvo) === nome) {
      return true;
    }
  }
  if (
    (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
    (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    const alvo = n.operand;
    if ((ts.isPropertyAccessExpression(alvo) || ts.isElementAccessExpression(alvo)) && raizDaCadeia(alvo) === nome) {
      return true;
    }
  }
  return false;
}

export function escanear(arquivo: string, fonte: string): Ocorrencia[] {
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const linhas = fonte.split("\n");
  const saida: Ocorrencia[] = [];

  const registrar = (n: ts.Node, regra: Regra, detalhe: string): void => {
    const linha = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const anterior = linha >= 2 ? linhas[linha - 2] : "";
    const m = ESCAPE.exec(anterior);
    saida.push({ arquivo, linha, regra, detalhe, escapada: m !== null, motivo: m ? m[1].trim() : null });
  };

  // Estado de topo candidato (const X = [] | {} | new Map/Set/...): só vira ocorrência se alguma linha o muta.
  const candidatos: { nome: string; no: ts.VariableDeclaration }[] = [];

  const visitar = (n: ts.Node): void => {
    // 1. let/var de topo (fora de função; blocos de topo contam).
    if (ts.isVariableStatement(n) && !dentroDeFuncao(n)) {
      const flags = n.declarationList.flags;
      const ehConst = (flags & ts.NodeFlags.Const) !== 0;
      const ehUsing = (flags & ts.NodeFlags.Using) !== 0;
      if (!ehConst && !ehUsing) {
        const nomes = new Set<string>();
        for (const d of n.declarationList.declarations) nomesDeBinding(d.name, nomes);
        registrar(n, "let-var-de-topo", `${(flags & ts.NodeFlags.Let) !== 0 ? "let" : "var"} ${[...nomes].join(", ")}`);
      } else if (ehConst && ts.isSourceFile(n.parent)) {
        for (const d of n.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && inicializadorDeEstado(d.initializer)) {
            candidatos.push({ nome: d.name.text, no: d });
          }
        }
      }
    }

    // 3. chamada de configuração global fora de função, como instrução solta.
    if (ts.isExpressionStatement(n) && !dentroDeFuncao(n)) {
      let e: ts.Expression = n.expression;
      while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isCallExpression(e)) {
        const final = nomeFinalDoCallee(e.expression);
        if (CONFIG_GLOBAL.test(final)) {
          registrar(n, "configuracao-global-de-biblioteca", `${textoDoCallee(e.expression)}(...) no topo do módulo`);
        }
      }
    }

    // 4. escrita em globalThis (atribuição, Reflect.set, Object.defineProperty).
    if (ehAtribuicao(n)) {
      const esq = n.left;
      if ((ts.isPropertyAccessExpression(esq) || ts.isElementAccessExpression(esq))) {
        const raiz = raizDaCadeia(esq);
        if (raiz !== null && RAIZES_GLOBAIS.has(raiz) && !sombreado(n, raiz)) {
          registrar(n, "escrita-em-globalthis", `${esq.getText(sf)} = ...`);
        }
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const callee = textoDoCallee(n.expression);
      const arg0 = n.arguments[0];
      if (
        (callee === "Reflect.set" || callee === "Object.defineProperty" || callee === "Object.assign") &&
        arg0 !== undefined &&
        ts.isIdentifier(arg0) &&
        RAIZES_GLOBAIS.has(arg0.text) &&
        !sombreado(n, arg0.text)
      ) {
        registrar(n, "escrita-em-globalthis", `${callee}(${arg0.text}, ...)`);
      }
      // 5. Deno.env.set / Deno.env.delete
      if (callee === "Deno.env.set" || callee === "Deno.env.delete") {
        registrar(n, "env-mutado", `${callee}(...)`);
      }
    }

    // 6. import(...) com argumento que não é literal.
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      const literal = arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg));
      if (!literal) registrar(n, "import-dinamico-nao-literal", `import(${arg ? arg.getText(sf) : ""})`);
    }

    ts.forEachChild(n, visitar);
  };
  visitar(sf);

  // 2. estado de topo mutado em qualquer ponto do arquivo (fora do escopo de uma variável local homônima).
  for (const { nome, no } of candidatos) {
    let mutacoes = 0;
    let primeira: ts.Node | null = null;
    const procurar = (n: ts.Node): void => {
      if (mutaNome(n, nome) && !sombreado(n, nome)) {
        mutacoes++;
        primeira ??= n;
      }
      ts.forEachChild(n, procurar);
    };
    procurar(sf);
    if (mutacoes > 0 && primeira !== null) {
      const linhaMut = sf.getLineAndCharacterOfPosition((primeira as ts.Node).getStart(sf)).line + 1;
      registrar(no, "estado-mutavel-de-topo", `const ${nome} mutado ${mutacoes}x (1ª na linha ${linhaMut})`);
    }
  }

  return saida.sort((a, b) => a.linha - b.linha);
}

/** Arquivos `.ts` de produção sob `raiz` (sem `*.test.ts`). */
export async function listarArquivos(raiz: string): Promise<string[]> {
  const achados: string[] = [];
  const andar = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const caminho = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name === ".temp") continue;
        await andar(caminho);
      } else if (e.isFile && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".test-helper.ts")) {
        achados.push(caminho);
      }
    }
  };
  await andar(raiz);
  return achados.sort();
}

export async function escanearPasta(raiz: string): Promise<Ocorrencia[]> {
  const todas: Ocorrencia[] = [];
  for (const arquivo of await listarArquivos(raiz)) {
    todas.push(...escanear(arquivo, await Deno.readTextFile(arquivo)));
  }
  return todas;
}
