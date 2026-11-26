import {
  CONFIG_PDF,
  erroDeLeituraTransitorio,
  lacunaImediata,
  leituraAtual,
  lerMidia,
  precisaLeitura,
  separarClasse,
  tipoDeLeitura,
  type Leitura,
  type LeituraIO,
  type MensagemMidia,
} from "../../supabase/functions/_shared/leitura-midia.ts";
import { compararIso, isoUs } from "../../supabase/functions/_shared/iso-us.ts";
import { mascarar } from "../../supabase/functions/_shared/mascara.ts";
import { caminhoDoAnexoNosso } from "../../supabase/functions/_shared/url-publica.ts";
import { CONFIG_RETRY, OpenAIErro, type Uso } from "../../supabase/functions/_shared/openai.ts";

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
CONFIG_RETRY.esperaMs = 5;

const AGORA = new Date("2026-10-15T15:00:00.000Z");
function midia(p: Partial<MensagemMidia> = {}): MensagemMidia {
  return {
    id: "m1",
    conversation_id: "c1",
    direction: "inbound",
    message_type: "audio",
    content: "[Áudio]",
    is_deleted: false,
    media_url: "https://abc.supabase.co/storage/v1/object/public/attachments/inbound/x.ogg",
    media_mime_type: "audio/ogg; codecs=opus",
    media_filename: null,
    media_size_bytes: 50_000,
    metadata: null,
    ...p,
  };
}
const leit = (p: Partial<Leitura> = {}): Record<string, unknown> => ({
  leitura: { v: 1, tipo: null, classe: null, texto: null, tentativas: 0, lacuna: false, custo_usd: 0, ...p },
});

// ---- tipoDeLeitura ----

Deno.test("tipoDeLeitura", () => {
  equal(tipoDeLeitura(midia({ message_type: "ptt" })), "audio");
  equal(tipoDeLeitura(midia({ message_type: "audio", media_mime_type: "audio/amr" })), "nao_suportado");
  equal(tipoDeLeitura(midia({ message_type: "image", media_mime_type: "image/jpeg" })), "imagem");
  equal(tipoDeLeitura(midia({ message_type: "image", media_mime_type: "image/heic" })), "nao_suportado");
  equal(tipoDeLeitura(midia({ message_type: "sticker", media_mime_type: "image/webp" })), "figurinha");
  equal(tipoDeLeitura(midia({ message_type: "video", media_mime_type: "video/mp4" })), "video");
  equal(tipoDeLeitura(midia({ message_type: "document", media_mime_type: "application/pdf", media_size_bytes: 1000 })), "pdf_texto");
  equal(tipoDeLeitura(midia({ message_type: "document", media_mime_type: "application/pdf", media_size_bytes: 5_000_000 })), "pdf_arquivo");
  equal(tipoDeLeitura(midia({ message_type: "document", media_mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })), "nao_suportado");
  equal(tipoDeLeitura(midia({ message_type: "document", media_mime_type: "application/zip" })), "nao_suportado");
  equal(tipoDeLeitura(midia({ message_type: "text" })), null);
  equal(tipoDeLeitura(midia({ message_type: "location" })), null);
});

// ---- precisaLeitura ----

Deno.test("precisaLeitura: sem leitura, 3 tentativas, lacuna, janela de 5 min", () => {
  equal(precisaLeitura(midia(), AGORA), true);
  equal(precisaLeitura(midia({ metadata: leit({ tentativas: 2 }) }), AGORA), true);
  equal(precisaLeitura(midia({ metadata: leit({ tentativas: 3 }) }), AGORA), false);
  equal(precisaLeitura(midia({ metadata: leit({ lacuna: true }) }), AGORA), false);
  equal(precisaLeitura(midia({ metadata: leit({ texto: "já lida" }) }), AGORA), false);
  const dois = isoUs(new Date(AGORA.getTime() - 2 * 60_000));
  const seis = isoUs(new Date(AGORA.getTime() - 6 * 60_000));
  equal(precisaLeitura(midia({ metadata: leit({ tentativas: 1, em_leitura_desde: dois } as Partial<Leitura>) }), AGORA), false);
  equal(precisaLeitura(midia({ metadata: leit({ tentativas: 1, em_leitura_desde: seis } as Partial<Leitura>) }), AGORA), true);
  equal(precisaLeitura(midia({ is_deleted: true }), AGORA), false);
  equal(precisaLeitura(midia({ media_url: null }), AGORA), false);
  equal(precisaLeitura(midia({ message_type: "text" }), AGORA), false);
});

