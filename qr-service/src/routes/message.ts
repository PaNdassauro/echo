import { Router, Request, Response } from 'express';
import { sessionManager } from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { requirePhoneAccess } from '../middleware/auth.js';
import { conditionalUpload } from '../middleware/upload.js';
import { fetchMediaUrl } from '../lib/url-guard.js';

export const messageRouter = Router();

// Every message route targets a :phoneNumberId — enforce the caller's org owns it.
messageRouter.param('phoneNumberId', requirePhoneAccess);

// Helper to normalize phone number for searching
function normalizePhoneNumber(phone: string): { normalized: string; variations: string[] } {
    const digits = phone.replace(/\D/g, '');
    const variations: string[] = [digits];

    // Handle Brazilian numbers
    if (digits.startsWith('55') && digits.length >= 12) {
        const withoutCountry = digits.slice(2);
        const ddd = withoutCountry.slice(0, 2);
        const rest = withoutCountry.slice(2);

        // Add variation without country code
        variations.push(withoutCountry);

        // If has 9 digit, add without; if doesn't have, add with
        if (rest.length === 9 && rest.startsWith('9')) {
            variations.push(`55${ddd}${rest.slice(1)}`);
            variations.push(`${ddd}${rest.slice(1)}`);
        } else if (rest.length === 8) {
            variations.push(`55${ddd}9${rest}`);
            variations.push(`${ddd}9${rest}`);
        }
    }

    return { normalized: digits.startsWith('55') ? digits : `55${digits}`, variations: [...new Set(variations)] };
}

// Helper to find or create conversation
async function findOrCreateConversation(
    contactPhone: string,
    phoneNumberId: string
): Promise<{ id: string; isNew: boolean } | null> {
    // Grupo é identificado pelo JID, não por telefone. normalizePhoneNumber faz
    // replace(/\D/g,'') — comendo o "@g.us" — e ainda prefixa "55" no que sobra,
    // então um grupo virava a conversa 1:1 fantasma "55120363...": a mensagem ia
    // para o grupo certo, mas o registro nascia fora da thread, e o atendente não
    // via que a resposta automática tinha sido enviada.
    //
    // Não cria: a conversa de grupo nasce no webhook, que é quem tem o assunto do
    // grupo. Devolver null aqui só pula o save — todos os chamadores tratam isso
    // como "enviado, não gravado", que é honesto e reversível.
    if (contactPhone.endsWith('@g.us')) {
        const { data: groupConv } = await supabase
            .from('conversations')
            .select('id')
            .eq('group_jid', contactPhone)
            .eq('phone_number_id', phoneNumberId)
            .limit(1)
            .maybeSingle();

        if (groupConv) {
            return { id: groupConv.id, isNew: false };
        }
        console.error('[QR] Group conversation not found, skipping save for:', contactPhone);
        return null;
    }

    const { normalized, variations } = normalizePhoneNumber(contactPhone);

    // Try to find existing conversation
    const { data: existing } = await supabase
        .from('conversations')
        .select('id, contact_phone')
        .in('contact_phone', variations)
        .eq('phone_number_id', phoneNumberId)
        .limit(1)
        .single();

    if (existing) {
        console.log(`[QR] Found existing conversation ${existing.id}`);
        return { id: existing.id, isNew: false };
    }

    // Create new conversation
    const { data: newConv, error } = await supabase
        .from('conversations')
        .insert({
            contact_phone: normalized,
            contact_name: normalized,
            phone_number_id: phoneNumberId,
            whatsapp_id: `${normalized}_${phoneNumberId}`,
            status: 'active'
        })
        .select('id')
        .single();

    if (error) {
        console.error('[QR] Error creating conversation:', error);
        return null;
    }

    console.log(`[QR] Created new conversation ${newConv.id}`);
    return { id: newConv.id, isNew: true };
}

