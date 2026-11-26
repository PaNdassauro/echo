// Só o TIPO do proto (apagado na compilação): descreve o schema do WhatsApp, não a lib.
import type { proto } from '@whiskeysockets/baileys';
import { getContentType } from './unwrap.js';

/**
 * Última rede do pipeline de entrada: tipo de mensagem que nenhum branch trata
 * NÃO é mais descartado — degrada para algo persistível.
 *
 * Contexto: mensagens reais morriam como
 * `msg_drop_unhandled` — templateMessage, listMessage,
 * listResponseMessage (a RESPOSTA de um cliente a uma lista!), groupInviteMessage,
 * buttonsMessage, interactiveMessage. Para um CRM, dropar a resposta de um
 * cliente é o pior defeito possível. Regra:
 *
 *  - extraiu texto de verdade → messageType 'text' (renderiza natural na bolha)
 *    + metadata.original_type para auditoria;
 *  - envelope sem conteúdo próprio (albumMessage — as mídias chegam separadas;
 *    pin; call) → skip DELIBERADO, auditável com action própria;
 *  - qualquer outro shape → 'unsupported' com rótulo e o shape em metadata.
 *
 * 'unsupported' está no CHECK de messages.message_type (verificado
 * no banco); a whitelist da edge também o aceita.
 */

export type FallbackResult =
    | { kind: 'message'; messageType: string; content: string; metadata: Record<string, unknown> }
    | { kind: 'skip'; reason: 'album' | 'deliberate' };