Deno.test("leituraAtual valida com Zod; inválido → null; reserva parcial recebe defaults", () => {
  equal(leituraAtual(midia({ metadata: { leitura: "lixo" } })), null);
  equal(leituraAtual(midia({ metadata: { leitura: { v: 2 } } })), null);
  equal(leituraAtual(midia({ metadata: null })), null);
  const parcial = leituraAtual(midia({ metadata: { leitura: { v: 1, tentativas: 1, lacuna: false, custo_usd: 0, em_leitura_desde: "2026-10-15T14:00:00.000000Z", erro: null } } }));
  equal(parcial?.texto, null);
  equal(parcial?.tentativas, 1);
});

// ---- caminhoDoAnexoNosso (o que o download da leitura usa para achar o objeto no bucket) ----

Deno.test("caminhoDoAnexoNosso: caminho do bucket nas duas bases; URL assinada é externa", () => {
  const antes = [Deno.env.get("SUPABASE_URL"), Deno.env.get("ECHO_PUBLIC_URL")] as const;
  const restaurar = (nome: string, v: string | undefined) => (v === undefined ? Deno.env.delete(nome) : Deno.env.set(nome, v));
  try {
    // Supabase Cloud: só a SUPABASE_URL.
    Deno.env.set("SUPABASE_URL", "https://abc.supabase.co");
    Deno.env.delete("ECHO_PUBLIC_URL");
    const h = "https://abc.supabase.co/storage/v1/object";
    equal(caminhoDoAnexoNosso(`${h}/public/attachments/inbound/a%20b.ogg`), "inbound/a b.ogg");
    // Decisão 6: só `object/public/` é "anexo nosso"; URL assinada cai no fallback do download (host conferido).
    equal(caminhoDoAnexoNosso(`${h}/sign/attachments/outbound/u/x.pdf?token=eyJabc&t=1`), null);
    equal(caminhoDoAnexoNosso("https://evil.com/storage/v1/object/public/attachments/x.ogg"), null);
    equal(caminhoDoAnexoNosso(`${h}/public/outro-bucket/x.ogg`), null);
    equal(caminhoDoAnexoNosso(`${h}/public/attachments/../segredo`), null);
    equal(caminhoDoAnexoNosso("não é url"), null);
    // Docker: a URL gravada é a pública e a interna também é reconhecida.
    Deno.env.set("SUPABASE_URL", "http://gateway:8000");
    Deno.env.set("ECHO_PUBLIC_URL", "https://echo.example.com");
    equal(caminhoDoAnexoNosso("https://echo.example.com/storage/v1/object/public/attachments/inbound/a%20b.ogg"), "inbound/a b.ogg");
    equal(caminhoDoAnexoNosso("http://gateway:8000/storage/v1/object/public/attachments/inbound/a.ogg"), "inbound/a.ogg");
    equal(caminhoDoAnexoNosso("https://abc.supabase.co/storage/v1/object/public/attachments/x.ogg"), null);
  } finally {
    restaurar("SUPABASE_URL", antes[0]);
    restaurar("ECHO_PUBLIC_URL", antes[1]);
  }
});

// ---- mascarar ----

Deno.test("mascarar: CPF com e sem pontuação", () => {
  equal(mascarar("cpf 123.456.789-09 ok"), "cpf [CPF] ok");
  equal(mascarar("cpf 12345678909 ok"), "cpf [CPF] ok");
  // 11 dígitos que não fecham o dígito verificador (telefone) não são CPF
  equal(mascarar("fone 11987654321"), "fone 11987654321");
  equal(mascarar("111.111.111-11"), "[CPF]"); // pontuado é sempre mascarado
});

Deno.test("mascarar: EMV Pix e chave", () => {
  const emv = "00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-4266141740005204000053039865802BR5913Fulano de Tal6009SAO PAULO62070503***63041D3D";
  equal(mascarar(`pague: ${emv} obrigado`), "pague: [PIX] obrigado");
  equal(mascarar("minha chave pix: maria@exemplo.com"), "minha chave pix: [PIX]");
  equal(mascarar("chave pix 11987654321"), "chave pix [PIX]");
});

