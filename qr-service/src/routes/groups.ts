import { Router, Request, Response } from 'express';
import { sessionManager } from '../lib/session.js';
import type { GroupCreateSettings } from '../services/SessionManager.js';
import { requirePhoneAccess } from '../middleware/auth.js';
import { conditionalUpload, resolveImageUpload } from '../middleware/upload.js';

export const groupsRouter = Router();

const GROUP_SETTINGS = ['announcement', 'not_announcement', 'locked', 'unlocked'] as const;
const MEMBER_ADD_MODES = ['admin_add', 'all_member_add'] as const;
const JOIN_APPROVAL_MODES = ['on', 'off'] as const;
// Values WhatsApp accepts for disappearing messages: off, 24h, 7d, 90d
const EPHEMERAL_DURATIONS = [0, 86400, 604800, 7776000] as const;

const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us');

// Validates the optional `settings` object accepted by POST /create — returns an error message or null
function validateCreateSettings(settings: unknown): string | null {
    if (settings === undefined) return null;
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
        return 'settings must be an object';
    }

    const s = settings as Record<string, unknown>;

    if (s.announce !== undefined && typeof s.announce !== 'boolean') {
        return 'settings.announce must be a boolean';
    }
    if (s.restrict !== undefined && typeof s.restrict !== 'boolean') {
        return 'settings.restrict must be a boolean';
    }
    if (s.memberAddMode !== undefined && !MEMBER_ADD_MODES.includes(s.memberAddMode as never)) {
        return `settings.memberAddMode must be one of: ${MEMBER_ADD_MODES.join(', ')}`;
    }
    if (s.joinApprovalMode !== undefined && !JOIN_APPROVAL_MODES.includes(s.joinApprovalMode as never)) {
        return `settings.joinApprovalMode must be one of: ${JOIN_APPROVAL_MODES.join(', ')}`;
    }
    if (s.ephemeralDuration !== undefined && !EPHEMERAL_DURATIONS.includes(s.ephemeralDuration as never)) {
        return `settings.ephemeralDuration must be one of: ${EPHEMERAL_DURATIONS.join(', ')} (seconds)`;
    }

    return null;
}

// Every group route targets a :phoneNumberId — enforce the caller's org owns it.
groupsRouter.param('phoneNumberId', requirePhoneAccess);

