import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";

// O client real exige VITE_SUPABASE_URL no import: irrelevante aqui, o client é
// injetado em cada teste.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { criarRegistroPresenca } from "./presencaPorNumero";

const IDLE_MS = 30_000;

type Binding = (mensagem: { payload: unknown }) => void;
type CallbackDeStatus = (status: string, erro?: Error) => void;

interface CanalFalso {
  topic: string;
  eventos: string[];
  binding: Binding | null;
  assinado: boolean;
  callback: CallbackDeStatus | null;
  on: (tipo: string, filtro: { event: string }, binding: Binding) => CanalFalso;
  subscribe: (callback?: CallbackDeStatus) => CanalFalso;
  /** Entrega um evento de broadcast, como o Realtime faria. */
  emitir: (payload: unknown) => void;
  /** Entrega um status de assinatura ao registro (TIMED_OUT, CHANNEL_ERROR…). */
  status: (status: string, erro?: Error) => void;
}

/**
 * Client falso no formato do `supabase-js`: `channel(topic)` devolve SEMPRE o
 * mesmo objeto enquanto o canal não saiu (como o de verdade, que deduplica por
 * tópico). `removeChannel` age como o realtime-js 2.87.1: tira o canal da lista
 * na hora e o `close` da saída chega ao callback da assinatura (CLOSED).
 */
function criarClienteFalso() {
  const canais: CanalFalso[] = [];
  const removidos: CanalFalso[] = [];
  const vivos = new Map<string, CanalFalso>();

  const client = {
    channel: (topic: string) => {
      const existente = vivos.get(topic);
      if (existente) return existente as unknown as RealtimeChannel;

      const canal: CanalFalso = {
        topic,
        eventos: [],
        binding: null,
        assinado: false,
        callback: null,
        on: (_tipo, filtro, binding) => {
          canal.eventos.push(filtro.event);
          canal.binding = binding;
          return canal;
        },
        subscribe: (callback) => {
          canal.assinado = true;
          canal.callback = callback ?? null;
          return canal;
        },
        emitir: (payload) => canal.binding?.({ payload }),
        status: (status, erro) => canal.callback?.(status, erro),
      };
      vivos.set(topic, canal);
      canais.push(canal);
      return canal as unknown as RealtimeChannel;
    },
    removeChannel: (canal: RealtimeChannel) => {
      const falso = canal as unknown as CanalFalso;
      removidos.push(falso);
      if (vivos.get(falso.topic) === falso) vivos.delete(falso.topic);
      falso.callback?.("CLOSED");
      return Promise.resolve("ok");
    },
  };

  return { client, canais, removidos };
}

const ultimoCanal = (canais: CanalFalso[]) => canais[canais.length - 1];

