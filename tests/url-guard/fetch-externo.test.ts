// deno test --no-config --allow-env --allow-read tests/url-guard
import {
  fetchExterno,
  fetchMidia,
  hostsExternosPermitidos,
  UrlExternaBloqueadaError,
} from "../../supabase/functions/_shared/url-guard.ts";

function igual<T>(a: T, b: T, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
  }
}

interface Chamada {
  url: string;
  metodo: string;
  corpo: BodyInit | null | undefined;
  headers: Headers;
  redirect: RequestRedirect | undefined;
}

/** fetch falso: devolve as respostas na ordem e anota o que recebeu. */
function falso(respostas: Array<{ status: number; location?: string }>): { fetchImpl: typeof fetch; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  let i = 0;
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({
      url: String(url),
      metodo: init?.method ?? "GET",
      corpo: init?.body,
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
    });
    const r = respostas[Math.min(i++, respostas.length - 1)];
    const headers = r.location ? { location: r.location } : undefined;
    return Promise.resolve(new Response(r.status === 204 || (r.status >= 300 && r.status < 400) ? null : "ok", { status: r.status, headers }));
  }) as typeof fetch;
  return { fetchImpl, chamadas };
}

async function motivo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof UrlExternaBloqueadaError) return e.reason;
    throw e;
  }
  return "passou";
}

const SEM_DNS = { resolver: null, permitidos: [] as string[] };

Deno.test("recusa os destinos internos do compose e o IMDS da nuvem", async () => {
  for (
    const [url, esperado] of [
      ["http://rest:3000/", "host_interno"],
      ["http://gateway:8000/functions/v1/x", "host_interno"],
      ["http://auth:9999/admin/users", "host_interno"],
      ["http://storage:5000/", "host_interno"],
      ["http://realtime:4000/", "host_interno"],
      ["http://qr:3000/health", "host_interno"],
      ["http://functions:9000/_health", "host_interno"],
      ["http://169.254.169.254/latest/meta-data", "ip_bloqueado"],
      ["http://localhost:8000/", "host_interno"],
      ["http://127.0.0.1:5432/", "ip_bloqueado"],
      ["file:///etc/passwd", "protocolo_nao_permitido"],
    ] as const
  ) {
    const { fetchImpl, chamadas } = falso([{ status: 200 }]);
    igual(await motivo(fetchExterno(url, {}, { ...SEM_DNS, fetchImpl })), esperado, url);
    igual(chamadas.length, 0, `${url}: nenhuma requisição saiu`);
  }
});

Deno.test("recusa nome público que resolve para a rede interna (DNS)", async () => {
  const resolver = (host: string, tipo: "A" | "AAAA") =>
    host === "rebind.example.com" && tipo === "A" ? Promise.resolve(["10.0.0.7"]) : Promise.reject(new Error("NXDOMAIN"));
  const { fetchImpl, chamadas } = falso([{ status: 200 }]);
  igual(
    await motivo(fetchExterno("https://rebind.example.com/x", {}, { resolver, permitidos: [], fetchImpl })),
    "dns_aponta_para_rede_interna",
    "dns",
  );
  igual(chamadas.length, 0, "nada saiu");
});

Deno.test("nome com sublinhado é recusado na camada 1, mesmo com o resolvedor real do runtime", async () => {
  for (
    const url of [
      "http://rest.echo_default:3000/organizations?select=*",
      "http://gateway.echo_default:8000/auth/v1/admin/users",
      "http://a_b.example.com/",
    ]
  ) {
    const { fetchImpl, chamadas } = falso([{ status: 200 }]);
    // sem `resolver` na opção: usa o Deno.resolveDns de verdade (que nem chega a consultar um nome com '_').
    igual(await motivo(fetchExterno(url, {}, { permitidos: [], fetchImpl })), "host_invalido", url);
    igual(chamadas.length, 0, `${url}: nenhuma requisição saiu`);
  }
});

