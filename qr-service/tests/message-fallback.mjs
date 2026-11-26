/**
 * Teste de mesa dos ramos de extractUnsupportedFallback.
 *
 * Os tipos comerciais (produto/pedido/cobrança/evento) e a resposta interativa são
 * inviáveis de reproduzir à mão num aparelho — este script cobre a classificação
 * deles com fixtures do shape do proto. Roda contra o BUILD (dist/), então exige
 * `npm run build` antes.
 *
 * Uso: npm run test:message-fallback
 */
import assert from 'node:assert/strict';
import { extractUnsupportedFallback } from '../dist/adapter/proto/messageFallback.js';
import { normalizeContent } from '../dist/adapter/proto/content.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error(`       ${err.message}`);
    }
}

console.log('\nextractUnsupportedFallback\n');

// --- Resposta interativa: a mais grave de dropar (resposta de cliente) ---

test('interactiveResponseMessage usa o texto do body', () => {
    const r = extractUnsupportedFallback({
        interactiveResponseMessage: {
            body: { text: 'Quero o pacote 3' },
            nativeFlowResponseMessage: { name: 'quick_reply', paramsJson: '{"id":"pkg3"}' },
        },
    });
    assert.equal(r.kind, 'message');
    assert.equal(r.messageType, 'text');
    assert.equal(r.content, 'Quero o pacote 3');
    assert.equal(r.metadata.original_type, 'interactiveResponseMessage');
    assert.equal(r.metadata.response_name, 'quick_reply');
    assert.equal(r.metadata.params_json, '{"id":"pkg3"}');
});

test('interactiveResponseMessage sem body cai no nome do flow', () => {
    const r = extractUnsupportedFallback({
        interactiveResponseMessage: { nativeFlowResponseMessage: { name: 'form_submit' } },
    });
    assert.equal(r.content, 'form_submit');
    assert.equal(r.metadata.params_json, undefined, 'paramsJson ausente não deve virar chave');
});

test('interactiveResponseMessage vazio tem rótulo neutro', () => {
    const r = extractUnsupportedFallback({ interactiveResponseMessage: {} });
    assert.equal(r.messageType, 'text');
    assert.equal(r.content, '[Resposta interativa]');
});

// --- interactiveMessage: o Pix NATIVO do WhatsApp (caso observado) ---

// EMV de exemplo (fictício), com CRC válido, usado como payload dentro do botão de native flow.
const EMV =
    '00020101021226850014BR.GOV.BCB.PIX2563pix.example.com/qr/v2/cobv/00000000-0000-4000-8000-0000000000015204000053039865802BR5909ACME LTDA6009SAO PAULO62070503***63048963';

test('interactiveMessage: extrai chave Pix do buttonParamsJson', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: {
                buttons: [
                    { name: 'review_and_pay', buttonParamsJson: JSON.stringify({ payment_method: 'pix', pix_code: EMV }) },
                ],
            },
        },
    });
    assert.equal(r.kind, 'message');
    assert.equal(r.messageType, 'text');
    // O payload NÃO entra no content (ilegível); viaja em metadata.pix_code.
    assert.doesNotMatch(r.content, /br\.gov\.bcb\.pix/i, `content nao deve ter o EMV: ${r.content}`);
    assert.equal(r.content, 'Cobrança via Pix');
    assert.equal(r.metadata.pix_code, EMV);
    assert.deepEqual(r.metadata.native_flow_buttons, ['review_and_pay']);
});

test('interactiveMessage: acha o Pix aninhado em profundidade', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: {
                buttons: [
                    { name: 'payment_info', buttonParamsJson: JSON.stringify({ payment: { methods: [{ type: 'pix', qr: { code: EMV } }] } }) },
                ],
            },
        },
    });
    assert.equal(r.metadata.pix_code, EMV);
});

test('interactiveMessage: body próprio vira o texto; a chave fica no metadata', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            body: { text: 'Pagamento do pacote' },
            nativeFlowMessage: { buttons: [{ name: 'review_and_pay', buttonParamsJson: JSON.stringify({ pix_code: EMV }) }] },
        },
    });
    assert.equal(r.content, 'Pagamento do pacote', 'body próprio manda no texto');
    assert.doesNotMatch(r.content, /br\.gov\.bcb\.pix/i, 'payload fica fora do content');
    assert.equal(r.metadata.pix_code, EMV, 'a chave vive no metadata');
});

