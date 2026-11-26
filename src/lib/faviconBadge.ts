/**
 * Favicon badge utility — draws an unread count bubble over the base favicon
 * and swaps <link rel="icon"> href with a data URL. Pure DOM, no React.
 */

const DEFAULT_ICON = "/echo-icon.png";
const CANVAS_SIZE = 64;

let baseImage: HTMLImageElement | null = null;
let baseImageLoaded = false;
let originalHref: string | null = null;

const getIconLink = (): HTMLLinkElement => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        link.type = "image/png";
        document.head.appendChild(link);
    }
    return link;
};

export const initFaviconBadge = (iconUrl: string = DEFAULT_ICON): Promise<void> => {
    return new Promise((resolve) => {
        if (baseImageLoaded) {
            resolve();
            return;
        }

        const link = getIconLink();
        if (originalHref === null) {
            originalHref = link.href || iconUrl;
        }

        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            baseImage = img;
            baseImageLoaded = true;
            resolve();
        };
        img.onerror = () => {
            // Fail silently — badge just won't render, original favicon stays
            resolve();
        };
        img.src = iconUrl;
    });
};

export const setFaviconBadge = (count: number): void => {
    if (count <= 0) {
        clearFaviconBadge();
        return;
    }

    if (!baseImage || !baseImageLoaded) {
        // Base not ready yet — skip this update; a later call will catch up
        return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Base icon
    ctx.drawImage(baseImage, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Badge circle (top-right corner, compact)
    const radius = 14;
    const cx = CANVAS_SIZE - radius;
    const cy = radius;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#ef4444";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    // Count text
    const text = count > 99 ? "99+" : String(count);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = text.length >= 3 ? "bold 13px sans-serif" : "bold 19px sans-serif";
    ctx.fillText(text, cx, cy + 1);

    const link = getIconLink();
    link.href = canvas.toDataURL("image/png");
};

export const clearFaviconBadge = (): void => {
    const link = getIconLink();
    link.href = originalHref ?? DEFAULT_ICON;
};
