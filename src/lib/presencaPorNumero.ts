/**
 * Registro dos canais de presença ("digitando") por número.
 *
 * O serviço publica a presença num tópico por número (`presence-<id>`), então
 * há UM canal por número, compartilhado por quem o escuta e contado por
 * referência. Quem decide se um evento é da conversa aberta é o ouvinte.
 *
 * Por que não um `supabase.channel(...)` direto em cada effect:
 *  - `channel(topic)` deduplica por tópico: dois effects que pedem o mesmo número
 *    recebem o MESMO objeto, e o primeiro `removeChannel` derruba o `.on(...)` do
 *    outro (o canal fecha e ninguém mais ouve). É a classe do bug do c39167e. Com
 *    dono único e contagem de referências, só o último a sair remove o canal.
 *  - Trocar de conversa entre números (a caixa conjunta) desmontaria e remontaria o
 *    canal a cada troca. Sem ouvinte, o canal fica vivo por `idleMs`: voltar ao
 *    número reaproveita o canal em vez de reassinar.
 *
 * Medido no realtime-js 2.87.1: `removeChannel` tira o canal da lista do client de
 * forma SÍNCRONA (o `unsubscribe` marca `leaving`, `_canPush()` dá falso, o leave é
 * dado como ok na hora e o `onClose` roda `socket._remove`). Um `channel(topic)`
 * logo depois já devolve um canal NOVO, sem esperar o servidor, então o registro
 * não precisa esperar a saída. Reconferir ao subir o supabase-js: o teste com o
 * client real (fim de presencaPorNumero.test.ts) quebra se isso mudar.
 *
 * Falha do canal: sem callback de status o Realtime nem sempre re-junta um canal
 * sozinho (join lento, rede ruim), e o canal morto seria dividido por todo ouvinte
 * novo daquele número até recarregar a página. Por isso o registro ouve o status e,
 * em CHANNEL_ERROR, TIMED_OUT ou um CLOSED que ele não pediu, larga o canal e abre
 * outro com backoff (1 s, 2 s, 4 s… até 30 s, zerado no SUBSCRIBED), como o
 * `subscribeWithBackoff`. Não usa o helper de propósito: ele reporta ao
 * `realtimeHealth` (faixa global "Reconectando…"), e "digitando" é opcional, então
 * uma falha dele não deve acender a faixa; e o retry aqui é por número, com ouvintes
 * que vêm e vão.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

/** Quanto o canal de um número sobrevive sem nenhum ouvinte. */
const IDLE_MS = 30_000;

/** Teto da espera entre tentativas depois de uma falha do canal. */
const MAX_BACKOFF_MS = 30_000;

export type OuvintePresenca = (payload: unknown) => void;

/** O mínimo do client que o registro usa, para o teste injetar um falso. */
export interface ClienteDePresenca {
  channel: (topic: string) => RealtimeChannel;
  removeChannel: (channel: RealtimeChannel) => Promise<unknown>;
}

interface Inscricao {
  ouvinte: OuvintePresenca;
}

interface Entrada {
  inscricoes: Set<Inscricao>;
  /** Null só antes do `abrir`, ou entre uma falha do canal e a nova tentativa. */
  canal: RealtimeChannel | null;
  /** Timer do tempo ocioso; null com ouvintes ou antes do primeiro release. */
  ocioso: ReturnType<typeof setTimeout> | null;
  /** Timer da próxima tentativa depois de uma falha do canal; null fora disso. */
  retry: ReturnType<typeof setTimeout> | null;
  /** Falhas seguidas desde o último SUBSCRIBED: define a espera da próxima tentativa. */
  tentativas: number;
  /** Já desmontada (idempotência, e uma entrada órfã de um `abrir` que falhou). */
  encerrada: boolean;
}

export interface OpcoesDoRegistro {
  client: ClienteDePresenca;
  idleMs?: number;
}

