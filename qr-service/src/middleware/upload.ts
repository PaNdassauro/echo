import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import express from 'express';
import { fetchMediaUrl } from '../lib/url-guard.js';

// Multer for file uploads (memory storage)
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Middleware that conditionally applies multer or JSON parser based on Content-Type
export const conditionalUpload = (req: Request, res: Response, next: NextFunction) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
        // Parse JSON body
        express.json()(req, res, next);
    } else {
        // Use multer for multipart/form-data
        upload.single('file')(req, res, next);
    }
};

// Resolve an image from multipart upload (file) or JSON body (media_url) — shared by picture routes
export async function resolveImageUpload(
    req: Request
): Promise<{ success: true; buffer: Buffer } | { success: false; error: string }> {
    const file = req.file;
    const mediaUrl = req.body?.media_url;

    if (file) {
        if (!file.mimetype.startsWith('image/')) {
            return { success: false, error: 'file must be an image' };
        }
        return { success: true, buffer: file.buffer };
    }

    if (!mediaUrl || typeof mediaUrl !== 'string') {
        return { success: false, error: 'file OR media_url is required' };
    }

    try {
        // SSRF guard: reject non-http(s) and private/link-local/metadata hosts
        // (anexo do nosso Storage vai pela URL interna, sem guarda: ver fetchMediaUrl).
        const response = await fetchMediaUrl(mediaUrl);
        if (!response.ok) {
            return { success: false, error: `Failed to fetch media from URL: ${response.status}` };
        }
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
            return { success: false, error: 'media_url must point to an image' };
        }
        return { success: true, buffer: Buffer.from(await response.arrayBuffer()) };
    } catch (err) {
        return {
            success: false,
            error: `Failed to fetch media: ${err instanceof Error ? err.message : 'unknown error'}`,
        };
    }
}