/** Primeira string não-vazia. */
function first(...values: Array<string | null | undefined>): string | null {
    for (const v of values) {
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
}

/**
 * int64 do proto (`Long`) → number serializável. Valor monetário e timestamp do
 * WhatsApp chegam como Long e viram `{low,high,unsigned}` no JSON do webhook.
 */
function num(value: number | Long | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Nota livre que acompanha cobrança/pagamento (um IMessage aninhado). */
function noteText(note: proto.IMessage | null | undefined): string | null {
    if (!note) return null;
    return first(note.conversation, note.extendedTextMessage?.text);
}

/** Payload EMV do Pix (BR Code): começa em 000201 e traz o domínio do Bacen. */
const PIX_EMV = /000201[\s\S]*?6304[0-9A-Fa-f]{4}/;

/**
 * Procura uma chave Pix dentro dos botões de native flow de um interactiveMessage.
 *
 * O `buttonParamsJson` é JSON livre definido pelo WhatsApp (as chaves variam por
 * versão e por tipo de botão — `review_and_pay`, `payment_info`, `cta_url`…), e o
 * EMV pode estar em qualquer profundidade. Em vez de casar nomes de campo que
 * mudam sem aviso, varremos os valores string em busca do próprio payload — ele
 * é autoidentificável pelo prefixo e pelo domínio do Bacen.
 */
function extractPixFromNativeFlow(
    buttons: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton[]
): string | null {
    for (const button of buttons) {
        const json = button.buttonParamsJson;
        if (!json) continue;

        // Caminho preferido: achar a string exata dentro do JSON parseado, para
        // não arrastar escapes nem campos vizinhos. Sem curto-circuito por
        // `br.gov.bcb.pix` no texto cru: se o payload vier escapado (\/ nas
        // barras, unicode) o gate pulava o botão sem nem tentar parsear.
        try {
            const found = findPixInValue(JSON.parse(json) as unknown, 0);
            if (found) return found;
        } catch {
            // JSON malformado: o regex direto abaixo ainda recupera o payload.
        }

        // Último recurso (JSON inválido): tira os escapes de barra que o
        // WhatsApp usa em URL dentro de JSON antes de validar o payload.
        const direct = json.replace(/\\\//g, '/').match(PIX_EMV);
        if (direct && isPixPayload(direct[0])) return direct[0];
    }
    return null;
}

/**
 * CRC16/CCITT-FALSE do BR Code, calculado sobre tudo até e incluindo `6304`.
 * É o que separa um EMV de verdade de uma string que só parece um.
 */
function crc16(input: string): string {
    let crc = 0xffff;
    for (let i = 0; i < input.length; i++) {
        crc ^= input.charCodeAt(i) << 8;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Aceita o candidato como Pix se traz o domínio do Bacen OU se o CRC fecha.
 * O CRC cobre o QR de chave aleatória, que não cita o domínio — exigir só o
 * domínio deixava esse caso de fora.
 */
function isPixPayload(candidate: string): boolean {
    if (/br\.gov\.bcb\.pix/i.test(candidate)) return true;
    const crcIndex = candidate.lastIndexOf('6304');
    if (crcIndex <= 0) return false;
    const expected = crc16(candidate.slice(0, crcIndex + 4));
    return expected === candidate.slice(crcIndex + 4, crcIndex + 8).toUpperCase();
}

/** Campo TLV do BR Code: id + tamanho em 2 dígitos + valor. */
function tlv(id: string, value: string): string {
    return `${id}${value.length.toString().padStart(2, '0')}${value}`;
}

/**
 * Remove acento e caractere fora do ASCII imprimível. O BR Code é ASCII, e um
 * "ã" no nome do beneficiário viraria 2 bytes — o tamanho declarado no TLV
 * ficaria errado e o app do banco rejeitaria o código.
 */
function toAscii(input: string): string {
    return input
        .normalize('NFD')
        .replace(/[^\x20-\x7E]/g, '')
        .trim();
}

/**
 * Monta o EMV (BR Code) a partir dos campos de `pix_static_code`.
 *
 * O Pix nativo do WhatsApp NÃO transporta o payload copia-e-cola: manda os
 * campos da chave (`key`, `key_type`, `merchant_name`) e o app do destinatário
 * monta o código. Verificado num payment_info real — por isso
 * nenhuma varredura achava EMV ali.
 *
 * Estático, sem valor: campo 54 fica de fora, e quem paga digita o valor (é o
 * que o WhatsApp faz, já que o order vem como ORDER_WITHOUT_AMOUNT).
 */
function buildPixEmv(key: string, merchantName: string | null, city: string | null): string | null {
    const cleanKey = toAscii(key);
    if (!cleanKey) return null;

    // 26 = merchant account information: GUI do Bacen + a chave.
    const merchantAccount = tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', cleanKey);
    // 59/60 são obrigatórios no BR Code; o padrão limita a 25/15 chars.
    const name = (toAscii(merchantName ?? '') || 'RECEBEDOR').slice(0, 25);
    const merchantCity = (toAscii(city ?? '') || 'BRASIL').slice(0, 15);

    const payload =
        tlv('00', '01') + // payload format indicator
        tlv('26', merchantAccount) +
        tlv('52', '0000') + // merchant category code: não informado
        tlv('53', '986') + // moeda: BRL
        tlv('58', 'BR') +
        tlv('59', name) +
        tlv('60', merchantCity) +
        tlv('62', tlv('05', '***')); // txid livre

    const withCrcTag = `${payload}6304`;
    return `${withCrcTag}${crc16(withCrcTag)}`;
}

/** Formata a chave para exibição, sem expor CPF inteiro. */
function describePixKey(keyType: string | null, key: string): string {
    const type = (keyType ?? '').toUpperCase();
    if (type === 'CPF' && key.length >= 4) return `CPF ***${key.slice(-4)}`;
    if (type === 'CNPJ' && key.length >= 4) return `CNPJ ***${key.slice(-4)}`;
    return key;
}

/** Dados de um pix_static_code encontrado nos params do native flow. */
interface PixStaticCode {
    key: string;
    keyType: string | null;
    merchantName: string | null;
}

/** Procura recursivamente um objeto `pix_static_code` com chave utilizável. */
function findPixStaticCode(value: unknown, depth: number): PixStaticCode | null {
    if (depth > 8 || !value || typeof value !== 'object') return null;

    if (!Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const node = record.pix_static_code;
        if (node && typeof node === 'object') {
            const n = node as Record<string, unknown>;
            const key = typeof n.key === 'string' ? n.key.trim() : '';
            if (key) {
                return {
                    key,
                    keyType: typeof n.key_type === 'string' ? n.key_type : null,
                    merchantName: typeof n.merchant_name === 'string' ? n.merchant_name : null,
                };
            }
        }
    }

    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const child of children) {
        const found = findPixStaticCode(child, depth + 1);
        if (found) return found;
    }
    return null;
}

/** Varre os params (botões + mensagem) por um pix_static_code. */
function extractPixStaticCode(
    buttons: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton[],
    messageParamsJson: string | null | undefined
): PixStaticCode | null {
    const sources = [...buttons.map((b) => b.buttonParamsJson), messageParamsJson];
    for (const json of sources) {
        if (!json) continue;
        try {
            const found = findPixStaticCode(JSON.parse(json) as unknown, 0);
            if (found) return found;
        } catch {
            // JSON inválido: nada a extrair estruturalmente daqui.
        }
    }
    return null;
}

/** Parseia uma string JSON e varre o resultado; tolera JSON inválido. */
function findPixInJsonString(json: string | null | undefined): string | null {
    if (!json) return null;
    try {
        return findPixInValue(JSON.parse(json) as unknown, 0);
    } catch {
        return null;
    }
}

/** Varredura em profundidade limitada por strings que contenham um EMV de Pix. */
function findPixInValue(value: unknown, depth: number): string | null {
    if (depth > 6) return null;
    if (typeof value === 'string') {
        // O valor pode ser exatamente o EMV, ou JSON aninhado como string.
        const match = value.match(PIX_EMV);
        if (match && isPixPayload(match[0])) return match[0];
        // JSON serializado dentro de uma string (params aninhados): só vale
        // descer se houver sinal de EMV, senão paga parse em toda string longa.
        if (/000201/.test(value) && /[{[]/.test(value)) {
            const nested = findPixInJsonString(value);
            if (nested) return nested;
        }
        return null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findPixInValue(item, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) {
            const found = findPixInValue(item, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

export function extractUnsupportedFallback(messageContent: proto.IMessage | null | undefined): FallbackResult {
    if (!messageContent) {
        return { kind: 'message', messageType: 'unsupported', content: '[Mensagem não suportada]', metadata: {} };
    }

    // --- Skips deliberados (não são mensagens de chat) ---

    // Álbum: envelope com só expectedImageCount/VideoCount — as fotos/vídeos
    // chegam como imageMessage/videoMessage separados (verificado no Baileys
    // rc13, Utils/messages.js). Persistir o envelope duplicaria a conversa.
    if (messageContent.albumMessage) {
        return { kind: 'skip', reason: 'album' };
    }
    // Pin/chamada: viram linha de sistema quando o front souber renderizar —
    // decisão de produto, não perda. O skip é auditável (msg_skip_deliberate).
    // `callLogMesssage` (3 s's) era typo: o campo do proto é callLogMessage, então o
    // skip nunca disparava por essa chave e log de chamada virava 'unsupported'.
    // As duas grafias ficam para não regredir caso algum proto use a errada.
    const raw = messageContent as Record<string, unknown>;
    if (
        messageContent.pinInChatMessage ||
        raw.callLogMessage ||
        raw.callLogMesssage ||
        messageContent.call ||
        // Decline/cancel de cobrança carregam só uma `key` — nada exibível.
        messageContent.declinePaymentRequestMessage ||
        messageContent.cancelPaymentRequestMessage
    ) {
        return { kind: 'skip', reason: 'deliberate' };
    }
    // Avisos de protocolo que chegam sem payload de chat.
    if ((messageContent as Record<string, unknown>).messageHistoryNotice) {
        return { kind: 'skip', reason: 'deliberate' };
    }

    // --- Conteúdo interativo com texto extraível → text + original_type ---

    const tpl = messageContent.templateMessage;
    if (tpl) {
        const hydrated = tpl.hydratedTemplate ?? tpl.hydratedFourRowTemplate ?? null;
        const text = first(
            hydrated?.hydratedContentText,
            hydrated?.hydratedTitleText,
            tpl.interactiveMessageTemplate?.body?.text,
        ) ?? '[Mensagem de template]';
        const buttons = (hydrated?.hydratedButtons ?? [])
            .map((b) => first(b.quickReplyButton?.displayText, b.urlButton?.displayText, b.callButton?.displayText))
            .filter((t): t is string => !!t);
        return {
            kind: 'message',
            messageType: 'text',
            content: text,
            metadata: { original_type: 'templateMessage', ...(buttons.length ? { buttons } : {}) },
        };
    }

    const list = messageContent.listMessage;
    if (list) {
        const text = [first(list.title), first(list.description)].filter(Boolean).join('\n') || '[Lista]';
        const sections = (list.sections ?? []).map((s) => ({
            title: s.title ?? null,
            rows: (s.rows ?? []).map((r) => r.title ?? r.rowId ?? '').filter(Boolean),
        }));
        return {
            kind: 'message',
            messageType: 'text',
            content: text,
            metadata: { original_type: 'listMessage', ...(sections.length ? { sections } : {}) },
        };
    }

    const listResp = messageContent.listResponseMessage;
    if (listResp) {
        // Resposta REAL do contato a uma lista — a mais grave de dropar.
        const text = first(listResp.title, listResp.singleSelectReply?.selectedRowId) ?? '[Resposta de lista]';
        return {
            kind: 'message',
            messageType: 'text',
            content: text,
            metadata: {
                original_type: 'listResponseMessage',
                selected_row_id: listResp.singleSelectReply?.selectedRowId ?? null,
            },
        };
    }

    const btns = messageContent.buttonsMessage;
    if (btns) {
        const text = first(btns.contentText, btns.text, btns.footerText) ?? '[Mensagem com botões]';
        const buttons = (btns.buttons ?? [])
            .map((b) => first(b.buttonText?.displayText, b.buttonId))
            .filter((t): t is string => !!t);
        return {
            kind: 'message',
            messageType: 'text',
            content: text,
            metadata: { original_type: 'buttonsMessage', ...(buttons.length ? { buttons } : {}) },
        };
    }

    const btnResp = messageContent.buttonsResponseMessage;
    if (btnResp) {
        const text = first(btnResp.selectedDisplayText, btnResp.selectedButtonId) ?? '[Resposta de botão]';
        return {
            kind: 'message',
            messageType: 'text',
            content: text,
            metadata: { original_type: 'buttonsResponseMessage', selected_button_id: btnResp.selectedButtonId ?? null },
        };
    }

    const tplReply = messageContent.templateButtonReplyMessage;
    if (tplReply) {
        const text = first(tplReply.selectedDisplayText, tplReply.selectedId) ?? '[Resposta de botão]';
        return {
            kind: 'message',
            messageType: 'text',
            content: text,
            metadata: { original_type: 'templateButtonReplyMessage', selected_id: tplReply.selectedId ?? null },
        };
    }

    const interactive = messageContent.interactiveMessage;
    if (interactive) {
        // O corpo/título cobre o caso simples, mas o conteúdo de verdade costuma
        // vir nos botões de native flow: é ali que o Pix nativo do WhatsApp
        // carrega a chave copia-e-cola. Ler só body/header descartava o payload
        // e a mensagem virava um "[Mensagem interativa]" inútil no CRM
        // (reproduzido com mensagem real).
        const nativeFlow = interactive.nativeFlowMessage;
        const nativeButtons = nativeFlow?.buttons ?? [];
        const buttonNames = nativeButtons
            .map((b) => b.name)
            .filter((n): n is string => !!n);
        // A chave pode estar nos params do botão OU nos da mensagem: um
        // payment_info real chegou com os botões sem EMV, então a
        // busca cobre o interactiveMessage inteiro (params de mensagem incluídos).
        // 1) EMV pronto, se por acaso vier. 2) pix_static_code, que é o que o
        // WhatsApp REALMENTE manda: campos da chave, sem payload — montamos o
        // BR Code a partir deles (verificado com mensagem real).
        const staticCode = extractPixStaticCode(nativeButtons, nativeFlow?.messageParamsJson);
        const pixKey =
            extractPixFromNativeFlow(nativeButtons) ??
            findPixInValue(nativeFlow?.messageParamsJson, 0) ??
            findPixInJsonString(nativeFlow?.messageParamsJson) ??
            (staticCode ? buildPixEmv(staticCode.key, staticCode.merchantName, null) : null);
        // O payload NUNCA entra no content: são 150-230 caracteres ilegíveis que
        // poluiriam a bolha e o preview da conversa. Ele viaja em
        // metadata.pix_code, e o front desenha o card (copiar + QR) a partir dele.
        const text =
            first(interactive.body?.text, interactive.header?.title) ??
            (pixKey
                ? staticCode?.merchantName
                    ? `Cobrança via Pix — ${staticCode.merchantName}`
                    : 'Cobrança via Pix'
                : buttonNames[0] ?? '[Mensagem interativa]');
        // Diagnóstico: sem os params crus não há como descobrir ONDE a chave
        // mora quando a extração falha (os logs do container são inacessíveis e
        // o ingresso não registra o payload). Guardado só nesse caso, truncado,
        // e apenas quando o botão sugere pagamento — não é log de tudo.
        const looksLikePayment = buttonNames.some((n) => /pay|pix|payment|order|checkout/i.test(n));
        const debugParams =
            !pixKey && looksLikePayment
                ? nativeButtons
                      .map((b) => `${b.name ?? '?'}:${(b.buttonParamsJson ?? '').slice(0, 600)}`)
                      .join(' || ')
                      .slice(0, 1800)
                : null;
        return {
            kind: 'message',
            messageType: 'text',
            content: text,
            metadata: {
                original_type: 'interactiveMessage',
                ...(buttonNames.length ? { native_flow_buttons: buttonNames } : {}),
                ...(pixKey ? { pix_code: pixKey } : {}),
                // Chave mascarada de propósito: CPF completo no metadata seria
                // dado pessoal exposto a qualquer leitor da conversa, e o card
                // não precisa dele (o EMV já leva a chave para o pagamento).
                ...(staticCode
                    ? {
                          pix_key_label: describePixKey(staticCode.keyType, staticCode.key),
                          ...(staticCode.merchantName ? { pix_merchant_name: staticCode.merchantName } : {}),
                          pix_code_built: true,
                      }
                    : {}),
                ...(debugParams ? { native_flow_params_debug: debugParams } : {}),
            },
        };
    }

    const interactiveResp = messageContent.interactiveResponseMessage;
    if (interactiveResp) {
        // A RESPOSTA do contato a um menu interativo — mesma classe de perda do
        // listResponseMessage acima (resposta de cliente é o pior a se dropar).
        const nfr = interactiveResp.nativeFlowResponseMessage;
        const text = first(interactiveResp.body?.text, nfr?.name) ?? '[Resposta interativa]';
        return {
            kind: 'message',
            messageType: 'text',
            content: text,
            metadata: {
                original_type: 'interactiveResponseMessage',
                ...(nfr?.name ? { response_name: nfr.name } : {}),
                // paramsJson é payload do cliente: guardado cru, sem parse aqui.
                ...(nfr?.paramsJson ? { params_json: nfr.paramsJson } : {}),
            },
        };
    }

    const invite = messageContent.groupInviteMessage;
    if (invite) {
        const groupName = first(invite.groupName) ?? 'grupo';
        const caption = first(invite.caption);
        return {
            kind: 'message',
            messageType: 'text',
            content: caption ? `[Convite de grupo: ${groupName}] ${caption}` : `[Convite de grupo: ${groupName}]`,
            metadata: {
                original_type: 'groupInviteMessage',
                group_jid: invite.groupJid ?? null,
                invite_code: invite.inviteCode ?? null,
                invite_expiration: invite.inviteExpiration != null ? Number(invite.inviteExpiration) : null,
            },
        };
    }

    // --- Conteúdo comercial / agenda → text + original_type ---

    const event = messageContent.eventMessage;
    if (event) {
        const name = first(event.name) ?? 'Evento';
        const label = event.isCanceled ? `[Evento cancelado: ${name}]` : `[Evento: ${name}]`;
        const description = first(event.description);
        const loc = event.location;
        const lat = Number(loc?.degreesLatitude);
        const lng = Number(loc?.degreesLongitude);
        return {
            kind: 'message',
            messageType: 'text',
            content: description ? `${label} ${description}` : label,
            metadata: {
                original_type: 'eventMessage',
                is_canceled: event.isCanceled === true,
                event_start: num(event.startTime),
                event_end: num(event.endTime),
                ...(first(event.joinLink) ? { join_link: event.joinLink } : {}),
                ...(Number.isFinite(lat) && Number.isFinite(lng)
                    ? { location: { lat, lng, name: loc?.name ?? null, address: loc?.address ?? null } }
                    : {}),
            },
        };
    }

    const product = messageContent.productMessage;
    if (product) {
        const snapshot = product.product;
        const text = first(snapshot?.title, product.body, product.footer) ?? '[Produto]';
        return {
            kind: 'message',
            messageType: 'text',
            content: text,
            metadata: {
                original_type: 'productMessage',
                product_id: snapshot?.productId ?? null,
                retailer_id: snapshot?.retailerId ?? null,
                // priceAmount1000 = valor × 1000 (convenção do WhatsApp).
                price_amount_1000: num(snapshot?.priceAmount1000),
                currency_code: snapshot?.currencyCode ?? null,
                business_owner_jid: product.businessOwnerJid ?? null,
            },
        };
    }

    const order = messageContent.orderMessage;
    if (order) {
        const text = first(order.orderTitle, order.message) ?? '[Pedido]';
        return {
            kind: 'message',
            messageType: 'text',
            content: text,
            metadata: {
                original_type: 'orderMessage',
                order_id: order.orderId ?? null,
                item_count: order.itemCount ?? null,
                total_amount_1000: num(order.totalAmount1000),
                total_currency_code: order.totalCurrencyCode ?? null,
                seller_jid: order.sellerJid ?? null,
                status: order.status ?? null,
            },
        };
    }

    // Pagamento: o proto NÃO tem um `paymentMessage` único — são chaves distintas.
    // Decline/cancel já saíram no skip deliberado (só carregam uma `key`).
    const reqPayment = messageContent.requestPaymentMessage;
    if (reqPayment) {
        const currency = first(reqPayment.currencyCodeIso4217);
        const amount = num(reqPayment.amount1000);
        const value = amount != null ? ` ${(amount / 1000).toFixed(2)}${currency ? ` ${currency}` : ''}` : '';
        const note = noteText(reqPayment.noteMessage);
        return {
            kind: 'message',
            messageType: 'text',
            content: note ? `[Cobrança:${value || ' valor não informado'}] ${note}` : `[Cobrança:${value || ' valor não informado'}]`,
            metadata: {
                original_type: 'requestPaymentMessage',
                amount_1000: amount,
                currency_code: currency ?? null,
                request_from: reqPayment.requestFrom ?? null,
                expiry_timestamp: num(reqPayment.expiryTimestamp),
            },
        };
    }

    const sendPayment = messageContent.sendPaymentMessage;
    if (sendPayment) {
        const note = noteText(sendPayment.noteMessage);
        return {
            kind: 'message',
            messageType: 'text',
            content: note ? `[Pagamento enviado] ${note}` : '[Pagamento enviado]',
            metadata: { original_type: 'sendPaymentMessage' },
        };
    }

    const payInvite = messageContent.paymentInviteMessage;
    if (payInvite) {
        return {
            kind: 'message',
            messageType: 'text',
            content: '[Convite de pagamento]',
            metadata: {
                original_type: 'paymentInviteMessage',
                service_type: payInvite.serviceType ?? null,
                expiry_timestamp: num(payInvite.expiryTimestamp),
            },
        };
    }

    // --- Catch-all: persiste como unsupported, nunca dropa ---
    const contentType = getContentType(messageContent) ?? 'desconhecido';
    return {
        kind: 'message',
        messageType: 'unsupported',
        content: '[Mensagem não suportada]',
        metadata: { original_type: String(contentType) },
    };
}