Deno.test("mascarar: cartão com Luhn válido e inválido", () => {
  equal(mascarar("cartão 4111 1111 1111 1111 validade"), "cartão [CARTAO] validade");
  equal(mascarar("4111111111111111"), "[CARTAO]");
  equal(mascarar("4111 1111 1111 1112"), "4111 1111 1111 1112"); // Luhn inválido
  equal(mascarar("telefone 5511987654321"), "telefone 5511987654321"); // telefone BR com DDI não vira cartão
});

// ---- isoUs ----

Deno.test("isoUs: PostgREST com µs, +00:00, sem fração, Date, offsets", () => {
  equal(isoUs("2026-10-14T10:00:00.123456+00:00"), "2026-10-14T10:00:00.123456Z");
  equal(isoUs("2026-10-14T10:00:00.123456Z"), "2026-10-14T10:00:00.123456Z");
  equal(isoUs("2026-10-14T10:00:00+00:00"), "2026-10-14T10:00:00.000000Z");
  equal(isoUs("2026-10-14 10:00:00.5+00"), "2026-10-14T10:00:00.500000Z");
  equal(isoUs("2026-10-14T10:00:00.123456789Z"), "2026-10-14T10:00:00.123456Z");
  equal(isoUs(new Date("2026-10-14T10:00:00.123Z")), "2026-10-14T10:00:00.123000Z");
  equal(isoUs("2026-10-14T10:00:00.000001-03:00"), "2026-10-14T13:00:00.000001Z");
  let erro = "";
  try { isoUs("ontem"); } catch (e) { erro = (e as Error).message; }
  equal(erro.startsWith("isoUs: formato inválido"), true);
  try { isoUs("2026-13-45T10:00:00Z"); erro = ""; } catch (e) { erro = (e as Error).message; }
  equal(erro.startsWith("isoUs"), true);
});

Deno.test("compararIso: µs e largura fixa", () => {
  equal(compararIso("2026-10-14T10:00:00.123456Z", "2026-10-14T10:00:00.123457+00:00"), -1);
  equal(compararIso("2026-10-14T10:00:00.123456Z", "2026-10-14T10:00:00.123456+00:00"), 0);
  equal(compararIso("2026-10-14T10:00:01+00:00", "2026-10-14T10:00:00.999999Z"), 1);
});

// ---- separarClasse ----

Deno.test("separarClasse", () => {
  equal(separarClasse("CLASSE: comprovante\nPix R$ 10"), { classe: "comprovante", resto: "Pix R$ 10" });
  equal(separarClasse("classe: Documento\nx"), { classe: "documento", resto: "x" });
  equal(separarClasse("sem classe\nx"), { classe: "outro", resto: "sem classe\nx" });
  equal(separarClasse("CLASSE: inventada\nx"), { classe: "outro", resto: "x" });
});

// ---- lerMidia com IO falso e fetch falso ----

class IOFalso implements LeituraIO {
  eventos: string[] = [];
  gravadas: Leitura[] = [];
  constructor(
    private opts: { reserva?: Leitura | null; falhaDownload?: boolean; bytes?: Uint8Array; tentativas?: number } = {},
  ) {}
  reservar(id: string): Promise<Leitura | null> {
    this.eventos.push(`reservar:${id}`);
    if (this.opts.reserva === null) return Promise.resolve(null);
    return Promise.resolve(this.opts.reserva ?? {
      v: 1, tipo: null, classe: null, texto: null, modelo: null, segundos: null, tokens: null, custo_usd: 0,
      at: null, erro: null, tentativas: this.opts.tentativas ?? 1, em_leitura_desde: "2026-10-15T15:00:00.000000Z", lacuna: false,
    });
  }
  baixar(): Promise<Uint8Array> {
    this.eventos.push("baixar");
    if (this.opts.falhaDownload) return Promise.reject(new Error("HTTP 404"));
    return Promise.resolve(this.opts.bytes ?? new Uint8Array([1, 2, 3]));
  }
  gravar(_id: string, l: Leitura): Promise<void> {
    this.eventos.push("gravar");
    this.gravadas.push(l);
    return Promise.resolve();
  }
}

