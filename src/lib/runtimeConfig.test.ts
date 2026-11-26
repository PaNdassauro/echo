import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeConfigError,
  functionUrl,
  getRuntimeConfig,
  getRuntimeFeatures,
  isOwnStorageBase,
  publicAttachmentUrl,
  publicFunctionUrl,
  qrServiceUrl,
  restUrl,
  siteUrl,
  storageUrl,
  supabaseBaseUrl,
} from "./runtimeConfig";

const ORIGEM = window.location.origin;

/** Sem nenhuma VITE_* (o que o build do docker vê): só /config.js e o padrão de mesma origem. */
function semEnv() {
  for (const nome of [
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "VITE_QR_SERVICE_URL",
    "VITE_SITE_URL",
    "VITE_VAPID_PUBLIC_KEY",
    "VITE_FEEDBACK_WEBHOOK_URL",
  ]) {
    vi.stubEnv(nome, "");
  }
}

beforeEach(() => {
  window.__ECHO_CONFIG__ = undefined;
});

afterEach(() => {
  window.__ECHO_CONFIG__ = undefined;
  vi.unstubAllEnvs();
});

describe("runtimeConfig: precedência por campo", () => {
  it("/config.js vence a env, que vence o padrão de mesma origem", () => {
    semEnv();
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "chave-da-env");
    vi.stubEnv("VITE_SUPABASE_URL", "https://api-da-env.exemplo.com");
    vi.stubEnv("VITE_QR_SERVICE_URL", "https://qr-da-env.exemplo.com");
    window.__ECHO_CONFIG__ = { supabaseUrl: "https://api-do-config.exemplo.com", supabaseAnonKey: "chave-do-config" };

    const config = getRuntimeConfig();

    expect(config.supabaseUrl).toBe("https://api-do-config.exemplo.com"); // /config.js
    expect(config.supabaseAnonKey).toBe("chave-do-config");
    expect(config.qrServiceUrl).toBe("https://qr-da-env.exemplo.com"); // só a env definiu
    expect(config.siteUrl).toBe(ORIGEM); // nenhum definiu: padrão
  });

  it("sem /config.js a env serve (desenvolvimento e hospedagem estática)", () => {
    semEnv();
    vi.stubEnv("VITE_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon-local");
    vi.stubEnv("VITE_VAPID_PUBLIC_KEY", "vapid-publica");
    vi.stubEnv("VITE_FEEDBACK_WEBHOOK_URL", "https://hooks.exemplo.com/feedback");

    expect(getRuntimeConfig()).toMatchObject({
      supabaseUrl: "http://127.0.0.1:54321",
      supabaseAnonKey: "anon-local",
      vapidPublicKey: "vapid-publica",
      feedbackWebhookUrl: "https://hooks.exemplo.com/feedback",
    });
  });

  it("string vazia conta como ausente, no /config.js e na env", () => {
    semEnv();
    vi.stubEnv("VITE_SUPABASE_URL", "https://api-da-env.exemplo.com");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "chave-da-env");
    window.__ECHO_CONFIG__ = { supabaseUrl: "", supabaseAnonKey: "  ", vapidPublicKey: "", feedbackWebhookUrl: "" };

    const config = getRuntimeConfig();

    expect(config.supabaseUrl).toBe("https://api-da-env.exemplo.com");
    expect(config.supabaseAnonKey).toBe("chave-da-env");
    expect(config.vapidPublicKey).toBeNull();
    expect(config.feedbackWebhookUrl).toBeNull();
  });

  it("campo com tipo errado no /config.js é ignorado em vez de derrubar o app", () => {
    semEnv();
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "chave-da-env");
    window.__ECHO_CONFIG__ = { supabaseUrl: 123, features: "tudo" };

    const config = getRuntimeConfig();

    expect(config.supabaseUrl).toBe(ORIGEM);
    expect(config.features.email).toBe(true);
  });

  it("/config.js que nem é objeto cai para a env", () => {
    semEnv();
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "chave-da-env");
    window.__ECHO_CONFIG__ = "lixo";

    expect(getRuntimeConfig().supabaseAnonKey).toBe("chave-da-env");
  });
});

