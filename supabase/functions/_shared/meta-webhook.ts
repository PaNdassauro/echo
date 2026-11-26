/** Helpers puros do webhook da Meta (Cloud API): segredos de assinatura, valor do aviso e
 * linhas oficiais. Sem I/O, para poder ser testado sem rede. */

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** WHATSAPP_APP_SECRET aceita uma lista separada por vírgula: um segredo por app da Meta. */
export function metaAppSecrets(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Valor do aviso da Meta EXATAMENTE como o whatsapp-webhook o calcula. Uma regra só:
 * decidir a assinatura por um valor e processar outro deixaria passar corpo com 'entry'
 * sem 'value'. */
// deno-lint-ignore no-explicit-any
export function webhookValue(body: any): any {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  return object(value) ? value : body;
}

/** Rampa de instalação do WHATSAPP_APP_SECRET, separando CONFERIR de RECUSAR.
 * Cadastrar o segredo já era, sozinho, um corte instantâneo e sem volta: segredo de outro app
 * ou desatualizado = 401 em todas as linhas no mesmo segundo. Desligado, a assinatura é
 * conferida e registrada mas não recusa, então dá para confirmar `signature_valid` nas linhas
 * reais ANTES de cortar. Estado final pretendido é `true`: o handler registra quando está
 * seguro virar. */
export function signatureEnforced(): boolean {
  try {
    return Deno.env.get('WHATSAPP_APP_SECRET_ENFORCE') === 'true';
  } catch {
    return false; // Isolados de teste não têm permissão de ambiente.
  }
}

/** Lista FECHADA de linha oficial: o Echo já teve 'twilio' e "não é QR" deixaria um canal
 * não oficial entrar. */
export const OFFICIAL_CONNECTION_TYPES = ['business', 'business_api', 'official'];
