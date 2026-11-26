import { listarFuncoes, lerDeclarado, montarMapa } from "../gen-verify-jwt-map.mjs";
import { igual } from "./helpers.ts";

const RAIZ = new URL("../../../", import.meta.url).pathname;

Deno.test("lerDeclarado: só [functions.<nome>] com verify_jwt, ignora comentário e outras seções", () => {
  const toml = `
# comentário
[api]
verify_jwt = false

[functions.a]
verify_jwt = false # explica

[functions."b-c"]
verify_jwt = true

[functions.sem-flag]
# nada

[auth.hook.before_user_created]
enabled = true
`;
  igual(lerDeclarado(toml), { a: false, "b-c": true }, "declarado");
});

Deno.test("montarMapa: sem entrada = true; órfã e confiança no gateway são apontadas", () => {
  const index: Record<string, string> = {
    a: "Deno.serve(() => new Response('a'));",
    b: "isInternalCaller(req, { jwtVerifiedByGateway: true });",
    c: "isInternalCaller(req, { jwtVerifiedByGateway: true });",
    d: "isInternalCaller(req, { jwtVerifiedByGateway: false });",
  };
  const lerIndex = (n: string) => index[n];

  const ok = montarMapa(["a", "b"], { a: false, b: true }, lerIndex);
  igual(ok.mapa, { a: false, b: true }, "mapa");
  igual([ok.orfas, ok.confiaNoGateway, ok.semEntrada], [[], [], []], "sem violações");

  const semEntrada = montarMapa(["a", "b"], { a: false }, lerIndex);
  igual([semEntrada.mapa.b, semEntrada.semEntrada], [true, ["b"]], "função sem entrada fecha por padrão");

  const orfa = montarMapa(["a"], { a: true, fantasma: false }, lerIndex);
  igual(orfa.orfas, ["fantasma"], "órfã");

  const confia = montarMapa(["a", "b", "c", "d"], { a: false, b: false, c: true, d: false }, lerIndex);
  igual(confia.confiaNoGateway, ["b"], "jwtVerifiedByGateway: true com verify_jwt = false");
});

Deno.test("o config.toml e as funções reais do repositório passam nas três regras", () => {
  const dir = `${RAIZ}supabase/functions`;
  const funcoes = listarFuncoes(dir);
  const declarado = lerDeclarado(Deno.readTextFileSync(`${RAIZ}supabase/config.toml`));
  const r = montarMapa(funcoes, declarado, (f) => Deno.readTextFileSync(`${dir}/${f}/index.ts`));
  igual([r.orfas, r.confiaNoGateway, r.semEntrada], [[], [], []], "violações no repositório");
  igual(funcoes.includes("primeiro-acesso"), true, "primeiro-acesso é função");
  igual(r.mapa["primeiro-acesso"], false, "primeiro-acesso é verify_jwt = false");
  igual(funcoes.includes("_shared"), false, "_shared não é função");
});
