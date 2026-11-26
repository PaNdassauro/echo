import { useCallback, useEffect } from "react";

const SOUND_URL = "/universfield-system-notification-02-352442.mp3";
const COOLDOWN_MS = 3000;

// Module-level singleton (survives re-renders, shared across all hook consumers)
let audioElement: HTMLAudioElement | null = null;
let unlocked = false;
let lastPlayedAt = 0;

function getAudio(): HTMLAudioElement {
    if (!audioElement) {
        audioElement = new Audio(SOUND_URL);
        audioElement.preload = "auto";
    }
    return audioElement;
}

function unlockAudio(onSuccess?: () => void) {
    if (unlocked) {
        onSuccess?.();
        return;
    }
    const audio = getAudio();
    audio.volume = 0;
    audio.play().then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 1;
        unlocked = true;
        onSuccess?.();
    }).catch(() => {
        // Autoplay still blocked — keep the listeners attached to retry on next gesture
    });
}

export const useNotificationSound = () => {
    // Unlock audio on user interaction. Keep the listeners attached until the
    // unlock actually succeeds — using { once: true } dropped them after the
    // first gesture even when play() was still blocked, so a PWA reload (which
    // resets `unlocked` to false) could leave the tab permanently muted.
    useEffect(() => {
        if (unlocked) return;

        const handler = () => {
            unlockAudio(() => {
                document.removeEventListener("click", handler);
                document.removeEventListener("keydown", handler);
            });
        };
        document.addEventListener("click", handler);
        document.addEventListener("keydown", handler);

        return () => {
            document.removeEventListener("click", handler);
            document.removeEventListener("keydown", handler);
        };
    }, []);

    const playNotificationSound = useCallback(() => {
        // Check user preference
        if (localStorage.getItem("notificationSoundEnabled") === "false") return;

        // Cooldown to avoid spam
        const now = Date.now();
        if (now - lastPlayedAt < COOLDOWN_MS) return;
        lastPlayedAt = now;

        const audio = getAudio();
        audio.currentTime = 0;
        audio.play().catch(() => {
            // Autoplay blocked or audio error — silent fallback
        });
    }, []);

    return { playNotificationSound };
};
