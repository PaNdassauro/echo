/**
 * subscribeWithBackoff contra o realtime-js DE VERDADE (RealtimeClient +
 * RealtimeChannel), com um servidor Phoenix falso em processo. O teste unitário
 * (realtimeReconnect.test.ts) mocka o canal; este cobre o que só a biblioteca
 * real faz: fechar o canal por `phx_close`, reenviar joins velhos do buffer
 * quando o socket volta, e o join duplicado que derruba o canal vivo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeClient } from "@supabase/realtime-js";
import type { RealtimeChannel } from "@supabase/supabase-js";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { subscribeWithBackoff } from "./realtimeReconnect";
import { isRealtimeDegraded, reportChannelHealth } from "./realtimeHealth";

interface Mensagem {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: string | null;
  join_ref?: string | null;
}

/** Rede e servidor falsos, compartilhados pelos sockets de um teste. */
const rede = {
  online: true,
  sockets: new Set<SocketFalso>(),
  /** Quantas vezes um join duplicado fechou o canal anterior. */
  fechamentosPorDuplicata: 0,
};

class SocketFalso {
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  /** topic -> join_ref do canal aberto neste socket (lado servidor). */
  readonly joined = new Map<string, string>();

  constructor(_url: string) {
    setTimeout(() => {
      if (!rede.online) {
        this.readyState = 3;
        this.onerror?.(new Error("offline"));
        this.onclose?.({ code: 1006, reason: "offline" });
        return;
      }
      this.readyState = 1;
      rede.sockets.add(this);
      this.onopen?.();
    }, 20);
  }

  private entregar(msg: Mensagem) {
    if (this.readyState !== 1) return;
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), 5);
  }

  private responder(topic: string, ref: string | null, join_ref: string | null | undefined, status: string, response: unknown) {
    this.entregar({ topic, event: "phx_reply", ref, join_ref, payload: { status, response } });
  }

  send(raw: string) {
    const { topic, event, payload, ref, join_ref } = JSON.parse(raw) as Mensagem;
    if (topic === "phoenix" && event === "heartbeat") {
      this.responder("phoenix", ref, null, "ok", {});
      return;
    }
    if (event === "phx_join") {
      const anterior = this.joined.get(topic);
      if (anterior) {
        // Phoenix: join duplicado do mesmo tópico fecha o canal anterior.
        rede.fechamentosPorDuplicata += 1;
        this.entregar({ topic, event: "phx_close", ref: anterior, join_ref: anterior, payload: {} });
      }
      this.joined.set(topic, join_ref as string);
      const config = (payload.config as { postgres_changes?: Record<string, unknown>[] } | undefined) ?? {};
      const pc = (config.postgres_changes ?? []).map((f, i) => ({ ...f, id: i + 1 }));
      this.responder(topic, ref, join_ref, "ok", { postgres_changes: pc });
      return;
    }
    if (event === "phx_leave") {
      this.joined.delete(topic);
      this.responder(topic, ref, join_ref, "ok", {});
    }
  }

  /** Lado servidor: fecha o canal deste tópico, como o Realtime faz por conta própria. */
  fecharCanal(topic: string) {
    const joinRef = this.joined.get(topic);
    if (!joinRef) throw new Error(`canal ${topic} não está aberto neste socket`);
    this.joined.delete(topic);
    this.entregar({ topic, event: "phx_close", ref: joinRef, join_ref: joinRef, payload: {} });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    rede.sockets.delete(this);
    setTimeout(() => this.onclose?.({ code: 1000, reason: "client" }), 5);
  }
}

function derrubarRede() {
  rede.online = false;
  for (const s of [...rede.sockets]) {
    s.readyState = 3;
    rede.sockets.delete(s);
    s.onclose?.({ code: 1006, reason: "network" });
  }
}

const TOPICO = "messages-conversa-1";

// Relógio real de propósito: o realtime-js encadeia promessas e timers no
// reconnect (auth → flush do buffer → join), e o relógio falso do vitest não
// reproduz a ordem que o navegador produz. Os tempos são encurtados
// (join timeout 1,5 s, reconnect 300 ms) para o teste caber em segundos.
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clientes: RealtimeClient[] = [];

function novoCliente(accessToken: () => Promise<string>) {
  const client = new RealtimeClient("ws://falso/realtime/v1", {
    transport: SocketFalso as unknown as typeof WebSocket,
    params: { apikey: "anon" },
    timeout: 1500,
    heartbeatIntervalMs: 60_000,
    reconnectAfterMs: () => 300,
    accessToken,
  });
  clientes.push(client);
  return client;
}

