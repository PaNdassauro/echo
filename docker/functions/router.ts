// Roteador de processo único das edge functions do Echo auto-hospedado (Deno puro).
//
// Cada supabase/functions/<nome>/index.ts chama Deno.serve(handler) no topo. `carregarFuncoes` troca o Deno.serve
// por um registrador ANTES de importar cada função (import dinâmico, uma por vez), então cada import guarda o
// handler em vez de abrir uma porta. `criarDespachante` devolve o handler do servidor real, que despacha
// /<nome>/... para o handler da função: verify_jwt por função, 504 por tempo de parede, corpo drenado.
// O `serve` do deno.land/std@0.168.0 (2 funções) é remapeado no deno.json para shim/std_server.ts.
//
// Limites do processo único (SPEC 3.7): as funções dividem módulos, ambiente e event loop. A CPU de uma atrasa as
// outras; o CI (tests/processo-unico) barra estado de módulo compartilhado no código das funções.
import { AsyncLocalStorage } from "node:async_hooks";
import { erro, exigeJwt, nomeDaFuncao, type VerifyMap } from "./common.ts";
import { definirRegistrador, type Handler } from "./shim/std_server.ts";

export type { Handler };

/** Nome da função em execução; segue awaits, timers e waitUntil. Usado só para prefixar os logs. */
export const contexto = new AsyncLocalStorage<string>();

export interface ResultadoCarga {
  handlers: Map<string, Handler>;
  /** nome -> primeiras linhas do erro de carga. Vazio = tudo carregou. */
  falhas: Record<string, string>;
  nomes: string[];
}

function servidorFalso(porta: number): Deno.HttpServer {
  return {
    finished: Promise.resolve(),
    addr: { transport: "tcp", hostname: "0.0.0.0", port: porta },
    shutdown: () => Promise.resolve(),
    ref() {},
    unref() {},
    [Symbol.asyncDispose]: () => Promise.resolve(),
  } as unknown as Deno.HttpServer;
}

function extrairHandler(a: unknown, b: unknown): Handler | undefined {
  if (typeof a === "function") return a as Handler;
  if (typeof b === "function") return b as Handler;
  if (a !== null && typeof a === "object" && "handler" in a && typeof a.handler === "function") {
    return a.handler as Handler;
  }
  return undefined;
}

/**
 * Importa cada `<dir>/<nome>/index.ts` com o Deno.serve trocado por um registrador e devolve os handlers.
 * Recusa função que não chama Deno.serve ou que chama duas vezes. Restaura o Deno.serve original ao terminar.
 */
export async function carregarFuncoes(
  { dir, nomes, aoCarregar }: {
    dir: string;
    nomes: string[];
    /** Chamado depois de cada função (nome, ms, falha), para log. */
    aoCarregar?: (nome: string, ms: number, falha: string | null) => void;
  },
): Promise<ResultadoCarga> {
  const handlers = new Map<string, Handler>();
  const falhas: Record<string, string> = {};
  let registrando: string | null = null;

  const registrar = (a: unknown, b?: unknown): Deno.HttpServer => {
    const h = extrairHandler(a, b);
    if (!registrando) throw new Error("Deno.serve chamado fora do carregamento de uma função");
    if (!h) throw new Error(`${registrando}: Deno.serve sem handler`);
    if (handlers.has(registrando)) throw new Error(`${registrando}: Deno.serve chamado duas vezes`);
    handlers.set(registrando, h);
    return servidorFalso(0);
  };

  const serveOriginal = Deno.serve;
  Reflect.set(Deno, "serve", registrar);
  definirRegistrador((h) => registrar(h));
  try {
    for (const nome of nomes) {
      registrando = nome;
      const inicio = performance.now();
      let falha: string | null = null;
      try {
        await contexto.run(nome, () => import(`file://${dir}/${nome}/index.ts`));
        if (!handlers.has(nome)) falha = "importou, mas não chamou Deno.serve";
      } catch (e) {
        falha = String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join(" | ");
      }
      if (falha !== null) {
        falhas[nome] = falha;
        handlers.delete(nome); // função que falhou na carga não atende nem pela metade (ex.: 2ª chamada de Deno.serve)
      }
      aoCarregar?.(nome, Math.round(performance.now() - inicio), falha);
    }
  } finally {
    registrando = null;
    definirRegistrador(null);
    Reflect.set(Deno, "serve", serveOriginal);
  }
  return { handlers, falhas, nomes };
}

/** Teto do que o roteador consome de um corpo que ninguém leu; passou disso, o stream é cancelado (a conexão fecha). */
export const LIMITE_DRENAGEM_BYTES = 16 * 1024 * 1024;

/**
 * Consome o corpo que a função (ou o próprio roteador, nos retornos antecipados) deixou sem ler. Sem isso o servidor
 * do Deno fecha a conexão keep-alive e o Caddy, que a reaproveita para outro POST, devolve 502 ("server closed idle
 * connection", 3 em 1000 na prova C). Em streaming e com teto: não bufferiza o corpo inteiro no processo único.
 */
export async function drenar(req: Request, limite = LIMITE_DRENAGEM_BYTES): Promise<void> {
  const corpo = req.body;
  if (!corpo || req.bodyUsed || corpo.locked) return;
  let lidos = 0;
  try {
    for await (const parte of corpo) {
      lidos += parte.byteLength;
      if (lidos > limite) break; // o `break` cancela o stream
    }
  } catch { /* corpo já fechado pelo cliente */ }
}

