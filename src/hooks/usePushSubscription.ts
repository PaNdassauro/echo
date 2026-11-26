import { useEffect } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { getRuntimeConfig } from "@/lib/runtimeConfig";

// Server-sent Web Push: registers this device with the browser vendor's push
// service and stores the subscription so the `send-web-push` edge function can
// deliver notifications even when the tab is fully closed. No-op when the
// browser lacks support, the VAPID key is not configured, or permission is not
// granted. Complements the in-tab layer (toast/sound) and the interim OS
// notification fired while the tab is merely backgrounded.

// A chave pública VAPID vem da configuração de runtime (/config.js); lida na hora
// do uso, não no import. Sem ela o push fica desligado.
const vapidPublicKey = (): string | null => getRuntimeConfig().vapidPublicKey;

const BrowserSubscriptionSchema = z.object({
    endpoint: z.string().url(),
    keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1),
    }),
});

function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
}

function pushSupported(): boolean {
    return (
        typeof window !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window
    );
}

// Returns true when the device is subscribed and stored (or already was).
async function subscribeAndStore(userId: string): Promise<boolean> {
    const vapidKey = vapidPublicKey();
    if (!pushSupported() || !vapidKey) return false;
    if (Notification.permission !== "granted") return false;

    try {
        const registration = await navigator.serviceWorker.ready;

        // Reuse the existing subscription when present; otherwise create one.
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidKey),
            });
        }

        const parsed = BrowserSubscriptionSchema.safeParse(subscription.toJSON());
        if (!parsed.success) {
            console.warn("[Push] Subscription payload inválido:", parsed.error.issues);
            return false;
        }

        const { endpoint, keys } = parsed.data;
        const { error } = await supabase.from("push_subscriptions").upsert(
            {
                user_id: userId,
                endpoint,
                p256dh: keys.p256dh,
                auth: keys.auth,
                user_agent: navigator.userAgent,
                last_seen_at: new Date().toISOString(),
            },
            { onConflict: "endpoint" }
        );
        if (error) {
            console.warn("[Push] Falha ao salvar subscription:", error.message);
            return false;
        }
        console.log("[Push] Dispositivo inscrito para notificações.");
        return true;
    } catch (err) {
        console.error("[Push] Erro ao inscrever:", err);
        return false;
    }
}

export const usePushSubscription = (userId: string | null): void => {
    useEffect(() => {
        if (!userId) return;
        if (!pushSupported()) {
            console.log("[Push] Navegador sem suporte a Web Push.");
            return;
        }
        if (!vapidPublicKey()) {
            console.warn("[Push] Chave VAPID pública não configurada (vapidPublicKey em /config.js) — assinatura desativada.");
            return;
        }

        // Permission is requested elsewhere (GlobalNotificationListener, on a
        // user gesture — also drives the interim OS notification). We subscribe
        // the moment it is granted: immediately if already granted, the instant
        // it flips to granted (Permissions API), and as a gesture fallback for
        // browsers that don't emit notification permission-change events.
        let done = false;
        let permissionStatus: PermissionStatus | null = null;

        const attempt = async () => {
            if (done || Notification.permission !== "granted") return;
            done = await subscribeAndStore(userId);
            if (done) {
                document.removeEventListener("click", attempt);
                document.removeEventListener("keydown", attempt);
                if (permissionStatus) permissionStatus.onchange = null;
            }
        };

        void attempt();

        if (navigator.permissions?.query) {
            navigator.permissions
                .query({ name: "notifications" as PermissionName })
                .then((status) => {
                    if (done) return;
                    permissionStatus = status;
                    status.onchange = () => void attempt();
                })
                .catch(() => { /* Permissions API unavailable for notifications */ });
        }

        document.addEventListener("click", attempt);
        document.addEventListener("keydown", attempt);
        return () => {
            document.removeEventListener("click", attempt);
            document.removeEventListener("keydown", attempt);
            if (permissionStatus) permissionStatus.onchange = null;
        };
    }, [userId]);
};