Deno.test("resolvedor que falha em A e AAAA recusa (falha fechada); basta um tipo ter endereço", async () => {
  const falha = () => Promise.reject(new Error("falhou"));
  const a = falso([{ status: 200 }]);
  igual(
    await motivo(fetchExterno("https://sem-registro.example.com/", {}, { resolver: falha, permitidos: [], fetchImpl: a.fetchImpl })),
    "dns_sem_endereco",
    "A e AAAA lançam",
  );
  igual(a.chamadas.length, 0, "nada saiu");
  const vazio = () => Promise.resolve([] as string[]);
  igual(
    await motivo(fetchExterno("https://vazio.example.com/", {}, { resolver: vazio, permitidos: [], fetchImpl: a.fetchImpl })),
    "dns_sem_endereco",
    "A e AAAA vazios",
  );
  const soAAAA = (_h: string, tipo: "A" | "AAAA") => tipo === "AAAA" ? Promise.resolve(["2606:4700::1111"]) : Promise.reject(new Error("sem A"));
  const soA = (_h: string, tipo: "A" | "AAAA") => tipo === "A" ? Promise.resolve(["93.184.216.34"]) : Promise.reject(new Error("sem AAAA"));
  for (const resolver of [soAAAA, soA]) {
    const b = falso([{ status: 200 }]);
    const r = await fetchExterno("https://um-tipo.example.com/", {}, { resolver, permitidos: [], fetchImpl: b.fetchImpl });
    igual([r.status, b.chamadas.length], [200, 1], "um tipo basta");
  }
});

Deno.test("30x para nome com sublinhado é recusado antes de buscar", async () => {
  const { fetchImpl, chamadas } = falso([{ status: 302, location: "http://x_y.exemplo.com/" }, { status: 200 }]);
  igual(await motivo(fetchExterno("https://hooks.example.com/x", {}, { ...SEM_DNS, fetchImpl })), "host_invalido", "salto");
  igual(chamadas.length, 1, "só o 1º salto saiu");
});

Deno.test("host de ECHO_OUTBOUND_ALLOW_HOSTS com sublinhado continua liberado (a exceção vem antes da guarda)", async () => {
  const { fetchImpl, chamadas } = falso([{ status: 200 }]);
  const r = await fetchExterno("http://meu_servico.lan:8080/x", {}, { resolver: null, permitidos: ["meu_servico.lan"], fetchImpl });
  igual([r.status, chamadas.length], [200, 1], "liberado");
});

Deno.test("URL pública passa e o fetch sai com redirect manual", async () => {
  const { fetchImpl, chamadas } = falso([{ status: 200 }]);
  const r = await fetchExterno("https://hooks.example.com/x", { method: "POST", body: "{}" }, { ...SEM_DNS, fetchImpl });
  igual(r.status, 200, "resposta devolvida");
  igual([chamadas.length, chamadas[0].redirect, chamadas[0].metodo], [1, "manual", "POST"], "uma chamada, manual");
});

Deno.test("30x para host privado é recusado antes de buscar", async () => {
  for (const destino of ["http://169.254.169.254/", "http://rest:3000/", "http://10.0.0.5/admin", "file:///etc/passwd"]) {
    const { fetchImpl, chamadas } = falso([{ status: 302, location: destino }, { status: 200 }]);
    const m = await motivo(fetchExterno("https://hooks.example.com/x", {}, { ...SEM_DNS, fetchImpl }));
    igual(m === "passou", false, `${destino} recusado`);
    igual(chamadas.length, 1, `${destino}: só o 1º salto saiu`);
  }
});

Deno.test("30x para outro host público é seguido (e Location relativo é resolvido)", async () => {
  const { fetchImpl, chamadas } = falso([
    { status: 301, location: "https://outro.example.com/novo" },
    { status: 302, location: "/final" },
    { status: 200 },
  ]);
  const r = await fetchExterno("https://hooks.example.com/x", {}, { ...SEM_DNS, fetchImpl });
  igual(r.status, 200, "chegou ao fim");
  igual(chamadas.map((c) => c.url), [
    "https://hooks.example.com/x",
    "https://outro.example.com/novo",
    "https://outro.example.com/final",
  ], "saltos");
});