const originalFetch = globalThis.fetch;
function fetchFalso(respostas: Array<Response | Error>) {
  const corpos: string[] = [];
  let i = 0;
  globalThis.fetch = ((_u: string | URL | Request, init?: RequestInit) => {
    corpos.push(init?.body instanceof FormData ? "form" : String(init?.body ?? ""));
    const r = respostas[Math.min(i++, respostas.length - 1)];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r.clone());
  }) as typeof fetch;
  return { corpos, restaurar: () => (globalThis.fetch = originalFetch) };
}
const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const respostaTexto = (texto: string) => jsonRes({ id: "r", status: "completed", output_text: texto, usage: { input_tokens: 1000, output_tokens: 100 } });
const quieto = () => {
  const e = console.error;
  console.error = () => {};
  return () => (console.error = e);
};

Deno.test("lerMidia: reserva ANTES de baixar; reserva null não baixa", async () => {
  const f = fetchFalso([jsonRes({ text: "bom dia", usage: { seconds: 6 } })]);
  try {
    const io = new IOFalso();
    const l = await lerMidia(io, midia(), "sk-x", { agora: () => AGORA });
    equal(io.eventos, ["reservar:m1", "baixar", "gravar"]);
    equal(l.texto, "bom dia");
    equal(l.tipo, "audio");
    equal(l.segundos, 6);
    equal(l.classe, null);
    equal(l.erro, null);
    equal(l.em_leitura_desde, null);
    equal(l.at, "2026-10-15T15:00:00.000000Z");
    equal(l.modelo, "gpt-transcribe");
    equal(Math.abs(l.custo_usd - (6 / 60) * 0.0045) < 1e-12, true);
    equal(io.gravadas.length, 1);
    // reserva null
    const io2 = new IOFalso({ reserva: null });
    const l2 = await lerMidia(io2, midia(), "sk-x");
    equal(io2.eventos, ["reservar:m1"]);
    equal(l2.texto, null);
    equal(f.corpos.length, 1);
  } finally {
    f.restaurar();
  }
});

Deno.test("lerMidia: falha de download incrementa e vira lacuna na 3ª", async () => {
  const restaura = quieto();
  try {
    const io1 = new IOFalso({ falhaDownload: true, tentativas: 1 });
    const l1 = await lerMidia(io1, midia(), "sk-x");
    equal(l1.erro, "download");
    equal(l1.lacuna, false);
    equal(l1.tentativas, 1);
    equal(l1.em_leitura_desde, "2026-10-15T15:00:00.000000Z");
    const io3 = new IOFalso({ falhaDownload: true, tentativas: 3 });
    const l3 = await lerMidia(io3, midia(), "sk-x");
    equal(l3.erro, "download");
    equal(l3.lacuna, true);
    equal(io3.gravadas.length, 1);
  } finally {
    restaura();
  }
});

