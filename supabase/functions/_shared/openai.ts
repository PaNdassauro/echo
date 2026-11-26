// Cliente OpenAI (copiloto, leitura de mídia e transcrição): Responses API com `store: false`
// e transcrição de áudio. Modelo fixo no código, nunca herda o default do
// `ai-provider.ts`. Nada de `/v1/files` nem `previous_response_id`.
import { z } from 'https://esm.sh/zod@3.23.8';

export const MODELOS = {
  // análise da conversa (copiloto): gpt-6.1-terra; visão e PDF usam o luna, mais barato
  analise: 'gpt-6.1-terra',
  visao: 'gpt-6-luna',
  pdf: 'gpt-6-luna',
  transcricao: 'gpt-transcribe',
} as const;

// USD por 1M tokens.
export const PRECOS: Record<string, { entrada: number; cacheLeitura: number; cacheEscrita: number; saida: number }> = {
  'gpt-6-luna': { entrada: 0.1, cacheLeitura: 0.01, cacheEscrita: 0.125, saida: 0.5 },
  // developers.openai.com/api/docs/pricing (04/11/2026), contexto ≤ 272K, cache de 30 min
  'gpt-6.1-terra': { entrada: 1, cacheLeitura: 0.05, cacheEscrita: 1.25, saida: 5 },
};
export const PRECO_TRANSCRICAO_USD_POR_MIN: Record<string, number> = { 'gpt-transcribe': 0.0045 };
export const BYTES_POR_SEGUNDO_AUDIO = 2000; // opus/ogg de voz ~16 kbps; usado só para estimar

export type Esforco = 'none' | 'low' | 'medium';

export interface Uso {
  modelo: string;
  tokens_entrada: number; // input_tokens (total)
  tokens_cache_leitura: number; // input_tokens_details.cached_tokens
  tokens_cache_escrita: number; // input_tokens_details.cache_write_tokens (0 se ausente)
  tokens_saida: number; // output_tokens (inclui raciocínio)
  segundos_audio: number | null;
  custo_usd: number;
  ms: number;
}

export type CodigoOpenAI =
  | 'timeout'
  | 'rede'
  | 'http'
  | 'json_invalido'
  | 'incompleta'
  | 'sem_saldo'
  | 'chave_invalida'
  | 'recusa';

/** message = 'AI provider error: <codigo>' + (status ? ` (HTTP ${status})` : '').
 *  NUNCA inclui o texto do provedor (um 401 da OpenAI traz trecho da chave). */
