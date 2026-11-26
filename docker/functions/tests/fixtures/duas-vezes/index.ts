// Chama Deno.serve duas vezes: o roteador recusa.
Deno.serve(() => new Response("a"));
Deno.serve(() => new Response("b"));
