// Usa o shim de EdgeRuntime.waitUntil: a promessa segue sozinha depois da resposta.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(() => {
  EdgeRuntime.waitUntil(new Promise((resolve) => setTimeout(resolve, 200)));
  return Response.json({ agendado: true });
});
