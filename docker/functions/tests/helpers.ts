// Apoio dos testes do roteador: JWT HS256 assinado com WebCrypto e atalhos de asserção.
export const SEGREDO = "segredo-de-teste-com-mais-de-trinta-e-dois-caracteres";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const texto = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

export async function assinarJwt(
  payload: Record<string, unknown>,
  { segredo = SEGREDO, alg = "HS256" }: { segredo?: string; alg?: string } = {},
): Promise<string> {
  const cabecalho = b64url(texto({ alg, typ: "JWT" }));
  const corpo = b64url(texto(payload));
  const chave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assinatura = new Uint8Array(
    await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(`${cabecalho}.${corpo}`)),
  );
  return `${cabecalho}.${corpo}.${b64url(assinatura)}`;
}

export const agora = () => Math.floor(Date.now() / 1000);

export function igual<T>(a: T, b: T, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
  }
}

export const FIXTURES = new URL("./fixtures", import.meta.url).pathname;
