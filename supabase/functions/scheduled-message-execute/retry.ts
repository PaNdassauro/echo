// Quais erros de envio valem outra tentativa do agendamento (texto, template e arquivo).

// Mesmo teto do c_max_attempts em reap_stuck_scheduled_messages()
// (migração da função). Os dois lados decidem se ainda
// há tentativa sobrando, então mudar um sem o outro deixa o retry inconsistente:
// o executor devolveria a linha para 'scheduled' e o reaper a mataria depois.
export const MAX_ATTEMPTS = 3;

// Erros que valem outra tentativa: o agendamento é para daqui a horas ou dias e
// perdê-lo porque a sessão QR piscou por cinco segundos é o pior desfecho
// possível. Já um template em número QR, ou credencial ausente, vai falhar
// exatamente igual nas próximas três tentativas — esses caem direto em 'failed'.
const RETRYABLE_ERROR_PATTERNS = [
  'unreachable',
  'network',
  'timeout',
  'timed out',
  'fetch failed',
  'session not connected',
  'not connected',
  'econnreset',
  'econnrefused',
  'socket',
  'invalid response',
  'temporarily',
  'rate limit',
  'too many requests',
];

export function isRetryableError(message: string): boolean {
  const lower = (message || '').toLowerCase();
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}