// Send a text message
messageRouter.post('/send/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, content, quotedMessageId, quotedContent, quotedFromMe, quotedParticipant, skipSave, mentions, isForwarded } = req.body;

    if (!to || !content) {
        res.status(400).json({ error: 'to and content are required' });
        return;
    }

    try {
        // Send via Baileys
        const result = await sessionManager.sendMessage(
            phoneNumberId,
            to,
            content,
            quotedMessageId,
            quotedContent,
            quotedFromMe,
            quotedParticipant,
            mentions, // Array of JIDs to mention
            isForwarded === 'true' || isForwarded === true
        );

        if (!result.success) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }

        // If skipSave is true, caller will handle DB save (e.g., Edge Functions)
        if (skipSave) {
            console.log('[QR] Skipping DB save (caller will handle)');
            res.json({ success: true, messageId: result.messageId });
            return;
        }

        // Find or create conversation
        const conv = await findOrCreateConversation(to, phoneNumberId);
        if (!conv) {
            // Message sent but failed to save - still return success with warning
            console.error('[QR] Message sent but failed to find/create conversation');
            res.json({ success: true, messageId: result.messageId, warning: 'Failed to save to database' });
            return;
        }

        // Save message to database
        const { data: msgData, error: msgError } = await supabase
            .from('messages')
            .insert({
                conversation_id: conv.id,
                content: content,
                direction: 'outbound',
                whatsapp_message_id: result.messageId,
                message_type: 'text',
                status: 'sent'
            })
            .select('id')
            .single();

        if (msgError) {
            console.error('[QR] Error saving message:', msgError);
            res.json({ success: true, messageId: result.messageId, warning: 'Failed to save to database' });
            return;
        }

        // Update conversation last_message_at
        await supabase
            .from('conversations')
            .update({ last_message_at: new Date().toISOString(), status: 'active' })
            .eq('id', conv.id);

        console.log(`[QR] Message saved: ${msgData.id} for conversation: ${conv.id}`);
        res.json({
            success: true,
            messageId: result.messageId,
            conversation_id: conv.id,
            message_id: msgData.id
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Send a media message (supports both file upload and URL)
messageRouter.post('/send-media/:phoneNumberId', conditionalUpload, async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, caption, quotedMessageId, quotedContent, quotedFromMe, isPtt, quotedParticipant, skipSave, media_url, mime_type, filename, isSticker, isAnimated, isForwarded, viewOnce, isGif } = req.body;
    const file = req.file;

    // Accept either file upload OR media_url
    if (!to || (!file && !media_url)) {
        res.status(400).json({
            error: 'to and (file OR media_url) are required',
            note: 'Use multipart/form-data with file, or include media_url in body'
        });
        return;
    }

    try {
        let buffer: Buffer;
        let mimeType: string;
        let originalName: string;

        if (file) {
            // File uploaded directly
            buffer = file.buffer;
            mimeType = file.mimetype;
            originalName = file.originalname;
            console.log(`[SendMedia] Sending uploaded file ${mimeType} to ${to} via ${phoneNumberId}`);
        } else {
            // Fetch from URL
            console.log(`[SendMedia] Fetching media from URL: ${media_url}`);
            try {
                // SSRF guard: reject non-http(s) and private/link-local/metadata hosts
                // (anexo do nosso Storage vai pela URL interna, sem guarda: ver fetchMediaUrl).
                const response = await fetchMediaUrl(media_url);
                if (!response.ok) {
                    res.status(400).json({ error: `Failed to fetch media from URL: ${response.status}` });
                    return;
                }
                const arrayBuffer = await response.arrayBuffer();
                buffer = Buffer.from(arrayBuffer);
                mimeType = mime_type || response.headers.get('content-type') || 'application/octet-stream';
                originalName = filename || media_url.split('/').pop()?.split('?')[0] || 'file';
                console.log(`[SendMedia] Fetched ${buffer.length} bytes, type: ${mimeType}`);
            } catch (fetchErr: any) {
                console.error('[SendMedia] Failed to fetch URL:', fetchErr?.message);
                res.status(400).json({ error: `Failed to fetch media: ${fetchErr?.message}` });
                return;
            }
        }

        const result = await sessionManager.sendMediaMessage(
            phoneNumberId,
            to,
            buffer,
            mimeType,
            originalName,
            caption,
            quotedMessageId,
            quotedContent,
            // Multipart entrega strings: 'false' cru era truthy no proto do quote.
            quotedFromMe === 'true' || quotedFromMe === true,
            isPtt === 'true' || isPtt === true,
            quotedParticipant,
            isSticker === 'true' || isSticker === true,
            isAnimated === 'true' || isAnimated === true,
            isForwarded === 'true' || isForwarded === true,
            viewOnce === 'true' || viewOnce === true,
            isGif === 'true' || isGif === true
        );

        if (!result.success) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }

        // If skipSave is true, caller will handle DB save (e.g., Edge Functions with media_url)
        if (skipSave === 'true' || skipSave === true) {
            console.log('[QR] Skipping DB save for media (caller will handle)');
            res.json({ success: true, messageId: result.messageId });
            return;
        }

        // Find or create conversation
        const conv = await findOrCreateConversation(to, phoneNumberId);
        if (!conv) {
            console.error('[QR] Media sent but failed to find/create conversation');
            res.json({ success: true, messageId: result.messageId, warning: 'Failed to save to database' });
            return;
        }

        // Determine message type from mime
        let messageType = 'document';
        if (isSticker === 'true' || isSticker === true) messageType = 'sticker';
        else if (mimeType.startsWith('image/')) messageType = 'image';
        else if (mimeType.startsWith('video/')) messageType = 'video';
        else if (mimeType.startsWith('audio/')) messageType = isPtt === 'true' || isPtt === true ? 'ptt' : 'audio';

        // Save message to database
        const { data: msgData, error: msgError } = await supabase
            .from('messages')
            .insert({
                conversation_id: conv.id,
                content: caption || originalName || '',
                direction: 'outbound',
                whatsapp_message_id: result.messageId,
                message_type: messageType,
                media_mime_type: mimeType,
                media_url: media_url || null,
                status: 'sent'
            })
            .select('id')
            .single();

        if (msgError) {
            console.error('[QR] Error saving media message:', msgError);
            res.json({ success: true, messageId: result.messageId, warning: 'Failed to save to database' });
            return;
        }

        // Update conversation
        await supabase
            .from('conversations')
            .update({ last_message_at: new Date().toISOString(), status: 'active' })
            .eq('id', conv.id);

        console.log(`[QR] Media message saved: ${msgData.id} for conversation: ${conv.id}`);
        res.json({
            success: true,
            messageId: result.messageId,
            conversation_id: conv.id,
            message_id: msgData.id
        });
    } catch (error) {
        console.error('Error sending media message:', error);
        res.status(500).json({ error: 'Failed to send media message' });
    }
});