export interface DepsDespachante {
  handlers: Map<string, Handler>;
  falhas: Record<string, string>;
  mapa: VerifyMap;
  /** null = JWT válido; string = motivo da recusa (vira o código do 401). */
  verificar: (req: Request) => Promise<string | null>;
  timeoutMs: number;
  /** Quantas promessas do shim de EdgeRuntime.waitUntil estão pendentes (só para o /_health). */
  pendentesWaitUntil?: () => number;
}

/** O pedido vem do próprio container (healthcheck, `docker exec`)? O gateway chega de outro IP da rede do compose. */
function ehLoopback(info: Deno.ServeHandlerInfo): boolean {
  const addr = info.remoteAddr;
  if (addr.transport !== "tcp") return false;
  const host = addr.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1" || host.startsWith("127.");
}

/**
 * O handler do servidor real: /_health e /<função>/...
 *
 * `/_health` só responde ao próprio container (loopback): o gateway repassa `/functions/v1/*` sem filtrar o
 * caminho, e o corpo do health traz as linhas de erro de carga de cada função (caminhos de arquivo, pilha).
 */
export function criarDespachante(
  { handlers, falhas, mapa, verificar, timeoutMs, pendentesWaitUntil }: DepsDespachante,
): Handler {
  let emVoo = 0;
  const carregadas = handlers.size;

  const despachar: Handler = async (req, info) => {
    const url = new URL(req.url);
    if (url.pathname === "/_health") {
      if (!ehLoopback(info)) return erro(404, "NOT_FOUND", "Requested function was not found");
      const ok = Object.keys(falhas).length === 0;
      return Response.json(
        { ok, carregadas, falhas, emVoo, waitUntil: pendentesWaitUntil?.() ?? 0 },
        { status: ok ? 200 : 503 },
      );
    }
    const nome = nomeDaFuncao(url);
    if (!nome) return erro(404, "NOT_FOUND", "Requested function was not found");
    if (Object.hasOwn(falhas, nome)) return erro(503, "BOOT_ERROR", "Function failed to start (please check logs)");
    const h = handlers.get(nome);
    if (!h) return erro(404, "NOT_FOUND", "Requested function was not found");

    if (exigeJwt(mapa, nome) && req.method !== "OPTIONS") {
      const motivo = await verificar(req);
      if (motivo) {
        console.warn(`[router] ${nome}: 401 ${motivo}`);
        return erro(401, motivo, "Invalid JWT");
      }
    }

    const inicio = performance.now();
    emVoo++;
    let relogio: ReturnType<typeof setTimeout> | undefined;
    try {
      // Paridade com o --user-worker-request-idle-timeout do edge-runtime (150 s): sem resposta até lá, 504.
      // Não há isolate para matar: a função segue em segundo plano.
      const limite = new Promise<Response>((resolve) => {
        relogio = setTimeout(() => {
          console.warn(`[router] ${nome}: sem resposta em ${timeoutMs} ms -> 504 (a função continua rodando)`);
          resolve(erro(504, "IDLE_TIMEOUT", `Request idle timeout limit (${timeoutMs / 1000}s) reached`));
        }, timeoutMs);
      });
      const resp = await Promise.race([contexto.run(nome, () => h(req, info)), limite]);
      console.log(`[router] ${req.method} ${nome} -> ${resp.status} ${Math.round(performance.now() - inicio)}ms`);
      return resp;
    } catch (e) {
      console.error(`[router] ${nome}: exceção não tratada`, e);
      return erro(500, "EDGE_FUNCTION_ERROR", "Internal Server Error");
    } finally {
      clearTimeout(relogio);
      emVoo--;
    }
  };

  // Todo retorno (401, 404, 503, 500 e a resposta da função) passa por aqui: corpo que ninguém leu derruba o keep-alive.
  return async (req, info) => {
    try {
      return await despachar(req, info);
    } finally {
      await drenar(req);
    }
  };
}

const pendentes = new Set<Promise<unknown>>();

export function pendentesDeWaitUntil(): number {
  return pendentes.size;
}

/**
 * Globais do processo (só o main.ts chama; os testes do despachante não precisam):
 *  - logs prefixados com o nome da função;
 *  - shim de EdgeRuntime.waitUntil (o processo é longo: a promessa segue sozinha, só se registra e loga erro);
 *  - promessa solta ou erro de timer de QUALQUER função não derruba o processo das outras.
 */
export function instalarGlobais(): void {
  for (const nivel of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[nivel].bind(console);
    console[nivel] = (...args: unknown[]) => {
      const fn = contexto.getStore();
      return fn ? original(`[${fn}]`, ...args) : original(...args);
    };
  }

  Reflect.set(globalThis, "EdgeRuntime", {
    waitUntil(p: Promise<unknown>) {
      const fn = contexto.getStore() ?? "?";
      const q: Promise<unknown> = Promise.resolve(p)
        .catch((e) => console.error(`[waitUntil ${fn}]`, e))
        .finally(() => pendentes.delete(q));
      pendentes.add(q);
    },
  });

  addEventListener("unhandledrejection", (ev) => {
    ev.preventDefault();
    // exit(): o evento não roda no contexto da função que errou; sem isto o log saía com o nome de outra (medido).
    contexto.exit(() => console.error("[router] unhandled rejection", ev.reason));
  });
  addEventListener("error", (ev) => {
    ev.preventDefault();
    contexto.exit(() => console.error("[router] uncaught error", ev.error));
  });
}
