// Agendamento com arquivo (message_type = 'media').
//
// A linha leva a lista `media` (contrato na coluna scheduled_messages.media). Os arquivos
// saem em ordem, um por vez. O wamid de cada um é gravado em media[i] logo depois
// do envio e ANTES de qualquer outra escrita: numa nova tentativa (retry do
// executor ou requeue do reaper) o item com wamid é pulado, então nada sai duas
// vezes e nada fica para trás. A coluna whatsapp_message_id da linha só é
// preenchida pelo chamador depois do último arquivo.
//
// Três regras contra envio em dobro:
// - POSSE: cada gravação de progresso renova last_attempt_at e só vale se a linha
//   ainda é desta execução (status 'processing' e o mesmo `attempts` do claim).
//   O reaper mede 5 min a partir de last_attempt_at; sem renovar, um lote longo
//   era devolvido à fila e uma 2ª execução mandava os mesmos arquivos.
// - ORÇAMENTO: passou de ORCAMENTO_MS, o lote para entre dois arquivos e volta à
//   fila sem gastar tentativa (LotePausado). Cada arquivo tem PRAZO_DO_ARQUIVO_MS:
//   orçamento + prazo ficam abaixo do limite de tempo da edge.
// - DÚVIDA NÃO REENVIA: progresso que não grava, ou resposta que não prova que o
//   arquivo NÃO saiu (corpo que não é JSON, 502/504 do proxy, prazo estourado),
//   vira falha sem retry com o aviso de que pode ter saído.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { z } from 'https://esm.sh/zod@3.23.8';
import { emitMessageSent } from '../_shared/webhooks.ts';
import { logWriteFailure } from '../_shared/failure-log.ts';
import { maxMediaBytes } from '../_shared/media-limits.ts';
import { reativarConversa } from '../_shared/conversation-touch.ts';
import { isRetryableError } from './retry.ts';
import {
    caminhoDoUsuarioValido,
    conteudoDaMidia,
    corrigirMimeDeHtml,
    enviarMidiaAoWhatsApp,
    prepararMidiaDoStorage,
    type CitacaoDoEnvio,
} from '../_shared/midia-envio.ts';

const Dimensao = z.number().int().min(1).max(65535);

// Par do ScheduledMediaItem em src/lib/scheduledMedia.ts: mudar nos dois.
export const ItemAgendadoSchema = z.object({
    storage_path: z.string().min(1).max(1024),
    filename: z.string().min(1).max(255),
    mime_type: z.string().min(1).max(255),
    size_bytes: z.number().int().nonnegative(),
    caption: z.string().max(4096).nullish(),
    width: Dimensao.nullish(),
    height: Dimensao.nullish(),
    view_once: z.boolean().nullish(),
    whatsapp_message_id: z.string().min(1).nullish(),
}).passthrough();

export const ItensAgendadosSchema = z.array(ItemAgendadoSchema).min(1).max(30);

export type ItemAgendado = z.infer<typeof ItemAgendadoSchema>;

/** Erro que não melhora com outra tentativa (dado inválido): o chamador marca 'failed'. */
export class ArquivoAgendadoInvalido extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ArquivoAgendadoInvalido';
    }
}

/**
 * Falha num arquivo. `retentavel` sai da frase ORIGINAL do erro (o nome do
 * arquivo, que entra na frase do painel, não pode virar "network" por acaso).
 */
export class FalhaNoArquivo extends Error {
    constructor(message: string, readonly retentavel: boolean) {
        super(message);
        this.name = 'FalhaNoArquivo';
    }
}

/** O lote passou do orçamento de tempo: volta à fila sem gastar tentativa. */
export class LotePausado extends Error {
    constructor(readonly enviadosNestaExecucao: number) {
        super('Lote de arquivos pausado pelo tempo; continua no próximo minuto');
        this.name = 'LotePausado';
    }
}

/** A linha deixou de ser desta execução (outra execução ou mudança de status): parar sem escrever. */
export class AgendamentoPerdido extends Error {
    constructor() {
        super('Agendamento não pertence mais a esta execução');
        this.name = 'AgendamentoPerdido';
    }
}

/**
 * Tempo de envio por execução, conferido entre arquivos. Com o prazo de um
 * arquivo (PRAZO_DO_ARQUIVO_MS) a soma fica abaixo do limite da edge (150 s) e
 * bem abaixo dos 5 min do reaper.
 */