test('interactiveMessage: buttonParamsJson malformado ainda recupera o EMV', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: [{ name: 'x', buttonParamsJson: `{"pix_code":"${EMV}"` }].reduce((a, b) => ({ buttons: [b] }), {}),
        },
    });
    assert.equal(r.metadata.pix_code, EMV);
});

test('interactiveMessage: acha o Pix em messageParamsJson (fora dos botões)', () => {
    // Caso observado: payment_info cujos botões não traziam o EMV.
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: {
                buttons: [{ name: 'payment_info', buttonParamsJson: '{"reference_id":"abc"}' }],
                messageParamsJson: JSON.stringify({ payment_settings: [{ pix_static_code: { code: EMV } }] }),
            },
        },
    });
    assert.equal(r.metadata.pix_code, EMV);
    assert.equal(r.content, 'Cobrança via Pix');
});

test('interactiveMessage: aceita EMV com barras escapadas em JSON inválido', () => {
    const escaped = EMV.replace(/\//g, '\\/');
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: { buttons: [{ name: 'review_and_pay', buttonParamsJson: `{"code":"${escaped}"` }] },
        },
    });
    assert.equal(r.metadata.pix_code, EMV, 'as barras devem ser desescapadas');
});

test('interactiveMessage: JSON aninhado como string também é varrido', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: {
                buttons: [{ name: 'review_and_pay', buttonParamsJson: JSON.stringify({ inner: JSON.stringify({ pix: EMV }) }) }],
            },
        },
    });
    assert.equal(r.metadata.pix_code, EMV);
});

test('interactiveMessage: guarda os params crus quando o botão é de pagamento e falha', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: { buttons: [{ name: 'payment_info', buttonParamsJson: '{"reference_id":"xyz"}' }] },
        },
    });
    assert.equal(r.metadata.pix_code, undefined);
    assert.ok(r.metadata.native_flow_params_debug, 'sem os params não há como diagnosticar');
    assert.match(r.metadata.native_flow_params_debug, /reference_id/);
});

test('interactiveMessage: botão NÃO-pagamento não gera dump de diagnóstico', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: '{"url":"https://ex.com"}' }] } },
    });
    assert.equal(r.metadata.native_flow_params_debug, undefined);
});

// Formato real do payload que o WhatsApp manda (dados fictícios): não há EMV,
// só os campos da chave em pix_static_code.
const REAL_PAYMENT_INFO = JSON.stringify({
    additional_note: '',
    reference_id: 'REF0000001',
    total_amount: { value: 0, offset: 1 },
    order: {
        status: 'payment_requested',
        items: [{ amount: { offset: 1, value: 0 }, retailer_id: 'custom-item-0000000001', quantity: 0, name: '' }],
        order_type: 'ORDER_WITHOUT_AMOUNT',
        subtotal: { value: 0, offset: 1 },
    },
    type: 'physical-goods',
    payment_settings: [
        { pix_static_code: { merchant_name: 'Ana Souza', key_type: 'CPF', key: '12345678909' }, type: 'pix_static_code' },
        { cards: { enabled: false }, type: 'cards' },
    ],
    currency: 'BRL',
    referral: 'chat_attachment',
});

test('payment_info REAL: monta o EMV a partir do pix_static_code', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: { buttons: [{ name: 'payment_info', buttonParamsJson: REAL_PAYMENT_INFO }] },
        },
    });
    assert.ok(r.metadata.pix_code, 'deve montar a chave copia-e-cola');
    assert.match(r.metadata.pix_code, /^000201/, 'começa no payload format indicator');
    assert.match(r.metadata.pix_code, /BR\.GOV\.BCB\.PIX/, 'traz o GUI do Bacen');
    assert.match(r.metadata.pix_code, /12345678909/, 'traz a chave');
    assert.equal(r.metadata.pix_code_built, true, 'sinaliza que foi montado, não recebido');
    assert.equal(r.content, 'Cobrança via Pix — Ana Souza');
    // Não deve sobrar dump de diagnóstico quando a extração deu certo.
    assert.equal(r.metadata.native_flow_params_debug, undefined);
});