describe("criarRegistroPresenca", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("assina o tópico presence-<id> e liga o evento chatstate", () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });

    registro.assinarPresenca("linha-1", vi.fn());

    expect(falso.canais).toHaveLength(1);
    expect(falso.canais[0].topic).toBe("presence-linha-1");
    expect(falso.canais[0].eventos).toEqual(["chatstate"]);
    expect(falso.canais[0].assinado).toBe(true);
  });

  it("dois ouvintes do mesmo número dividem um canal só e os dois recebem o evento", () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
    const a = vi.fn();
    const b = vi.fn();

    registro.assinarPresenca("linha-1", a);
    registro.assinarPresenca("linha-1", b);
    falso.canais[0].emitir({ state: "typing" });

    expect(falso.canais).toHaveLength(1);
    expect(a).toHaveBeenCalledExactlyOnceWith({ state: "typing" });
    expect(b).toHaveBeenCalledExactlyOnceWith({ state: "typing" });
  });

  it("números diferentes têm canais diferentes, e o evento não cruza", () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
    const a = vi.fn();
    const b = vi.fn();

    registro.assinarPresenca("linha-1", a);
    registro.assinarPresenca("linha-2", b);
    falso.canais[1].emitir("so-da-2");

    expect(falso.canais.map((c) => c.topic)).toEqual(["presence-linha-1", "presence-linha-2"]);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledExactlyOnceWith("so-da-2");
  });

  it("a saída do último ouvinte só desmonta o canal depois do tempo ocioso", async () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });

    const sair = registro.assinarPresenca("linha-1", vi.fn());
    sair();

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(falso.removidos).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(falso.removidos).toEqual([falso.canais[0]]);
  });

  it("enquanto sobra um ouvinte o canal não entra em ocioso", async () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
    const restante = vi.fn();

    const sairA = registro.assinarPresenca("linha-1", vi.fn());
    registro.assinarPresenca("linha-1", restante);
    sairA();

    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(falso.removidos).toHaveLength(0);

    falso.canais[0].emitir("ainda-vivo");
    expect(restante).toHaveBeenCalledExactlyOnceWith("ainda-vivo");
  });

  it("voltar ao número dentro do tempo ocioso reaproveita o canal vivo", async () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });

    const sair = registro.assinarPresenca("linha-1", vi.fn());
    sair();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);

    const volta = vi.fn();
    registro.assinarPresenca("linha-1", volta);

    // O timer antigo foi cancelado: passar do prazo original não desmonta nada.
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(falso.canais).toHaveLength(1);
    expect(falso.removidos).toHaveLength(0);

    falso.canais[0].emitir("reaproveitado");
    expect(volta).toHaveBeenCalledExactlyOnceWith("reaproveitado");
  });

  it("voltar ao número depois do tempo ocioso e da remoção abre um canal novo e entrega nele", async () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });

    registro.assinarPresenca("linha-1", vi.fn())();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(falso.removidos).toHaveLength(1);

    // Se a entrada desmontada ficasse no mapa, a volta se penduraria nela e o
    // "digitando" do número sumiria até recarregar a página.
    const volta = vi.fn();
    registro.assinarPresenca("linha-1", volta);

    expect(falso.canais).toHaveLength(2);
    expect(falso.canais[1]).not.toBe(falso.canais[0]);
    expect(falso.canais[1].assinado).toBe(true);

    falso.canais[1].emitir("canal-novo");
    expect(volta).toHaveBeenCalledExactlyOnceWith("canal-novo");
  });

  it("depois que o último ouvinte sai, o canal parado não entrega mais nada", async () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
    const ouvinte = vi.fn();

    const sair = registro.assinarPresenca("linha-1", ouvinte);
    sair();
    falso.canais[0].emitir("tarde-demais");

    expect(ouvinte).not.toHaveBeenCalled();
  });

  it("um ouvinte que lança não impede os outros de receber o evento", () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const quebrado = vi.fn(() => {
      throw new Error("ouvinte com defeito");
    });
    const saudavel = vi.fn();

    registro.assinarPresenca("linha-1", quebrado);
    registro.assinarPresenca("linha-1", saudavel);
    falso.canais[0].emitir("evento");

    expect(quebrado).toHaveBeenCalledTimes(1);
    expect(saudavel).toHaveBeenCalledExactlyOnceWith("evento");
    expect(erro).toHaveBeenCalledTimes(1);
  });

  it("um ouvinte que sai durante o despacho não recebe o evento que já estava na fila", () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
    const segundo = vi.fn();
    let sairDoSegundo: () => void = () => undefined;

    registro.assinarPresenca("linha-1", () => sairDoSegundo());
    sairDoSegundo = registro.assinarPresenca("linha-1", segundo);
    falso.canais[0].emitir("evento");

    expect(segundo).not.toHaveBeenCalled();
  });

  it("cancelar duas vezes é inofensivo e não encurta o tempo de quem ficou", async () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });

    const sairA = registro.assinarPresenca("linha-1", vi.fn());
    registro.assinarPresenca("linha-1", vi.fn());
    sairA();
    sairA();

    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(falso.removidos).toHaveLength(0);
  });

  it("o mesmo ouvinte assinado duas vezes conta como duas assinaturas", async () => {
    const falso = criarClienteFalso();
    const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
    const ouvinte = vi.fn();

    const sairA = registro.assinarPresenca("linha-1", ouvinte);
    registro.assinarPresenca("linha-1", ouvinte);
    sairA();

    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(falso.removidos).toHaveLength(0);

    falso.canais[0].emitir("x");
    expect(ouvinte).toHaveBeenCalledTimes(1);
  });

  it("falha ao abrir o canal não derruba quem assina, e a próxima assinatura tenta de novo", () => {
    const falso = criarClienteFalso();
    const erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const channel = vi.fn(falso.client.channel);
    channel.mockImplementationOnce(() => {
      throw new Error("realtime indisponível");
    });
    const registro = criarRegistroPresenca({
      client: { ...falso.client, channel },
      idleMs: IDLE_MS,
    });

    expect(() => registro.assinarPresenca("linha-1", vi.fn())).not.toThrow();
    expect(erro).toHaveBeenCalledTimes(1);

    const ouvinte = vi.fn();
    registro.assinarPresenca("linha-1", ouvinte);
    falso.canais[0].emitir("agora-vai");

    expect(ouvinte).toHaveBeenCalledExactlyOnceWith("agora-vai");
  });

  it("falha ao remover o canal é registrada e não impede abrir um novo depois", async () => {
    const falso = criarClienteFalso();
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const channel = vi.fn(falso.client.channel);
    // Defensivo: o client real resolve "ok" e solta o canal na hora, nunca rejeita.
    const removeChannel = vi.fn(() => Promise.reject(new Error("timeout")));
    const registro = criarRegistroPresenca({ client: { channel, removeChannel }, idleMs: IDLE_MS });

    registro.assinarPresenca("linha-1", vi.fn())();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(aviso).toHaveBeenCalledTimes(1);

    // O fake só solta o tópico quando a remoção dá certo: aqui o canal ficou
    // "vivo" no client, então o pedido novo recebe o mesmo objeto. O que se confere
    // é que o registro abriu OUTRA vez (a entrada velha não ficou no mapa) e que o
    // ouvinte novo é quem recebe.
    const novo = vi.fn();
    registro.assinarPresenca("linha-1", novo);

    expect(channel).toHaveBeenCalledTimes(2);
    falso.canais[0].emitir("depois-da-falha");
    expect(novo).toHaveBeenCalledExactlyOnceWith("depois-da-falha");
  });

  describe("falha do canal", () => {
    it.each(["CHANNEL_ERROR", "TIMED_OUT"])(
      "%s: remove o canal, reabre depois de 1 s e o ouvinte que já estava recebe pelo canal novo",
      async (status) => {
        const falso = criarClienteFalso();
        const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
        const ouvinte = vi.fn();
        registro.assinarPresenca("linha-1", ouvinte);

        falso.canais[0].status(status, new Error("queda"));

        expect(falso.removidos).toEqual([falso.canais[0]]);
        expect(falso.canais).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(999);
        expect(falso.canais).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);

        expect(falso.canais).toHaveLength(2);
        expect(falso.canais[1].assinado).toBe(true);
        falso.canais[1].emitir("pelo-canal-novo");
        expect(ouvinte).toHaveBeenCalledExactlyOnceWith("pelo-canal-novo");
        // Uma falha, um aviso: o CLOSED que a própria remoção dispara não conta.
        expect(aviso).toHaveBeenCalledTimes(1);
      },
    );

    it("a espera dobra a cada falha seguida, para no teto de 30 s e volta a 1 s depois de um SUBSCRIBED", async () => {
      const falso = criarClienteFalso();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
      registro.assinarPresenca("linha-1", vi.fn());

      for (const espera of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        const antes = falso.canais.length;
        ultimoCanal(falso.canais).status("TIMED_OUT");

        await vi.advanceTimersByTimeAsync(espera - 1);
        expect(falso.canais).toHaveLength(antes);
        await vi.advanceTimersByTimeAsync(1);
        expect(falso.canais).toHaveLength(antes + 1);
      }

      // Entrou de novo: a próxima queda começa da espera curta.
      ultimoCanal(falso.canais).status("SUBSCRIBED");
      ultimoCanal(falso.canais).status("CHANNEL_ERROR");
      const antes = falso.canais.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(falso.canais).toHaveLength(antes + 1);
    });

    it("um CLOSED que o registro não pediu (o servidor fechou o canal) também reabre", async () => {
      const falso = criarClienteFalso();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
      const ouvinte = vi.fn();
      registro.assinarPresenca("linha-1", ouvinte);

      falso.canais[0].status("CLOSED");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(falso.canais).toHaveLength(2);
      falso.canais[1].emitir("de-volta");
      expect(ouvinte).toHaveBeenCalledExactlyOnceWith("de-volta");
    });

    it("o CLOSED da remoção que o próprio registro faz no tempo ocioso não reabre nem avisa nada", async () => {
      const falso = criarClienteFalso();
      const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });

      registro.assinarPresenca("linha-1", vi.fn())();
      await vi.advanceTimersByTimeAsync(IDLE_MS + 60_000);

      expect(falso.removidos).toHaveLength(1);
      expect(falso.canais).toHaveLength(1);
      expect(aviso).not.toHaveBeenCalled();
    });

    it("falha durante o tempo ocioso desmonta de vez e não reabre canal para ninguém", async () => {
      const falso = criarClienteFalso();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });

      registro.assinarPresenca("linha-1", vi.fn())();
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
      falso.canais[0].status("TIMED_OUT");
      await vi.advanceTimersByTimeAsync(IDLE_MS * 4);

      // Removido uma vez só (pela falha), e nada reaberto.
      expect(falso.removidos).toHaveLength(1);
      expect(falso.canais).toHaveLength(1);

      // A entrada saiu do mapa: quem voltar abre um canal novo.
      registro.assinarPresenca("linha-1", vi.fn());
      expect(falso.canais).toHaveLength(2);
    });

    it("sair enquanto espera a nova tentativa cancela a tentativa e não deixa canal órfão", async () => {
      const falso = criarClienteFalso();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      // Ocioso mais curto que a espera da tentativa (1 s).
      const registro = criarRegistroPresenca({ client: falso.client, idleMs: 500 });

      const sair = registro.assinarPresenca("linha-1", vi.fn());
      falso.canais[0].status("CHANNEL_ERROR");
      sair();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(falso.canais).toHaveLength(1);
    });

    it("quem entra enquanto espera a nova tentativa passa a receber pelo canal que vier", async () => {
      const falso = criarClienteFalso();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
      const a = vi.fn();
      const b = vi.fn();

      registro.assinarPresenca("linha-1", a);
      falso.canais[0].status("TIMED_OUT");
      registro.assinarPresenca("linha-1", b);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(falso.canais).toHaveLength(2);
      falso.canais[1].emitir("pros-dois");
      expect(a).toHaveBeenCalledExactlyOnceWith("pros-dois");
      expect(b).toHaveBeenCalledExactlyOnceWith("pros-dois");
    });

    it("um status de um canal que já foi largado é ignorado", async () => {
      const falso = criarClienteFalso();
      const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const registro = criarRegistroPresenca({ client: falso.client, idleMs: IDLE_MS });
      registro.assinarPresenca("linha-1", vi.fn());

      const velho = falso.canais[0];
      velho.status("TIMED_OUT");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(falso.canais).toHaveLength(2);

      // O Realtime ainda pode dar um último TIMED_OUT do join do canal antigo.
      velho.status("TIMED_OUT");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(falso.canais).toHaveLength(2);
      expect(aviso).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * O registro com o client DE VERDADE (o realtime-js do lockfile) e um WebSocket
 * falso no lugar da rede. Os fakes acima assumem como o realtime-js se comporta;
 * aqui isso é medido, e um upgrade do supabase-js que mude a semântica quebra
 * estes testes em vez de passar despercebido.
 */
interface MensagemDoSocket {
  topic: string;
  event: string;
  ref: string | null;
  join_ref: string | null;
  payload: unknown;
}

class WebSocketFalso {
  static instancias: WebSocketFalso[] = [];
  /** Se o falso "servidor" responde ok ao phx_join sozinho. */
  static aceitaJoin = true;
  readyState = 0;
  binaryType = "blob";
  enviadas: MensagemDoSocket[] = [];
  onopen: ((evento: unknown) => void) | null = null;
  onerror: ((evento: unknown) => void) | null = null;
  onmessage: ((evento: { data: string }) => void) | null = null;
  onclose: ((evento: { code: number }) => void) | null = null;

  constructor(public url: string) {
    WebSocketFalso.instancias.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(dado: string) {
    const mensagem = JSON.parse(dado) as MensagemDoSocket;
    this.enviadas.push(mensagem);
    if (mensagem.event === "phx_join" && WebSocketFalso.aceitaJoin) this.responderOk(mensagem);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  responderOk(a: MensagemDoSocket) {
    this.doServidor({
      topic: a.topic,
      event: "phx_reply",
      ref: a.ref,
      join_ref: a.join_ref,
      payload: { status: "ok", response: {} },
    });
  }

  doServidor(mensagem: MensagemDoSocket) {
    this.onmessage?.({ data: JSON.stringify(mensagem) });
  }

  doServidorBroadcast(topic: string, joinRef: string | null, payload: unknown) {
    this.doServidor({
      topic,
      event: "broadcast",
      ref: null,
      join_ref: joinRef,
      payload: { type: "broadcast", event: "chatstate", payload },
    });
  }

  static atual() {
    return WebSocketFalso.instancias[WebSocketFalso.instancias.length - 1];
  }

  /** Todas as mensagens de um evento, de todas as conexões. */
  static enviadasDe(evento: string, topic: string) {
    return WebSocketFalso.instancias.flatMap((ws) =>
      ws.enviadas.filter((mensagem) => mensagem.event === evento && mensagem.topic === topic),
    );
  }
}

type OpcoesDoCreateClient = NonNullable<Parameters<typeof createClient>[2]>;
type TransporteDoRealtime = NonNullable<NonNullable<OpcoesDoCreateClient["realtime"]>["transport"]>;

let clientesCriados = 0;

function criarClienteReal(timeoutDoJoinMs = 10_000) {
  // Um projeto de mentira por client: o GoTrue avisa quando dois clients dividem a
  // mesma chave de storage (derivada da URL).
  clientesCriados += 1;
  return createClient(`https://presenca-teste-${clientesCriados}.supabase.co`, "chave-de-teste", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: {
      transport: WebSocketFalso as unknown as TransporteDoRealtime,
      timeout: timeoutDoJoinMs,
      heartbeatIntervalMs: 1_000_000,
    },
  });
}

describe("criarRegistroPresenca com o RealtimeClient real", () => {
  const TOPICO = "realtime:presence-linha-1";

  beforeEach(() => {
    vi.useFakeTimers();
    WebSocketFalso.instancias = [];
    WebSocketFalso.aceitaJoin = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Anda o relógio até o client falar (abrir o socket, buscar o token, mandar o join). */
  const esperarJoins = async (quantos: number) => {
    for (let i = 0; i < 50 && WebSocketFalso.enviadasDe("phx_join", TOPICO).length < quantos; i += 1) {
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(WebSocketFalso.enviadasDe("phx_join", TOPICO)).toHaveLength(quantos);
  };

  it("depois do tempo ocioso, assinar de novo cria um canal novo na hora, sem esperar o servidor responder ao leave", async () => {
    const client = criarClienteReal();
    const registro = criarRegistroPresenca({ client, idleMs: IDLE_MS });
    const antigo = vi.fn();
    const novo = vi.fn();

    registro.assinarPresenca("linha-1", antigo)();
    await esperarJoins(1);
    const joinAntigo = WebSocketFalso.enviadasDe("phx_join", TOPICO)[0];

    // O ocioso vence: o registro remove o canal, e o servidor ainda NÃO respondeu ao leave.
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    const leave = WebSocketFalso.enviadasDe("phx_leave", TOPICO)[0];
    expect(leave).toBeDefined();
    expect(client.getChannels().filter((c) => c.topic === TOPICO)).toHaveLength(0);

    // Voltar ao número: o join do canal novo sai na hora (nenhuma espera pelo servidor).
    WebSocketFalso.aceitaJoin = false;
    registro.assinarPresenca("linha-1", novo);
    await esperarJoins(2);
    const joinNovo = WebSocketFalso.enviadasDe("phx_join", TOPICO)[1];
    expect(joinNovo.join_ref).not.toBe(joinAntigo.join_ref);

    // Só agora o servidor responde ao leave e fecha o canal ANTIGO: nada disso pode
    // atingir o canal novo. O Phoenix manda o phx_close com `ref` = join_ref do canal
    // que fechou, e é por isso que o realtime-js descarta o que não é do join atual.
    const ws = WebSocketFalso.atual();
    ws.doServidor({ topic: TOPICO, event: "phx_reply", ref: leave.ref, join_ref: leave.join_ref, payload: { status: "ok", response: {} } });
    ws.doServidor({ topic: TOPICO, event: "phx_close", ref: joinAntigo.join_ref, join_ref: joinAntigo.join_ref, payload: {} });
    ws.responderOk(joinNovo);
    await vi.advanceTimersByTimeAsync(5);

    ws.doServidorBroadcast(TOPICO, joinNovo.join_ref, { state: "typing" });

    expect(novo).toHaveBeenCalledExactlyOnceWith({ state: "typing" });
    expect(antigo).not.toHaveBeenCalled();
  });

  it("canal que não entra (join sem resposta) é trocado por outro com backoff, e o ouvinte volta a receber", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = criarClienteReal(200);
    const registro = criarRegistroPresenca({ client, idleMs: IDLE_MS });
    const ouvinte = vi.fn();

    // O servidor recebe o join e não responde: estoura o timeout do join (TIMED_OUT).
    WebSocketFalso.aceitaJoin = false;
    registro.assinarPresenca("linha-1", ouvinte);
    await esperarJoins(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(client.getChannels().filter((c) => c.topic === TOPICO)).toHaveLength(0);

    // O servidor normaliza; passado o backoff de 1 s, o canal novo entra.
    WebSocketFalso.aceitaJoin = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await esperarJoins(2);
    await vi.advanceTimersByTimeAsync(5);

    const joinNovo = WebSocketFalso.enviadasDe("phx_join", TOPICO)[1];
    WebSocketFalso.atual().doServidorBroadcast(TOPICO, joinNovo.join_ref, { state: "typing" });
    expect(ouvinte).toHaveBeenCalledExactlyOnceWith({ state: "typing" });
  });

  it("sem o registro, dois donos do mesmo tópico dividem o objeto e o primeiro removeChannel deixa o outro surdo", async () => {
    const client = criarClienteReal();
    const ouvinteA = vi.fn();
    const ouvinteB = vi.fn();

    const a = client.channel("presence-linha-1").on("broadcast", { event: "chatstate" }, ({ payload }) => ouvinteA(payload));
    a.subscribe();
    const b = client.channel("presence-linha-1");
    b.on("broadcast", { event: "chatstate" }, ({ payload }) => ouvinteB(payload));
    await esperarJoins(1);
    const join = WebSocketFalso.enviadasDe("phx_join", TOPICO)[0];

    // É a razão do registro: o mesmo objeto, então quem sai primeiro leva o outro junto.
    expect(b).toBe(a);
    await client.removeChannel(a);
    WebSocketFalso.atual().doServidorBroadcast(TOPICO, join.join_ref, { state: "typing" });

    expect(ouvinteA).not.toHaveBeenCalled();
    expect(ouvinteB).not.toHaveBeenCalled();
  });
});
