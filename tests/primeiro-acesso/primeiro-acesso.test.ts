// deno test --no-config --allow-env --allow-read tests/primeiro-acesso
import {
  criarHandler,
  type DepsPrimeiroAcesso,
  type ResultadoConcluir,
  type ResultadoCriarUsuario,
} from "../../supabase/functions/_shared/primeiro-acesso.ts";

function igual<T>(a: T, b: T, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
  }
}

const TOKEN = "0123456789abcdef0123456789abcdef";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-0000000000aa";

const PEDIDO = {
  codigo: TOKEN,
  nome: "Ana Souza",
  email: "Admin@Example.com",
  senha: "SenhaForte123",
  organizacao: "Acme",
};

interface Chamadas {
  precisaSetup: number;
  criarUsuario: Array<{ email: string; senha: string; nome: string }>;
  entrarComSenha: Array<[string, string]>;
  concluirSetup: Array<[string, string]>;
  apagarUsuario: string[];
}

function montar(sobre: {
  token?: string;
  precisa?: boolean;
  criar?: ResultadoCriarUsuario;
  entrar?: { id: string } | null;
  concluir?: ResultadoConcluir;
  falhaPrecisa?: boolean;
  falhaApagar?: boolean;
} = {}): { handler: (r: Request) => Promise<Response>; c: Chamadas } {
  const c: Chamadas = { precisaSetup: 0, criarUsuario: [], entrarComSenha: [], concluirSetup: [], apagarUsuario: [] };
  const deps: DepsPrimeiroAcesso = {
    tokenConfigurado: () => sobre.token ?? TOKEN,
    precisaSetup: () => {
      c.precisaSetup++;
      return sobre.falhaPrecisa ? Promise.reject(new Error("banco fora")) : Promise.resolve(sobre.precisa ?? true);
    },
    criarUsuario: (d) => {
      c.criarUsuario.push(d);
      return Promise.resolve(sobre.criar ?? { ok: true, id: USER_ID });
    },
    entrarComSenha: (e, s) => {
      c.entrarComSenha.push([e, s]);
      return Promise.resolve(sobre.entrar ?? null);
    },
    concluirSetup: (u, o) => {
      c.concluirSetup.push([u, o]);
      return Promise.resolve(sobre.concluir ?? { ok: true, organization_id: ORG_ID });
    },
    apagarUsuario: (u) => {
      c.apagarUsuario.push(u);
      return sobre.falhaApagar ? Promise.reject(new Error("auth fora")) : Promise.resolve();
    },
  };
  return { handler: criarHandler(deps), c };
}

const post = (corpo: unknown) =>
  new Request("http://x/primeiro-acesso", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });
const get = () => new Request("http://x/primeiro-acesso");

async function chamar(h: (r: Request) => Promise<Response>, req: Request): Promise<[number, Record<string, unknown>]> {
  const r = await h(req);
  return [r.status, await r.json()];
}

// Os logs de erro de propósito não poluem a saída dos testes.
async function semLog<T>(fn: () => Promise<T>): Promise<T> {
  const [erro, aviso] = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = erro;
    console.warn = aviso;
  }
}

Deno.test("GET devolve precisa_setup do banco, só com ECHO_SETUP_TOKEN configurado", async () => {
  const a = montar({ precisa: true });
  igual(await chamar(a.handler, get()), [200, { precisa_setup: true }], "token + banco vazio");
  const b = montar({ precisa: false });
  igual(await chamar(b.handler, get()), [200, { precisa_setup: false }], "já configurada");
  const c = montar({ token: "", precisa: true });
  igual(await chamar(c.handler, get()), [200, { precisa_setup: false }], "token vazio = desligado");
  igual(c.c.precisaSetup, 0, "token vazio nem consulta o banco");
});

Deno.test("GET com o banco fora: 500 falha_interna", async () => {
  const { handler } = montar({ falhaPrecisa: true });
  const [status, corpo] = await semLog(() => chamar(handler, get()));
  igual([status, corpo], [500, { ok: false, erro: "falha_interna" }], "500");
});

Deno.test("método diferente de GET/POST/OPTIONS: 405; OPTIONS: CORS sem corpo", async () => {
  const { handler } = montar();
  for (const metodo of ["PUT", "DELETE", "PATCH"]) {
    const r = await handler(new Request("http://x/primeiro-acesso", { method: metodo }));
    igual(r.status, 405, metodo);
    await r.body?.cancel();
  }
  const o = await handler(new Request("http://x/primeiro-acesso", { method: "OPTIONS" }));
  igual([o.status, o.headers.get("access-control-allow-origin")], [200, "*"], "OPTIONS");
});

