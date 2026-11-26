// deno test --config docker/functions/deno.json --allow-net=127.0.0.1 --allow-env --allow-read docker/functions/tests
import { criarVerificador, exigeJwt, nomeDaFuncao, parseMapa } from "../common.ts";
import { agora, assinarJwt, igual, SEGREDO } from "./helpers.ts";

const verificar = criarVerificador(SEGREDO);
const pedido = (auth?: string) => new Request("http://x/f", { headers: auth === undefined ? {} : { authorization: auth } });

Deno.test("verificador: sem Authorization -> UNAUTHORIZED_NO_AUTH_HEADER", async () => {
  igual(await verificar(pedido()), "UNAUTHORIZED_NO_AUTH_HEADER", "sem header");
  igual(await verificar(pedido("   ")), "UNAUTHORIZED_NO_AUTH_HEADER", "header em branco");
});

Deno.test("verificador: formato inválido", async () => {
  igual(await verificar(pedido("Basic abc")), "UNAUTHORIZED_INVALID_JWT_FORMAT", "esquema errado");
  igual(await verificar(pedido("Bearer a.b")), "UNAUTHORIZED_INVALID_JWT_FORMAT", "duas partes");
  igual(await verificar(pedido("Bearer %%%.%%%.%%%")), "UNAUTHORIZED_INVALID_JWT_FORMAT", "base64 inválido");
});

Deno.test("verificador: alg diferente de HS256 é recusado (inclusive none)", async () => {
  const none = await assinarJwt({ role: "anon" }, { alg: "none" });
  igual(await verificar(pedido(`Bearer ${none}`)), "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM", "alg none");
  const hs512 = await assinarJwt({ role: "anon" }, { alg: "HS512" });
  igual(await verificar(pedido(`Bearer ${hs512}`)), "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM", "alg HS512");
});

Deno.test("verificador: assinatura forjada, vencido e nbf futuro", async () => {
  const forjado = await assinarJwt({ role: "service_role" }, { segredo: "outro-segredo-qualquer-com-mais-de-32-chars" });
  igual(await verificar(pedido(`Bearer ${forjado}`)), "UNAUTHORIZED_LEGACY_JWT", "assinado com outro segredo");
  const vencido = await assinarJwt({ role: "anon", exp: agora() - 10 });
  igual(await verificar(pedido(`Bearer ${vencido}`)), "UNAUTHORIZED_LEGACY_JWT_EXPIRED", "exp no passado");
  const futuro = await assinarJwt({ role: "anon", nbf: agora() + 3600 });
  igual(await verificar(pedido(`Bearer ${futuro}`)), "UNAUTHORIZED_LEGACY_JWT_NBF", "nbf no futuro");
});

Deno.test("verificador: JWT válido passa (anon, service_role e sem exp)", async () => {
  for (const payload of [{ role: "anon", exp: agora() + 60 }, { role: "service_role" }, { role: "authenticated", sub: "x" }]) {
    igual(await verificar(pedido(`Bearer ${await assinarJwt(payload)}`)), null, JSON.stringify(payload));
  }
  igual(await verificar(pedido(`bearer ${await assinarJwt({ role: "anon" })}`)), null, "bearer em minúsculas");
});

Deno.test("criarVerificador recusa segredo ausente ou curto", () => {
  for (const segredo of ["", "curto"]) {
    let lancou = false;
    try {
      criarVerificador(segredo);
    } catch {
      lancou = true;
    }
    igual(lancou, true, `segredo "${segredo}"`);
  }
});

Deno.test("função fora do mapa exige JWT; a do mapa segue o valor declarado", () => {
  const mapa = { aberta: false, fechada: true };
  igual(exigeJwt(mapa, "aberta"), false, "false declarado");
  igual(exigeJwt(mapa, "fechada"), true, "true declarado");
  igual(exigeJwt(mapa, "desconhecida"), true, "fora do mapa");
  igual(exigeJwt(mapa, "constructor"), true, "nome herdado de Object.prototype não conta como declarado");
});

Deno.test("parseMapa valida o JSON gerado no build", () => {
  igual(parseMapa('{"a":true,"b":false}', "t"), { a: true, b: false }, "mapa válido");
  for (const ruim of ["não é json", "[]", "null", '{"a":"sim"}', '{"a":1}']) {
    let lancou = false;
    try {
      parseMapa(ruim, "t");
    } catch {
      lancou = true;
    }
    igual(lancou, true, `recusa ${ruim}`);
  }
});

Deno.test("nomeDaFuncao: só o primeiro segmento, com nome de pasta válido", () => {
  igual(nomeDaFuncao(new URL("http://x/whatsapp-send/a/b?c=1")), "whatsapp-send", "caminho com resto");
  igual(nomeDaFuncao(new URL("http://x/")), null, "raiz");
  igual(nomeDaFuncao(new URL("http://x/.env")), null, "ponto");
  igual(nomeDaFuncao(new URL("http://x/-x")), null, "começa com hífen");
});