describe("runtimeConfig: opcionais mal formados não derrubam o app", () => {
  beforeEach(() => {
    semEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("feedbackWebhookUrl sem esquema no /config.js vira null com aviso, e o resto da configuração sobrevive", () => {
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", feedbackWebhookUrl: "hooks.exemplo.com/feedback" };

    const config = getRuntimeConfig();

    expect(config.feedbackWebhookUrl).toBeNull();
    expect(config.supabaseAnonKey).toBe("anon");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("feedbackWebhookUrl"));
  });

  it("feedbackWebhookUrl mal formado em VITE_FEEDBACK_WEBHOOK_URL (hospedagem estática) também vira null", () => {
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon");
    vi.stubEnv("VITE_FEEDBACK_WEBHOOK_URL", "ftp://hooks.exemplo.com/feedback");

    expect(getRuntimeConfig().feedbackWebhookUrl).toBeNull();
  });

  it("vapidPublicKey com espaço ou aspas vira null com aviso", () => {
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", vapidPublicKey: 'chave com "aspas"' };

    expect(getRuntimeConfig().vapidPublicKey).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("vapidPublicKey"));
  });

  it("valores válidos passam sem aviso", () => {
    window.__ECHO_CONFIG__ = {
      supabaseAnonKey: "anon",
      vapidPublicKey: "BNc-abc_123",
      feedbackWebhookUrl: "https://hooks.exemplo.com/feedback",
    };

    expect(getRuntimeConfig()).toMatchObject({
      vapidPublicKey: "BNc-abc_123",
      feedbackWebhookUrl: "https://hooks.exemplo.com/feedback",
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("só a chave anon e as URLs obrigatórias ainda dão RuntimeConfigError", () => {
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", siteUrl: "http://" };
    expect(() => getRuntimeConfig()).toThrow(RuntimeConfigError);
  });
});

describe("runtimeConfig: padrões de mesma origem", () => {
  beforeEach(() => {
    semEnv();
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon" };
  });

  it("supabaseUrl e siteUrl = origem da página; qrServiceUrl = origem + /qr", () => {
    expect(getRuntimeConfig()).toMatchObject({
      supabaseUrl: ORIGEM,
      siteUrl: ORIGEM,
      qrServiceUrl: `${ORIGEM}/qr`,
      vapidPublicKey: null,
      feedbackWebhookUrl: null,
    });
    expect(supabaseBaseUrl()).toBe(ORIGEM);
    expect(siteUrl()).toBe(ORIGEM);
    expect(qrServiceUrl()).toBe(`${ORIGEM}/qr`);
  });

  it("features ausentes valem todas true (o comportamento do caminho Supabase na nuvem)", () => {
    expect(getRuntimeConfig().features).toEqual({
      email: true,
      recuperacaoSenha: true,
      feedback: true,
      transformacaoImagem: true,
    });
  });

  it("features do /config.js valem campo a campo, e o resto continua true", () => {
    window.__ECHO_CONFIG__ = {
      supabaseAnonKey: "anon",
      features: { email: false, recuperacaoSenha: false, transformacaoImagem: false },
    };

    expect(getRuntimeConfig().features).toEqual({
      email: false,
      recuperacaoSenha: false,
      feedback: true,
      transformacaoImagem: false,
    });
    expect(getRuntimeFeatures().transformacaoImagem).toBe(false);
  });

  it("getRuntimeFeatures não exige a chave anon", () => {
    window.__ECHO_CONFIG__ = { features: { feedback: false } };
    expect(getRuntimeFeatures().feedback).toBe(false);
  });
});

describe("runtimeConfig: URLs", () => {
  beforeEach(() => {
    semEnv();
  });

  it("valor relativo é resolvido contra a origem; barra final é removida", () => {
    window.__ECHO_CONFIG__ = {
      supabaseAnonKey: "anon",
      qrServiceUrl: "/qr/",
      supabaseUrl: "https://echo.exemplo.com///",
      siteUrl: "https://site.exemplo.com/",
    };

    const config = getRuntimeConfig();

    expect(config.qrServiceUrl).toBe(`${ORIGEM}/qr`);
    expect(config.supabaseUrl).toBe("https://echo.exemplo.com");
    expect(config.siteUrl).toBe("https://site.exemplo.com");
  });

  it("URL impossível de resolver vira RuntimeConfigError com o nome do campo", () => {
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", supabaseUrl: "http://" };
    expect(() => getRuntimeConfig()).toThrow(RuntimeConfigError);
    expect(() => getRuntimeConfig()).toThrow(/supabaseUrl/);
  });

  it("monta function, rest e storage sobre a base atual", () => {
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", supabaseUrl: "https://echo.exemplo.com" };

    expect(functionUrl("whatsapp-send-media")).toBe("https://echo.exemplo.com/functions/v1/whatsapp-send-media");
    expect(functionUrl("/echo-api")).toBe("https://echo.exemplo.com/functions/v1/echo-api");
    expect(restUrl("messages?id=eq.1")).toBe("https://echo.exemplo.com/rest/v1/messages?id=eq.1");
    expect(storageUrl("object/attachments/a.png")).toBe("https://echo.exemplo.com/storage/v1/object/attachments/a.png");
  });

  it("publicAttachmentUrl segue o formato do getPublicUrl do storage-js (encodeURI)", () => {
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", supabaseUrl: "https://echo.exemplo.com" };

    expect(publicAttachmentUrl("outbound/u1/foto 1.png")).toBe(
      "https://echo.exemplo.com/storage/v1/object/public/attachments/outbound/u1/foto%201.png",
    );
  });

  it("publicAttachmentUrl usa a base canônica (siteUrl do /config.js) mesmo com a aba aberta por outro endereço", () => {
    window.__ECHO_CONFIG__ = {
      supabaseAnonKey: "anon",
      supabaseUrl: "http://192.168.0.10:8088",
      siteUrl: "https://echo.exemplo.com",
    };

    expect(publicAttachmentUrl("outbound/u1/foto 1.png")).toBe(
      "https://echo.exemplo.com/storage/v1/object/public/attachments/outbound/u1/foto%201.png",
    );
  });

  it("publicAttachmentUrl com VITE_SUPABASE_URL e VITE_SITE_URL (caminho Cloud) usa a base do Supabase", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon");
    vi.stubEnv("VITE_SITE_URL", "https://app.exemplo.com");

    expect(publicAttachmentUrl("a/b.png")).toBe("https://proj.supabase.co/storage/v1/object/public/attachments/a/b.png");
  });

  it("publicFunctionUrl: com siteUrl explícito é o endereço do site; sem ele, a base do Supabase", () => {
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", supabaseUrl: "http://192.168.0.10:8088", siteUrl: "https://echo.exemplo.com" };
    expect(publicFunctionUrl("whatsapp-webhook")).toBe("https://echo.exemplo.com/functions/v1/whatsapp-webhook");

    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", supabaseUrl: "https://proj.exemplo.com" };
    expect(publicFunctionUrl("whatsapp-webhook")).toBe("https://proj.exemplo.com/functions/v1/whatsapp-webhook");
  });

  it("publicFunctionUrl: com VITE_SUPABASE_URL (front e API em hosts diferentes), VITE_SITE_URL não vira endereço de função", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "anon");
    vi.stubEnv("VITE_SITE_URL", "https://app.exemplo.com");

    expect(publicFunctionUrl("whatsapp-webhook")).toBe("https://proj.supabase.co/functions/v1/whatsapp-webhook");
    expect(siteUrl()).toBe("https://app.exemplo.com"); // o endereço do front continua valendo nos links de convite
  });

  it("publicFunctionUrl: com supabaseUrl no /config.js e VITE_SITE_URL, também é a base do Supabase", () => {
    vi.stubEnv("VITE_SITE_URL", "https://app.exemplo.com");
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon", supabaseUrl: "https://proj.supabase.co" };

    expect(publicFunctionUrl("echo-api")).toBe("https://proj.supabase.co/functions/v1/echo-api");
  });

  it("publicFunctionUrl: sem base do Supabase definida (mesma origem), VITE_SITE_URL é o endereço público", () => {
    vi.stubEnv("VITE_SITE_URL", "https://echo.exemplo.com");
    window.__ECHO_CONFIG__ = { supabaseAnonKey: "anon" };

    expect(publicFunctionUrl("echo-api")).toBe("https://echo.exemplo.com/functions/v1/echo-api");
  });
});

describe("runtimeConfig: anexo é do nosso Storage?", () => {
  beforeEach(() => {
    semEnv();
    window.__ECHO_CONFIG__ = {
      supabaseAnonKey: "anon",
      supabaseUrl: "http://192.168.0.10:8088",
      siteUrl: "https://echo.exemplo.com",
    };
  });

  it("aceita a base atual e o endereço canônico, e devolve a que casou", () => {
    expect(isOwnStorageBase("http://192.168.0.10:8088/storage/v1/object/public/attachments/a.png")).toBe(
      "http://192.168.0.10:8088",
    );
    expect(isOwnStorageBase("https://echo.exemplo.com/storage/v1/object/public/attachments/a.png")).toBe(
      "https://echo.exemplo.com",
    );
  });

  it("recusa host de fora, prefixo parecido e vazio", () => {
    expect(isOwnStorageBase("https://outro.exemplo.com/storage/v1/object/public/attachments/a.png")).toBeNull();
    expect(isOwnStorageBase("https://echo.exemplo.com.atacante.net/storage/v1/object/public/attachments/a.png")).toBeNull();
    expect(isOwnStorageBase("https://echo.exemplo.com/outra/rota")).toBeNull();
    expect(isOwnStorageBase("")).toBeNull();
  });
});

describe("runtimeConfig: sem chave anon", () => {
  it("lança RuntimeConfigError dizendo o que falta e onde", () => {
    semEnv();
    window.__ECHO_CONFIG__ = {};

    expect(() => getRuntimeConfig()).toThrow(RuntimeConfigError);
    expect(() => getRuntimeConfig()).toThrow("Echo sem configuração: falta supabaseAnonKey (/config.js)");
  });
});