describe("subscribeWithBackoff com o realtime-js real", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    rede.online = true;
    rede.sockets.clear();
    rede.fechamentosPorDuplicata = 0;
  });

  afterEach(() => {
    // O realtimeHealth é um store de módulo: um teste que falha no meio não
    // roda o cleanup e deixaria a chave caída para o seguinte.
    reportChannelHealth("integracao-closed", true);
    reportChannelHealth("integracao-queda", true);
    // Um teste que falha no meio deixaria o cliente reconectando em cima do seguinte.
    clientes.splice(0).forEach((c) => c.disconnect());
    vi.restoreAllMocks();
  });

  it("canal fechado pelo servidor (phx_close) é reassinado e a faixa cai", async () => {
    // É o que o Realtime faz ao receber um join duplicado do mesmo tópico (join
    // velho do buffer de envio reenviado na volta da rede), com token vencido
    // ou no limite de canais: o canal some do socket e nenhum erro chega depois.
    const client = novoCliente(async () => "tok");
    const statuses: string[] = [];

    const cleanup = subscribeWithBackoff({
      healthKey: "integracao-closed",
      maxDelayMs: 3000,
      createChannel: () =>
        client
          .channel(TOPICO)
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "m", filter: "a=eq.1" }, () => {}) as unknown as RealtimeChannel,
      onSubscribed: (recovered) => statuses.push(`SUBSCRIBED:${recovered}`),
      onDown: () => statuses.push("DOWN"),
      removeChannel: (ch) => void client.removeChannel(ch as unknown as Parameters<typeof client.removeChannel>[0]),
    });

    await esperar(300);
    expect(statuses).toEqual(["SUBSCRIBED:false"]);
    expect(isRealtimeDegraded()).toBe(false);

    const socket = [...rede.sockets][0];
    socket.fecharCanal(`realtime:${TOPICO}`);
    await esperar(100);
    expect(statuses).toEqual(["SUBSCRIBED:false", "DOWN"]);
    expect(isRealtimeDegraded()).toBe(true);
    expect(client.getChannels().filter((c) => c.topic === `realtime:${TOPICO}`)).toHaveLength(0);

    // Backoff de 1 s e o canal volta, com um único canal vivo no cliente e no servidor.
    await esperar(1300);
    expect(statuses).toEqual(["SUBSCRIBED:false", "DOWN", "SUBSCRIBED:true"]);
    expect(isRealtimeDegraded()).toBe(false);
    const vivos = client.getChannels().filter((c) => c.topic === `realtime:${TOPICO}`);
    expect(vivos).toHaveLength(1);
    expect(vivos[0].state).toBe("joined");
    // Sem outro canal no socket, o removeChannel derruba a conexão inteira e
    // a volta abre outro socket: conferir o canal no socket que estiver vivo.
    expect([...rede.sockets].some((s) => s.joined.has(`realtime:${TOPICO}`))).toBe(true);
    expect(rede.fechamentosPorDuplicata).toBe(0);

    cleanup();
    await esperar(100);
    expect(isRealtimeDegraded()).toBe(false);
  }, 60_000);

  it("queda longa de rede (maior que o timeout do join) termina assinado e sem faixa", async () => {
    const client = novoCliente(async () => "tok");
    const onSubscribed = vi.fn();

    const cleanup = subscribeWithBackoff({
      healthKey: "integracao-queda",
      maxDelayMs: 3000,
      createChannel: () =>
        client
          .channel(TOPICO)
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "m" }, () => {}) as unknown as RealtimeChannel,
      onSubscribed,
      removeChannel: (ch) => void client.removeChannel(ch as unknown as Parameters<typeof client.removeChannel>[0]),
    });

    await esperar(300);
    expect(onSubscribed).toHaveBeenCalledWith(false);

    derrubarRede();
    await esperar(2500);
    expect(isRealtimeDegraded()).toBe(true);

    rede.online = true;
    await esperar(5000);
    expect(onSubscribed).toHaveBeenLastCalledWith(true);
    expect(isRealtimeDegraded()).toBe(false);
    expect(client.getChannels().filter((c) => c.topic === `realtime:${TOPICO}`)).toHaveLength(1);

    cleanup();
    await esperar(100);
  }, 60_000);
});