export class OpenAIErro extends Error {
  constructor(readonly status: number | null, readonly transitorio: boolean, readonly codigo: CodigoOpenAI) {
    super(`AI provider error: ${codigo}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'OpenAIErro';
  }
}

export type ParteEntrada =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'low' | 'high' } // data URL base64
  | { type: 'input_file'; filename: string; file_data: string }; // 'data:application/pdf;base64,...'

export interface ResponderOpcoes {
  chave: string;
  modelo: string; // sempre de MODELOS
  esforco: Esforco;
  instrucoes: string; // vai em `instructions` (prefixo fixo → cache)
  entrada: Array<{ role: 'user' | 'developer'; content: string | ParteEntrada[] }>;
  schema?: { nome: string; schema: Record<string, unknown> }; // text.format json_schema strict
  maxSaida?: number; // max_output_tokens, default 4000
  cacheKey?: string; // prompt_cache_key
  timeoutMs?: number; // default 30_000; quem chama passa min(padrão, prazo restante − margem)
  tentativas?: number; // default 2 (1 retry); a 2ª só se ainda couber no timeoutMs restante
  serviceTier?: 'default' | 'flex'; // default 'default'
  aoUsar?: (u: Uso) => Promise<void> | void; // chamado ASSIM QUE a resposta chega, antes de qualquer parse
}

export interface TranscreverOpcoes {
  chave: string;
  bytes: Uint8Array;
  mime: string;
  nomeArquivo: string; // 'audio.ogg', 'video.mp4'…
  timeoutMs?: number; // default 60_000
  aoUsar?: (u: Uso) => Promise<void> | void;
}

/** Ajustável em teste para não esperar 1,5 s de verdade. */
export const CONFIG_RETRY = { esperaMs: 1500, esperaMaxMs: 5000, sobraMinimaMs: 3000 };

const URL_RESPONSES = 'https://api.openai.com/v1/responses';
const URL_TRANSCRICAO = 'https://api.openai.com/v1/audio/transcriptions';

// ---- Custos ----

export function custoTokens(
  modelo: string,
  t: { entrada: number; cacheLeitura: number; cacheEscrita: number; saida: number },
): number {
  const p = PRECOS[modelo];
  if (!p) {
    console.warn(`[openai] modelo sem preço: ${modelo}`);
    return 0;
  }
  const semCache = Math.max(0, t.entrada - t.cacheLeitura - t.cacheEscrita);
  return (semCache * p.entrada + t.cacheLeitura * p.cacheLeitura + t.cacheEscrita * p.cacheEscrita + t.saida * p.saida) /
    1e6;
}

/** Estimativa conservadora para reservar no teto antes da chamada. */
export function estimarCusto(
  e:
    | { tipo: 'texto'; modelo: string; charsEntrada: number; maxSaida: number }
    | { tipo: 'imagem'; modelo: string; maxSaida: number }
    | { tipo: 'pdf'; modelo: string; bytes: number; maxSaida: number }
    | { tipo: 'transcricao'; bytes: number },
): number {
  const tokens = (entrada: number, modelo: string, saida: number) =>
    custoTokens(modelo, { entrada: Math.ceil(entrada), cacheLeitura: 0, cacheEscrita: 0, saida });
  switch (e.tipo) {
    case 'texto':
      return tokens(e.charsEntrada / 3.5, e.modelo, e.maxSaida);
    case 'imagem':
      return tokens(1600, e.modelo, e.maxSaida);
    case 'pdf':
      return tokens((e.bytes / 102_400) * 1500, e.modelo, e.maxSaida);
    case 'transcricao':
      return (e.bytes / BYTES_POR_SEGUNDO_AUDIO / 60) * PRECO_TRANSCRICAO_USD_POR_MIN[MODELOS.transcricao];
  }
}

/** Base64 em blocos (múltiplos de 3 bytes, sem spread gigante). */
export function base64DeBytes(bytes: Uint8Array): string {
  const BLOCO = 32766; // ~32 KB e divisível por 3: cada bloco codifica sem padding no meio
  const partes: string[] = [];
  for (let i = 0; i < bytes.length; i += BLOCO) {
    const sub = bytes.subarray(i, i + BLOCO);
    let bin = '';
    for (let j = 0; j < sub.length; j++) bin += String.fromCharCode(sub[j]);
    partes.push(btoa(bin));
  }
  return partes.join('');
}

// ---- Resposta do provedor (validada) ----

const UsoBrutoSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  input_tokens_details: z
    .object({ cached_tokens: z.number().optional(), cache_write_tokens: z.number().optional() })
    .partial()
    .nullish(),
  seconds: z.number().optional(),
  duration: z.number().optional(),
}).passthrough();

const RespostaSchema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  output_text: z.string().nullish(),
  output: z
    .array(
      z.object({
        content: z
          .array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough())
          .nullish(),
      }).passthrough(),
    )
    .nullish(),
  usage: UsoBrutoSchema.nullish(),
}).passthrough();

const ErroSchema = z.object({
  error: z.object({ code: z.string().nullish(), type: z.string().nullish() }).passthrough().nullish(),
}).passthrough();

function usoDe(
  modelo: string,
  bruto: z.infer<typeof UsoBrutoSchema> | null | undefined,
  ms: number,
): Uso {
  const entrada = bruto?.input_tokens ?? 0;
  const cacheLeitura = bruto?.input_tokens_details?.cached_tokens ?? 0;
  const cacheEscrita = bruto?.input_tokens_details?.cache_write_tokens ?? 0;
  const saida = bruto?.output_tokens ?? 0;
  return {
    modelo,
    tokens_entrada: entrada,
    tokens_cache_leitura: cacheLeitura,
    tokens_cache_escrita: cacheEscrita,
    tokens_saida: saida,
    segundos_audio: null,
    custo_usd: custoTokens(modelo, { entrada, cacheLeitura, cacheEscrita, saida }),
    ms,
  };
}

function ehTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

/** Lê só o código do erro (nunca devolve texto do provedor). */
async function codigoDoErro(res: Response): Promise<string | null> {
  try {
    const j = ErroSchema.safeParse(await res.json());
    if (!j.success) return null;
    const { code, type } = j.data.error ?? {};
    // O código pode estar em `code` ou em `type`: o de conta/billing ganha de um genérico.
    if (code && CODIGOS_SEM_SALDO.has(code)) return code;
    if (type && CODIGOS_SEM_SALDO.has(type)) return type;
    return code ?? type ?? null;
  } catch {
    return null;
  }
}

const CODIGOS_SEM_SALDO = new Set([
  'billing_not_active',
  'insufficient_quota',
  'account_deactivated',
  'billing_hard_limit_reached',
  'access_terminated',
]);

function erroDeStatus(status: number, codigoProvedor: string | null): OpenAIErro {
  // Conta/billing sem saldo vem como 429 (ou 402/403) com code/type próprio: nunca é rate limit.
  if (codigoProvedor && CODIGOS_SEM_SALDO.has(codigoProvedor)) return new OpenAIErro(status, false, 'sem_saldo');
  if (status === 402) return new OpenAIErro(status, false, 'sem_saldo');
  if (status === 401 || status === 403) return new OpenAIErro(status, false, 'chave_invalida');
  const transitorio = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  return new OpenAIErro(status, transitorio, 'http');
}

/** Relógio monotônico: `agoraMs()` anda para trás quando o relógio do sistema é corrigido (WSL, NTP) e dava `ms=-1233`. */
const agoraMs = (): number => performance.now();

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function esperaDoRetry(res: Response | null): number {
  const ra = res?.headers.get('retry-after');
  const s = ra ? Number(ra) : NaN;
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, CONFIG_RETRY.esperaMaxMs);
  return CONFIG_RETRY.esperaMs;
}

// ---- responder ----

export async function responder(
  o: ResponderOpcoes,
): Promise<{ texto: string; json: unknown | null; uso: Uso; respostaId: string }> {
  const tentativas = Math.max(1, o.tentativas ?? 2);
  const timeoutTotal = o.timeoutMs ?? 30_000;
  const inicio = agoraMs();

  const corpo: Record<string, unknown> = {
    model: o.modelo,
    instructions: o.instrucoes,
    input: o.entrada,
    reasoning: { effort: o.esforco },
    store: false,
    max_output_tokens: o.maxSaida ?? 4000,
  };
  if (o.cacheKey) corpo.prompt_cache_key = o.cacheKey;
  if (o.serviceTier) corpo.service_tier = o.serviceTier;
  if (o.schema) {
    corpo.text = { format: { type: 'json_schema', name: o.schema.nome, schema: o.schema.schema, strict: true } };
  }
  const corpoJson = JSON.stringify(corpo);

  let ultimoErro: OpenAIErro | null = null;
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const restante = timeoutTotal - (agoraMs() - inicio);
    if (restante <= 0) throw ultimoErro ?? new OpenAIErro(null, true, 'timeout');

    const t0 = agoraMs();
    let res: Response | null = null;
    let falha: OpenAIErro;
    try {
      res = await fetch(URL_RESPONSES, {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.chave}`, 'Content-Type': 'application/json' },
        body: corpoJson,
        signal: AbortSignal.timeout(restante),
      });
    } catch (e) {
      const ms = agoraMs() - t0;
      if (ehTimeout(e)) {
        // Timeout não repete: a resposta pode ter sido cobrada, quem chama decide.
        console.error(`[openai] responder codigo=timeout ms=${ms}`);
        throw new OpenAIErro(null, true, 'timeout');
      }
      console.error(`[openai] responder codigo=rede ms=${ms}`);
      falha = new OpenAIErro(null, true, 'rede');
      res = null;
      ultimoErro = falha;
    }

    if (res) {
      const ms = agoraMs() - t0;
      if (res.ok) {
        let brutoJson: unknown;
        try {
          brutoJson = await res.json();
        } catch (e) {
          if (ehTimeout(e)) throw new OpenAIErro(null, true, 'timeout');
          throw new OpenAIErro(res.status, false, 'json_invalido');
        }
        const r = RespostaSchema.safeParse(brutoJson);
        if (!r.success) throw new OpenAIErro(res.status, false, 'json_invalido');
        const uso = usoDe(o.modelo, r.data.usage, ms);
        // Assim que a resposta chega, antes de qualquer parse: o custo já foi cobrado.
        if (o.aoUsar) await o.aoUsar(uso);

        if (r.data.status === 'incomplete') {
          console.error(`[openai] responder codigo=incompleta ms=${ms}`);
          throw new OpenAIErro(res.status, false, 'incompleta');
        }
        const conteudos = (r.data.output ?? []).flatMap((it) => it.content ?? []);
        if (conteudos.some((c) => c.type === 'refusal')) {
          console.error(`[openai] responder codigo=recusa ms=${ms}`);
          throw new OpenAIErro(res.status, false, 'recusa');
        }
        const texto = typeof r.data.output_text === 'string' && r.data.output_text.length > 0
          ? r.data.output_text
          : conteudos.filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');

        let json: unknown | null = null;
        if (o.schema) {
          try {
            json = JSON.parse(texto);
          } catch {
            console.error(`[openai] responder codigo=json_invalido ms=${ms}`);
            throw new OpenAIErro(res.status, false, 'json_invalido');
          }
        }
        return { texto, json, uso, respostaId: r.data.id ?? '' };
      }

      const err = erroDeStatus(res.status, await codigoDoErro(res));
      console.error(`[openai] responder codigo=${err.codigo} status=${res.status} ms=${ms}`);
      if (!err.transitorio) throw err;
      ultimoErro = err;
    }

    // Retry: só se ainda sobrar tempo depois da espera.
    if (tentativa >= tentativas) break;
    const espera = esperaDoRetry(res);
    const sobra = timeoutTotal - (agoraMs() - inicio) - espera;
    if (sobra < CONFIG_RETRY.sobraMinimaMs) break;
    await dormir(espera);
  }
  throw ultimoErro ?? new OpenAIErro(null, true, 'rede');
}