// List all groups for a session
groupsRouter.get('/:phoneNumberId', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;

    try {
        const result = await sessionManager.getGroups(phoneNumberId);

        if (result.success) {
            res.json({
                success: true,
                groups: result.groups
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error fetching groups:', error);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

// Join a group via invite code or full https://chat.whatsapp.com/<code> URL
// Registered before GET /:phoneNumberId/:groupJid so 'join'/'invite-info' never match as groupJid
groupsRouter.post('/:phoneNumberId/join', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { code } = req.body;

    if (typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ error: 'code required (invite code or URL)' });
    }

    try {
        const result = await sessionManager.acceptGroupInvite(phoneNumberId, code);

        if (result.success) {
            res.json({
                success: true,
                groupJid: result.groupJid
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error joining group:', error);
        res.status(500).json({ error: 'Failed to join group' });
    }
});

// Preview a group from an invite code without joining
groupsRouter.get('/:phoneNumberId/invite-info/:code', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const code = req.params.code as string;

    try {
        const result = await sessionManager.getGroupInviteInfo(phoneNumberId, code);

        if (result.success) {
            res.json({
                success: true,
                group: result.group
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error fetching invite info:', error);
        res.status(500).json({ error: 'Failed to fetch invite info' });
    }
});

// Get group metadata (details + members)
groupsRouter.get('/:phoneNumberId/:groupJid', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    // ?picture=0: pula a consulta da foto (o autocomplete de menção só quer participantes)
    const includePicture = req.query.picture !== '0';

    try {
        const result = await sessionManager.getGroupMetadata(phoneNumberId, groupJid, { includePicture });

        if (result.success) {
            res.json({
                success: true,
                group: result.group
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error fetching group metadata:', error);
        res.status(500).json({ error: 'Failed to fetch group metadata' });
    }
});

// Create a new group (optionally with initial settings — see validateCreateSettings)
groupsRouter.post('/:phoneNumberId/create', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const { name, participants, settings } = req.body;

    if (!name || !Array.isArray(participants)) {
        return res.status(400).json({ error: 'name and participants array required' });
    }

    const settingsError = validateCreateSettings(settings);
    if (settingsError) {
        return res.status(400).json({ error: settingsError });
    }

    try {
        const result = await sessionManager.createGroup(
            phoneNumberId,
            name,
            participants,
            settings as GroupCreateSettings | undefined
        );

        if (result.success) {
            res.json({
                success: true,
                groupJid: result.groupJid,
                // Group was created even if some settings failed — surface those per key
                ...(result.settingsErrors ? { settingsErrors: result.settingsErrors } : {})
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error creating group:', error);
        res.status(500).json({ error: 'Failed to create group' });
    }
});

// Add participants to group
groupsRouter.post('/:phoneNumberId/:groupJid/participants', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { participants } = req.body;

    if (!Array.isArray(participants) || participants.length === 0) {
        return res.status(400).json({ error: 'participants array required' });
    }

    try {
        const result = await sessionManager.addGroupParticipants(phoneNumberId, groupJid, participants);

        if (result.success) {
            res.json({
                success: true,
                inviteRequired: result.inviteRequired,
                details: result.details
            });
        } else {
            // 403 = recusa nossa (linha não é admin / grupo restrito), antes de falar
            // com o WhatsApp. 400 segue sendo erro devolvido pelo WhatsApp.
            res.status(result.code ? 403 : 400).json({
                success: false,
                error: result.error,
                ...(result.code ? { code: result.code } : {})
            });
        }
    } catch (error) {
        console.error('Error adding participants:', error);
        res.status(500).json({ error: 'Failed to add participants' });
    }
});

// Send a group invite message to a contact whose privacy settings block direct add
groupsRouter.post('/:phoneNumberId/:groupJid/invite-message', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { jid, code, expiration, text } = req.body;

    if (typeof jid !== 'string' || !jid || typeof code !== 'string' || !code) {
        return res.status(400).json({ error: 'jid and code required' });
    }

    if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'text required' });
    }

    try {
        const result = await sessionManager.sendGroupInviteMessage(
            phoneNumberId,
            groupJid,
            jid,
            code,
            Number(expiration) || 0,
            text.trim()
        );

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error sending group invite message:', error);
        res.status(500).json({ error: 'Failed to send group invite message' });
    }
});

// Remove participants from group
groupsRouter.delete('/:phoneNumberId/:groupJid/participants', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { participants } = req.body;

    if (!Array.isArray(participants) || participants.length === 0) {
        return res.status(400).json({ error: 'participants array required' });
    }

    try {
        const result = await sessionManager.removeGroupParticipants(phoneNumberId, groupJid, participants);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error removing participants:', error);
        res.status(500).json({ error: 'Failed to remove participants' });
    }
});

// Update group subject (name)
groupsRouter.patch('/:phoneNumberId/:groupJid/subject', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { subject } = req.body;

    if (!subject) {
        return res.status(400).json({ error: 'subject required' });
    }

    try {
        const result = await sessionManager.updateGroupSubject(phoneNumberId, groupJid, subject);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error updating group subject:', error);
        res.status(500).json({ error: 'Failed to update group subject' });
    }
});

// Update group picture (multipart file OR media_url in JSON body)
groupsRouter.put('/:phoneNumberId/:groupJid/picture', conditionalUpload, async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;

    try {
        const image = await resolveImageUpload(req);
        if (!image.success) {
            return res.status(400).json({ error: image.error });
        }

        const result = await sessionManager.updateGroupPicture(phoneNumberId, groupJid, image.buffer);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error updating group picture:', error);
        res.status(500).json({ error: 'Failed to update group picture' });
    }
});

// Update group description
groupsRouter.patch('/:phoneNumberId/:groupJid/description', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { description } = req.body;

    // Empty string is valid (clears the description)
    if (typeof description !== 'string') {
        return res.status(400).json({ error: 'description required' });
    }

    try {
        const result = await sessionManager.updateGroupDescription(phoneNumberId, groupJid, description);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error updating group description:', error);
        res.status(500).json({ error: 'Failed to update group description' });
    }
});

// Promote participants to admin
groupsRouter.post('/:phoneNumberId/:groupJid/promote', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { participants } = req.body;

    if (!Array.isArray(participants) || participants.length === 0) {
        return res.status(400).json({ error: 'participants array required' });
    }

    try {
        const result = await sessionManager.promoteGroupParticipants(phoneNumberId, groupJid, participants);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error promoting participants:', error);
        res.status(500).json({ error: 'Failed to promote participants' });
    }
});

// Demote participants from admin
groupsRouter.post('/:phoneNumberId/:groupJid/demote', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { participants } = req.body;

    if (!Array.isArray(participants) || participants.length === 0) {
        return res.status(400).json({ error: 'participants array required' });
    }

    try {
        const result = await sessionManager.demoteGroupParticipants(phoneNumberId, groupJid, participants);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error demoting participants:', error);
        res.status(500).json({ error: 'Failed to demote participants' });
    }
});

// Leave group
groupsRouter.delete('/:phoneNumberId/:groupJid/leave', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;

    try {
        const result = await sessionManager.leaveGroup(phoneNumberId, groupJid);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error leaving group:', error);
        res.status(500).json({ error: 'Failed to leave group' });
    }
});

// ============================================
// GROUP SETTINGS & INVITES
// ============================================

// Update group settings (who can send messages / edit group info)
groupsRouter.patch('/:phoneNumberId/:groupJid/settings', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { setting } = req.body;

    if (!isGroupJid(groupJid)) {
        return res.status(400).json({ error: 'groupJid must end with @g.us' });
    }

    if (!GROUP_SETTINGS.includes(setting)) {
        return res.status(400).json({ error: `setting must be one of: ${GROUP_SETTINGS.join(', ')}` });
    }

    try {
        const result = await sessionManager.updateGroupSetting(phoneNumberId, groupJid, setting);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error updating group setting:', error);
        res.status(500).json({ error: 'Failed to update group setting' });
    }
});

