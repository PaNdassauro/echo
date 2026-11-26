// Rampa de chamada interna (S5/S6), guarda de SSRF do botão de ação e regras
// da chave da echo-api (S2). Rodar:
//   npx -y deno@2 test --no-config --allow-env --allow-read tests/edge-authz
import {
  checkInternalCaller,
  isInternalCaller,
  rampDeny,
} from "../../supabase/functions/_shared/authz.ts";
import {
  checkOutboundUrl,
  checkUrlLiteral,
  isBlockedIp,
} from "../../supabase/functions/_shared/url-guard.ts";
import {
  apiKeyOwnerStillAllowed,
  apiOriginMetadata,
  LAST_USED_WRITE_INTERVAL_MS,
  lastUsedIsStale,
  parseApiSource,
} from "../../supabase/functions/echo-api/apiKeyAuth.ts";
import {
  agentDisplayName,
  normalizeEmail,
  resolveApiAuthor,
  withAgentHeader,
} from "../../supabase/functions/echo-api/author.ts";

function equal(a: unknown, b: unknown, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

// Montados por partes só para que as chaves de mentira não pareçam segredos reais a um scanner de vazamento.
const SERVICE = ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoic2VydmljZV9yb2xlIn0", "assinatura-legada"].join(".");
const SECRET = ["sb", "secret", "abcdefghijklmnopqrstuvwxyz"].join("_");

const b64 = (v: unknown) =>
  btoa(JSON.stringify(v)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const fakeJwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;

function req(headers: Record<string, string> = {}) {
  return new Request("https://edge.invalid/fn", { method: "POST", headers });
}

function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  return async () => {
    const before: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      before[k] = Deno.env.get(k);
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    const warn = console.warn;
    console.warn = () => {};
    try {
      await fn();
    } finally {
      console.warn = warn;
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  };
}

const baseEnv = {
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  SUPABASE_SECRET_KEYS: undefined,
  EDGE_INTERNAL_SECRET_KEYS: undefined,
  EDGE_INTERNAL_AUTH_ENFORCE: undefined,
};

Deno.test("aceita a SUPABASE_SERVICE_ROLE_KEY no Authorization e no apikey", withEnv(baseEnv, () => {
  equal(isInternalCaller(req({ Authorization: `Bearer ${SERVICE}` })), { ok: true, via: "service_role_key" });
  equal(isInternalCaller(req({ apikey: SERVICE })), { ok: true, via: "service_role_key" });
}));

Deno.test("aceita sb_secret_ de SUPABASE_SECRET_KEYS (JSON) e de EDGE_INTERNAL_SECRET_KEYS (lista)", async () => {
  await withEnv({ ...baseEnv, SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }) }, () => {
    equal(isInternalCaller(req({ Authorization: `Bearer ${SECRET}` })), { ok: true, via: "secret_key" });
  })();
  await withEnv({ ...baseEnv, EDGE_INTERNAL_SECRET_KEYS: `outra, ${SECRET}` }, () => {
    equal(isInternalCaller(req({ Authorization: `Bearer ${SECRET}` })), { ok: true, via: "secret_key" });
  })();
  // Sem env, a mesma chave é desconhecida.
  await withEnv(baseEnv, () => {
    equal(isInternalCaller(req({ Authorization: `Bearer ${SECRET}` })), { ok: false, reason: "chave_desconhecida" });
  })();
});

Deno.test("JWT com role=service_role só vale quando o gateway conferiu a assinatura", withEnv(baseEnv, () => {
  const forged = fakeJwt({ role: "service_role" });
  equal(isInternalCaller(req({ Authorization: `Bearer ${forged}` })), {
    ok: false,
    reason: "jwt_service_role_nao_verificado",
  });
  equal(isInternalCaller(req({ Authorization: `Bearer ${forged}` }), { jwtVerifiedByGateway: true }), {
    ok: true,
    via: "jwt_service_role",
  });
}));