Deno.test("payload inválido (e-mail ruim, senha de 7, campo extra, JSON quebrado): 400 sem chamar nada", async () => {
  for (
    const [corpo, motivo] of [
      [{ ...PEDIDO, email: "isso-nao-e-email" }, "e-mail inválido"],
      [{ ...PEDIDO, senha: "1234567" }, "senha com 7 caracteres"],
      [{ ...PEDIDO, senha: "x".repeat(73) }, "senha com 73 caracteres"],
      [{ ...PEDIDO, organizacao: "A" }, "organização com 1 caractere"],
      [{ ...PEDIDO, organizacao: "😀" }, "organização com 1 ponto de código (2 unidades UTF-16)"],
      [{ ...PEDIDO, organizacao: "😀".repeat(101) }, "organização com 101 pontos de código"],
      [{ ...PEDIDO, nome: "  " }, "nome em branco"],
      [{ ...PEDIDO, extra: 1 }, "campo extra (strict)"],
      [{ nome: "Ana" }, "campos faltando"],
      ["{não é json", "JSON quebrado"],
    ] as Array<[unknown, string]>
  ) {
    const { handler, c } = montar();
    const [status, resp] = await chamar(handler, post(corpo));
    igual([status, resp.erro], [400, "payload_invalido"], motivo);
    igual(
      [c.precisaSetup, c.criarUsuario.length, c.entrarComSenha.length, c.concluirSetup.length, c.apagarUsuario.length],
      [0, 0, 0, 0, 0],
      `${motivo}: nada foi chamado`,
    );
  }
});

Deno.test("ECHO_SETUP_TOKEN vazio: 403 setup_desligado, sem chamar nada", async () => {
  const { handler, c } = montar({ token: "" });
  igual(await chamar(handler, post(PEDIDO)), [403, { ok: false, erro: "setup_desligado" }], "desligado");
  igual([c.precisaSetup, c.criarUsuario.length], [0, 0], "nada chamado");
});

Deno.test("código errado: 403 codigo_invalido, sem consultar o banco nem criar usuário", async () => {
  for (const errado of ["0123456789abcdef0123456789abcdee", "x", TOKEN + "0", TOKEN.toUpperCase()]) {
    const { handler, c } = montar();
    igual(await chamar(handler, post({ ...PEDIDO, codigo: errado })), [403, { ok: false, erro: "codigo_invalido" }], errado);
    igual([c.precisaSetup, c.criarUsuario.length], [0, 0], `${errado}: nada chamado`);
  }
});

Deno.test("instalação já configurada: 409 e criarUsuario NÃO é chamado", async () => {
  const { handler, c } = montar({ precisa: false });
  igual(await chamar(handler, post(PEDIDO)), [409, { ok: false, erro: "ja_configurado" }], "409");
  igual([c.criarUsuario.length, c.concluirSetup.length, c.apagarUsuario.length], [0, 0, 0], "nada criado nem apagado");
});

Deno.test("caminho feliz: 201 com organization_id; o e-mail chega normalizado ao Auth", async () => {
  const { handler, c } = montar();
  igual(await chamar(handler, post(PEDIDO)), [201, { ok: true, organization_id: ORG_ID }], "201");
  igual(c.criarUsuario, [{ email: "admin@example.com", senha: "SenhaForte123", nome: "Ana Souza" }], "usuário criado");
  igual(c.concluirSetup, [[USER_ID, "Acme"]], "RPC com o id e a organização");
  igual(c.apagarUsuario, [], "ninguém apagado");
});

Deno.test("senha fraca no Auth: 422 senha_fraca e a RPC não é chamada", async () => {
  const { handler, c } = montar({ criar: { ok: false, motivo: "senha_fraca" } });
  igual(await chamar(handler, post(PEDIDO)), [422, { ok: false, erro: "senha_fraca" }], "422");
  igual([c.concluirSetup.length, c.apagarUsuario.length], [0, 0], "sem RPC e sem apagar");
});

Deno.test("e-mail inválido no Auth: 422 email_invalido", async () => {
  const { handler } = montar({ criar: { ok: false, motivo: "email_invalido" } });
  igual(await chamar(handler, post(PEDIDO)), [422, { ok: false, erro: "email_invalido" }], "422");
});

Deno.test("erro genérico do Auth ao criar: 500 falha_interna", async () => {
  const { handler, c } = montar({ criar: { ok: false, motivo: "erro" } });
  const [status, corpo] = await semLog(() => chamar(handler, post(PEDIDO)));
  igual([status, corpo], [500, { ok: false, erro: "falha_interna" }], "500");
  igual(c.concluirSetup.length, 0, "sem RPC");
});

Deno.test("RPC PT409 (outra chamada ganhou): apaga o usuário criado uma vez e responde 409", async () => {
  const { handler, c } = montar({ concluir: { ok: false, codigo: "PT409", mensagem: "instalação já configurada" } });
  igual(await chamar(handler, post(PEDIDO)), [409, { ok: false, erro: "ja_configurado" }], "409");
  igual(c.apagarUsuario, [USER_ID], "usuário criado nesta chamada apagado uma vez");
});