test('payment_info REAL: o EMV montado passa na própria validação de CRC', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: { buttons: [{ name: 'payment_info', buttonParamsJson: REAL_PAYMENT_INFO }] },
        },
    });
    const emv = r.metadata.pix_code;
    // Recalcula o CRC do jeito que o app do banco faria.
    const idx = emv.lastIndexOf('6304');
    const body = emv.slice(0, idx + 4);
    let crc = 0xffff;
    for (let i = 0; i < body.length; i++) {
        crc ^= body.charCodeAt(i) << 8;
        for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    const expected = crc.toString(16).toUpperCase().padStart(4, '0');
    assert.equal(emv.slice(idx + 4), expected, `CRC do EMV montado não fecha: ${emv}`);
});

test('payment_info REAL: mascara o CPF no metadata', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: { buttons: [{ name: 'payment_info', buttonParamsJson: REAL_PAYMENT_INFO }] },
        },
    });
    assert.equal(r.metadata.pix_key_label, 'CPF ***8909');
    assert.equal(r.metadata.pix_merchant_name, 'Ana Souza');
});

test('pix_static_code sem chave não inventa EMV', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: {
                buttons: [{ name: 'payment_info', buttonParamsJson: JSON.stringify({ payment_settings: [{ pix_static_code: { merchant_name: 'X', key: '' } }] }) }],
            },
        },
    });
    assert.equal(r.metadata.pix_code, undefined);
});

test('nome com acento não quebra o tamanho do TLV', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: {
            nativeFlowMessage: {
                buttons: [{ name: 'payment_info', buttonParamsJson: JSON.stringify({ pix_static_code: { merchant_name: 'José Antônio Coração', key_type: 'EMAIL', key: 'jose@ex.com' } }) }],
            },
        },
    });
    const emv = r.metadata.pix_code;
    // O nome entra sem acento, e o TLV declara o tamanho ASCII correto.
    assert.match(emv, /5920Jose Antonio Coracao/, `TLV do nome errado: ${emv}`);
});

test('interactiveMessage sem native flow segue no rótulo antigo', () => {
    const r = extractUnsupportedFallback({ interactiveMessage: {} });
    assert.equal(r.content, '[Mensagem interativa]');
    assert.equal(r.metadata.pix_code, undefined);
});

test('interactiveMessage sem Pix usa o nome do botão como texto', () => {
    const r = extractUnsupportedFallback({
        interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: '{"url":"https://ex.com"}' }] } },
    });
    assert.equal(r.content, 'cta_url');
    assert.deepEqual(r.metadata.native_flow_buttons, ['cta_url']);
});

// --- Evento ---

test('eventMessage traz nome, descrição e converte Long', () => {
    const r = extractUnsupportedFallback({
        eventMessage: {
            name: 'Lançamento Acme',
            description: 'Traje social',
            startTime: 1789000000,
            endTime: 1789020000,
            joinLink: 'https://ex.com/rsvp',
        },
    });
    assert.equal(r.content, '[Evento: Lançamento Acme] Traje social');
    assert.equal(r.metadata.original_type, 'eventMessage');
    assert.equal(r.metadata.event_start, 1789000000);
    assert.equal(r.metadata.event_end, 1789020000);
    assert.equal(r.metadata.join_link, 'https://ex.com/rsvp');
    assert.equal(r.metadata.is_canceled, false);
});

test('eventMessage cancelado muda o rótulo', () => {
    const r = extractUnsupportedFallback({ eventMessage: { name: 'Ensaio', isCanceled: true } });
    assert.equal(r.content, '[Evento cancelado: Ensaio]');
    assert.equal(r.metadata.is_canceled, true);
});

