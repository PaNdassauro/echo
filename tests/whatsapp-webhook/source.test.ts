// O whatsapp-webhook sobe o servidor ao ser importado; estas checagens leem o código publicado.
const source = await Deno.readTextFile(
  new URL(
    "../../supabase/functions/whatsapp-webhook/index.ts",
    import.meta.url,
  ),
);
function assert(v: unknown, m: string) {
  if (!v) throw new Error(m);
}

Deno.test("Meta webhook body is never logged whole", () => {
  assert(
    !source.includes("JSON.stringify(body, null, 2)"),
    "full body log is back",
  );
  assert(!/console\.log\([^)]*nfmReply/.test(source), "Flow reply logged");
  assert(
    (source.match(/nfm_reply' \? '\[Flow Response omitted\]'/g) ?? [])
      .length === 2,
    "Flow response content must stay out of the message logs",
  );
});

Deno.test("assinatura da Meta: segredo cadastrado + enforce recusa; sem isso só registra", () => {
  assert(
    source.includes("metaAppSecrets(Deno.env.get('WHATSAPP_APP_SECRET'))"),
    "secret list not used",
  );
  assert(
    source.includes("if (appSecrets.length > 0 && signatureEnforced()) {"),
    "a recusa deixou de depender de segredo cadastrado + enforce",
  );
});

Deno.test("uma regra só de valor: o handler processa o webhookValue e registra signature_valid", () => {
  assert(source.includes("const value = webhookValue(body);"), "handler não usa a regra compartilhada");
  assert(
    !/value = body\.entry\[0\]\.changes\[0\]\.value/.test(source),
    "segunda derivação de valor voltou",
  );
  assert(
    source.includes("signature_valid: metaSignatureValid"),
    "resumo do aviso não diz se a assinatura conferiu",
  );
});

Deno.test("rotas /qr-*: sem QR_WEBHOOK_SECRET a resposta é 503, nunca aberta", () => {
  const bloco = source.slice(
    source.indexOf("if (url.pathname.includes('/qr-')) {"),
    source.indexOf("if (url.pathname.endsWith('/qr-reaction'))"),
  );
  assert(bloco.includes("if (!qrSecret) {"), "ausência do segredo deixou de ser tratada primeiro");
  assert(bloco.includes("status: 503"), "sem segredo a rota deixou de responder 503");
  assert(!bloco.includes("DISABLED"), "o modo aberto voltou");
});

Deno.test("reenvio do nono dígito marca o failed antes de inserir a mensagem nova", () => {
  const block = source.slice(
    source.indexOf("[Fallback] Resent successfully"),
    source.indexOf("// Skip standard update below"),
  );
  assert(block.length > 0, "bloco do reenvio não encontrado");
  const failedAt = block.indexOf("status: 'failed'");
  const sentAt = block.indexOf("emitMessageSent");
  assert(failedAt >= 0, "o reenvio não marca mais o original como failed");
  assert(sentAt >= 0, "o reenvio não emite mais o evento da mensagem nova");
  assert(
    failedAt < sentAt,
    "o 'sent' do reenvio sai antes do 'failed' do original",
  );
});
