import { afterEach, describe, expect, it, vi } from "vitest";
import { postSendMedia } from "./sendMediaRequest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.__ECHO_CONFIG__ = undefined;
});

describe("postSendMedia", () => {
  it("manda para a função com o JWT e a chave anon da configuração", async () => {
    window.__ECHO_CONFIG__ = { supabaseUrl: "https://echo.exemplo.com/", supabaseAnonKey: "anon-da-config" };
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const corpo = new FormData();
    corpo.append("conversationId", "c1");

    await postSendMedia(corpo, "jwt-do-usuario");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://echo.exemplo.com/functions/v1/whatsapp-send-media");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer jwt-do-usuario", apikey: "anon-da-config" });
    expect(init.body).toBe(corpo);
  });
});