// Update who can add members to the group
groupsRouter.patch('/:phoneNumberId/:groupJid/member-add-mode', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { mode } = req.body;

    if (!isGroupJid(groupJid)) {
        return res.status(400).json({ error: 'groupJid must end with @g.us' });
    }

    if (!MEMBER_ADD_MODES.includes(mode)) {
        return res.status(400).json({ error: `mode must be one of: ${MEMBER_ADD_MODES.join(', ')}` });
    }

    try {
        const result = await sessionManager.updateGroupMemberAddMode(phoneNumberId, groupJid, mode);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error updating member add mode:', error);
        res.status(500).json({ error: 'Failed to update member add mode' });
    }
});

// Update join approval mode (admin approval to enter the group)
groupsRouter.patch('/:phoneNumberId/:groupJid/join-approval', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { mode } = req.body;

    if (!isGroupJid(groupJid)) {
        return res.status(400).json({ error: 'groupJid must end with @g.us' });
    }

    if (!JOIN_APPROVAL_MODES.includes(mode)) {
        return res.status(400).json({ error: `mode must be one of: ${JOIN_APPROVAL_MODES.join(', ')}` });
    }

    try {
        const result = await sessionManager.updateGroupJoinApprovalMode(phoneNumberId, groupJid, mode);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error updating join approval mode:', error);
        res.status(500).json({ error: 'Failed to update join approval mode' });
    }
});

// Update disappearing messages duration
groupsRouter.patch('/:phoneNumberId/:groupJid/ephemeral', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { expiration } = req.body;

    if (!isGroupJid(groupJid)) {
        return res.status(400).json({ error: 'groupJid must end with @g.us' });
    }

    if (!EPHEMERAL_DURATIONS.includes(expiration)) {
        return res.status(400).json({ error: `expiration must be one of: ${EPHEMERAL_DURATIONS.join(', ')} (seconds)` });
    }

    try {
        const result = await sessionManager.updateGroupEphemeral(phoneNumberId, groupJid, expiration);

        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error updating ephemeral setting:', error);
        res.status(500).json({ error: 'Failed to update ephemeral setting' });
    }
});

// Get group invite code/link
groupsRouter.get('/:phoneNumberId/:groupJid/invite-code', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;

    if (!isGroupJid(groupJid)) {
        return res.status(400).json({ error: 'groupJid must end with @g.us' });
    }

    try {
        const result = await sessionManager.getGroupInviteCode(phoneNumberId, groupJid);

        if (result.success) {
            res.json({
                success: true,
                code: result.code,
                inviteUrl: result.inviteUrl
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error fetching invite code:', error);
        res.status(500).json({ error: 'Failed to fetch invite code' });
    }
});

// Revoke group invite link (returns the new one)
groupsRouter.post('/:phoneNumberId/:groupJid/invite-code/revoke', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;

    if (!isGroupJid(groupJid)) {
        return res.status(400).json({ error: 'groupJid must end with @g.us' });
    }

    try {
        const result = await sessionManager.revokeGroupInviteCode(phoneNumberId, groupJid);

        if (result.success) {
            res.json({
                success: true,
                code: result.code,
                inviteUrl: result.inviteUrl
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error revoking invite code:', error);
        res.status(500).json({ error: 'Failed to revoke invite code' });
    }
});

// List pending join requests
groupsRouter.get('/:phoneNumberId/:groupJid/join-requests', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;

    if (!isGroupJid(groupJid)) {
        return res.status(400).json({ error: 'groupJid must end with @g.us' });
    }

    try {
        const result = await sessionManager.getGroupJoinRequests(phoneNumberId, groupJid);

        if (result.success) {
            res.json({
                success: true,
                requests: result.requests
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error fetching join requests:', error);
        res.status(500).json({ error: 'Failed to fetch join requests' });
    }
});

// Approve/reject pending join requests
groupsRouter.post('/:phoneNumberId/:groupJid/join-requests', async (req: Request, res: Response) => {
    const phoneNumberId = req.params.phoneNumberId as string;
    const groupJid = req.params.groupJid as string;
    const { participants, action } = req.body;

    if (!isGroupJid(groupJid)) {
        return res.status(400).json({ error: 'groupJid must end with @g.us' });
    }

    if (!Array.isArray(participants) || participants.length === 0) {
        return res.status(400).json({ error: 'participants array required' });
    }

    if (action !== 'approve' && action !== 'reject') {
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    }

    try {
        const result = await sessionManager.updateGroupJoinRequests(phoneNumberId, groupJid, participants, action);

        if (result.success) {
            res.json({
                success: true,
                details: result.details
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error,
                details: result.details
            });
        }
    } catch (error) {
        console.error('Error updating join requests:', error);
        res.status(500).json({ error: 'Failed to update join requests' });
    }
});
