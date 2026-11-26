// Peças do scripts/smoke/realtime.mjs que não dependem de stack nem de supabase-js e por isso têm teste próprio
// (scripts/smoke/realtime-lib.test.mjs, que o testes-infra.sh roda). Sem nenhum import: recebem canal, relógio e
// espera por parâmetro.
//
// Por que existem: com a máquina carregada (2 vCPU do CI, outra carga no mesmo host) o Realtime demora para aplicar o
// filtro de um canal novo e, logo depois de um reinício, o primeiro subscribe pode dar CHANNEL_ERROR. Esperar um tempo
// fixo e mandar UMA mensagem reprova a fumaça por um motivo que não é do stack; sondar até chegar e tentar de novo na
// assinatura tem a mesma prova, só sem apostar no relógio.

export const dormeReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Relógio dos prazos: MONOTÔNICO. O relógio de parede (`Date.now`) do WSL2 salta para frente e volta (medido: +16 s por
 * menos de 1 s, num stack em que o evento chegou 0,7 s depois do POST), e um prazo de 10 s calculado com ele vence na
 * hora e reprova uma mensagem que estava chegando.
 */
export const agoraMonotonico = () => performance.now();

/**
 * Assina o canal e espera o SUBSCRIBED e o "Subscribed to PostgreSQL" do servidor.
 * Rejeita com `<nome>: <status>` em CHANNEL_ERROR/TIMED_OUT, ou por tempo esgotado em qualquer das duas etapas.
 */
export function assinar(canal, nome, { timeoutMs = 20000 } = {}) {
  let cdcOk;
  const cdc = new Promise((resolve) => (cdcOk = resolve));
  canal.on("system", {}, (m) => {
    if (m.extension === "postgres_changes" && m.status === "ok") cdcOk();
  });
  const subscrito = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${nome}: subscribe não respondeu em ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    canal.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(t);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(t);
        reject(new Error(`${nome}: ${status} ${err?.message ?? ""}`.trim()));
      }
    });
  });
  return subscrito.then(() =>
    Promise.race([
      cdc,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${nome}: sem "Subscribed to PostgreSQL" em ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)),
    ]),
  );
}

/**
 * Assina um canal com tentativas e espera crescente (como o `subscribeWithBackoff` do front): em falha, REMOVE o canal
 * antes de criar outro (o `channel(topic)` do supabase-js devolve o que já existe com o mesmo nome, e o
 * `removeChannel` é assíncrono), espera 1, 2, 4, 8 s (o último valor se repete) e tenta de novo, até `totalMs` desde
 * a primeira tentativa.
 *
 * @param {object} p
 * @param {() => unknown} p.criar monta um canal NOVO, já com os `.on(...)` (chamado a cada tentativa)
 * @param {string} p.nome rótulo para a mensagem de erro
 * @param {(canal: unknown) => Promise<unknown>} p.remover tira o canal do cliente
 * @param {(canal: unknown, nome: string, opcoes: { timeoutMs: number }) => Promise<unknown>} [p.assinarFn]
 * @returns {Promise<{ canal: unknown, tentativas: number }>}
 * @throws {Error} com a última causa e o número de tentativas
 */
export async function assinarComTentativas({
  criar,
  nome,
  remover,
  assinarFn = assinar,
  totalMs = 45000,
  esperasMs = [1000, 2000, 4000, 8000],
  timeoutPorTentativaMs = 20000,
  dorme = dormeReal,
  agora = agoraMonotonico,
}) {
  const inicio = agora();
  let tentativas = 0;
  let ultimo = "nenhuma tentativa";
  for (;;) {
    const restante = totalMs - (agora() - inicio);
    const canal = criar();
    tentativas += 1;
    try {
      await assinarFn(canal, nome, { timeoutMs: Math.max(5000, Math.min(timeoutPorTentativaMs, restante)) });
      return { canal, tentativas };
    } catch (e) {
      ultimo = e instanceof Error ? e.message : String(e);
    }
    try {
      await remover(canal);
    } catch {
      // o canal já pode ter saído sozinho; o que importa é que o próximo seja novo
    }
    const espera = esperasMs[Math.min(tentativas - 1, esperasMs.length - 1)];
    if (agora() - inicio + espera >= totalMs) break;
    await dorme(espera);
  }
  const gastosS = Math.round((agora() - inicio) / 1000);
  throw new Error(`${ultimo} (${tentativas} tentativa(s) em ${gastosS} s)`);
}

/**
 * Manda mensagens de sonda até alguma ser recebida: `enviar(i)` posta uma mensagem NOVA (id novo a cada tentativa) e
 * devolve o id; depois espera até `intervaloMs` por `recebeu(ids)` (verdadeiro se qualquer id enviado já chegou). Sem
 * chegar em `totalMs`, devolve `recebeu: false`. `enviados` lista TODOS os ids postados, para quem precisa provar que
 * nenhum deles vazou (a checagem de RLS com o outro usuário vale para todas as sondas, não só para a que chegou).
 *
 * @param {object} p
 * @param {(i: number) => string} p.enviar
 * @param {(ids: string[]) => boolean} p.recebeu
 * @returns {Promise<{ recebeu: boolean, enviados: string[] }>}
 */
export async function sondarAte({
  enviar,
  recebeu,
  intervaloMs = 3000,
  totalMs = 30000,
  passoMs = 100,
  dorme = dormeReal,
  agora = agoraMonotonico,
}) {
  const inicio = agora();
  const enviados = [];
  while (agora() - inicio < totalMs) {
    enviados.push(enviar(enviados.length + 1));
    const fim = agora() + intervaloMs;
    while (agora() < fim) {
      if (recebeu(enviados)) return { recebeu: true, enviados };
      await dorme(passoMs);
    }
    if (recebeu(enviados)) return { recebeu: true, enviados };
  }
  return { recebeu: false, enviados };
}

/**
 * Manda a mensagem principal em até `tentativas` vezes, com id NOVO a cada uma, esperando `esperaMs` por cada. Passou em
 * qualquer uma = recebeu. Existe porque o primeiro INSERT depois do "Subscribed to PostgreSQL" de um stack recém-criado
 * pode se perder dentro do Realtime (medido, ver docs/troubleshooting.md): o que a fumaça prova é que a mensagem
 * chega ao assinante certo, não que a primeira tentativa chega. `enviados` lista TODOS os ids postados (a checagem de RLS
 * com o outro usuário vale para todos) e `id` é o da tentativa que chegou (os passos seguintes usam esse).
 *
 * @param {object} p
 * @param {(tentativa: number) => string} p.enviar posta uma mensagem NOVA e devolve o id dela
 * @param {(id: string) => boolean} p.recebeu verdadeiro se o evento daquele id já chegou
 * @returns {Promise<{ recebeu: boolean, tentativa: number, id: string | null, enviados: string[] }>}
 *   `tentativa` é a que chegou (1 = primeira), ou o total tentado quando nenhuma chegou
 */
export async function tentarMensagem({
  enviar,
  recebeu,
  tentativas = 3,
  esperaMs = 10000,
  passoMs = 100,
  dorme = dormeReal,
  agora = agoraMonotonico,
}) {
  const enviados = [];
  for (let n = 1; n <= tentativas; n += 1) {
    const id = enviar(n);
    enviados.push(id);
    const fim = agora() + esperaMs;
    while (agora() < fim) {
      if (recebeu(id)) return { recebeu: true, tentativa: n, id, enviados };
      await dorme(passoMs);
    }
    if (recebeu(id)) return { recebeu: true, tentativa: n, id, enviados };
  }
  return { recebeu: false, tentativa: tentativas, id: null, enviados };
}