export const ORCAMENTO_MS = 50_000;

/** Prazo da chamada ao canal por arquivo. Estourou = ambíguo (pode ter saído): sem retry. */
export const PRAZO_DO_ARQUIVO_MS = 60_000;

/**
 * Resposta que não prova que o arquivo deixou de sair: o proxy pode ter cortado
 * (502/504, corpo HTML) depois de o qr-service mandar.
 */
export function respostaAmbigua(message: string): boolean {
    return /invalid response|timed out after/i.test(message);
}

/** Valida a lista e o dono dos caminhos. Lança ArquivoAgendadoInvalido. */
export function lerItensAgendados(media: unknown, createdBy: string | null): ItemAgendado[] {
    const parsed = ItensAgendadosSchema.safeParse(media);
    if (!parsed.success) {
        throw new ArquivoAgendadoInvalido(`Agendamento com arquivo inválido: ${parsed.error.issues[0]?.message ?? 'formato'}`);
    }
    if (!createdBy) {
        throw new ArquivoAgendadoInvalido('Agendamento com arquivo sem autor: não dá para conferir o arquivo.');
    }
    for (const item of parsed.data) {
        // O caminho vem do front: só a pasta de quem agendou (a mesma regra do envio do painel).
        if (!caminhoDoUsuarioValido(item.storage_path, createdBy)) {
            throw new ArquivoAgendadoInvalido('Agendamento com caminho de arquivo inválido.');
        }
    }
    return parsed.data;
}

/** Índices que ainda faltam mandar, na ordem. */
export function pendentes(itens: ItemAgendado[]): number[] {
    return itens.flatMap((item, i) => (item.whatsapp_message_id ? [] : [i]));
}

/** Prefixo da mensagem de erro quando parte dos arquivos já saiu. */
export function progressoDoErro(itens: ItemAgendado[]): string {
    const enviados = itens.length - pendentes(itens).length;
    return enviados > 0 ? `${enviados} de ${itens.length} arquivos enviados. ` : '';
}

export interface ContextoDoAgendamento {
    id: string;
    /** Valor de `attempts` gravado pelo claim desta execução (prova de posse). */
    attempts: number;
    conversation_id: string;
    contact_phone: string;
    created_by: string | null;
    quoted_message_id: string | null;
    media: unknown;
}

export interface LinhaDoEnvio {
    id: string;
    phone_number_id: string | null;
    connection_type: string | null;
    organization_id: string;
    accessToken: string | null | undefined;
}

/** Citação do primeiro arquivo (mesma regra do diálogo de anexo). */
async function citacaoDoAgendamento(
    supabase: SupabaseClient,
    agendamento: ContextoDoAgendamento,
): Promise<(CitacaoDoEnvio & { messageId: string }) | null> {
    if (!agendamento.quoted_message_id) return null;
    const { data: quotedMsg } = await supabase
        .from('messages')
        .select('whatsapp_message_id, content, direction, sender_phone, conversation_id')
        .eq('id', agendamento.quoted_message_id)
        .maybeSingle();
    // Citação de outra conversa seria contrabando de contexto: ignora.
    if (!quotedMsg?.whatsapp_message_id || quotedMsg.conversation_id !== agendamento.conversation_id) return null;
    return {
        messageId: agendamento.quoted_message_id,
        whatsappId: quotedMsg.whatsapp_message_id,
        content: quotedMsg.content,
        fromMe: quotedMsg.direction === 'outbound',
        participant: quotedMsg.sender_phone ? `${quotedMsg.sender_phone.replace(/\D/g, '')}@s.whatsapp.net` : null,
    };
}

type Progresso = 'ok' | 'perdido' | 'erro';

/** Grava o progresso e renova o relógio do reaper, só se a linha ainda é desta execução. */
async function gravarProgresso(
    supabase: SupabaseClient,
    agendamento: ContextoDoAgendamento,
    itens: ItemAgendado[],
): Promise<Progresso> {
    for (let tentativa = 0; tentativa < 3; tentativa++) {
        if (tentativa > 0) await new Promise((r) => setTimeout(r, 400 * tentativa));
        const { data, error } = await supabase
            .from('scheduled_messages')
            .update({ media: [...itens], last_attempt_at: new Date().toISOString() })
            .eq('id', agendamento.id)
            .eq('status', 'processing')
            .eq('attempts', agendamento.attempts)
            .select('id');
        if (!error) return (data?.length ?? 0) > 0 ? 'ok' : 'perdido';
        console.error('[ScheduledMessage] Falha ao gravar o progresso do arquivo:', error);
    }
    return 'erro';
}