Deno.test("limite de redirecionamentos: o 4º salto (3 permitidos) é recusado", async () => {
  const { fetchImpl, chamadas } = falso([{ status: 302, location: "https://a.example.com/loop" }]);
  igual(await motivo(fetchExterno("https://a.example.com/", {}, { ...SEM_DNS, fetchImpl })), "redirecionamentos_demais", "padrão 3");
  igual(chamadas.length, 4, "1 pedido + 3 redirecionamentos");
  const dois = falso([{ status: 302, location: "https://a.example.com/loop" }]);
  igual(
    await motivo(fetchExterno("https://a.example.com/", {}, { ...SEM_DNS, fetchImpl: dois.fetchImpl, maxRedirecionamentos: 1 })),
    "redirecionamentos_demais",
    "limite configurável",
  );
  igual(dois.chamadas.length, 2, "1 pedido + 1 redirecionamento");
});

Deno.test("303 e 302 de POST viram GET sem corpo; 307 repete método e corpo; outra origem perde Authorization", async () => {
  const a = falso([{ status: 303, location: "https://hooks.example.com/ok" }, { status: 200 }]);
  await fetchExterno("https://hooks.example.com/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, { ...SEM_DNS, fetchImpl: a.fetchImpl });
  igual([a.chamadas[1].metodo, a.chamadas[1].corpo ?? null, a.chamadas[1].headers.has("content-type")], ["GET", null, false], "303");

  const b = falso([{ status: 307, location: "https://hooks.example.com/ok" }, { status: 200 }]);
  await fetchExterno("https://hooks.example.com/x", { method: "POST", body: "{}" }, { ...SEM_DNS, fetchImpl: b.fetchImpl });
  igual([b.chamadas[1].metodo, b.chamadas[1].corpo], ["POST", "{}"], "307");

  const c = falso([{ status: 302, location: "https://terceiro.example.com/ok" }, { status: 200 }]);
  await fetchExterno("https://hooks.example.com/x", { headers: { authorization: "Bearer segredo", "x-extra": "1" } }, { ...SEM_DNS, fetchImpl: c.fetchImpl });
  igual([c.chamadas[1].headers.has("authorization"), c.chamadas[1].headers.get("x-extra")], [false, "1"], "outra origem");
  const d = falso([{ status: 302, location: "/ok" }, { status: 200 }]);
  await fetchExterno("https://hooks.example.com/x", { headers: { authorization: "Bearer segredo" } }, { ...SEM_DNS, fetchImpl: d.fetchImpl });
  igual(d.chamadas[1].headers.get("authorization"), "Bearer segredo", "mesma origem mantém");
});

Deno.test("30x sem Location devolve a resposta como veio", async () => {
  const { fetchImpl } = falso([{ status: 304 }]);
  const r = await fetchExterno("https://hooks.example.com/x", {}, { ...SEM_DNS, fetchImpl });
  igual(r.status, 304, "304 sem Location");
});

Deno.test("ECHO_OUTBOUND_ALLOW_HOSTS: host exato da lista passa sem a camada de IP", async () => {
  const permitidos = hostsExternosPermitidos("n8n, 192.168.1.5 ,CRM.rede.local, [fd00::5]");
  igual(permitidos, ["n8n", "192.168.1.5", "crm.rede.local", "fd00::5"], "lista normalizada");
  for (const url of ["http://n8n:5678/webhook/x", "http://192.168.1.5:8080/hook", "https://crm.rede.local/hook", "http://[fd00::5]/hook"]) {
    const { fetchImpl, chamadas } = falso([{ status: 200 }]);
    igual((await fetchExterno(url, {}, { resolver: null, permitidos, fetchImpl })).status, 200, url);
    igual(chamadas.length, 1, `${url}: saiu`);
  }
  // Fora da lista continua recusado, inclusive host parecido com um da lista.
  for (const url of ["http://rest:3000/", "http://192.168.1.6/", "http://n8n2/", "http://[fd00::6]/"]) {
    const { fetchImpl } = falso([{ status: 200 }]);
    igual((await motivo(fetchExterno(url, {}, { resolver: null, permitidos, fetchImpl }))) === "passou", false, `${url} segue recusado`);
  }
});

Deno.test("host liberado não libera protocolo estranho, credencial na URL nem o salto para host não liberado", async () => {
  const permitidos = ["n8n"];
  igual(await motivo(fetchExterno("ftp://n8n/x", {}, { resolver: null, permitidos })), "protocolo_nao_permitido", "ftp");
  igual(await motivo(fetchExterno("http://u:p@n8n/x", {}, { resolver: null, permitidos })), "credencial_na_url", "credencial");
  const { fetchImpl, chamadas } = falso([{ status: 302, location: "http://169.254.169.254/" }]);
  igual(await motivo(fetchExterno("http://n8n/x", {}, { resolver: null, permitidos, fetchImpl })), "ip_bloqueado", "salto para o IMDS");
  igual(chamadas.length, 1, "só o host liberado foi buscado");
});

Deno.test("sem opção, lê ECHO_OUTBOUND_ALLOW_HOSTS do ambiente; vazio = nenhum host liberado", async () => {
  const antes = Deno.env.get("ECHO_OUTBOUND_ALLOW_HOSTS");
  try {
    Deno.env.delete("ECHO_OUTBOUND_ALLOW_HOSTS");
    igual(await motivo(fetchExterno("http://n8n/x", {}, { resolver: null })), "host_interno", "vazio");
    Deno.env.set("ECHO_OUTBOUND_ALLOW_HOSTS", "n8n");
    const { fetchImpl } = falso([{ status: 200 }]);
    igual((await fetchExterno("http://n8n/x", {}, { resolver: null, fetchImpl })).status, 200, "liberado pelo ambiente");
  } finally {
    if (antes === undefined) Deno.env.delete("ECHO_OUTBOUND_ALLOW_HOSTS");
    else Deno.env.set("ECHO_OUTBOUND_ALLOW_HOSTS", antes);
  }
});

Deno.test("erro de rede do fetch segue como veio (não vira bloqueio)", async () => {
  const fetchImpl = (() => Promise.reject(new TypeError("falhou"))) as typeof fetch;
  let tipo = "";
  try {
    await fetchExterno("https://hooks.example.com/x", {}, { ...SEM_DNS, fetchImpl });
  } catch (e) {
    tipo = e instanceof UrlExternaBloqueadaError ? "bloqueio" : (e as Error).name;
  }
  igual(tipo, "TypeError", "erro original");
});

async function comEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const antes = Object.keys(vars).map((k) => [k, Deno.env.get(k)] as const);
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await fn();
  } finally {
    for (const [k, v] of antes) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("fetchMidia: anexo do nosso Storage vai pela base interna, sem a guarda (mesmo com host interno)", async () => {
  await comEnv({ SUPABASE_URL: "http://gateway:8000", ECHO_PUBLIC_URL: "https://echo.example.com" }, async () => {
    const { fetchImpl, chamadas } = falso([{ status: 200 }, { status: 200 }]);
    await fetchMidia("https://echo.example.com/storage/v1/object/public/attachments/outbound/u/a%20b.png", {}, { fetchImpl });
    await fetchMidia("http://gateway:8000/storage/v1/object/public/attachments/outbound/u/a.png", { method: "HEAD" }, { fetchImpl });
    igual(chamadas.map((c) => c.url), [
      "http://gateway:8000/storage/v1/object/public/attachments/outbound/u/a%20b.png",
      "http://gateway:8000/storage/v1/object/public/attachments/outbound/u/a.png",
    ], "as duas bases viram a interna");
    igual(chamadas[1].metodo, "HEAD", "init preservado");
  });
});

Deno.test("fetchMidia: URL de terceiro passa pela guarda; host interno, IMDS e Storage de outro bucket são recusados", async () => {
  await comEnv({ SUPABASE_URL: "http://gateway:8000", ECHO_PUBLIC_URL: "https://echo.example.com" }, async () => {
    for (
      const url of [
        "http://rest:3000/",
        "http://gateway:8000/functions/v1/send-web-push",
        "http://169.254.169.254/latest/meta-data",
        // bucket que não é o de anexos: nunca ganha o atalho da base interna
        "http://gateway:8000/storage/v1/object/public/outro/a.png",
      ]
    ) {
      const { fetchImpl, chamadas } = falso([{ status: 200 }]);
      igual(await motivo(fetchMidia(url, {}, { ...SEM_DNS, fetchImpl })) === "passou", false, `${url} recusado`);
      igual(chamadas.length, 0, `${url}: nada saiu`);
    }
    const ok = falso([{ status: 200 }]);
    igual((await fetchMidia("https://cdn.example.org/foto.png", {}, { ...SEM_DNS, fetchImpl: ok.fetchImpl })).status, 200, "público passa");
    igual(ok.chamadas[0].redirect, "manual", "pela guarda, com redirect manual");
  });
});
