/**
 * Parser de mensagens de localização.
 *
 * Fontes, em ordem de preferência:
 * 1. metadata.location {lat,lng,name?,address?,live?} — formato novo (QR e CA)
 * 2. content "[Localização: lat, lng]" — legado da Cloud API (lat/lng só na string)
 *
 * Parse falho → null, e a bolha cai no render de texto cru (nunca bolha vazia).
 */
import { z } from "zod";

const LocationMetadataSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  name: z.string().nullish(),
  address: z.string().nullish(),
  live: z.boolean().nullish(),
});

export interface ParsedLocation {
  lat: number;
  lng: number;
  name: string | null;
  address: string | null;
  live: boolean;
}

const CONTENT_PATTERN = /^\[Localiza(?:ç|c)(?:ã|a)o:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]$/;

export function parseLocationMessage(
  content: string | null | undefined,
  metadata: unknown,
): ParsedLocation | null {
  // 1. metadata.location (estruturado)
  if (metadata && typeof metadata === "object" && "location" in metadata) {
    const parsed = LocationMetadataSchema.safeParse(
      (metadata as { location: unknown }).location,
    );
    if (parsed.success) {
      return {
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        name: parsed.data.name ?? null,
        address: parsed.data.address ?? null,
        live: parsed.data.live ?? false,
      };
    }
  }

  // 2. string legada
  const match = content?.trim().match(CONTENT_PATTERN);
  if (match) {
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng, name: null, address: null, live: false };
    }
  }

  return null;
}

export function locationMapsUrl(location: ParsedLocation): string {
  return `https://maps.google.com/?q=${location.lat},${location.lng}`;
}

/**
 * Interpreta o que o usuário cola no dialog de envio de localização:
 * "lat, lng" cru ou link do Google Maps (`@lat,lng`, `?q=lat,lng`,
 * `?q=loc:lat,lng`, `!3dlat!4dlng` de links de place).
 */
export function parseCoordinateInput(input: string): { lat: number; lng: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const candidates: Array<[string, string]> = [];

  const at = trimmed.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) candidates.push([at[1], at[2]]);

  const q = trimmed.match(/[?&]q=(?:loc:)?(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i);
  if (q) candidates.push([q[1], q[2]]);

  const bang = trimmed.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (bang) candidates.push([bang[1], bang[2]]);

  const raw = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (raw) candidates.push([raw[1], raw[2]]);

  for (const [latStr, lngStr] of candidates) {
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
  }
  return null;
}
