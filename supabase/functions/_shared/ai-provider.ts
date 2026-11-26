import Anthropic from 'npm:@anthropic-ai/sdk@0.110.0';

/**
 * Suporte multi-provedor para a chave de IA da organização
 * (organizations.ai_api_key via get_decrypted_ai_key):
 * - `sk-ant-...` → Anthropic (Claude)
 * - qualquer outra → OpenAI (comportamento original)
 *
 * O chamador mantém sua própria chamada OpenAI; este módulo cobre o ramo
 * Anthropic com o SDK oficial.
 */

export function isAnthropicKey(apiKey: string): boolean {
  return apiKey.startsWith('sk-ant-');
}

export interface AnthropicCompleteOptions {
  apiKey: string;
  system: string;
  /**
   * `content` aceita texto simples ou blocos. Os blocos existem para anexar
   * documento/imagem junto da conversa (ex.: o PDF de orçamento que o cliente
   * mandou) — o Claude lê a página, inclusive gráficos e tabelas.
   */
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>;
  maxTokens?: number;
  /** Modelo Claude — default claude-opus-5-5; use claude-haiku-4-5 pra tarefas leves/latência baixa. */
  model?: string;
  /** JSON Schema do objeto raiz — quando presente, força saída estruturada. */
  jsonSchema?: Record<string, unknown>;
}

export async function anthropicComplete(options: AnthropicCompleteOptions): Promise<string> {
  const client = new Anthropic({ apiKey: options.apiKey });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: options.model ?? 'claude-opus-5-5',
      max_tokens: options.maxTokens ?? 16000,
      system: options.system,
      messages: options.messages,
      ...(options.jsonSchema
        ? { output_config: { format: { type: 'json_schema' as const, schema: options.jsonSchema } } }
        : {}),
    });
  } catch (e) {
    const message = e instanceof Anthropic.APIError ? e.message : String(e);
    console.error('Anthropic API error:', e);
    throw new Error(`AI provider error: ${message}`);
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('AI provider error: solicitação recusada pelo modelo');
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!text) {
    throw new Error('AI provider error: resposta vazia do modelo');
  }
  return text;
}
