import { spawn } from 'node:child_process';

/**
 * Transcodifica qualquer áudio (MP3, M4A/AAC, WebM, WAV, OGG, ...) para OGG/Opus,
 * o formato exigido pelo WhatsApp em mensagens de voz (PTT). O WhatsApp só mostra
 * a "bolinha com onda" quando o áudio é opus; outros formatos chegam como anexo de
 * arquivo (player quadrado) ou são descartados silenciosamente. O Baileys NÃO
 * transcodifica o codec sozinho — ele envia o buffer como está —, então a conversão
 * precisa acontecer aqui.
 *
 * Usa o ffmpeg instalado na imagem, lendo o buffer por stdin (pipe:0) e devolvendo
 * o resultado por stdout (pipe:1) — sem tocar em disco.
 *
 * Parâmetros alinhados com o que o WhatsApp usa para voz: opus mono a 48kHz.
 */
export async function transcodeToOpus(input: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', 'pipe:0',
            '-vn', // descarta qualquer stream de vídeo/capa embutida
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-ar', '48000',
            '-ac', '1',
            '-f', 'ogg',
            'pipe:1',
        ];

        const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

        const out: Buffer[] = [];
        const err: Buffer[] = [];

        ff.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        ff.stderr.on('data', (chunk: Buffer) => err.push(chunk));

        ff.on('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));

        ff.on('close', (code) => {
            const output = Buffer.concat(out);
            if (code === 0 && output.length > 0) {
                resolve(output);
            } else {
                const detail = Buffer.concat(err).toString().slice(0, 500);
                reject(new Error(`ffmpeg exited ${code}: ${detail || 'no output produced'}`));
            }
        });

        // Se o ffmpeg fechar cedo (ex.: input inválido), o write no stdin dispara EPIPE;
        // ignoramos aqui porque o handler de 'close' já reporta o erro real.
        ff.stdin.on('error', () => { /* noop */ });
        ff.stdin.write(input);
        ff.stdin.end();
    });
}
