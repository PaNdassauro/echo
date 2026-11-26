import { describe, expect, it, vi } from "vitest";
import {
  createDeliveryMatcher,
  createUploadQueue,
  type TransportArgs,
  type UploadRequest,
} from "./mediaUploadQueue";

/** Transporte controlável: cada chamada fica pendente até o teste resolver. */
function fakeTransport() {
  const calls: Array<
    TransportArgs & { resolve: () => void; reject: (e: unknown) => void }
  > = [];
  const transport = (args: TransportArgs) =>
    new Promise<void>((resolve, reject) => {
      const call = { ...args, resolve, reject };
      args.signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
      calls.push(call);
    });
  return { calls, transport };
}

const req = (
  name: string,
  conversationId = "c1",
  previewUrl = "",
): UploadRequest => ({
  conversationId,
  file: new File(["x".repeat(100)], name, { type: "video/mp4" }),
  previewUrl,
  caption: "",
  fields: { to: "5511999999999" },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("mediaUploadQueue", () => {
  it("sobe em série por conversa, na ordem da seleção", async () => {
    const { calls, transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    q.enqueue([req("a"), req("b"), req("c")]);

    expect(calls.map((c) => c.file.name)).toEqual(["a"]);
    expect(q.getSnapshot().map((i) => i.status)).toEqual([
      "uploading",
      "queued",
      "queued",
    ]);

    calls[0].resolve();
    await flush();
    expect(calls.map((c) => c.file.name)).toEqual(["a", "b"]);
    expect(q.getSnapshot().map((i) => i.file.name)).toEqual(["b", "c"]);
  });

  it("conversas diferentes sobem em paralelo", () => {
    const { calls, transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    q.enqueue([req("a", "c1"), req("b", "c2")]);
    expect(calls.map((c) => c.file.name)).toEqual(["a", "b"]);
  });

  it("repassa o progresso e vira processing no último byte", () => {
    const { calls, transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    q.enqueue([req("a")]);

    calls[0].onProgress(40, 100);
    expect(q.getSnapshot()[0]).toMatchObject({
      loaded: 40,
      total: 100,
      status: "uploading",
    });

    calls[0].onUploaded();
    expect(q.getSnapshot()[0]).toMatchObject({
      status: "processing",
      loaded: 100,
    });
  });

  it("X durante o upload aborta, remove e começa o próximo", async () => {
    const { calls, transport } = fakeTransport();
    const revoke = vi.fn();
    const q = createUploadQueue(transport, { revokeUrl: revoke });
    const [idA] = q.enqueue([req("a", "c1", "blob:a"), req("b")]);

    expect(q.cancel(idA)).toBe(true);
    expect(calls[0].signal.aborted).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(calls.map((c) => c.file.name)).toEqual(["a", "b"]);
    await flush();
    // O reject do abort não vira falha nem dispara o pump de novo.
    expect(q.getSnapshot().map((i) => [i.file.name, i.status])).toEqual([
      ["b", "uploading"],
    ]);
    expect(calls).toHaveLength(2);
  });

  it("X num item na fila só o tira da fila", () => {
    const { calls, transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    const [, idB] = q.enqueue([req("a"), req("b"), req("c")]);

    expect(q.cancel(idB)).toBe(true);
    expect(q.getSnapshot().map((i) => i.file.name)).toEqual(["a", "c"]);
    expect(calls).toHaveLength(1);
  });

  it("não cancela depois que o arquivo chegou ao servidor", () => {
    const { calls, transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    const [id] = q.enqueue([req("a")]);
    calls[0].onUploaded();

    expect(q.cancel(id)).toBe(false);
    expect(calls[0].signal.aborted).toBe(false);
    expect(q.getSnapshot()).toHaveLength(1);
  });

  it("falha não trava a fila e o retry reenvia o mesmo item", async () => {
    const { calls, transport } = fakeTransport();
    const onFailed = vi.fn();
    const onSent = vi.fn();
    const q = createUploadQueue(transport, {
      revokeUrl: () => {},
      errorMessage: () => "deu ruim",
    });
    const [idA] = q.enqueue([req("a"), req("b")], { onFailed, onSent });

    calls[0].reject(new Error("500"));
    await flush();
    expect(q.getSnapshot().map((i) => [i.file.name, i.status])).toEqual([
      ["a", "failed"],
      ["b", "uploading"],
    ]);
    expect(q.getSnapshot()[0].error).toBe("deu ruim");
    expect(onFailed).toHaveBeenCalledTimes(1);

    q.retry(idA);
    // b ainda sobe: a espera a vez.
    expect(q.getSnapshot()[0].status).toBe("queued");
    calls[1].resolve();
    await flush();
    expect(calls.map((c) => c.file.name)).toEqual(["a", "b", "a"]);
    calls[2].resolve();
    await flush();
    expect(q.getSnapshot()).toHaveLength(0);
    expect(onSent).toHaveBeenCalledTimes(2);
  });

  it("hasPending ignora itens falhados", async () => {
    const { calls, transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    q.enqueue([req("a")]);
    expect(q.hasPending()).toBe(true);
    calls[0].reject(new Error("x"));
    await flush();
    expect(q.hasPending()).toBe(false);
  });

  it("notifica assinantes com snapshot novo a cada mudança", () => {
    const { transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    const listener = vi.fn();
    q.subscribe(listener);
    const before = q.getSnapshot();
    q.enqueue([req("a")]);
    expect(listener).toHaveBeenCalled();
    expect(q.getSnapshot()).not.toBe(before);
  });

  it("marca a posição no lote para escalonar a entrada", () => {
    const { transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    q.enqueue([req("a"), req("b")]);
    q.enqueue([req("c")]);
    expect(q.getSnapshot().map((i) => i.batchIndex)).toEqual([0, 1, 0]);
  });

  it("settle tira a bolha em processing sem esperar a resposta", async () => {
    const { calls, transport } = fakeTransport();
    const onSent = vi.fn();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    const [id] = q.enqueue([req("a"), req("b")], { onSent });

    q.settle(id); // ainda subindo: não vale
    expect(q.getSnapshot()).toHaveLength(2);

    calls[0].onUploaded();
    q.settle(id);
    expect(q.getSnapshot().map((i) => i.file.name)).toEqual(["b"]);
    expect(calls).toHaveLength(1); // o próximo só sobe quando o envio de fato termina
    q.enqueue([req("c")]); // enfileirar no intervalo não fura a vez
    expect(calls).toHaveLength(1);

    calls[0].resolve();
    await flush();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.file.name)).toEqual(["a", "b"]);
  });
});

describe("createDeliveryMatcher", () => {
  const out = (id: string, name: string) => ({
    id,
    direction: "outbound",
    media_filename: name,
  });

  it("casa só mensagem nova depois do processing, pelo nome do arquivo", () => {
    const { calls, transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    const [id] = q.enqueue([req("video.mp4")]);
    const match = createDeliveryMatcher();
    // Envio antigo do MESMO arquivo já na conversa.
    const history = [out("m-old", "video.mp4")];

    expect(match(q.getSnapshot(), history, "c1")).toEqual([]); // ainda subindo
    calls[0].onUploaded();
    expect(match(q.getSnapshot(), history, "c1")).toEqual([]); // grava a linha de base
    expect(match(q.getSnapshot(), history, "c1")).toEqual([]); // o antigo não conta

    const withReal = [
      ...history,
      { id: "m-in", direction: "inbound", media_filename: "video.mp4" },
    ];
    expect(match(q.getSnapshot(), withReal, "c1")).toEqual([]); // recebida não conta

    expect(
      match(q.getSnapshot(), [...withReal, out("m-new", "video.mp4")], "c1"),
    ).toEqual([id]);
  });

  it("ignora outra conversa e nome diferente", () => {
    const { calls, transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    q.enqueue([req("a.pdf", "c1")]);
    calls[0].onUploaded();
    const match = createDeliveryMatcher();
    match(q.getSnapshot(), [], "c1");

    expect(match(q.getSnapshot(), [out("m1", "b.pdf")], "c1")).toEqual([]);
    expect(match(q.getSnapshot(), [out("m1", "a.pdf")], "c2")).toEqual([]);
  });

  it("uma mensagem não entrega dois itens", () => {
    const { calls, transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    q.enqueue([req("a.pdf", "c1"), req("a.pdf", "c2")]);
    calls.forEach((c) => c.onUploaded());
    const match = createDeliveryMatcher();
    const items = q.getSnapshot().map((i) => ({ ...i, conversationId: "c1" }));
    match(items, [], "c1");

    expect(match(items, [out("m1", "a.pdf")], "c1")).toHaveLength(1);
  });

  it("copia o tamanho medido para o item e o mantém depois do progresso", () => {
    const { calls, transport } = fakeTransport();
    const q = createUploadQueue(transport, { revokeUrl: () => {} });
    const mediaSize = { width: 1200, height: 800 };
    q.enqueue([{ ...req("foto.jpg"), mediaSize }]);

    const item = q.getSnapshot()[0];
    expect(item.mediaSize).toEqual(mediaSize);
    expect(item.mediaSize).not.toBe(mediaSize);

    calls[0].onProgress(50, 100);
    expect(q.getSnapshot()[0].mediaSize).toEqual({ width: 1200, height: 800 });
  });
});