Deno.test("organização conta pontos de código como o length() do Postgres: 2 emojis e 100 emojis passam; 22023 da RPC vira 400 payload_invalido", async () => {
  for (const organizacao of ["😀😀", "😀".repeat(100), "𝔄𝔅"]) {
    const { handler, c } = montar();
    const [status] = await chamar(handler, post({ ...PEDIDO, organizacao }));
    igual([status, c.concluirSetup], [201, [[USER_ID, organizacao]]], `organização ${Array.from(organizacao).length} pontos de código`);
  }
  // O banco recusou o nome (ou o usuário sumiu): erro do chamador, não 500; o usuário criado nesta chamada é apagado.
  const { handler, c } = montar({ concluir: { ok: false, codigo: "22023", mensagem: "nome da organização precisa ter de 2 a 100 caracteres" } });
  const [status, corpo] = await chamar(handler, post(PEDIDO));
  igual([status, corpo.erro], [400, "payload_invalido"], "22023 -> 400");
  igual(c.apagarUsuario, [USER_ID], "usuário criado apagado");
});

Deno.test("RPC com erro genérico: apaga o usuário criado, 500 e log sem senha nem e-mail", async () => {
  const { handler, c } = montar({ concluir: { ok: false, codigo: "XX000", mensagem: "falha qualquer" } });
  const linhas: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void linhas.push(a.map(String).join(" "));
  let resposta: [number, Record<string, unknown>];
  try {
    resposta = await chamar(handler, post(PEDIDO));
  } finally {
    console.error = original;
  }
  igual(resposta, [500, { ok: false, erro: "falha_interna" }], "500");
  igual(c.apagarUsuario, [USER_ID], "apagou o criado");
  igual(linhas.length > 0, true, "logou o erro");
  const log = linhas.join("\n");
  igual([log.includes("SenhaForte123"), log.toLowerCase().includes("admin@example.com"), log.includes(TOKEN)], [false, false, false], "sem segredo no log");
});

Deno.test("falha ao apagar o usuário não esconde o 409 da corrida", async () => {
  const { handler } = montar({
    concluir: { ok: false, codigo: "PT409", mensagem: "x" },
    falhaApagar: true,
  });
  const [status, corpo] = await semLog(() => chamar(handler, post(PEDIDO)));
  igual([status, corpo], [409, { ok: false, erro: "ja_configurado" }], "409 mesmo assim");
});

Deno.test("e-mail já existe + senha certa: segue para a RPC e NÃO apaga o usuário que já existia, nem no 409", async () => {
  const a = montar({ criar: { ok: false, motivo: "email_existe" }, entrar: { id: USER_ID } });
  igual(await chamar(a.handler, post(PEDIDO)), [201, { ok: true, organization_id: ORG_ID }], "201");
  igual(a.c.entrarComSenha, [["admin@example.com", "SenhaForte123"]], "prova de que é a mesma pessoa");
  igual(a.c.concluirSetup, [[USER_ID, "Acme"]], "RPC com o id do usuário que entrou");

  const b = montar({
    criar: { ok: false, motivo: "email_existe" },
    entrar: { id: USER_ID },
    concluir: { ok: false, codigo: "PT409", mensagem: "x" },
  });
  igual(await chamar(b.handler, post(PEDIDO)), [409, { ok: false, erro: "ja_configurado" }], "409");
  igual(b.c.apagarUsuario, [], "usuário preexistente nunca é apagado");

  const c = montar({
    criar: { ok: false, motivo: "email_existe" },
    entrar: { id: USER_ID },
    concluir: { ok: false, codigo: "XX000", mensagem: "x" },
  });
  const [status] = await semLog(() => chamar(c.handler, post(PEDIDO)));
  igual([status, c.c.apagarUsuario], [500, []], "erro genérico também não apaga o preexistente");
});

Deno.test("e-mail já existe + senha errada: 422 email_em_uso, sem RPC e sem trocar senha", async () => {
  const { handler, c } = montar({ criar: { ok: false, motivo: "email_existe" }, entrar: null });
  igual(await chamar(handler, post(PEDIDO)), [422, { ok: false, erro: "email_em_uso" }], "422");
  igual([c.concluirSetup.length, c.apagarUsuario.length], [0, 0], "sem RPC, sem apagar");
});

Deno.test("dependência que lança vira 500 falha_interna (sem derrubar o handler)", async () => {
  const handler = criarHandler({
    tokenConfigurado: () => TOKEN,
    precisaSetup: () => Promise.reject(new Error("banco fora")),
    criarUsuario: () => Promise.resolve({ ok: true, id: USER_ID }),
    entrarComSenha: () => Promise.resolve(null),
    concluirSetup: () => Promise.resolve({ ok: true, organization_id: ORG_ID }),
    apagarUsuario: () => Promise.resolve(),
  });
  const [status, corpo] = await semLog(() => chamar(handler, post(PEDIDO)));
  igual([status, corpo], [500, { ok: false, erro: "falha_interna" }], "500");
});

Deno.test("respostas não são cacheáveis e levam CORS", async () => {
  const { handler } = montar();
  const r = await handler(get());
  igual([r.headers.get("cache-control"), r.headers.get("access-control-allow-origin")], ["no-store", "*"], "cabeçalhos");
  await r.body?.cancel();
});
