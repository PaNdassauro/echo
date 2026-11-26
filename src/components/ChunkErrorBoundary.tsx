import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, reloadOnce } from "@/lib/reloadOnce";

interface ChunkErrorBoundaryProps {
  children: ReactNode;
  /** Shown while a stale-chunk reload is in flight. */
  fallback: ReactNode;
}

interface ChunkErrorBoundaryState {
  /** "chunk" → recoverable via reload; "fatal" → non-recoverable. */
  error: "chunk" | "fatal" | null;
}

/**
 * Catches failed lazy-route loads that reach React (a rejected dynamic import
 * that slipped past the `vite:preloadError` handler in main.tsx) and recovers
 * with a single guarded reload instead of showing a white screen.
 *
 * - Chunk-load errors → trigger `reloadOnce()` and render `fallback` (a spinner)
 *   while the reload happens. If the guard suppresses the reload (e.g. offline),
 *   the fallback stays up rather than a dead screen or a render loop — we render
 *   `fallback`, never the children that just threw.
 * - Any other error → render a minimal "algo deu errado" message.
 */
export class ChunkErrorBoundary extends Component<
  ChunkErrorBoundaryProps,
  ChunkErrorBoundaryState
> {
  state: ChunkErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ChunkErrorBoundaryState {
    return { error: isChunkLoadError(error) ? "chunk" : "fatal" };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isChunkLoadError(error)) {
      if (reloadOnce()) return;
      // Guarda suprimiu o reload (segunda falha dentro da janela, típico de
      // deploy em propagação). Antes ficava no spinner do fallback para
      // sempre — sem tela, sem erro, sem saída. Mostra a ação de recarregar.
      console.error("[ChunkErrorBoundary] chunk falhou e o reload foi suprimido:", error);
      this.setState({ error: "fatal" });
      return;
    }
    console.error("[ChunkErrorBoundary] Uncaught error:", error, info);
  }

  render(): ReactNode {
    if (this.state.error === "chunk") {
      return this.props.fallback;
    }

    if (this.state.error === "fatal") {
      return (
        <div className="min-h-dvh flex flex-col items-center justify-center gap-4 bg-background px-6 text-center">
          <p className="text-sm text-muted-foreground">
            Algo deu errado ao carregar a página.
          </p>
          <button
            type="button"
            onClick={() => {
              // Limpa os caches do SW antes de recarregar: este caminho é
              // alcançado justamente quando um chunk não veio (propagação de
              // deploy ou cache do SW), e recarregar sobre o mesmo cache
              // devolveria o mesmo erro.
              void (async () => {
                try {
                  if ("caches" in window) {
                    const nomes = await caches.keys();
                    await Promise.all(nomes.map((n) => caches.delete(n)));
                  }
                } catch {
                  // cache indisponível (modo privado, permissão) — recarrega igual
                }
                window.location.reload();
              })();
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Recarregar
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