Deno.test("classifica o motivo da recusa", withEnv(baseEnv, () => {
  equal(isInternalCaller(req()), { ok: false, reason: "sem_credencial" });
  equal(isInternalCaller(req({ Authorization: `Bearer ${fakeJwt({ role: "anon" })}` })), { ok: false, reason: "jwt_anon" });
  equal(isInternalCaller(req({ Authorization: `Bearer ${fakeJwt({ role: "authenticated" })}` })), {
    ok: false,
    reason: "jwt_de_usuario",
  });
  // Prefixo certo e tamanho diferente não passa.
  equal(isInternalCaller(req({ Authorization: `Bearer ${SERVICE}x` })).ok, false);
}));

Deno.test("padrão (variável ausente): recusa vira 401", withEnv(baseEnv, () => {
  equal(checkInternalCaller(req(), "fn-teste")?.status, 401);
  equal(rampDeny("fn-teste", "motivo")?.status, 401);
}));

Deno.test("EDGE_INTERNAL_AUTH_ENFORCE=0: modo log, recusa só registra e deixa seguir", withEnv(
  { ...baseEnv, EDGE_INTERNAL_AUTH_ENFORCE: "0" },
  () => {
    equal(checkInternalCaller(req(), "fn-teste"), null);
    equal(rampDeny("fn-teste", "motivo"), null);
  },
));

Deno.test("recusa por padrão: 401 com CORS e serviço continua passando", withEnv(
  baseEnv,
  async () => {
    const denied = checkInternalCaller(req({ Authorization: "Bearer qualquer" }), "fn-teste", {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
    equal(denied?.status, 401);
    equal(denied?.headers.get("Access-Control-Allow-Origin"), "*");
    equal(await denied?.json(), { error: "Unauthorized" });
    equal(checkInternalCaller(req({ Authorization: `Bearer ${SERVICE}` }), "fn-teste"), null);
  },
));

Deno.test("o log da rampa nunca imprime o token", async () => {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.join(" "));
  const before = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
  try {
    checkInternalCaller(req({ Authorization: "Bearer segredo-que-nao-pode-vazar" }), "fn-teste");
  } finally {
    console.warn = warn;
    if (before === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", before);
  }
  equal(lines.length, 1);
  equal(lines[0].includes("segredo-que-nao-pode-vazar"), false);
  equal(lines[0].includes("fn-teste"), true);
});

// ---------------------------------------------------------------- url-guard

Deno.test("isBlockedIp cobre as faixas internas", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.169.254",
    "0.0.0.0", "100.64.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "64:ff9b::a00:1",
  ]) {
    equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    equal(isBlockedIp(ip), false, ip);
  }
});

Deno.test("checkUrlLiteral recusa protocolo, host interno e IP literal privado", () => {
  const reasons = (u: string) => {
    const r = checkUrlLiteral(u);
    return r.ok ? "ok" : r.reason;
  };
  equal(reasons("ftp://example.com/x"), "protocolo_nao_permitido");
  equal(reasons("file:///etc/passwd"), "protocolo_nao_permitido");
  equal(reasons("http://localhost:54321/functions"), "host_interno");
  equal(reasons("http://api.localhost/"), "host_interno");
  equal(reasons("http://metadata.google.internal/"), "host_interno");
  equal(reasons("http://printer.local/"), "host_interno");
  equal(reasons("http://kong:8000/"), "host_interno");
  equal(reasons("http://127.0.0.1/"), "ip_bloqueado");
  equal(reasons("http://2130706433/"), "ip_bloqueado"); // = 127.0.0.1
  equal(reasons("http://0x7f.1/"), "ip_bloqueado");
  equal(reasons("http://[::1]:8080/"), "ip_bloqueado");
  equal(reasons("http://[fd00::5]/"), "ip_bloqueado");
  equal(reasons("http://169.254.169.254/latest/meta-data"), "ip_bloqueado");
  equal(reasons("https://user:pw@example.com/"), "credencial_na_url");
  equal(reasons("não é url"), "url_invalida");
  equal(reasons("https://hooks.example.com/botao?x=1"), "ok");
  equal(reasons("http://8.8.8.8/"), "ok");
});