Deno.test("lerMidia: docx e imagem outbound viram lacuna sem tentativa", async () => {
  const io = new IOFalso();
  const docx = await lerMidia(io, midia({ message_type: "document", media_mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "k");
  equal(docx.lacuna, true);
  equal(docx.erro, "nao_suportado");
  equal(docx.tentativas, 0);
  const img = await lerMidia(io, midia({ message_type: "image", direction: "outbound", media_mime_type: "image/jpeg" }), "k");
  equal(img.lacuna, true);
  equal(img.erro, "imagem_enviada");
  equal(img.tentativas, 0);
  const grande = await lerMidia(io, midia({ media_size_bytes: 4 * 1024 * 1024 }), "k");
  equal(grande.erro, "grande_demais");
  equal(grande.lacuna, true);
  equal(io.eventos.includes("baixar"), false);
  equal(io.eventos.filter((e) => e.startsWith("reservar")).length, 0);
  equal(lacunaImediata(midia()), null);
});

Deno.test("lerMidia: imagem extrai CLASSE, mascara e manda input_image high", async () => {
  const f = fetchFalso([respostaTexto("CLASSE: comprovante\nPix de R$ 500 para CPF 123.456.789-09 em 14/10")]);
  try {
    const io = new IOFalso();
    const l = await lerMidia(io, midia({ message_type: "image", content: "[Imagem]", media_mime_type: "image/jpeg" }), "sk-x", { agora: () => AGORA });
    equal(l.tipo, "imagem");
    equal(l.classe, "comprovante");
    equal(l.texto, "Pix de R$ 500 para CPF [CPF] em 14/10");
    equal(l.modelo, "gpt-6-luna");
    equal(l.tokens, { entrada: 1000, saida: 100 });
    const corpo = JSON.parse(f.corpos[0]);
    equal(corpo.store, false);
    equal(corpo.max_output_tokens, 900);
    equal(corpo.reasoning, { effort: "none" });
    const partes = corpo.input[0].content;
    const imagem = partes.find((p: { type: string }) => p.type === "input_image");
    equal(imagem.detail, "high");
    equal(imagem.image_url.startsWith("data:image/jpeg;base64,"), true);
    equal(corpo.instructions.includes("CLASSE: "), true);
  } finally {
    f.restaurar();
  }
});

Deno.test("lerMidia: figurinha usa detail low", async () => {
  const f = fetchFalso([respostaTexto("CLASSE: foto\nfigurinha de coração")]);
  try {
    const l = await lerMidia(new IOFalso(), midia({ message_type: "sticker", media_mime_type: "image/webp" }), "k");
    equal(l.tipo, "figurinha");
    equal(JSON.parse(f.corpos[0]).input[0].content[1].detail, "low");
  } finally {
    f.restaurar();
  }
});

Deno.test("lerMidia: classe documento grava texto null", async () => {
  const f = fetchFalso([respostaTexto("CLASSE: documento\nPASSAPORTE AB123456")]);
  try {
    const io = new IOFalso();
    const l = await lerMidia(io, midia({ message_type: "image", media_mime_type: "image/png" }), "k");
    equal(l.classe, "documento");
    equal(l.texto, null);
    equal(io.gravadas[0].texto, null);
  } finally {
    f.restaurar();
  }
});

Deno.test("lerMidia: PDF com texto extraído vira pdf_texto; escaneado vai como input_file", async () => {
  const original = CONFIG_PDF.carregar;
  const longo = "Recibo de pagamento Pix emitido ".repeat(20);
  CONFIG_PDF.carregar = () => Promise.resolve({
    getDocumentProxy: () => Promise.resolve({
      numPages: 20,
      getPage: () => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [{ str: longo }] }) }),
    }),
  });
  let f = fetchFalso([respostaTexto("CLASSE: comprovante\nPix R$ 10 pago")]);
  try {
    const l = await lerMidia(new IOFalso(), midia({ message_type: "document", media_mime_type: "application/pdf", media_filename: "recibo.pdf", media_size_bytes: 100_000 }), "k");
    equal(l.tipo, "pdf_texto");
    equal(l.classe, "comprovante");
    const partes = JSON.parse(f.corpos[0]).input[0].content;
    equal(partes.length, 1);
    equal(partes[0].type, "input_text");
  } finally {
    f.restaurar();
  }
  // escaneado: texto curto
  CONFIG_PDF.carregar = () => Promise.resolve({
    getDocumentProxy: () => Promise.resolve({
      numPages: 1,
      getPage: () => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [{ str: "x" }] }) }),
    }),
  });
  f = fetchFalso([respostaTexto("CLASSE: outro\nContrato assinado")]);
  try {
    const l = await lerMidia(new IOFalso(), midia({ message_type: "document", media_mime_type: "application/pdf", media_filename: "v.pdf", media_size_bytes: 100_000 }), "k");
    equal(l.tipo, "pdf_arquivo");
    const partes = JSON.parse(f.corpos[0]).input[0].content;
    const arq = partes.find((p: { type: string }) => p.type === "input_file");
    equal(arq.file_data.startsWith("data:application/pdf;base64,"), true);
    equal(arq.filename, "v.pdf");
  } finally {
    f.restaurar();
  }
  // acima de 2 MB: nem tenta extrair
  let extraiu = false;
  CONFIG_PDF.carregar = () => { extraiu = true; return original(); };
  f = fetchFalso([respostaTexto("CLASSE: outro\nok")]);
  try {
    const l = await lerMidia(new IOFalso({ bytes: new Uint8Array(3 * 1024 * 1024) }), midia({ message_type: "document", media_mime_type: "application/pdf", media_size_bytes: 3 * 1024 * 1024 }), "k");
    equal(l.tipo, "pdf_arquivo");
    equal(extraiu, false);
  } finally {
    f.restaurar();
    CONFIG_PDF.carregar = original;
  }
});

