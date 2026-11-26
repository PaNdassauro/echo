// Configuração do roteador, lida do ambiente uma vez (main.ts). Variável vazia (o compose passa `${VAR:-}`) vale
// como ausente. Valor inválido derruba a subida com a lista das variáveis erradas, nunca roda com um padrão no lugar.
import { z } from "https://esm.sh/zod@3.23.8";

const Inteiro = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const EnvSchema = z.object({
  JWT_SECRET: z.string().min(32, "ausente ou com menos de 32 caracteres"),
  PORT: Inteiro(0, 65535).default(9000),
  BIND: z.string().min(1).default("0.0.0.0"),
  FUNCTIONS_DIR: z.string().min(1).default("/app/functions"),
  VERIFY_JWT_MAP: z.string().min(1).default("/app/verify_jwt.json"),
  FN_REQUEST_TIMEOUT_MS: Inteiro(1, 3_600_000).default(150_000),
});

export interface ConfigRuntime {
  jwtSecret: string;
  porta: number;
  bind: string;
  functionsDir: string;
  mapaPath: string;
  timeoutMs: number;
}

export function lerConfigRuntime(env: Record<string, string | undefined>): ConfigRuntime {
  const normalizado: Record<string, string | undefined> = {};
  for (const chave of Object.keys(EnvSchema.shape)) {
    const valor = (env[chave] ?? "").trim();
    normalizado[chave] = valor === "" ? undefined : valor;
  }
  const lido = EnvSchema.safeParse(normalizado);
  if (!lido.success) {
    const problemas = lido.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`configuração do roteador inválida (${problemas})`);
  }
  const e = lido.data;
  return {
    jwtSecret: e.JWT_SECRET,
    porta: e.PORT,
    bind: e.BIND,
    functionsDir: e.FUNCTIONS_DIR,
    mapaPath: e.VERIFY_JWT_MAP,
    timeoutMs: e.FN_REQUEST_TIMEOUT_MS,
  };
}
