import { supabase } from "@/integrations/supabase/client";
import { qrServiceUrl } from "@/lib/runtimeConfig";

async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  // Aba ociosa/suspensa pode atrasar o auto-refresh (agravado pelo lock
  // desabilitado no client) e o getSession devolver um access token vencido,
  // que o qr-service rejeita com "Invalid token". Refresh proativo com margem
  // de 60s antes de enviar.
  const expiresInMs = (session.expires_at ?? 0) * 1000 - Date.now();
  if (expiresInMs < 60_000) {
    const { data: { session: refreshed } } = await supabase.auth.refreshSession();
    return refreshed?.access_token ?? session.access_token;
  }
  return session.access_token;
}

// O qr-service exige Bearer (JWT da sessão Supabase) em /session, /message,
// /groups e /profile.
export async function qrFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${qrServiceUrl()}${path}`, { ...init, headers });
}

// EventSource não envia headers — o token vai na query string do SSE.
export async function qrEventSourceUrl(path: string): Promise<string> {
  const token = await getAccessToken();
  const base = qrServiceUrl();
  if (!token) return `${base}${path}`;
  const separator = path.includes("?") ? "&" : "?";
  return `${base}${path}${separator}access_token=${encodeURIComponent(token)}`;
}
