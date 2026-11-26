import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { recusarSeDirect } from '../_shared/canal.ts';
import { createErrorResponse } from '../_shared/error-utils.ts';
import { requireUser, requirePhoneAccess } from '../_shared/authz.ts';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { MediaSendError, assertMediaSize, maxMediaBytes } from '../_shared/media-limits.ts';
import { reativarConversa } from '../_shared/conversation-touch.ts';
import { bufferReader, probeMediaDimensions, thumbHashFromUrl, type MediaDims } from '../_shared/media-probe.ts';
import { urlPublicaDoAnexo } from '../_shared/url-publica.ts';
import { fetchMidia } from '../_shared/url-guard.ts';
import {
    caminhoDoUsuarioValido,
    conteudoDaMidia,
    corrigirMimeDeHtml,
    enviarMidiaAoWhatsApp,
    prepararMidiaDoStorage,
    type CitacaoDoEnvio,
} from '../_shared/midia-envio.ts';

// Dica de dimensões que o front mede antes do envio (FormData chega como string).
// Par do MediaHintSchema em src/lib/mediaBox.ts: mudar nos dois.
const MediaHintSchema = z.object({
    width: z.coerce.number().int().min(1).max(65535),
    height: z.coerce.number().int().min(1).max(65535),
});

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mapeia erros técnicos para mensagens amigáveis
function friendlyError(error: string): string {
  const errorMap: Record<string, string> = {
    'session not connected': 'Sessão desconectada. Tente novamente ou reconecte o WhatsApp.',
    'not connected': 'WhatsApp desconectado. Tente novamente.',
    'missing required fields': 'Campos obrigatórios não preenchidos.',
    'phone number not found': 'Número de WhatsApp não encontrado.',
    'failed to upload': 'Falha ao enviar arquivo. Tente novamente.',
    'qr service unreachable': 'Serviço temporariamente indisponível. Tente novamente.',
    'failed to send media': 'Falha ao enviar mídia. Tente novamente.',
    'whatsapp credentials not configured': 'WhatsApp não configurado.',
    'file too large': 'Arquivo muito grande.',
    'arquivo de áudio vazio': 'Arquivo de áudio vazio ou inválido. Grave novamente.',
    'sticker not found': 'Figurinha não encontrada na sua coleção.',
    'sticker outside whatsapp spec': 'Esta figurinha está fora do padrão do WhatsApp e só pode ser enviada por números conectados via QR.',
    'failed to fetch sticker file': 'Não foi possível baixar o arquivo da figurinha. Tente novamente.',
  };

  const lowerError = error.toLowerCase();
  for (const [key, value] of Object.entries(errorMap)) {
    if (lowerError.includes(key)) {
      return value;
    }
  }

  return `Erro: ${error}`;
}