Deno.test("checkOutboundUrl recusa nome público que resolve para rede interna", async () => {
  const resolver = (host: string, type: "A" | "AAAA") => {
    if (host === "rebind.example.com" && type === "A") return Promise.resolve(["10.0.0.7"]);
    if (host === "ok.example.com" && type === "A") return Promise.resolve(["93.184.216.34"]);
    return Promise.reject(new Error("NXDOMAIN"));
  };
  const bad = await checkOutboundUrl("https://rebind.example.com/hook", resolver);
  equal(bad.ok ? "ok" : bad.reason, "dns_aponta_para_rede_interna");
  const good = await checkOutboundUrl("https://ok.example.com/hook", resolver);
  equal(good.ok, true);
  // Sem resolvedor (runtime sem Deno.resolveDns): fica a camada literal.
  equal((await checkOutboundUrl("https://ok.example.com/hook", null)).ok, true);
  equal((await checkOutboundUrl("http://localhost/", null)).ok, false);
});

// ---------------------------------------------------------------- echo-api

Deno.test("lastUsedIsStale: no máximo uma escrita por minuto", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  equal(lastUsedIsStale(null, now), true);
  equal(lastUsedIsStale("lixo", now), true);
  equal(lastUsedIsStale(new Date(now - 10_000).toISOString(), now), false);
  equal(lastUsedIsStale(new Date(now - LAST_USED_WRITE_INTERVAL_MS).toISOString(), now), true);
  equal(lastUsedIsStale(new Date(now - 5 * 60_000).toISOString(), now), true);
});

type Row = Record<string, unknown> | null;
function fakeClient(rows: { member: Row; profile: Row; memberError?: boolean; profileError?: boolean }) {
  const build = (table: string) => {
    const result = table === "organization_members"
      ? { data: rows.member, error: rows.memberError ? { code: "57014" } : null }
      : { data: rows.profile, error: rows.profileError ? { code: "57014" } : null };
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve(result),
    };
    return chain;
  };
  return { from: build } as unknown as Parameters<typeof apiKeyOwnerStillAllowed>[0];
}

Deno.test("apiKeyOwnerStillAllowed: membro e super admin passam; ex-membro e chave cruzada não", async () => {
  const err = console.error;
  console.error = () => {};
  try {
    equal(await apiKeyOwnerStillAllowed(fakeClient({ member: { user_id: "u" }, profile: null }), "u", "o"), "allowed");
    equal(await apiKeyOwnerStillAllowed(fakeClient({ member: null, profile: { is_super_admin: true } }), "u", "o"), "allowed");
    equal(await apiKeyOwnerStillAllowed(fakeClient({ member: null, profile: { is_super_admin: false } }), "u", "o"), "denied");
    equal(await apiKeyOwnerStillAllowed(fakeClient({ member: null, profile: null }), "u", "o"), "denied");
    equal(
      await apiKeyOwnerStillAllowed(fakeClient({ member: null, profile: null, memberError: true }), "u", "o"),
      "error",
    );
  } finally {
    console.error = err;
  }
});

Deno.test("parseApiSource: normaliza o rótulo e nunca devolve lixo", () => {
  equal(parseApiSource(null), null);
  equal(parseApiSource(undefined), null);
  equal(parseApiSource("   "), null);
  equal(parseApiSource("acme:ai-agent-router"), "acme:ai-agent-router");
  equal(parseApiSource("  n8n:fluxo\r\nx  "), "n8n:fluxo  x");
  equal(parseApiSource("a".repeat(200))?.length, 80);
});

Deno.test("apiOriginMetadata: sempre origin e chave; nome e source só quando existem", () => {
  equal(apiOriginMetadata({ keyId: "k1", keyName: null, source: null }), { origin: "api", api_key_id: "k1" });
  equal(
    apiOriginMetadata({ keyId: "k1", keyName: "integracao-n8n", source: "n8n:fluxo" }),
    { origin: "api", api_key_id: "k1", api_key_name: "integracao-n8n", api_source: "n8n:fluxo" },
  );
});

