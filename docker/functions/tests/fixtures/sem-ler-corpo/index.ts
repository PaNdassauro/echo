// Responde sem ler o corpo: o roteador precisa drenar para manter a conexão keep-alive reutilizável.
Deno.serve(() => Response.json({ leu: false }, { status: 500 }));