export function criarRegistroPresenca({ client, idleMs = IDLE_MS }: OpcoesDoRegistro) {
  const entradas = new Map<string, Entrada>();

  // Falhar ao remover não pode travar nada: o registro já largou o canal.
  const removerCanal = (numeroId: string, canal: RealtimeChannel) => {
    void (async () => {
      try {
        await client.removeChannel(canal);
      } catch (erro) {
        console.warn(`[presença] falha ao remover o canal de ${numeroId}:`, erro);
      }
    })();
  };

  /** Dá baixa na entrada: cancela os timers, tira do mapa e remove o canal, se houver. */
  const encerrar = (numeroId: string, entrada: Entrada) => {
    entrada.encerrada = true;
    if (entrada.ocioso) clearTimeout(entrada.ocioso);
    if (entrada.retry) clearTimeout(entrada.retry);
    entrada.ocioso = null;
    entrada.retry = null;
    if (entradas.get(numeroId) === entrada) entradas.delete(numeroId);

    const canal = entrada.canal;
    entrada.canal = null;
    if (canal) removerCanal(numeroId, canal);
  };

  const abrir = (numeroId: string, entrada: Entrada) => {
    if (entrada.encerrada) return;
    entrada.retry = null;

    try {
      const canal = client
        .channel(`presence-${numeroId}`)
        .on("broadcast", { event: "chatstate" }, ({ payload }) => {
          // Cópia: um ouvinte pode se desinscrever durante o despacho, e quem já
          // saiu não deve receber o evento que estava na fila.
          for (const inscricao of [...entrada.inscricoes]) {
            if (!entrada.inscricoes.has(inscricao)) continue;
            try {
              inscricao.ouvinte(payload);
            } catch (erro) {
              // Um ouvinte com defeito não pode calar os outros do mesmo número.
              console.error(`[presença] ouvinte de ${numeroId} falhou:`, erro);
            }
          }
        });
      entrada.canal = canal;

      canal.subscribe((status, erro) => {
        // Status de um canal que o registro já largou: inclui o CLOSED que a
        // própria remoção dispara, que não é falha.
        if (entrada.encerrada || entrada.canal !== canal) return;

        if (status === "SUBSCRIBED") {
          entrada.tentativas = 0;
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          falhou(numeroId, entrada, canal, status, erro);
        }
      });
    } catch (erro) {
      // "Digitando" é opcional: falhar aqui não pode derrubar o chat. A entrada
      // sem canal sai do mapa, para a próxima assinatura tentar de novo.
      console.error(`[presença] falha ao abrir o canal de ${numeroId}:`, erro);
      encerrar(numeroId, entrada);
    }
  };

  const falhou = (
    numeroId: string,
    entrada: Entrada,
    canal: RealtimeChannel,
    status: string,
    erro?: Error,
  ) => {
    console.warn(`[presença] canal de ${numeroId} ${status}:`, erro);

    // Larga o canal ANTES de removê-lo: o CLOSED que a remoção dispara chega ao
    // callback como o de um canal que já não é o da entrada, e é ignorado.
    entrada.canal = null;
    removerCanal(numeroId, canal);

    // Ninguém escuta mais (a falha veio no tempo ocioso): não reabre um canal
    // para ninguém.
    if (entrada.inscricoes.size === 0) {
      encerrar(numeroId, entrada);
      return;
    }

    const espera = Math.min(1000 * 2 ** entrada.tentativas, MAX_BACKOFF_MS);
    entrada.tentativas += 1;
    entrada.retry = setTimeout(() => abrir(numeroId, entrada), espera);
  };

  /**
   * Escuta o `chatstate` do número. Devolve o cancelamento (idempotente). O
   * canal só é desmontado `idleMs` depois que o último ouvinte sai.
   */
  const assinarPresenca = (numeroId: string, ouvinte: OuvintePresenca): (() => void) => {
    let entrada = entradas.get(numeroId);
    if (!entrada) {
      entrada = {
        inscricoes: new Set(),
        canal: null,
        ocioso: null,
        retry: null,
        tentativas: 0,
        encerrada: false,
      };
      entradas.set(numeroId, entrada);
      abrir(numeroId, entrada);
    }

    if (entrada.ocioso) {
      clearTimeout(entrada.ocioso);
      entrada.ocioso = null;
    }
    const inscricao: Inscricao = { ouvinte };
    entrada.inscricoes.add(inscricao);

    const atual = entrada;
    return () => {
      if (!atual.inscricoes.delete(inscricao)) return;
      if (atual.inscricoes.size > 0) return;
      atual.ocioso = setTimeout(() => {
        atual.ocioso = null;
        // Voltou alguém no meio da espera, ou já foi desmontada por uma falha.
        if (atual.encerrada || atual.inscricoes.size > 0) return;
        encerrar(numeroId, atual);
      }, idleMs);
    };
  };

  return { assinarPresenca };
}

const registro = criarRegistroPresenca({ client: supabase });

export const assinarPresenca = registro.assinarPresenca;
