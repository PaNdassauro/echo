/**
 * Shared error handling utilities for Edge Functions
 */

/**
 * Determines the appropriate HTTP status code based on error message content.
 * This ensures errors are properly logged in Supabase dashboard.
 */
export function getErrorStatusCode(errorMessage: string): number {
  const e = (errorMessage || '').toLowerCase();

  // 400 Bad Request - Client validation errors
  if (e.includes('required') || e.includes('invalid') || e.includes('missing')) {
    return 400;
  }

  // 401 Unauthorized - Auth errors
  if (e.includes('unauthorized') || e.includes('not authenticated') || e.includes('invalid token')) {
    return 401;
  }

  // 403 Forbidden - Permission errors
  if (e.includes('permission') || e.includes('not a member') || e.includes('do not have access')) {
    return 403;
  }

  // 503 Service Unavailable - Session/connection errors (check BEFORE 'not found')
  if (
    e.includes('session') ||
    e.includes('disconnected') ||
    e.includes('not connected') ||
    e.includes('qr_service') ||
    e.includes('qr service') ||
    e.includes('not configured')
  ) {
    return 503;
  }

  // 504 Gateway Timeout
  if (e.includes('timeout') || e.includes('timed out')) {
    return 504;
  }

  // 404 Not Found - Resource not found (but NOT session errors)
  if (e.includes('not found')) {
    return 404;
  }

  // 429 Rate Limit
  if (e.includes('rate limit') || e.includes('too many')) {
    return 429;
  }

  // 502 Bad Gateway - External service/API errors
  if (
    e.includes('unreachable') ||
    (e.includes('service') && (e.includes('unavailable') || e.includes('error'))) ||
    e.includes('failed to send') ||
    e.includes('failed to create') ||
    e.includes('failed to delete') ||
    e.includes('failed to update') ||
    e.includes('failed to edit') ||
    e.includes('failed to execute') ||
    e.includes('whatsapp api') ||
    e.includes('meta api')
  ) {
    return 502;
  }

  // 500 Internal Server Error - Default for unexpected errors
  return 500;
}

/**
 * Creates a standardized error response with proper HTTP status code.
 * The response body always contains { success: false, error: "message" }
 * which the frontend can extract for user-friendly display.
 */
export function createErrorResponse(
  error: any,
  corsHeaders: Record<string, string>,
  friendlyError: (msg: string) => string
): Response {
  const rawMessage = error?.message || 'Erro desconhecido';
  const friendlyMessage = friendlyError(rawMessage);
  const statusCode = getErrorStatusCode(rawMessage);

  // Log with status code for Supabase dashboard visibility
  console.error(`[EdgeFunction] Error (HTTP ${statusCode}):`, rawMessage);

  return new Response(
    JSON.stringify({ success: false, error: friendlyMessage }),
    {
      status: statusCode,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
}
