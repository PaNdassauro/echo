import { metaAppSecrets, OFFICIAL_CONNECTION_TYPES, signatureEnforced, webhookValue } from './meta-webhook.ts';

function igual(a: unknown, b: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

Deno.test('metaAppSecrets: lista com vírgula, vazio e item único', () => {
  igual(metaAppSecrets('a, b ,,c'), ['a', 'b', 'c'], 'lista');
  igual(metaAppSecrets(undefined), [], 'undefined');
  igual(metaAppSecrets('unico'), ['unico'], 'único');
});

Deno.test('webhookValue é a regra única: entry com value devolve o value; sem entry devolve o corpo', () => {
  const value = { messages: [{ id: 'm1' }] };
  igual(webhookValue({ entry: [{ changes: [{ value }] }] }), value, 'com entry');
  const corpo = { messages: [] };
  igual(webhookValue(corpo), corpo, 'sem entry');
  const semValue = { entry: [{ changes: [{}] }] };
  igual(webhookValue(semValue), semValue, 'entry sem value');
});

Deno.test('signatureEnforced só liga com WHATSAPP_APP_SECRET_ENFORCE=true', () => {
  const antes = Deno.env.get('WHATSAPP_APP_SECRET_ENFORCE');
  try {
    Deno.env.delete('WHATSAPP_APP_SECRET_ENFORCE');
    igual(signatureEnforced(), false, 'ausente');
    Deno.env.set('WHATSAPP_APP_SECRET_ENFORCE', '1');
    igual(signatureEnforced(), false, 'valor diferente de true');
    Deno.env.set('WHATSAPP_APP_SECRET_ENFORCE', 'true');
    igual(signatureEnforced(), true, 'true');
  } finally {
    if (antes === undefined) Deno.env.delete('WHATSAPP_APP_SECRET_ENFORCE');
    else Deno.env.set('WHATSAPP_APP_SECRET_ENFORCE', antes);
  }
});

Deno.test('linhas oficiais são uma lista fechada', () => {
  igual(OFFICIAL_CONNECTION_TYPES, ['business', 'business_api', 'official'], 'lista');
});
