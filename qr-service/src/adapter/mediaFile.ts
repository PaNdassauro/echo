/**
 * Escreve o stream de mídia decifrada num arquivo, com teto de bytes.
 * Compartilhado pelos adapters em `downloadMediaToFile`.
 */
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MediaDownloadError } from './WhatsAppClient.js';

export async function writeMediaStreamToFile(stream: Readable, filePath: string, maxBytes?: number): Promise<number> {
    let total = 0;
    const cap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            total += chunk.length;
            if (maxBytes && total > maxBytes) {
                callback(new MediaDownloadError(`download passou de ${maxBytes} bytes`, 'too_large'));
                return;
            }
            callback(null, chunk);
        },
    });
    try {
        await pipeline(stream, cap, createWriteStream(filePath));
        return total;
    } catch (error) {
        await rm(filePath, { force: true }).catch(() => undefined);
        throw error;
    }
}
