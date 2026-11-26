import { Router, Request, Response } from 'express';
import sharp from 'sharp';
import { conditionalUpload, resolveImageUpload } from '../middleware/upload.js';

export const stickerRouter = Router();

const STICKER_SIZE = 512;
const STATIC_MAX_BYTES = 100 * 1024; // limite Meta p/ sticker estático
const ANIMATED_MAX_BYTES = 500 * 1024; // limite Meta p/ sticker animado

// Converte uma imagem (PNG/JPEG/WebP/GIF, inclusive animada) em sticker webp
// 512x512 dentro da spec da Meta. Vive aqui — e não no browser — porque
// canvas não codifica webp ANIMADO (mataria a animação no primeiro frame) e
// Safari < 17 não codifica webp nenhum; sharp resolve os dois casos.
// Aceita file (multipart) OU media_url (JSON), como as demais rotas de mídia.
stickerRouter.post('/convert', conditionalUpload, async (req: Request, res: Response) => {
    const resolved = await resolveImageUpload(req);
    if (!resolved.success) {
        res.status(400).json({ error: resolved.error });
        return;
    }

    try {
        const input = resolved.buffer;
        const meta = await sharp(input, { animated: true }).metadata();
        const isAnimated = (meta.pages ?? 1) > 1;
        const maxBytes = isAnimated ? ANIMATED_MAX_BYTES : STATIC_MAX_BYTES;

        // Qualidade adaptativa: primeiro resultado que couber no limite vence.
        let output: Buffer | null = null;
        for (const quality of [85, 75, 65, 55, 45]) {
            const candidate = await sharp(input, { animated: true })
                .resize(STICKER_SIZE, STICKER_SIZE, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                })
                .webp({ quality, effort: 4 })
                .toBuffer();
            if (candidate.length <= maxBytes) {
                output = candidate;
                break;
            }
        }

        if (!output) {
            res.status(422).json({
                error: isAnimated
                    ? 'Animation too complex for a sticker (over 500KB even at lowest quality)'
                    : 'Image too complex for a sticker (over 100KB even at lowest quality)',
            });
            return;
        }

        console.log(
            `[StickerConvert] ${input.length}B ${meta.format} → ${output.length}B webp (animated=${isAnimated})`
        );

        res.set({
            'Content-Type': 'image/webp',
            'X-Sticker-Animated': String(isAnimated),
        });
        res.send(output);
    } catch (error) {
        console.error('[StickerConvert] Conversion failed:', error);
        res.status(422).json({ error: 'Failed to convert image to sticker' });
    }
});
