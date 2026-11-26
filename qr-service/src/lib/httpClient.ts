/**
 * HTTP client com timeout via AbortController.
 *
 * Why: o `fetch` nativo do Node não tem timeout default. Sem isso, um webhook
 * lento ou pendurado segura o body JSON na heap até a conexão TCP cair sozinha
 * (pode ser horas). Em volume, isso virou a principal fonte de leak do serviço.
 */
export async function postJson(
    url: string,
    body: unknown,
    timeoutMs = 30_000,
    // Destinos que não são o nosso webhook precisam da própria autenticação
    // (ex.: o broadcast do Realtime exige apikey + Bearer). Vem por último para
    // poder sobrescrever os headers default.
    extraHeaders?: Record<string, string>
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Shared secret so the webhook can authenticate our /qr-* callbacks
    // (see whatsapp-webhook: QR_WEBHOOK_SECRET). O boot exige a variável; a checagem só
    // protege contextos que não passam pelo index.ts (testes).
    const qrSecret = process.env.QR_WEBHOOK_SECRET;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(qrSecret ? { 'x-qr-secret': qrSecret } : {}),
                ...extraHeaders,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        // Drenar o body libera a conexão pro keep-alive pool e evita
        // que o Buffer da resposta fique preso por GC tardio.
        await res.arrayBuffer().catch(() => {});
        return res;
    } finally {
        clearTimeout(timer);
    }
}