// ---------------------------------------------------------------- autor do envio pela API

type Perfil = { id: string; first_name: string | null; last_name: string | null; email: string | null };
type Membro = { user_id: string; organization_id: string };
// Aplica TODOS os filtros encadeados, como o PostgREST: um filtro esquecido no
// código tem de aparecer aqui como pessoa de outra organização virando autor.
function authorClient(perfis: Perfil[], membros: Membro[], opts: { perfisError?: boolean } = {}) {
  const calls: string[] = [];
  const from = (table: string) => {
    const filtros: Array<(row: Record<string, unknown>) => boolean> = [];
    const chain = {
      select: () => chain,
      ilike: (c: string, v: string) => {
        calls.push(`ilike:${v}`);
        const re = new RegExp(
          "^" + v.replace(/\\(.)|([%*])|([.+?^${}()|[\]\\])/g, (_m, esc, cur, meta) =>
            esc !== undefined ? esc.replace(/[.+?^${}()|[\]\\]/g, "\\$&") : cur ? ".*" : "\\" + meta) + "$",
          "i",
        );
        filtros.push((r) => re.test(String(r[c] ?? "")));
        return chain;
      },
      eq: (c: string, v: unknown) => {
        filtros.push((r) => r[c] === v);
        return chain;
      },
      in: (c: string, vs: unknown[]) => {
        filtros.push((r) => vs.includes(r[c]));
        return chain;
      },
      limit: () => {
        if (table === "profiles" && opts.perfisError) return Promise.resolve({ data: null, error: { code: "57014" } });
        const rows = (table === "profiles" ? perfis : membros) as unknown as Record<string, unknown>[];
        return Promise.resolve({ data: rows.filter((r) => filtros.every((f) => f(r))), error: null });
      },
    };
    return chain;
  };
  return { client: { from } as unknown as Parameters<typeof resolveApiAuthor>[0], calls };
}

const BRUNO: Perfil = { id: "t1", first_name: "Bruno", last_name: "Silva", email: "bruno@example.com" };
const CARLA: Perfil = { id: "j1", first_name: "Carla", last_name: null, email: "carla.g@example.com" };
const DE_FORA: Perfil = { id: "f1", first_name: "Fulana", last_name: "Outra", email: "fulana@outra.com" };
const MEMBROS: Membro[] = [{ user_id: "t1", organization_id: "o" }, { user_id: "f1", organization_id: "outra-org" }];

Deno.test("agentDisplayName/withAgentHeader: mesma regra do painel", () => {
  equal(agentDisplayName(BRUNO), "Bruno Silva");
  equal(agentDisplayName(CARLA), "Carla");
  equal(agentDisplayName({ first_name: null, last_name: "X", email: "ana.b@x.com" }), "ana.b");
  equal(agentDisplayName(null), "Agente");
  equal(withAgentHeader("Ola Ana", "Bruno Silva"), "*Bruno Silva*\n\nOla Ana");
});

Deno.test("normalizeEmail: aceita e-mail, recusa vazio, curinga e lixo", () => {
  equal(normalizeEmail(" Bruno@Example.com "), "bruno@example.com");
  equal(normalizeEmail("a_b@x.com"), "a_b@x.com");
  for (const ruim of ["", "  ", "*", "a*@x.com", "sem-arroba", "a@b@c", "a b@x.com", 42, null]) {
    equal(normalizeEmail(ruim), null, `normalizeEmail(${JSON.stringify(ruim)})`);
  }
});

Deno.test("resolveApiAuthor: sem user_id nem user_email não consulta nada", async () => {
  const { client, calls } = authorClient([BRUNO], MEMBROS);
  equal(await resolveApiAuthor(client, "o", { userEmail: "  " }), { ok: true, author: null, unresolved: false });
  equal(calls, []);
});

