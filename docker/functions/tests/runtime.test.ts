// Sobe o runtime de verdade (HTTP em 127.0.0.1, porta efêmera) com as funções de fixtures.
import { iniciarRuntime } from "../runtime.ts";
import { assinarJwt, FIXTURES, igual, SEGREDO } from "./helpers.ts";

function envDe(mapa: string): Record<string, string> {
  return {
    JWT_SECRET: SEGREDO,
    PORT: "0",
    BIND: "127.0.0.1",
    FUNCTIONS_DIR: FIXTURES,
    VERIFY_JWT_MAP: `${FIXTURES}/${mapa}`,
    FN_REQUEST_TIMEOUT_MS: "100",
  };
}

Deno.test("runtime: JWT_SECRET sai do ambiente antes da 1ª função; verify_jwt e 504 valem pela porta real", async () => {
  Deno.env.set("JWT_SECRET", SEGREDO);
  const rt = await iniciarRuntime(envDe("verify_jwt.json"), { globais: false });
  try {
    igual(Deno.env.get("JWT_SECRET"), undefined, "JWT_SECRET apagado do ambiente do processo");
    igual([rt.carregadas, rt.total, rt.falhas], [7, 7, {}], "7/7 funções carregadas");
    const base = `http://127.0.0.1:${rt.porta}`;

    const visto = await (await fetch(`${base}/env-secret`)).json();
    igual(visto, { jwtSecret: null }, "a função não enxerga o JWT_SECRET");

    const semJwt = await fetch(`${base}/ok`);
    igual(semJwt.status, 401, "ok exige JWT");
    await semJwt.body?.cancel();
    const bom = await assinarJwt({ role: "anon" });
    const comJwt = await fetch(`${base}/ok`, { headers: { authorization: `Bearer ${bom}` } });
    igual([comJwt.status, await comJwt.json()], [200, { ok: true }], "ok com JWT");

    const lento = await fetch(`${base}/lento`, { headers: { authorization: `Bearer ${bom}` } });
    igual([lento.status, (await lento.json()).code], [504, "IDLE_TIMEOUT"], "504 pela porta real");
    await new Promise((resolve) => setTimeout(resolve, 450)); // a função lenta termina em segundo plano

    const h = await fetch(`${base}/_health`);
    igual([h.status, (await h.json()).ok], [200, true], "/_health 200");
  } finally {
    await rt.servidor.shutdown();
  }
});

Deno.test("runtime: função que falha na carga deixa o /_health em 503 e aparece pelo nome", async () => {
  Deno.env.set("JWT_SECRET", SEGREDO);
  const rt = await iniciarRuntime(envDe("verify_jwt-falha.json"), { globais: false });
  try {
    igual([rt.carregadas, rt.total], [1, 4], "1/4 carregada");
    igual(Object.keys(rt.falhas).sort(), ["duas-vezes", "quebrada", "sem-serve"], "falhas por nome");
    const base = `http://127.0.0.1:${rt.porta}`;
    const h = await fetch(`${base}/_health`);
    const corpo = await h.json();
    igual(h.status, 503, "health 503");
    igual(Object.keys(corpo.falhas).sort(), ["duas-vezes", "quebrada", "sem-serve"], "nomes no corpo do health");
  } finally {
    await rt.servidor.shutdown();
  }
});

Deno.test("runtime: configuração inválida derruba a subida", async () => {
  let lancou = false;
  try {
    await iniciarRuntime({ ...envDe("verify_jwt.json"), JWT_SECRET: "curto" }, { globais: false });
  } catch {
    lancou = true;
  }
  igual(lancou, true, "JWT_SECRET curto");
});
