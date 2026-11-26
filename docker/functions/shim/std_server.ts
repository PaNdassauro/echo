// Substitui https://deno.land/std@0.168.0/http/server.ts (remapeado no deno.json) no roteador de processo único.
// O `serve` original abre a própria porta com Deno.listen + Deno.serveHttp (API removida no Deno 2); aqui ele só
// entrega o handler ao registrador do roteador, como o Deno.serve trocado em `carregarFuncoes` (router.ts).
// Este módulo é o mesmo para o roteador e para as funções (o remapeamento aponta para este arquivo), por isso o
// registrador mora aqui e não em `globalThis`.
export type Handler = (req: Request, info: Deno.ServeHandlerInfo) => Response | Promise<Response>;
export type Registrador = (handler: Handler) => unknown;

let registrador: Registrador | null = null;

/** Chamado por `carregarFuncoes` antes de cada import; `null` desliga. */
export function definirRegistrador(r: Registrador | null): void {
  registrador = r;
}

export function serve(handler: Handler, _options?: unknown): Promise<void> {
  if (!registrador) throw new Error("std/http serve fora do roteador do Echo");
  registrador(handler);
  return new Promise(() => {}); // o serve original só resolve quando o servidor fecha
}