// Send a voice message (PTT / nota de voz).
// Aceita áudio em QUALQUER formato (upload de arquivo OU media_url) e o serviço
// transcodifica para OGG/Opus antes de enviar como voz de verdade. Diferente de
// /send-media, aqui não existe flag isPtt — este endpoint É a rota de voz.
messageRouter.post('/send-voice/:phoneNumberId', conditionalUpload, async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, quotedMessageId, quotedContent, quotedFromMe, quotedParticipant, skipSave, media_url } = req.body;
    const file = req.file;

    if (!to || (!file && !media_url)) {
        res.status(400).json({
            error: 'to and (file OR media_url) are required',
            note: 'Use multipart/form-data with file, or include media_url in body'
        });
        return;
    }

    try {
        let buffer: Buffer;

        if (file) {
            buffer = file.buffer;
            console.log(`[SendVoice] Sending uploaded voice (${file.mimetype}, ${buffer.length}B) to ${to} via ${phoneNumberId}`);
        } else {
            console.log(`[SendVoice] Fetching audio from URL: ${media_url}`);
            try {
                // SSRF guard: reject non-http(s) and private/link-local/metadata hosts
                // (anexo do nosso Storage vai pela URL interna, sem guarda: ver fetchMediaUrl).
                const response = await fetchMediaUrl(media_url);
                if (!response.ok) {
                    res.status(400).json({ error: `Failed to fetch media from URL: ${response.status}` });
                    return;
                }
                buffer = Buffer.from(await response.arrayBuffer());
                console.log(`[SendVoice] Fetched ${buffer.length} bytes`);
            } catch (fetchErr: any) {
                console.error('[SendVoice] Failed to fetch URL:', fetchErr?.message);
                res.status(400).json({ error: `Failed to fetch media: ${fetchErr?.message}` });
                return;
            }
        }

        const result = await sessionManager.sendVoiceMessage(
            phoneNumberId,
            to,
            buffer,
            quotedMessageId,
            quotedContent,
            quotedFromMe === 'true' || quotedFromMe === true,
            quotedParticipant
        );

        if (!result.success) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }

        // If skipSave is true, caller will handle DB save (e.g., Edge Functions with media_url)
        if (skipSave === 'true' || skipSave === true) {
            console.log('[QR] Skipping DB save for voice (caller will handle)');
            res.json({ success: true, messageId: result.messageId });
            return;
        }

        const conv = await findOrCreateConversation(to, phoneNumberId);
        if (!conv) {
            console.error('[QR] Voice sent but failed to find/create conversation');
            res.json({ success: true, messageId: result.messageId, warning: 'Failed to save to database' });
            return;
        }

        const { data: msgData, error: msgError } = await supabase
            .from('messages')
            .insert({
                conversation_id: conv.id,
                content: '',
                direction: 'outbound',
                whatsapp_message_id: result.messageId,
                message_type: 'ptt',
                media_mime_type: 'audio/ogg; codecs=opus',
                media_url: media_url || null,
                status: 'sent'
            })
            .select('id')
            .single();

        if (msgError) {
            console.error('[QR] Error saving voice message:', msgError);
            res.json({ success: true, messageId: result.messageId, warning: 'Failed to save to database' });
            return;
        }

        await supabase
            .from('conversations')
            .update({ last_message_at: new Date().toISOString(), status: 'active' })
            .eq('id', conv.id);

        console.log(`[QR] Voice message saved: ${msgData.id} for conversation: ${conv.id}`);
        res.json({
            success: true,
            messageId: result.messageId,
            conversation_id: conv.id,
            message_id: msgData.id
        });
    } catch (error) {
        console.error('Error sending voice message:', error);
        res.status(500).json({ error: 'Failed to send voice message' });
    }
});

