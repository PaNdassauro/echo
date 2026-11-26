/**
 * Authorization headers for server-to-server calls from edge functions to the
 * QR/Baileys service.
 *
 * The QR service's requireAuth requires a bearer token and requirePhoneAccess
 * enforces org ownership; presenting the service-role key both authenticates the
 * call and bypasses the per-tenant ownership check (trusted internal caller).
 * Every edge -> QR fetch MUST use these headers, or the request is rejected 401.
 *
 * Pass any extra headers (e.g. Content-Type) via `extra`. Omit Content-Type when
 * sending FormData so the runtime can set the multipart boundary itself.
 */
export function qrAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}` };
}
