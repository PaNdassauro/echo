// OS-level (native) notifications for when the tab is backgrounded but the
// browser process is still alive. This is the interim layer: it does NOT cover
// a fully closed tab — that requires server-sent Web Push via the service
// worker (see send-web-push). Toast/sound remain the in-tab layer.

export function canUseNativeNotifications(): boolean {
    return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission {
    return canUseNativeNotifications() ? Notification.permission : "denied";
}

// Ask for permission once. Browsers prefer this to be triggered by a user
// gesture, so callers should invoke it from a click/keydown handler. No-op if
// the user already granted or denied.
export async function ensureNotificationPermission(): Promise<NotificationPermission> {
    if (!canUseNativeNotifications()) return "denied";
    if (Notification.permission !== "default") return Notification.permission;
    try {
        return await Notification.requestPermission();
    } catch {
        return Notification.permission;
    }
}

interface NativeNotificationOptions {
    body?: string;
    tag?: string;
    onClick?: () => void;
}

// Fire a native notification. No-op unless permission is granted. Falls back
// silently on browsers that only allow notifications through the SW
// registration (e.g. Android Chrome), where the constructor throws.
export function showNativeNotification(title: string, options: NativeNotificationOptions = {}): void {
    if (!canUseNativeNotifications() || Notification.permission !== "granted") return;
    const { onClick, ...rest } = options;
    try {
        const notification = new Notification(title, { ...rest, icon: "/favicon.ico" });
        if (onClick) {
            notification.onclick = () => {
                window.focus();
                onClick();
                notification.close();
            };
        }
    } catch {
        // Constructor unavailable in this context — server-sent Web Push covers it.
    }
}
