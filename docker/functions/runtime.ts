// Sobe o runtime: lê a configuração, carrega as funções e abre a porta. Separado do main.ts para os testes
// subirem um runtime de verdade (com FUNCTIONS_DIR de fixtures) sem processo filho.
import { criarVerificador, lerMapa } from "./common.ts";
import { lerConfigRuntime } from "./config.ts";
import { carregarFuncoes, criarDespachante, instalarGlobais, pendentesDeWaitUntil } from "./router.ts";

export interface Runtime {
  servidor: Deno.HttpServer;
  porta: number;
  carregadas: number;
  total: number;
  falhas: Record<string, string>;
}

export async function iniciarRuntime(
  env: Record<string, string | undefined>,
  opcoes: { globais?: boolean } = {},
): Promise<Runtime> {
  const t0 = performance.now();
  const cfg = lerConfigRuntime(env);
  const mapa = lerMapa(cfg.mapaPath);
  const verificar = criarVerificador(cfg.jwtSecret);
  // As funções rodam neste processo: o JWT_SECRET sai do ambiente antes de importar qualquer uma.
  Deno.env.delete("JWT_SECRET");
  if (opcoes.globais ?? true) instalarGlobais();

  const { handlers, falhas, nomes } = await carregarFuncoes({
    dir: cfg.functionsDir,
    nomes: Object.keys(mapa),
    aoCarregar: (nome, ms) => {
      if (ms > 200) console.log(`[router] ${nome} carregou em ${ms}ms`);
    },
  });
  const carregadas = handlers.size;
  console.log(
    `[router] ${carregadas}/${nomes.length} funções carregadas em ${Math.round(performance.now() - t0)}ms` +
      (Object.keys(falhas).length ? `; FALHAS: ${JSON.stringify(falhas)}` : ""),
  );

  const despachante = criarDespachante({
    handlers,
    falhas,
    mapa,
    verificar,
    timeoutMs: cfg.timeoutMs,
    pendentesWaitUntil: pendentesDeWaitUntil,
  });
  const servidor = Deno.serve(
    {
      port: cfg.porta,
      hostname: cfg.bind,
      onListen: (addr) => console.log(`[router] ouvindo em :${addr.port}`),
    },
    despachante,
  );
  return { servidor, porta: servidor.addr.port, carregadas, total: nomes.length, falhas };
}