// phone_numbers.id is a uuid; the front may send a Meta phone_number_id or a
// synthetic 'qr_<ts>' id, so only query by 'id' when the value is a real uuid
// (otherwise Postgres raises 22P02 invalid input syntax for type uuid).
const isUUID = (str: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    try {
        const formData = await req.formData();

        const file = formData.get('file') as File;
        const to = formData.get('to') as string;
        const conversationId = formData.get('conversationId') as string;
        const phoneNumberId = formData.get('phoneNumberId') as string;
        const caption = formData.get('caption') as string | null;
        const isPtt = formData.get('isPtt') as string | null;
        // Envio de figurinha da coleção: em vez de re-subir o arquivo, o front
        // manda o id da row de user_stickers e esta função resolve a URL.
        const stickerId = formData.get('stickerId') as string | null;
        // Reply em mídia: id (uuid) da mensagem citada — mesmo contrato do whatsapp-send.
        const quotedMessageId = formData.get('quotedMessageId') as string | null;
        // "Ver uma vez" e GIF — só QR (a Cloud API não envia nenhum dos dois).
        const viewOnce = formData.get('viewOnce') === 'true';
        const isGif = formData.get('isGif') === 'true';
        // Reenvio de mídia falhada: update-in-place da MESMA linha (contrato do
        // whatsapp-send) — a mídia vem do media_url já no Storage, sem re-upload.
        const retryMessageId = formData.get('retryMessageId') as string | null;
        // Arquivo já no Storage: o front sobe direto para attachments/outbound/<userId>/
        // e manda só o caminho. Com o arquivo inteiro no corpo, mídia grande estourava
        // a memória do worker (HTTP 546). O nome e o mime originais vêm junto.
        const storagePath = formData.get('storagePath') as string | null;
        const storageFilename = formData.get('filename') as string | null;
        const storageMimeType = formData.get('mimeType') as string | null;
        // Tamanho que o front conhece (File.size). Só entra quando o HEAD do
        // Storage não traz content-length nem a listagem do objeto responde.
        const storageFileSize = formData.get('fileSize') as string | null;
        const mediaLimit = maxMediaBytes(Deno.env.get('MAX_MEDIA_BYTES'));

        if ((!file && !storagePath && !stickerId && !retryMessageId) || !conversationId || !phoneNumberId) {
            throw new Error('Missing required fields: file (or storagePath/stickerId/retryMessageId), conversationId, phoneNumberId');
        }
        if (!retryMessageId && !to) {
            throw new Error('Missing required fields: to');
        }

        const supabase = createClient(supabaseUrl, supabaseKey);
        await recusarSeDirect(supabase, [conversationId]);

        // Identity comes from the verified JWT, never from the request body.
        const userId = await requireUser(supabase, req);

        console.log(`[SendMedia] Looking up phone number: ${phoneNumberId}`);

        // Get phone number details - try by id first, then by phone_number_id
        let phoneData = null;
        let phoneError = null;

        // Try by database UUID first (only when it actually is a uuid)
        const result1 = isUUID(phoneNumberId)
            ? await supabase
                .from('phone_numbers')
                .select(`
                    id,
                    phone_number_id,
                    phone_number,
                    organization_id,
                    connection_type,
                    organizations (
                        id,
                        whatsapp_waba_id,
                        whatsapp_access_token
                    )
                `)
                .eq('id', phoneNumberId)
                .maybeSingle()
            : null;

        if (result1?.data) {
            phoneData = result1.data;
        } else {
            // Try by Meta phone_number_id
            const result2 = await supabase
                .from('phone_numbers')
                .select(`
                    id,
                    phone_number_id,
                    organization_id,
                    connection_type,
                    organizations (
                        id,
                        whatsapp_waba_id,
                        whatsapp_access_token
                    )
                `)
                .eq('phone_number_id', phoneNumberId)
                .maybeSingle();

            phoneData = result2.data;
            phoneError = result2.error;
        }

        if (!phoneData) {
            console.error('[SendMedia] Phone not found for:', phoneNumberId);
            throw new Error('Phone number not found');
        }

        // The caller must belong to the org that owns this number.
        await requirePhoneAccess(supabase, userId, phoneData.id, phoneData.organization_id);

        // Ver-uma-vez não existe na Cloud API (envio); GIF degrada p/ vídeo comum lá.
        if (viewOnce && phoneData.connection_type !== 'qr') {
            throw new Error('View-once not supported on Cloud API');
        }

        // Validação do reenvio: mesma conversa, saída, falhada, com mídia viva.
        // O destino vem do BANCO (conversa), não do form — banco é a autoridade.
        const MEDIA_RETRY_TYPES = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];
        interface RetryRow {
            content: string;
            message_type: string;
            media_url: string;
            media_mime_type: string | null;
            media_filename: string | null;
            media_size_bytes: number | null;
        }
        let retryRow: RetryRow | null = null;
        let resolvedTo = to;
        if (retryMessageId) {
            const { data: row } = await supabase
                .from('messages')
                .select('content, message_type, direction, status, is_deleted, conversation_id, media_url, media_mime_type, media_filename, media_size_bytes')
                .eq('id', retryMessageId)
                .maybeSingle();
            if (
                !row ||
                row.conversation_id !== conversationId ||
                row.direction !== 'outbound' ||
                row.status !== 'failed' ||
                row.is_deleted ||
                !row.media_url ||
                !MEDIA_RETRY_TYPES.includes(row.message_type)
            ) {
                throw new Error('Mensagem não elegível para reenvio');
            }
            retryRow = row as unknown as RetryRow;

            const { data: conv } = await supabase
                .from('conversations')
                .select('contact_phone, is_group, group_jid, phone_number_id')
                .eq('id', conversationId)
                .maybeSingle();
            if (!conv || conv.phone_number_id !== phoneData.id) {
                throw new Error('Conversa não pertence a este número');
            }
            resolvedTo = conv.is_group && conv.group_jid ? conv.group_jid : conv.contact_phone;
        }

        console.log(`[SendMedia] Found phone:`, phoneData.id, 'type:', phoneData.connection_type);

        const org = phoneData.organizations;
        const orgData = Array.isArray(org) ? org[0] : org;
        // @ts-ignore
        const accessToken = orgData?.whatsapp_access_token;
        const metaPhoneNumberId = phoneData.phone_number_id;

        // Determine media type, mime and the public URL to send
        let mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker' = 'document';
        let mimeType: string;
        let mediaUrl: string;
        let mediaFilename: string;
        let mediaSizeBytes: number;
        let fileBuffer: ArrayBuffer | null = null;
        let stickerIsAnimated = false;
        // Dimensões de exibição (metadata.media). Precedência: bytes medidos > dica do front.
        let probedDims: MediaDims | null = null;
        // ThumbHash (prévia borrada) calculado em paralelo ao resto; nunca lança.
        let thumbPromise: Promise<string | null> = Promise.resolve(null);
        const supabaseUrlForThumb = Deno.env.get('SUPABASE_URL') ?? '';

        if (retryRow) {
            // Reenvio: tudo vem da própria linha; QR precisa do buffer de volta.
            const rowType = retryRow.message_type === 'ptt' ? 'audio' : retryRow.message_type;
            mediaType = rowType as typeof mediaType;
            mimeType = retryRow.media_mime_type || 'application/octet-stream';
            mediaUrl = retryRow.media_url;
            mediaFilename = retryRow.media_filename || 'file';
            mediaSizeBytes = retryRow.media_size_bytes || 0;
            // O qr-service baixa pelo media_url sem teto próprio: o limite vale aqui também.
            assertMediaSize(mediaSizeBytes, mediaLimit);
            // QR: o qr-service baixa pelo media_url (sem buffer aqui, ver envio abaixo).
        } else if (storagePath) {
            // Só a pasta do próprio usuário (identidade do JWT, não do corpo).
            if (!caminhoDoUsuarioValido(storagePath, userId)) {
                throw new Error('Caminho de arquivo inválido');
            }
            const midia = await prepararMidiaDoStorage(supabase, {
                storagePath,
                filename: storageFilename,
                mimeHint: storageMimeType,
                sizeHint: storageFileSize,
                limitBytes: mediaLimit,
                supabaseUrl: supabaseUrlForThumb,
                logTag: 'SendMedia',
            });
            mediaUrl = midia.mediaUrl;
            mimeType = midia.mimeType;
            mediaType = midia.mediaType;
            mediaSizeBytes = midia.mediaSizeBytes;
            mediaFilename = midia.mediaFilename;
            probedDims = midia.probedDims;
            thumbPromise = midia.thumbPromise;
        } else if (stickerId) {
            // Figurinha da cole\u00e7\u00e3o: valida posse e reusa o arquivo j\u00e1 p\u00fablico em
            // attachments/stickers/<user_id>/<sha>.webp \u2014 sem re-upload por envio.
            const { data: sticker } = await supabase
                .from('user_stickers')
                .select('user_id, file_url, is_animated, size_bytes, meta_compliant')
                .eq('id', stickerId)
                .maybeSingle();

            // Mesma mensagem para "n\u00e3o existe" e "n\u00e3o \u00e9 seu": n\u00e3o vazar exist\u00eancia.
            if (!sticker || sticker.user_id !== userId) {
                throw new Error('Sticker not found');
            }
            // O Baileys envia qualquer webp, mas a Meta rejeita sticker fora da
            // spec (512x512, \u2264100KB/500KB) com erro cr\u00edptico \u2014 bloquear aqui.
            if (phoneData.connection_type !== 'qr' && !sticker.meta_compliant) {
                throw new Error('Sticker outside WhatsApp spec');
            }

            mediaType = 'sticker';
            mimeType = 'image/webp';
            mediaUrl = sticker.file_url;
            mediaFilename = 'sticker.webp';
            mediaSizeBytes = sticker.size_bytes;
            stickerIsAnimated = sticker.is_animated === true;

            // O qr-service recebe o arquivo por multipart (como toda m\u00eddia).
            if (phoneData.connection_type === 'qr') {
                const stickerResponse = await fetchMidia(mediaUrl);
                if (!stickerResponse.ok) {
                    throw new Error('Failed to fetch sticker file');
                }
                fileBuffer = await stickerResponse.arrayBuffer();
            }
        } else {
            // Determine media type from MIME type
            mimeType = file.type;

            if (mimeType.startsWith('image/')) {
                mediaType = 'image';
            } else if (mimeType.startsWith('video/')) {
                mediaType = 'video';
            } else if (mimeType.startsWith('audio/')) {
                mediaType = 'audio';
            }

            if (mediaType === 'audio' && file.size < 256) {
                throw new Error('Arquivo de áudio vazio ou inválido');
            }
            assertMediaSize(file.size, mediaLimit);

            // Sanitize filename for storage path (remove accents and special characters)
            const sanitizeFilename = (name: string) => {
                return name
                    .normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "") // Remove accents
                    .replace(/[^a-zA-Z0-9.-]/g, "_") // Replace non-alphanumeric (except . and -) with underscore
                    .replace(/_{2,}/g, "_"); // Remove consecutive underscores
            };

            // Upload file to Supabase Storage
            fileBuffer = await file.arrayBuffer();
            if (mediaType === 'image' || mediaType === 'video') {
                probedDims = await probeMediaDimensions(bufferReader(new Uint8Array(fileBuffer)), { timeoutMs: 500 });
            }
            const sanitizedName = sanitizeFilename(file.name);
            const uploadPath = `outbound/${userId}/${Date.now()}_${sanitizedName}`;

            const { error: uploadError } = await supabase.storage
                .from('attachments')
                .upload(uploadPath, fileBuffer, {
                    contentType: mimeType,
                    upsert: false
                });

            if (uploadError) {
                console.error('Storage upload error:', uploadError);
                throw new Error('Failed to upload file to storage');
            }

            // Get public URL (a base pública: a URL é gravada e segue ao canal)
            mediaUrl = urlPublicaDoAnexo(uploadPath);
            if (mediaType === 'image') {
                thumbPromise = thumbHashFromUrl(mediaUrl, supabaseUrlForThumb, { timeoutMs: 1500 });
            }
            mediaFilename = file.name;
            mediaSizeBytes = file.size;
            console.log(`[SendMedia] Uploaded to: ${mediaUrl}`);
        }

        // .html servido como text/plain pelo Storage (ver corrigirMimeDeHtml).
        mimeType = corrigirMimeDeHtml(mediaType, mediaFilename, mimeType);

        // Fetch quoted message details if replying to a message (espelha whatsapp-send)
        let quotedWhatsappId: string | null = null;
        let quotedContent: string | null = null;
        let quotedFromMe = false;
        let quotedParticipant: string | null = null;
        if (quotedMessageId) {
            const { data: quotedMsg } = await supabase
                .from('messages')
                .select('whatsapp_message_id, content, direction, sender_phone, conversation_id')
                .eq('id', quotedMessageId)
                .maybeSingle();
            // Quote de outra conversa seria contrabando de contexto — ignora.
            if (quotedMsg && quotedMsg.conversation_id === conversationId) {
                quotedWhatsappId = quotedMsg.whatsapp_message_id;
                quotedContent = quotedMsg.content;
                quotedFromMe = quotedMsg.direction === 'outbound';
                quotedParticipant = quotedMsg.sender_phone ? `${quotedMsg.sender_phone.replace(/\D/g, '')}@s.whatsapp.net` : null;
                console.log('[SendMedia] Quoted message:', quotedWhatsappId, 'fromMe:', quotedFromMe);
            }
        }

        const citacao: CitacaoDoEnvio | null = quotedWhatsappId
            ? { whatsappId: quotedWhatsappId, content: quotedContent, fromMe: quotedFromMe, participant: quotedParticipant }
            : null;
        const whatsappMessageId = await enviarMidiaAoWhatsApp({
            connectionType: phoneData.connection_type,
            phoneDbId: phoneData.id,
            metaPhoneNumberId,
            accessToken,
            to: resolvedTo,
            mediaType,
            mediaUrl,
            mimeType,
            filename: mediaFilename,
            fileBuffer,
            caption,
            isPtt,
            stickerAnimated: stickerIsAnimated,
            viewOnce,
            isGif,
            quoted: citacao,
            logTag: 'SendMedia',
        });

        // Save message to database
        const messageContent = retryRow ? retryRow.content : conteudoDaMidia(mediaType, caption);

        // Retry: a MESMA linha ganha o wamid novo (posição preservada na
        // conversa); 23505 = o eco do Baileys já gravou a linha viva → descarta
        // a antiga falhada. Envio normal: upsert (corrida com o eco).
        let newMessage: { id: string } | null = null;
        // metadata do insert: view_once, gif e media. O reenvio (update no lugar) não toca em metadata.
        const insertMetadata: Record<string, unknown> = {
            ...(viewOnce ? { view_once: true } : {}),
            ...(isGif ? { gif: true } : {}),
        };
        if (mediaType === 'image' || mediaType === 'video') {
            const hint = MediaHintSchema.safeParse({
                width: formData.get('mediaWidth'),
                height: formData.get('mediaHeight'),
            });
            const dims: MediaDims | null = probedDims ?? (hint.success ? hint.data : null);
            if (dims) {
                const source = probedDims ? 'bytes' : 'client';
                const thumbhash = mediaType === 'image' ? await thumbPromise : null;
                insertMetadata.media = {
                    width: dims.width,
                    height: dims.height,
                    ...(dims.seconds ? { seconds: dims.seconds } : {}),
                    ...(thumbhash ? { thumbhash } : {}),
                    source,
                };
            }
        }
        if (retryMessageId) {
            const { data: updated, error: updError } = await supabase
                .from('messages')
                .update({
                    whatsapp_message_id: whatsappMessageId,
                    status: 'sent',
                    error_message: null,
                })
                .eq('id', retryMessageId)
                .select()
                .maybeSingle();
            if (updError?.code === '23505') {
                await supabase.from('messages').delete().eq('id', retryMessageId);
            } else if (updError) {
                console.error('[SendMedia] Error updating retried message:', updError);
            } else {
                newMessage = updated;
            }
        } else {
        const { data: inserted, error: msgError } = await supabase
            .from('messages')
            .upsert({
                conversation_id: conversationId,
                content: messageContent,
                direction: 'outbound',
                sent_by: userId,
                whatsapp_message_id: whatsappMessageId,
                message_type: mediaType,
                media_url: mediaUrl,
                media_mime_type: mimeType,
                media_filename: mediaFilename,
                media_size_bytes: mediaSizeBytes,
                quoted_message_id: quotedWhatsappId ? quotedMessageId : null,
                ...(Object.keys(insertMetadata).length ? { metadata: insertMetadata } : {}),
            }, {
                onConflict: 'whatsapp_message_id,conversation_id',
                ignoreDuplicates: true,
            })
            .select()
            .maybeSingle();

        if (msgError) {
            console.error('Error saving message to DB:', msgError);
        }
        newMessage = inserted;
        }

        // Update conversation. Envio novo: o trigger on_message_inserted já avançou
        // last_message_at no insert; aqui só reabre, e só se não estiver 'active' (D1).
        // O reenvio atualiza a linha no lugar (sem trigger de INSERT) e segue
        // avançando last_message_at como antes.
        if (retryMessageId) {
            await supabase
                .from('conversations')
                .update({
                    last_message_at: new Date().toISOString(),
                    status: 'active'
                })
                .eq('id', conversationId);
        } else {
            await reativarConversa(supabase, conversationId);
        }

        if (newMessage) {
            await emitMessageSent(supabase, {
                conversationId,
                messageId: newMessage.id,
                whatsappMessageId,
                content: messageContent,
                messageType: mediaType,
                sentBy: userId,
                origin: 'panel',
                phoneNumberDbId: phoneData.id,
                organizationId: phoneData.organization_id,
                metaPhoneNumberId,
                media: {
                    url: mediaUrl,
                    mime_type: mimeType,
                    filename: mediaFilename,
                    size_bytes: mediaSizeBytes,
                },
                quotedMessageId: quotedWhatsappId ? quotedMessageId : null,
                quotedWhatsappId,
                quotedContent,
            });
        }

        return new Response(
            JSON.stringify({
                success: true,
                messageId: whatsappMessageId,
                mediaUrl: mediaUrl,
                message: newMessage
            }),
            {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            }
        );
    } catch (error: any) {
        console.error('Error sending media:', error);
        // Erro com code: o front decide pelo code (ex.: storage_object_missing
        // invalida o caminho já subido e sobe o arquivo de novo).
        if (error instanceof MediaSendError) {
            return new Response(
                JSON.stringify({ success: false, error: error.message, code: error.code }),
                { status: error.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
            );
        }
        return createErrorResponse(error, corsHeaders, friendlyError);
    }
});