test('eventMessage só grava location com lat/lng finitos', () => {
    const withLoc = extractUnsupportedFallback({
        eventMessage: { name: 'X', location: { degreesLatitude: -23.5, degreesLongitude: -46.6, name: 'Salão' } },
    });
    assert.deepEqual(withLoc.metadata.location, { lat: -23.5, lng: -46.6, name: 'Salão', address: null });

    const noLoc = extractUnsupportedFallback({ eventMessage: { name: 'X', location: {} } });
    assert.equal(noLoc.metadata.location, undefined);
});

// --- Produto / pedido ---

test('productMessage prefere o título do snapshot', () => {
    const r = extractUnsupportedFallback({
        productMessage: {
            product: { title: 'Álbum 30x30', productId: 'p1', retailerId: 'r1', priceAmount1000: 250000, currencyCode: 'BRL' },
            body: 'ignorado quando há título',
            businessOwnerJid: '55119@s.whatsapp.net',
        },
    });
    assert.equal(r.content, 'Álbum 30x30');
    assert.equal(r.metadata.original_type, 'productMessage');
    assert.equal(r.metadata.price_amount_1000, 250000);
    assert.equal(r.metadata.currency_code, 'BRL');
    assert.equal(r.metadata.business_owner_jid, '55119@s.whatsapp.net');
});

test('productMessage sem snapshot cai no body e no rótulo', () => {
    assert.equal(extractUnsupportedFallback({ productMessage: { body: 'Veja isto' } }).content, 'Veja isto');
    assert.equal(extractUnsupportedFallback({ productMessage: {} }).content, '[Produto]');
});

test('orderMessage traz título, contagem e total', () => {
    const r = extractUnsupportedFallback({
        orderMessage: { orderTitle: 'Pedido #42', itemCount: 3, totalAmount1000: 99900, totalCurrencyCode: 'BRL', orderId: 'o42' },
    });
    assert.equal(r.content, 'Pedido #42');
    assert.equal(r.metadata.order_id, 'o42');
    assert.equal(r.metadata.item_count, 3);
    assert.equal(r.metadata.total_amount_1000, 99900);
});

test('orderMessage sem título cai na mensagem, depois no rótulo', () => {
    assert.equal(extractUnsupportedFallback({ orderMessage: { message: 'Confira' } }).content, 'Confira');
    assert.equal(extractUnsupportedFallback({ orderMessage: {} }).content, '[Pedido]');
});

// --- Pagamento: 3 chaves com conteúdo, 2 no skip ---

test('requestPaymentMessage formata valor (amount1000 = valor x 1000)', () => {
    const r = extractUnsupportedFallback({
        requestPaymentMessage: {
            amount1000: 150000,
            currencyCodeIso4217: 'BRL',
            requestFrom: '5511@s.whatsapp.net',
            noteMessage: { conversation: 'Sinal do evento' },
        },
    });
    assert.equal(r.content, '[Cobrança: 150.00 BRL] Sinal do evento');
    assert.equal(r.metadata.amount_1000, 150000);
    assert.equal(r.metadata.request_from, '5511@s.whatsapp.net');
});

test('requestPaymentMessage sem valor não mente sobre o total', () => {
    const r = extractUnsupportedFallback({ requestPaymentMessage: {} });
    assert.equal(r.content, '[Cobrança: valor não informado]');
});

test('noteMessage também é lido de extendedTextMessage', () => {
    const r = extractUnsupportedFallback({
        sendPaymentMessage: { noteMessage: { extendedTextMessage: { text: 'Pago via pix' } } },
    });
    assert.equal(r.content, '[Pagamento enviado] Pago via pix');
    assert.equal(r.metadata.original_type, 'sendPaymentMessage');
});

test('paymentInviteMessage persiste serviceType', () => {
    const r = extractUnsupportedFallback({ paymentInviteMessage: { serviceType: 3, expiryTimestamp: 1789000000 } });
    assert.equal(r.content, '[Convite de pagamento]');
    assert.equal(r.metadata.service_type, 3);
    assert.equal(r.metadata.expiry_timestamp, 1789000000);
});

test('decline/cancel de cobrança são skip deliberado', () => {
    assert.equal(extractUnsupportedFallback({ declinePaymentRequestMessage: { key: {} } }).kind, 'skip');
    assert.equal(extractUnsupportedFallback({ cancelPaymentRequestMessage: { key: {} } }).kind, 'skip');
});