Deno.test("lerMidia: PDF enviado pela equipe também é lido", async () => {
  const original = CONFIG_PDF.carregar;
  CONFIG_PDF.carregar = () => Promise.reject(new Error("sem lib"));
  const f = fetchFalso([respostaTexto("CLASSE: comprovante\npago")]);
  const restaura = quieto();
  try {
    const l = await lerMidia(new IOFalso(), midia({ message_type: "document", direction: "outbound", media_mime_type: "application/pdf", media_size_bytes: 1000 }), "k");
    equal(l.classe, "comprovante");
    equal(l.tipo, "pdf_arquivo"); // lib fora do ar: cai no arquivo
  } finally {
    restaura();
    f.restaurar();
    CONFIG_PDF.carregar = original;
  }
});

Deno.test("lerMidia: erro grava só o código, nunca o texto do provedor", async () => {
  const f = fetchFalso([jsonRes({ error: { code: "x", message: "Incorrect API key sk-proj-SEGREDO" } }, 503), jsonRes({ error: { message: "sk-proj-SEGREDO" } }, 503)]);
  const restaura = quieto();
  try {
    const io = new IOFalso({ tentativas: 1 });
    const l = await lerMidia(io, midia({ message_type: "image", media_mime_type: "image/jpeg" }), "k");
    equal(l.erro, "http_503");
    equal(JSON.stringify(io.gravadas[0]).includes("SEGREDO"), false);
    equal(l.lacuna, false);
  } finally {
    restaura();
    f.restaurar();
  }
});

Deno.test("lerMidia: 5xx da OpenAI devolve a tentativa e não vira lacuna (queda não consome as 3 tentativas)", async () => {
  const f = fetchFalso([jsonRes({}, 503), jsonRes({}, 503)]);
  const restaura = quieto();
  try {
    const io = new IOFalso({ tentativas: 3 });
    const l = await lerMidia(io, midia({ message_type: "image", media_mime_type: "image/jpeg" }), "k");
    equal(l.erro, "http_503");
    equal(l.tentativas, 2);
    equal(l.lacuna, false);
    equal(erroDeLeituraTransitorio("http_503") && erroDeLeituraTransitorio("rede") && !erroDeLeituraTransitorio("timeout") && !erroDeLeituraTransitorio("download") && !erroDeLeituraTransitorio("http_400"), true);
  } finally {
    restaura();
    f.restaurar();
  }
});

Deno.test("lerMidia: sem_saldo e chave_invalida relançam (e devolvem a tentativa)", async () => {
  const restaura = quieto();
  try {
    let f = fetchFalso([jsonRes({ error: { code: "insufficient_quota" } }, 429)]);
    let io = new IOFalso({ tentativas: 2 });
    let erro: unknown = null;
    try { await lerMidia(io, midia({ message_type: "image", media_mime_type: "image/jpeg" }), "k"); } catch (e) { erro = e; }
    f.restaurar();
    equal((erro as OpenAIErro).codigo, "sem_saldo");
    equal(io.gravadas[0].tentativas, 1);
    equal(io.gravadas[0].lacuna, false);
    f = fetchFalso([jsonRes({}, 401)]);
    io = new IOFalso();
    erro = null;
    try { await lerMidia(io, midia(), "k"); } catch (e) { erro = e; }
    f.restaurar();
    equal((erro as OpenAIErro).codigo, "chave_invalida");
    equal(io.gravadas.length, 1);
  } finally {
    restaura();
  }
});

Deno.test("lerMidia: timeout de transcrição conta o custo estimado e não relança", async () => {
  const f = fetchFalso([new DOMException("t", "TimeoutError")]);
  const restaura = quieto();
  try {
    const usos: Uso[] = [];
    const io = new IOFalso({ bytes: new Uint8Array(120_000) });
    const l = await lerMidia(io, midia(), "k", { aoUsar: (u) => { usos.push(u); } });
    equal(l.erro, "timeout");
    equal(l.custo_usd > 0, true);
    equal(usos.length, 1);
    equal(usos[0].custo_usd, l.custo_usd);
  } finally {
    restaura();
    f.restaurar();
  }
});

