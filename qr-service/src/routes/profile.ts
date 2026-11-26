import { Router, Request, Response } from 'express';
import { sessionManager } from '../lib/session.js';
import { requirePhoneAccess } from '../middleware/auth.js';
import { conditionalUpload, resolveImageUpload } from '../middleware/upload.js';

export const profileRouter = Router();

// Every profile route targets a :phoneNumberId — enforce the caller's org owns it.
profileRouter.param('phoneNumberId', requirePhoneAccess);

// Get the connected number's own WhatsApp profile (display name + picture)
profileRouter.get('/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;

    try {
        const result = await sessionManager.getOwnProfile(phoneNumberId);

        if (result.success) {
            res.json({
                success: true,
                profile: result.profile
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// Update the connected number's profile picture (multipart file OR media_url in JSON body)
profileRouter.put('/:phoneNumberId/picture', conditionalUpload, async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;

    try {
        const image = await resolveImageUpload(req);
        if (!image.success) {
            return res.status(400).json({ error: image.error });
        }

        const result = await sessionManager.updateOwnProfilePicture(phoneNumberId, image.buffer);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error updating profile picture:', error);
        res.status(500).json({ error: 'Failed to update profile picture' });
    }
});

// Update the connected number's display name
profileRouter.patch('/:phoneNumberId/name', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { name } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name required' });
    }

    try {
        const result = await sessionManager.updateOwnProfileName(phoneNumberId, name.trim());

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error updating profile name:', error);
        res.status(500).json({ error: 'Failed to update profile name' });
    }
});
