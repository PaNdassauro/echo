import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { FunctionsHttpError, FunctionsRelayError, FunctionsFetchError } from "@supabase/supabase-js";

/**
 * Os tamanhos de fonte próprios do tailwind.config.ts (`text-2xs`, `text-message`,
 * `text-message-xs`) precisam estar no grupo `font-size`. Sem isso o
 * tailwind-merge os lê como COR de texto, e `cn("text-message", "text-primary")`
 * apagava um dos dois (e `text-message` não substituía um `text-sm` da base).
 * Tamanho novo em `theme.extend.fontSize` entra nesta lista também.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["2xs", "message", "message-xs"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Checks Edge Function response for errors.
 * Throws if there's a Supabase error OR if data.success === false
 */
export function checkEdgeFunctionResponse<T>(
  result: { data: T | null; error: Error | null }
): T {
  // Supabase-level error (network, auth, etc)
  if (result.error) {
    throw result.error;
  }

  // Edge Function returned success: false
  const data = result.data as { success?: boolean; error?: string } | null;
  if (data && data.success === false) {
    throw new Error(data.error || 'Erro desconhecido');
  }

  return result.data as T;
}

/**
 * Async version that extracts friendly error messages from HTTP error responses.
 * Use this for edge function calls that return proper HTTP status codes.
 */
export async function checkEdgeFunctionResponseAsync<T>(
  result: { data: T | null; error: Error | null; response?: Response }
): Promise<T> {
  if (result.error) {
    // Try to extract friendly message from FunctionsHttpError response body.
    // supabase-js v2 não devolve `response` no retorno do invoke() — a Response
    // do erro vem em error.context; sem esse fallback, todo erro de função
    // degradava para o genérico "Edge Function returned a non-2xx status code".
    const errorResponse =
      result.response ??
      (result.error instanceof FunctionsHttpError && result.error.context instanceof Response
        ? result.error.context
        : undefined);
    if (result.error instanceof FunctionsHttpError && errorResponse) {
      try {
        const errorBody = await errorResponse.json();
        if (errorBody?.error) {
          throw new Error(errorBody.error);
        }
      } catch (e) {
        // If we threw our own Error above, re-throw it
        if (e instanceof Error && e.message !== result.error.message) {
          throw e;
        }
        // Otherwise fall through to default handling
      }
    }

    // FunctionsRelayError - infrastructure error
    if (result.error instanceof FunctionsRelayError) {
      throw new Error('Serviço temporariamente indisponível. Tente novamente.');
    }

    // FunctionsFetchError - network error
    if (result.error instanceof FunctionsFetchError) {
      throw new Error('Erro de conexão. Verifique sua internet.');
    }

    // Default: throw the original error
    throw result.error;
  }

  // Backward compatibility: still supports { success: false } pattern
  const data = result.data as { success?: boolean; error?: string } | null;
  if (data && data.success === false) {
    throw new Error(data.error || 'Erro desconhecido');
  }

  return result.data as T;
}