// Send a contact card (vCard)
messageRouter.post('/send-contact/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, displayName, phone, quotedMessageId, quotedContent, quotedFromMe, quotedParticipant, skipSave } = req.body;

    if (!to || !displayName || !phone) {
        res.status(400).json({ error: 'to, displayName and phone are required' });
        return;
    }

    const isGroup = to.endsWith('@g.us');

    try {
        // Send via Baileys
        const result = await sessionManager.sendContact(
            phoneNumberId,
            to,
            { displayName, phone },
            quotedMessageId,
            quotedContent,
            quotedFromMe,
            quotedParticipant
        );

        if (!result.success) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }

        // If skipSave is true, caller will handle DB save
        if (skipSave === 'true' || skipSave === true) {
            console.log('[QR] Skipping DB save for contact (caller will handle)');
            res.json({ success: true, messageId: result.messageId });
            return;
        }

        // Find conversation (handle groups differently)
        let conversationId: string | null = null;

        if (isGroup) {
            // For groups, find by group_jid
            const { data: groupConv } = await supabase
                .from('conversations')
                .select('id')
                .eq('group_jid', to)
                .eq('phone_number_id', phoneNumberId)
                .single();

            if (groupConv) {
                conversationId = groupConv.id;
            } else {
                console.error('[QR] Group conversation not found for:', to);
            }
        } else {
            // For individual chats, use existing helper
            const conv = await findOrCreateConversation(to, phoneNumberId);
            if (conv) {
                conversationId = conv.id;
            }
        }

        if (!conversationId) {
            console.error('[QR] Contact sent but failed to find conversation');
            res.json({ success: true, messageId: result.messageId, warning: 'Failed to save to database' });
            return;
        }

        // Build vCard for storage
        const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${displayName}\nTEL;type=CELL:${phone}\nEND:VCARD`;

        // Save message to database
        const { data: msgData, error: msgError } = await supabase
            .from('messages')
            .insert({
                conversation_id: conversationId,
                content: '[Contato]',
                direction: 'outbound',
                whatsapp_message_id: result.messageId,
                message_type: 'contact',
                metadata: {
                    contact: {
                        displayName,
                        vcard,
                        phones: [phone]
                    }
                },
                status: 'sent'
            })
            .select('id')
            .single();

        if (msgError) {
            console.error('[QR] Error saving contact message:', msgError);
            res.json({ success: true, messageId: result.messageId, warning: 'Failed to save to database' });
            return;
        }

        // Update conversation last_message_at
        await supabase
            .from('conversations')
            .update({ last_message_at: new Date().toISOString(), status: 'active' })
            .eq('id', conversationId);

        console.log(`[QR] Contact message saved: ${msgData.id} for conversation: ${conversationId}`);
        res.json({
            success: true,
            messageId: result.messageId,
            conversation_id: conversationId,
            message_id: msgData.id
        });
    } catch (error) {
        console.error('Error sending contact:', error);
        res.status(500).json({ error: 'Failed to send contact' });
    }
});

// Send a static location pin
messageRouter.post('/send-location/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const {
        to, latitude, longitude, name, address,
        quotedMessageId, quotedContent, quotedFromMe, quotedParticipant, skipSave,
    } = req.body;

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!to || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        res.status(400).json({ error: 'to, latitude (-90..90) and longitude (-180..180) are required' });
        return;
    }

    try {
        const result = await sessionManager.sendLocation(
            phoneNumberId,
            to,
            {
                latitude: lat,
                longitude: lng,
                name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
                address: typeof address === 'string' && address.trim() ? address.trim() : undefined,
            },
            quotedMessageId,
            quotedContent,
            quotedFromMe === 'true' || quotedFromMe === true,
            quotedParticipant
        );

        if (!result.success) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }

        // Edge functions gravam a linha (skipSave) — caminho sem skipSave é
        // para consumidores diretos da API do serviço.
        if (skipSave === 'true' || skipSave === true) {
            res.json({ success: true, messageId: result.messageId });
            return;
        }

        const isGroup = to.endsWith('@g.us');
        let conversationId: string | null = null;
        if (isGroup) {
            const { data: groupConv } = await supabase
                .from('conversations')
                .select('id')
                .eq('group_jid', to)
                .eq('phone_number_id', phoneNumberId)
                .single();
            conversationId = groupConv?.id ?? null;
        } else {
            const conv = await findOrCreateConversation(to, phoneNumberId);
            conversationId = conv?.id ?? null;
        }

        if (!conversationId) {
            res.json({ success: true, messageId: result.messageId, warning: 'Conversation not found' });
            return;
        }

        const { data: msgData, error: msgError } = await supabase
            .from('messages')
            .insert({
                conversation_id: conversationId,
                content: `[Localização: ${lat}, ${lng}]`,
                direction: 'outbound',
                whatsapp_message_id: result.messageId,
                message_type: 'location',
                metadata: { location: { lat, lng, name: name ?? null, address: address ?? null } },
                status: 'sent'
            })
            .select('id')
            .single();

        if (msgError) {
            console.error('[QR] Error saving location message:', msgError);
            res.json({ success: true, messageId: result.messageId, warning: 'Failed to save to database' });
            return;
        }

        await supabase
            .from('conversations')
            .update({ last_message_at: new Date().toISOString(), status: 'active' })
            .eq('id', conversationId);

        res.json({
            success: true,
            messageId: result.messageId,
            conversation_id: conversationId,
            message_id: msgData.id
        });
    } catch (error) {
        console.error('Error sending location:', error);
        res.status(500).json({ error: 'Failed to send location' });
    }
});

// Envio de enquete (QR only). skipSave sempre: o edge fn grava a linha com o
// message_secret devolvido aqui.
messageRouter.post('/send-poll/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, question, options, selectableCount } = req.body as {
        to?: string;
        question?: string;
        options?: unknown;
        selectableCount?: unknown;
    };

    const opts = Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0) : [];
    const count = Number(selectableCount ?? 1);
    if (
        !to ||
        typeof question !== 'string' || !question.trim() || question.length > 255 ||
        opts.length < 2 || opts.length > 12 ||
        opts.some((o) => o.length > 100) ||
        !Number.isInteger(count) || count < 0 || count > opts.length
    ) {
        res.status(400).json({
            error: 'to, question (≤255), options (2–12 strings ≤100) and selectableCount (0..options.length) are required',
        });
        return;
    }

    try {
        const result = await sessionManager.sendPoll(phoneNumberId, to, {
            question: question.trim(),
            options: opts,
            selectableCount: count,
        });
        if (!result.success) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, messageId: result.messageId, messageSecret: result.messageSecret ?? null });
    } catch (error) {
        console.error('Error sending poll:', error);
        res.status(500).json({ error: 'Failed to send poll' });
    }
});

// Voto do painel numa enquete (QR only). O edge fn manda o contexto da
// enquete (wamid, criador, secret) e grava o voto no banco após o relay.
messageRouter.post('/poll-vote/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, pollMsgId, pollCreatorFromMe, pollCreatorJid, pollChatJid, messageSecret, selectedOptions } = req.body as {
        to?: string;
        pollMsgId?: string;
        pollCreatorFromMe?: boolean;
        pollCreatorJid?: string | null;
        pollChatJid?: string | null;
        messageSecret?: string;
        selectedOptions?: unknown;
    };

    const options = Array.isArray(selectedOptions)
        ? selectedOptions.filter((o): o is string => typeof o === 'string')
        : null;
    if (!to || !pollMsgId || !messageSecret || options === null) {
        res.status(400).json({ error: 'to, pollMsgId, messageSecret and selectedOptions[] are required' });
        return;
    }

    try {
        const result = await sessionManager.votePoll(
            phoneNumberId,
            to,
            {
                pollMsgId,
                pollCreatorFromMe: pollCreatorFromMe === true,
                pollCreatorJid: pollCreatorJid ?? null,
                pollChatJid: pollChatJid ?? null,
                messageSecretB64: messageSecret,
            },
            options
        );
        if (!result.success) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, voterJid: result.voterJid });
    } catch (error) {
        console.error('Error voting on poll:', error);
        res.status(500).json({ error: 'Failed to vote on poll' });
    }
});

// Confirmação de leitura (tique azul) — opt-in por número, decidido no edge fn
messageRouter.post('/mark-read/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { jid, keys } = req.body as { jid?: string; keys?: Array<{ id: string; participant?: string | null }> };

    if (!jid || !Array.isArray(keys) || keys.length === 0) {
        res.status(400).json({ error: 'jid and keys[] are required' });
        return;
    }
    if (keys.length > 100 || keys.some((k) => !k || typeof k.id !== 'string')) {
        res.status(400).json({ error: 'keys must be up to 100 items with string ids' });
        return;
    }

    try {
        const result = await sessionManager.markMessagesRead(phoneNumberId, jid, keys);
        if (!result.success) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }
        res.json({ success: true, count: keys.length });
    } catch (error) {
        console.error('Error marking messages read:', error);
        res.status(500).json({ error: 'Failed to mark messages read' });
    }
});

// Delete a message (QR connections only)
messageRouter.post('/delete/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, messageId, fromMe } = req.body;

    if (!to || !messageId) {
        res.status(400).json({ error: 'to and messageId are required' });
        return;
    }

    try {
        const result = await sessionManager.deleteMessage(
            phoneNumberId,
            to,
            messageId,
            fromMe ?? true
        );

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Error deleting message:', error);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// Edit a message (QR connections only)
messageRouter.post('/edit/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, messageId, newContent, messageType } = req.body;

    if (!to || !messageId || !newContent) {
        res.status(400).json({ error: 'to, messageId and newContent are required' });
        return;
    }

    try {
        const result = await sessionManager.editMessage(
            phoneNumberId,
            to,
            messageId,
            newContent,
            messageType
        );

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Error editing message:', error);
        res.status(500).json({ error: 'Failed to edit message' });
    }
});

// Chatstate de "digitando"/"gravando" (QR connections only). Efêmero: não grava
// nada no banco e não loga em message_events — dispara a cada poucos segundos
// enquanto o atendente digita.
const CHAT_STATES = ['composing', 'recording', 'paused'] as const;
type ChatState = (typeof CHAT_STATES)[number];

messageRouter.post('/presence/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, state } = req.body ?? {};

    if (!to || !state) {
        res.status(400).json({ error: 'to and state are required' });
        return;
    }

    if (!CHAT_STATES.includes(state as ChatState)) {
        res.status(400).json({ error: `state must be one of: ${CHAT_STATES.join(', ')}` });
        return;
    }

    try {
        const result = await sessionManager.sendChatState(phoneNumberId, to, state as ChatState);

        // Sessão caída no meio da digitação não é erro do cliente: 200 com
        // success:false evita ruído de 4xx no console do navegador a cada refresh.
        res.json(result);
    } catch (error) {
        console.error('Error sending chat state:', error);
        res.status(500).json({ error: 'Failed to send chat state' });
    }
});

// Assina a presença de um chat — o front chama ao abrir a conversa. Sem isto o
// WhatsApp não empurra presença nenhuma e o presence.update nunca dispara.
messageRouter.post('/presence-subscribe/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to } = req.body ?? {};

    if (!to) {
        res.status(400).json({ error: 'to is required' });
        return;
    }

    try {
        const result = await sessionManager.subscribeToPresence(phoneNumberId, to);
        res.json(result);
    } catch (error) {
        console.error('Error subscribing to presence:', error);
        res.status(500).json({ error: 'Failed to subscribe to presence' });
    }
});

// React to a message (QR connections only)
messageRouter.post('/react/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { to, messageId, emoji, fromMe, participant } = req.body;

    if (!to || !messageId) {
        res.status(400).json({ error: 'to and messageId are required' });
        return;
    }

    try {
        const result = await sessionManager.sendReaction(
            phoneNumberId,
            to,
            messageId,
            emoji || '', // Empty string removes the reaction
            fromMe ?? false,
            participant // JID of who sent the original message (for groups)
        );

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Error sending reaction:', error);
        res.status(500).json({ error: 'Failed to send reaction' });
    }
});
