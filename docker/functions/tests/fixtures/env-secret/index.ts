// Devolve o que a função enxerga do JWT_SECRET: o roteador o apaga do ambiente antes de importar qualquer função.
Deno.serve(() => Response.json({ jwtSecret: Deno.env.get("JWT_SECRET") ?? null }));