// --- Typo do call log ---

test('callLogMessage (grafia correta) agora é skip', () => {
    const r = extractUnsupportedFallback({ callLogMessage: { callOutcome: 1 } });
    assert.equal(r.kind, 'skip');
    assert.equal(r.reason, 'deliberate');
});

test('callLogMesssage (grafia com typo) segue em skip', () => {
    assert.equal(extractUnsupportedFallback({ callLogMesssage: {} }).kind, 'skip');
});

// --- Regressões: o que já funcionava não pode mudar ---

test('listResponseMessage continua text (não foi mascarado pelos ramos novos)', () => {
    const r = extractUnsupportedFallback({
        listResponseMessage: { title: 'Opção B', singleSelectReply: { selectedRowId: 'row_b' } },
    });
    assert.equal(r.messageType, 'text');
    assert.equal(r.content, 'Opção B');
    assert.equal(r.metadata.selected_row_id, 'row_b');
});

test('albumMessage continua skip de álbum', () => {
    const r = extractUnsupportedFallback({ albumMessage: { expectedImageCount: 3 } });
    assert.equal(r.kind, 'skip');
    assert.equal(r.reason, 'album');
});

test('tipo realmente desconhecido ainda vira unsupported, nunca dropa', () => {
    const r = extractUnsupportedFallback({ someBrandNewMessage: { foo: 1 } });
    assert.equal(r.kind, 'message');
    assert.equal(r.messageType, 'unsupported');
    assert.equal(r.content, '[Mensagem não suportada]');
    assert.ok(r.metadata.original_type, 'original_type deve ser preservado para auditoria');
});

test('conteúdo nulo vira unsupported sem estourar', () => {
    assert.equal(extractUnsupportedFallback(null).messageType, 'unsupported');
    assert.equal(extractUnsupportedFallback(undefined).messageType, 'unsupported');
});

// --- Stanza só de protocolo: nada para desenhar (era bolha fantasma no CRM) ---

console.log('\nnormalizeContent: stanza sem conteúdo\n');

const GROUP = '123@g.us';

test('senderKeyDistributionMessage + messageContextInfo dá skip de protocolo', () => {
    const c = normalizeContent({
        senderKeyDistributionMessage: { groupId: GROUP, axolotlSenderKeyDistributionMessage: 'x' },
        messageContextInfo: { deviceListMetadataVersion: 2 },
    }, GROUP);
    assert.equal(c.type, 'unsupported');
    assert.equal(c.skip, 'protocol', 'o aparelho não mostra nada: não pode virar mensagem');
});

test('fastRatchetKeySenderKeyDistributionMessage também é protocolo', () => {
    const c = normalizeContent({
        fastRatchetKeySenderKeyDistributionMessage: { groupId: GROUP },
        messageContextInfo: {},
    }, GROUP);
    assert.equal(c.skip, 'protocol');
});

test('messageContextInfo sozinho dá skip de protocolo', () => {
    assert.equal(normalizeContent({ messageContextInfo: { deviceListMetadata: {} } }, GROUP).skip, 'protocol');
});

test('oferta de chamada (`call`) não vira bolha', () => {
    assert.equal(normalizeContent({ call: { callKey: 'abc' } }, GROUP).skip, 'protocol');
});

test('corpo ao lado da chave de grupo continua sendo o corpo', () => {
    const c = normalizeContent({
        senderKeyDistributionMessage: { groupId: GROUP },
        conversation: 'oi',
        messageContextInfo: {},
    }, GROUP);
    assert.equal(c.type, 'text');
    assert.equal(c.text, 'oi');
});

test('tipo novo de verdade continua visível como unsupported', () => {
    const c = normalizeContent({ someBrandNewMessage: { foo: 1 }, messageContextInfo: {} }, GROUP);
    assert.equal(c.type, 'unsupported');
    assert.equal(c.skip, undefined, 'tipo desconhecido não pode ser silenciado');
    assert.equal(c.metadata.original_type, 'someBrandNewMessage');
});

console.log(`\n${passed} passaram, ${failed} falharam\n`);
process.exit(failed > 0 ? 1 : 0);