// ---- transcrever ----

/** Mime sem parâmetros (`audio/ogg; codecs=opus` → `audio/ogg`). */
function mimeLimpo(mime: string): string {
  return mime.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
}

export async function transcrever(o: TranscreverOpcoes): Promise<{ texto: string; uso: Uso }> {
  const timeoutMs = o.timeoutMs ?? 60_000;
  const form = new FormData();
  // Cópia para ArrayBuffer próprio: o Blob não pode apontar para um subarray compartilhado.
  const copia = new Uint8Array(o.bytes.byteLength);
  copia.set(o.bytes);
  form.append('file', new Blob([copia], { type: mimeLimpo(o.mime) }), o.nomeArquivo);
  form.append('model', MODELOS.transcricao);
  form.append('language', 'pt');
  form.append('response_format', 'json');

  const t0 = agoraMs();
  let res: Response;
  try {
    res = await fetch(URL_TRANSCRICAO, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.chave}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const ms = agoraMs() - t0;
    const codigo: CodigoOpenAI = ehTimeout(e) ? 'timeout' : 'rede';
    console.error(`[openai] transcrever codigo=${codigo} ms=${ms}`);
    // Sem retry: timeout de transcrição pode ter sido cobrado.
    throw new OpenAIErro(null, true, codigo);
  }
  const ms = agoraMs() - t0;
  if (!res.ok) {
    const err = erroDeStatus(res.status, await codigoDoErro(res));
    console.error(`[openai] transcrever codigo=${err.codigo} status=${res.status} ms=${ms}`);
    throw err;
  }

  let brutoJson: unknown;
  try {
    brutoJson = await res.json();
  } catch (e) {
    throw new OpenAIErro(res.status, false, ehTimeout(e) ? 'timeout' : 'json_invalido');
  }
  const r = z.object({ text: z.string().optional(), usage: UsoBrutoSchema.nullish() }).passthrough().safeParse(brutoJson);
  if (!r.success) throw new OpenAIErro(res.status, false, 'json_invalido');

  const segundos = r.data.usage?.seconds ?? r.data.usage?.duration ?? null;
  const preco = PRECO_TRANSCRICAO_USD_POR_MIN[MODELOS.transcricao];
  const uso: Uso = {
    modelo: MODELOS.transcricao,
    tokens_entrada: r.data.usage?.input_tokens ?? 0,
    tokens_cache_leitura: 0,
    tokens_cache_escrita: 0,
    tokens_saida: r.data.usage?.output_tokens ?? 0,
    segundos_audio: segundos,
    custo_usd: segundos !== null ? (segundos / 60) * preco : estimarCusto({ tipo: 'transcricao', bytes: o.bytes.byteLength }),
    ms,
  };
  if (o.aoUsar) await o.aoUsar(uso);
  if (typeof r.data.text !== 'string') throw new OpenAIErro(res.status, false, 'json_invalido');
  return { texto: r.data.text, uso };
}
