/**
 * Evidência estruturada de falha de escrita de mensagem: uma linha em
 * qr_message_log com success=false e o payload replayável em baileys_result.
 *
 * É o que o cron check-message-failure-alerts conta (banner + e-mail + push em
 * ≤60s) e o que o scripts/replay-write-failures.mjs re-POSTa. Usado por todo
 * caminho que envia/recebe mensagem: whatsapp-webhook, whatsapp-send,
 * scheduled-message-execute, automation-execute.
 *
 * media_base64 é descartado do payload — a mídia já está no Storage/URL e o
 * base64 estouraria a linha.
 *
 * Retorna false quando nem a evidência persistiu — em rotas com transporte que
 * reentrega, o caller deve devolver 5xx nesse caso.
 */
export type FailureAction =
  | 'msg_write_failed'
  | 'msg_write_degraded'
  | 'msg_payload_invalid'
  | 'msg_handler_throw'
  // A mensagem foi salva; só o binário não veio. Deliberadamente FORA da
  // allowlist do check_message_failure_alerts: é perda parcial e recorrente
  // (~1-3% dos documentos), e contá-la como falha dura manteria o banner aceso
  // o tempo todo até o alerta virar ruído.
  | 'media_download_failed'
  // Aviso ao CRM que esgotou as repetições (aviso-unico.ts, rota 'aviso-webhook'). Fora das rotas derivadas, o
  // check_message_failure_alerts conta como falha dura a partir de 1.
  | 'webhook_dead';

export async function logWriteFailure(supabase: any, args: {
  phoneNumberDbId?: string | null;
  toJid: string;
  wamid?: string | null;
  action: FailureAction;
  error: string;
  route: string;
  payload?: unknown;
}): Promise<boolean> {
  try {
    const { media_base64: _drop, ...replayable } =
      (args.payload && typeof args.payload === 'object' ? args.payload : {}) as Record<string, unknown>;
    const { error } = await supabase.from('qr_message_log').insert({
      phone_number_id: args.phoneNumberDbId ?? null,
      to_jid: args.toJid || 'unknown',
      message_id: args.wamid ?? null,
      action: args.action,
      success: false,
      error: args.error,
      baileys_result: { route: args.route, payload: replayable },
    });
    if (error) console.error('[FailLog] evidência não persistiu:', error);
    return !error;
  } catch (err) {
    console.error('[FailLog] evidência não persistiu (throw):', err);
    return false;
  }
}
