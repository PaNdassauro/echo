// Peças do roteador de funções: verify_jwt por função e respostas de erro (WebCrypto e Zod).
//
// verify_jwt por função, como o gateway do Supabase hospedado:
//   - OPTIONS passa sempre (preflight do navegador não leva Authorization).
//   - Exige `Authorization: Bearer <jwt>` HS256 assinado com JWT_SECRET e não vencido (exp) nem futuro (nbf).
//     A anon key também passa (é um JWT válido), igual ao hospedado: a função decide o resto.
//   - Função ausente do mapa = verify_jwt true (fecha por padrão: ver `exigeJwt`).
// Isto é LIMITE DE SEGURANÇA: _shared/authz.ts (isInternalCaller com jwtVerifiedByGateway) aceita a claim
// role=service_role sem conferir assinatura nas funções verify_jwt=true, porque confia que o gateway conferiu.

import { z } from "https://esm.sh/zod@3.23.8";

export type VerifyMap = Record<string, boolean>;

export const ERROR_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Expose-Headers": "sb-error-code",
};

export function erro(status: number, code: string, message: string): Response {
  return Response.json({ code, message, msg: message }, {
    status,
    headers: { ...ERROR_CORS_HEADERS, "sb-error-code": code },
  });
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function criarVerificador(segredo: string) {
  if (!segredo || segredo.length < 32) throw new Error("JWT_SECRET ausente ou curto (< 32)");
  const chave = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // null = válido; string = motivo da recusa (vai para o log e para o corpo do 401).
  return async function verificar(req: Request): Promise<string | null> {
    const auth = (req.headers.get("authorization") ?? "").trim();
    if (!auth) return "UNAUTHORIZED_NO_AUTH_HEADER";
    const m = auth.match(/^bearer\s+(\S+)$/i);
    if (!m) return "UNAUTHORIZED_INVALID_JWT_FORMAT";
    const partes = m[1].split(".");
    if (partes.length !== 3) return "UNAUTHORIZED_INVALID_JWT_FORMAT";
    let header: { alg?: string };
    let payload: { exp?: number; nbf?: number };
    try {
      header = JSON.parse(new TextDecoder().decode(b64urlDecode(partes[0])));
      payload = JSON.parse(new TextDecoder().decode(b64urlDecode(partes[1])));
    } catch {
      return "UNAUTHORIZED_INVALID_JWT_FORMAT";
    }
    if (header.alg !== "HS256") return "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM";
    let ok = false;
    try {
      ok = await crypto.subtle.verify(
        "HMAC",
        await chave,
        b64urlDecode(partes[2]),
        new TextEncoder().encode(`${partes[0]}.${partes[1]}`),
      );
    } catch {
      ok = false;
    }
    if (!ok) return "UNAUTHORIZED_LEGACY_JWT";
    const agora = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < agora) return "UNAUTHORIZED_LEGACY_JWT_EXPIRED";
    if (typeof payload.nbf === "number" && payload.nbf > agora + 30) return "UNAUTHORIZED_LEGACY_JWT_NBF";
    return null;
  };
}

// /<função>/resto?query -> "função". Nomes válidos: os de pasta do Supabase.
export function nomeDaFuncao(url: URL): string | null {
  const nome = url.pathname.split("/")[1] ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(nome) ? nome : null;
}

/** A função exige JWT? Fora do mapa = sim (a função que o mapa não conhece nunca fica aberta). */
export function exigeJwt(mapa: VerifyMap, nome: string): boolean {
  return Object.hasOwn(mapa, nome) ? mapa[nome] : true;
}

const MapaSchema = z.record(z.string().min(1), z.boolean());

/** Valida o JSON `{ "<função>": boolean }` gerado no build por gen-verify-jwt-map.mjs. */
export function parseMapa(texto: string, origem: string): VerifyMap {
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    throw new Error(`mapa inválido (JSON): ${origem}`);
  }
  const lido = MapaSchema.safeParse(bruto);
  if (!lido.success) {
    throw new Error(`mapa inválido: ${origem} (${lido.error.issues.map((i) => i.path.join(".") || "raiz").join(", ")})`);
  }
  return lido.data;
}

export function lerMapa(caminho: string): VerifyMap {
  return parseMapa(Deno.readTextFileSync(caminho), caminho);
}