Deno.test("lerMidia: timeout gasta a tentativa e na 3a vira lacuna (não é queda de infra)", async () => {
  const f = fetchFalso([new DOMException("t", "TimeoutError")]);
  const restaura = quieto();
  try {
    const io = new IOFalso({ bytes: new Uint8Array(120_000), tentativas: 3 });
    const l = await lerMidia(io, midia(), "k");
    equal(l.erro, "timeout");
    equal(l.tentativas, 3);
    equal(l.lacuna, true);
  } finally {
    restaura();
    f.restaurar();
  }
});

Deno.test("lerMidia: reservarCusto falso → não reserva, não baixa, erro teto_gasto", async () => {
  const io = new IOFalso();
  let estimado = 0;
  const l = await lerMidia(io, midia(), "k", { reservarCusto: (v) => { estimado = v; return Promise.resolve(false); } });
  equal(l.erro, "teto_gasto");
  equal(io.eventos, []);
  equal(estimado > 0, true);
});

Deno.test("lerMidia: aoUsar acumula no custo_usd com o anterior", async () => {
  const f = fetchFalso([respostaTexto("CLASSE: foto\nx")]);
  try {
    const reserva: Leitura = {
      v: 1, tipo: null, classe: null, texto: null, modelo: null, segundos: null, tokens: null, custo_usd: 0.01,
      at: null, erro: null, tentativas: 2, em_leitura_desde: null, lacuna: false,
    };
    const usos: Uso[] = [];
    const l = await lerMidia(new IOFalso({ reserva }), midia({ message_type: "image", media_mime_type: "image/jpeg" }), "k", { aoUsar: (u) => { usos.push(u); } });
    equal(usos.length, 1);
    equal(Math.abs(l.custo_usd - (0.01 + usos[0].custo_usd)) < 1e-12, true);
  } finally {
    f.restaurar();
  }
});

Deno.test("lerMidia: download pesa mais que o limite pelos bytes → grande_demais", async () => {
  const io = new IOFalso({ bytes: new Uint8Array(3 * 1024 * 1024 + 1) });
  const l = await lerMidia(io, midia({ media_size_bytes: null }), "k");
  equal(l.erro, "grande_demais");
  equal(l.lacuna, true);
});

Deno.test("precisaLeitura: mídia que falhou espera 5 min antes de outra tentativa", () => {
  const falhou = (desde: string) =>
    midia({ metadata: leit({ tentativas: 1, erro: "timeout", em_leitura_desde: desde } as Partial<Leitura>) });
  const agoraMs = AGORA.getTime();
  const dois = new Date(agoraMs - 2 * 60_000).toISOString().replace("Z", "000Z");
  const seis = new Date(agoraMs - 6 * 60_000).toISOString().replace("Z", "000Z");
  equal(precisaLeitura(falhou(dois), AGORA), false);
  equal(precisaLeitura(falhou(seis), AGORA), true);
  // leitura em voo (sem erro: a invocação morreu depois da reserva e antes do desfecho) também espera
  const emVoo = (desde: string, tentativas = 1) =>
    midia({ metadata: leit({ tentativas, em_leitura_desde: desde } as Partial<Leitura>) });
  equal(precisaLeitura(emVoo(dois), AGORA), false);
  // passados 5 min vira nova tentativa; na 3ª tentativa gasta não tenta mais (vira lacuna)
  equal(precisaLeitura(emVoo(seis), AGORA), true);
  equal(precisaLeitura(emVoo(dois, 3), AGORA), false);
});

Deno.test("precisaLeitura: leitura concluída com texto null (classe documento) é final", () => {
  const lida = midia({
    message_type: "image",
    media_mime_type: "image/jpeg",
    metadata: leit({ tipo: "imagem", classe: "documento", texto: null, tentativas: 1, at: "2026-10-15T14:59:00.000000Z", em_leitura_desde: null } as Partial<Leitura>),
  });
  equal(precisaLeitura(lida, AGORA), false);
});
