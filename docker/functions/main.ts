// Ponto de entrada do container `functions`: só lê o ambiente e sobe o runtime (runtime.ts).
import { iniciarRuntime } from "./runtime.ts";

await iniciarRuntime(Deno.env.toObject());