/**
 * Manda os arquivos que faltam e devolve o wamid do último. Lança FalhaNoArquivo
 * (com o progresso já gravado), LotePausado ou AgendamentoPerdido; o chamador
 * decide o status.
 */
export async function enviarArquivosAgendados(
    supabase: SupabaseClient,
    agendamento: ContextoDoAgendamento,
    linha: LinhaDoEnvio,
    agora: () => number = Date.now,
): Promise<string> {
    const inicio = agora();
    const itens = lerItensAgendados(agendamento.media, agendamento.created_by);
    const faltam = pendentes(itens);
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const limitBytes = maxMediaBytes(Deno.env.get('MAX_MEDIA_BYTES'));
    // Só o 1º arquivo cita, e só se ele ainda não saiu numa tentativa anterior.
    const citacao = faltam[0] === 0 ? await citacaoDoAgendamento(supabase, agendamento) : null;
    let enviadosAgora = 0;

    for (const i of faltam) {
        // Pelo menos um arquivo por execução, para o lote sempre andar.
        if (enviadosAgora > 0 && agora() - inicio > ORCAMENTO_MS) {
            throw new LotePausado(enviadosAgora);
        }
        const item = itens[i];
        let wamid: string;
        let midia: Awaited<ReturnType<typeof prepararMidiaDoStorage>>;
        let mimeType: string;
        let viewOnce: boolean;
        let caption: string | null;
        const quoted = i === 0 ? citacao : null;
        try {
            midia = await prepararMidiaDoStorage(supabase, {
                storagePath: item.storage_path,
                filename: item.filename,
                mimeHint: item.mime_type,
                sizeHint: String(item.size_bytes),
                limitBytes,
                supabaseUrl,
                logTag: 'ScheduledMessage',
            });
            mimeType = corrigirMimeDeHtml(midia.mediaType, midia.mediaFilename, midia.mimeType);
            const visual = midia.mediaType === 'image' || midia.mediaType === 'video';
            // Ver uma vez só existe no QR (a Cloud API recusa); o front só marca lá.
            viewOnce = item.view_once === true && visual && linha.connection_type === 'qr';
            caption = item.caption?.trim() || null;

            wamid = await enviarMidiaAoWhatsApp({
                connectionType: linha.connection_type,
                phoneDbId: linha.id,
                metaPhoneNumberId: linha.phone_number_id,
                accessToken: linha.accessToken,
                to: agendamento.contact_phone,
                mediaType: midia.mediaType,
                mediaUrl: midia.mediaUrl,
                mimeType,
                filename: midia.mediaFilename,
                caption,
                viewOnce,
                quoted,
                timeoutMs: PRAZO_DO_ARQUIVO_MS,
                logTag: 'ScheduledMessage',
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const prefixo = `${progressoDoErro(itens)}${item.filename}: `;
            if (respostaAmbigua(message)) {
                throw new FalhaNoArquivo(
                    `${prefixo}o envio pode ter saído (${message}). Confira a conversa antes de agendar de novo.`,
                    false,
                );
            }
            // A frase original vai inteira no fim: o painel mostra qual arquivo parou e quantos já saíram.
            throw new FalhaNoArquivo(`${prefixo}${message}`, isRetryableError(message));
        }

        // Primeira escrita depois do envio: é a evidência de que este arquivo saiu.
        itens[i] = { ...item, whatsapp_message_id: wamid };
        enviadosAgora++;
        const progresso = await gravarProgresso(supabase, agendamento, itens);
        if (progresso === 'erro') {
            // Sem a evidência gravada, outra tentativa mandaria este arquivo de novo.
            await gravarMensagem(supabase, agendamento, linha, { item, wamid, midia, mimeType, viewOnce, caption, quoted });
            throw new FalhaNoArquivo(
                `${progressoDoErro(itens)}${item.filename} saiu, mas o progresso não foi gravado; os próximos não foram enviados para não duplicar.`,
                false,
            );
        }
        await gravarMensagem(supabase, agendamento, linha, { item, wamid, midia, mimeType, viewOnce, caption, quoted });
        if (progresso === 'perdido') throw new AgendamentoPerdido();
    }

    const ultimo = itens[itens.length - 1].whatsapp_message_id;
    if (!ultimo) {
        // Não acontece: todo item pendente acabou de ganhar wamid.
        throw new Error('Arquivos agendados sem wamid depois do envio');
    }
    return ultimo;
}

/** Linha em `messages` do arquivo que saiu, reativação da conversa e aviso message.sent. */
async function gravarMensagem(
    supabase: SupabaseClient,
    agendamento: ContextoDoAgendamento,
    linha: LinhaDoEnvio,
    envio: {
        item: ItemAgendado;
        wamid: string;
        midia: Awaited<ReturnType<typeof prepararMidiaDoStorage>>;
        mimeType: string;
        viewOnce: boolean;
        caption: string | null;
        quoted: (CitacaoDoEnvio & { messageId: string }) | null;
    },
): Promise<void> {
    const { item, wamid, midia, mimeType, viewOnce, caption, quoted } = envio;
    const visual = midia.mediaType === 'image' || midia.mediaType === 'video';
    const dims = midia.probedDims
        ?? (visual && item.width && item.height ? { width: item.width, height: item.height } : null);
    const thumbhash = midia.mediaType === 'image' ? await midia.thumbPromise : null;
    const metadata: Record<string, unknown> = {
        scheduled_message_id: agendamento.id,
        ...(viewOnce ? { view_once: true } : {}),
        ...(visual && dims
            ? {
                media: {
                    width: dims.width,
                    height: dims.height,
                    ...('seconds' in dims && dims.seconds ? { seconds: dims.seconds } : {}),
                    ...(thumbhash ? { thumbhash } : {}),
                    source: midia.probedDims ? 'bytes' : 'client',
                },
            }
            : {}),
    };
    const content = conteudoDaMidia(midia.mediaType, caption);
    const linhaDaMensagem = {
        conversation_id: agendamento.conversation_id,
        content,
        direction: 'outbound',
        sent_by: agendamento.created_by,
        whatsapp_message_id: wamid,
        message_type: midia.mediaType,
        media_url: midia.mediaUrl,
        media_mime_type: mimeType,
        media_filename: midia.mediaFilename,
        media_size_bytes: midia.mediaSizeBytes,
        quoted_message_id: quoted ? quoted.messageId : null,
        metadata,
    };
    const { data: saved, error: msgError } = await supabase
        .from('messages')
        .upsert(linhaDaMensagem, { onConflict: 'whatsapp_message_id,conversation_id', ignoreDuplicates: true })
        .select('id')
        .maybeSingle();

    if (msgError) {
        // O arquivo saiu e o wamid está gravado (o retry não reenvia): sem
        // linha em messages a bolha some. Evidência → alerta + replay.
        console.error('[ScheduledMessage] Error saving media message:', msgError);
        await logWriteFailure(supabase, {
            phoneNumberDbId: linha.id,
            toJid: String(agendamento.conversation_id),
            wamid,
            action: 'msg_write_failed',
            error: `${msgError.code ?? 'unknown'}: ${msgError.message}`,
            route: 'scheduled-message-execute',
            payload: linhaDaMensagem,
        });
    }

    await reativarConversa(supabase, agendamento.conversation_id);

    if (saved) {
        await emitMessageSent(supabase, {
            conversationId: agendamento.conversation_id,
            messageId: saved.id,
            whatsappMessageId: wamid,
            content,
            messageType: midia.mediaType,
            sentBy: agendamento.created_by,
            origin: 'scheduled',
            phoneNumberDbId: linha.id,
            organizationId: linha.organization_id,
            metaPhoneNumberId: linha.phone_number_id,
            media: {
                url: midia.mediaUrl,
                mime_type: mimeType,
                filename: midia.mediaFilename,
                size_bytes: midia.mediaSizeBytes,
            },
            quotedMessageId: quoted ? quoted.messageId : null,
            quotedWhatsappId: quoted?.whatsappId ?? null,
            quotedContent: quoted?.content ?? null,
        });
    }
}
