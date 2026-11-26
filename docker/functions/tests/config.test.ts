import { lerConfigRuntime } from "../config.ts";
import { igual, SEGREDO } from "./helpers.ts";

function lanca(fn: () => unknown, trecho: string, msg: string) {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes(trecho)) throw new Error(`${msg}: mensagem sem "${trecho}": ${e}`);
    return;
  }
  throw new Error(`${msg}: não lançou`);
}

Deno.test("config: padrões do container", () => {
  igual(
    lerConfigRuntime({ JWT_SECRET: SEGREDO }),
    {
      jwtSecret: SEGREDO,
      porta: 9000,
      bind: "0.0.0.0",
      functionsDir: "/app/functions",
      mapaPath: "/app/verify_jwt.json",
      timeoutMs: 150000,
    },
    "padrões",
  );
});

Deno.test("config: variável vazia (compose ${VAR:-}) vale como ausente", () => {
  const c = lerConfigRuntime({ JWT_SECRET: SEGREDO, PORT: "", FN_REQUEST_TIMEOUT_MS: "  ", FUNCTIONS_DIR: "" });
  igual([c.porta, c.timeoutMs, c.functionsDir], [9000, 150000, "/app/functions"], "vazios");
});

Deno.test("config: valores informados", () => {
  const c = lerConfigRuntime({ JWT_SECRET: SEGREDO, PORT: "0", BIND: "127.0.0.1", FN_REQUEST_TIMEOUT_MS: "50" });
  igual([c.porta, c.bind, c.timeoutMs], [0, "127.0.0.1", 50], "informados");
});

Deno.test("config: JWT_SECRET ausente ou curto derruba a subida", () => {
  lanca(() => lerConfigRuntime({}), "JWT_SECRET", "ausente");
  lanca(() => lerConfigRuntime({ JWT_SECRET: "curto" }), "JWT_SECRET", "curto");
});

Deno.test("config: número inválido derruba a subida, sem cair no padrão", () => {
  lanca(() => lerConfigRuntime({ JWT_SECRET: SEGREDO, PORT: "abc" }), "PORT", "porta texto");
  lanca(() => lerConfigRuntime({ JWT_SECRET: SEGREDO, PORT: "70000" }), "PORT", "porta alta");
  lanca(() => lerConfigRuntime({ JWT_SECRET: SEGREDO, FN_REQUEST_TIMEOUT_MS: "-1" }), "FN_REQUEST_TIMEOUT_MS", "timeout");
});