Deno.test("resolveApiAuthor: e-mail de membro vira autor, sem caixa nem espaço", async () => {
  const { client } = authorClient([BRUNO], MEMBROS);
  equal(
    await resolveApiAuthor(client, "o", { userEmail: " Bruno@Example.com " }),
    { ok: true, author: { id: "t1", name: "Bruno Silva" }, unresolved: false },
  );
});

Deno.test("resolveApiAuthor: \"_\" não vira curinga e \"*\" nem chega ao banco", async () => {
  const sublinhado = { ...BRUNO, email: "a_b@x.com" };
  const parecido = { ...CARLA, id: "j2", email: "axb@x.com" };
  const { client, calls } = authorClient([sublinhado, parecido], [...MEMBROS, { user_id: "j2", organization_id: "o" }]);
  equal((await resolveApiAuthor(client, "o", { userEmail: "a_b@x.com" })), { ok: true, author: { id: "t1", name: "Bruno Silva" }, unresolved: false });
  equal(calls, ["ilike:a\\_b@x.com"]);
  equal(await resolveApiAuthor(client, "o", { userEmail: "t*" }), { ok: true, author: null, unresolved: true });
  equal(calls.length, 1);
});

Deno.test("resolveApiAuthor: quem não é membro DESTA organização sai sem autor, sem erro", async () => {
  const { client } = authorClient([BRUNO, CARLA, DE_FORA], MEMBROS);
  equal(await resolveApiAuthor(client, "o", { userEmail: CARLA.email }), { ok: true, author: null, unresolved: true });
  equal(await resolveApiAuthor(client, "o", { userEmail: DE_FORA.email }), { ok: true, author: null, unresolved: true });
  equal(await resolveApiAuthor(client, "o", { userEmail: "ninguem@x.com" }), { ok: true, author: null, unresolved: true });
  equal(await resolveApiAuthor(client, "o", { userId: "f1" }), { ok: true, author: null, unresolved: true });
  // a mesma pessoa é autora na organização dela
  equal(await resolveApiAuthor(client, "outra-org", { userEmail: DE_FORA.email }), { ok: true, author: { id: "f1", name: "Fulana Outra" }, unresolved: false });
});

Deno.test("resolveApiAuthor: user_id de membro vira autor; com e-mail, os dois têm de ser o mesmo membro", async () => {
  const { client } = authorClient([BRUNO, CARLA, DE_FORA], [...MEMBROS, { user_id: "j1", organization_id: "o" }]);
  equal(await resolveApiAuthor(client, "o", { userId: "t1" }), { ok: true, author: { id: "t1", name: "Bruno Silva" }, unresolved: false });
  equal(await resolveApiAuthor(client, "o", { userId: "t1", userEmail: BRUNO.email }), { ok: true, author: { id: "t1", name: "Bruno Silva" }, unresolved: false });
  equal(await resolveApiAuthor(client, "o", { userId: "j1", userEmail: BRUNO.email }), { ok: false, error: "mismatch" });
  // e-mail que não existe ou é de outra organização: mesma resposta, nada vaza sobre quem existe lá fora
  equal(await resolveApiAuthor(client, "o", { userId: "t1", userEmail: "erro@x.com" }), { ok: false, error: "mismatch" });
  equal(await resolveApiAuthor(client, "o", { userId: "t1", userEmail: DE_FORA.email }), { ok: false, error: "mismatch" });
  equal(await resolveApiAuthor(client, "o", { userId: "t1", userEmail: "t*" }), { ok: false, error: "mismatch" });
});

Deno.test("resolveApiAuthor: banco fora do ar não derruba o envio", async () => {
  const err = console.error;
  console.error = () => {};
  try {
    const { client } = authorClient([BRUNO], MEMBROS, { perfisError: true });
    equal(await resolveApiAuthor(client, "o", { userEmail: BRUNO.email }), { ok: true, author: null, unresolved: true });
  } finally {
    console.error = err;
  }
});
