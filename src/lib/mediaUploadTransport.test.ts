import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "jwt", user: { id: "user-1" } } } }),
    },
  },
}));

const xhrs: FakeXhr[] = [];
class FakeXhr {
  url = "";
  headers: Record<string, string> = {};
  status = 0;
  responseText = "";
  body: unknown = null;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
    xhrs.push(this);
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, text = "{}") {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}
vi.stubGlobal("XMLHttpRequest", FakeXhr);

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { mediaUploadQueue } = await import("./mediaUploadTransport");
const { knownMediaSize, wasMediaLoaded } = await import("./mediaSizeCache");

const flush = () => new Promise((r) => setTimeout(r, 0));
const file = () => new File(["x".repeat(300)], "Record (online).mp3", { type: "audio/mpeg" });

afterEach(() => {
  mediaUploadQueue.getSnapshot().forEach((i) => mediaUploadQueue.cancel(i.id));
  xhrs.length = 0;
  fetchMock.mockReset();
});

describe("mediaUploadTransport", () => {
  it("sobe para o Storage e manda só o caminho para a edge", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    mediaUploadQueue.enqueue([
      { conversationId: "c1", file: file(), previewUrl: "", caption: "", fields: { to: "5511" } },
    ]);
    await flush();

    const [xhr] = xhrs;
    expect(xhr.url).toMatch(/\/storage\/v1\/object\/attachments\/outbound\/user-1\/\d+_Record_online_.mp3$/);
    expect(xhr.headers["Content-Type"]).toBe("audio/mpeg");
    expect(xhr.body).toBeInstanceOf(File);

    xhr.respond(200);
    await flush();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/functions\/v1\/whatsapp-send-media$/);
    const form = init.body as FormData;
    expect(form.get("file")).toBeNull();
    expect(form.get("storagePath")).toMatch(/^outbound\/user-1\//);
    expect(form.get("filename")).toBe("Record (online).mp3");
    expect(form.get("to")).toBe("5511");
    await flush();
    expect(mediaUploadQueue.getSnapshot()).toHaveLength(0);
  });

  it("recusa do Storage vira falha legível e não chama a edge", async () => {
    mediaUploadQueue.enqueue([{ conversationId: "c1", file: file(), previewUrl: "", caption: "", fields: {} }]);
    await flush();
    xhrs[0].respond(413, JSON.stringify({ error: "Payload too large" }));
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mediaUploadQueue.getSnapshot()[0]).toMatchObject({
      status: "failed",
      error: "Arquivo maior que o limite permitido.",
    });
  });

  it("tentar de novo depois de falha na edge não sobe o arquivo outra vez", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Número desconectado" }), { status: 500 }));
    const [id] = mediaUploadQueue.enqueue([
      { conversationId: "c1", file: file(), previewUrl: "", caption: "", fields: {} },
    ]);
    await flush();
    xhrs[0].respond(200);
    await flush();
    await flush();
    expect(mediaUploadQueue.getSnapshot()[0]).toMatchObject({ status: "failed", error: "Número desconectado" });

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    mediaUploadQueue.retry(id);
    await flush();
    await flush();
    expect(xhrs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mediaUploadQueue.getSnapshot()).toHaveLength(0);
  });

  describe("semente do cache de tamanho", () => {
    const imageFile = () => new File(["x".repeat(300)], "foto.jpg", { type: "image/jpeg" });
    const urlOf = (path: string) =>
      `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/attachments/${path}`;

    const run = async (fields: Record<string, string>) => {
      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
      mediaUploadQueue.enqueue([
        { conversationId: "c1", file: imageFile(), previewUrl: "", caption: "", fields: { to: "5511", ...fields } },
      ]);
      await flush();
      xhrs[0].respond(200);
      await flush();
      const form = fetchMock.mock.calls[0][1].body as FormData;
      return form;
    };

    it("semeia a URL pública final antes da edge responder", async () => {
      const form = await run({ mediaWidth: "1200", mediaHeight: "800" });
      const path = String(form.get("storagePath"));
      expect(knownMediaSize(urlOf(path))).toEqual({ width: 1200, height: 800 });
      expect(wasMediaLoaded(urlOf(path))).toBe(false);
      expect(form.get("mediaWidth")).toBe("1200");
    });

    it.each([["0"], ["abc"]])("não semeia com tamanho inválido (%s)", async (bad) => {
      const form = await run({ mediaWidth: bad, mediaHeight: bad });
      expect(knownMediaSize(urlOf(String(form.get("storagePath"))))).toBeUndefined();
    });
  });
});
