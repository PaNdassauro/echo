/**
 * Drain a PostgREST query past the server's row cap.
 *
 * Supabase runs PostgREST with `max_rows` (1000 in this project), which is a
 * *silent* ceiling: a `select()` returning exactly 1000 rows looks identical to a
 * complete result, and `.limit(n)` above the cap is ignored rather than honoured.
 * Any list that can grow past 1000 has to be paged until drained.
 *
 * This pattern was previously inlined in ConversationsList (see the comment at
 * `ConversationsList.tsx:583`, where truncation made different users see
 * different subsets of the same connection). Prefer this helper over hand-rolling
 * the loop again.
 *
 * Usage — pass a builder that applies `.range()` to your query:
 *
 *   const failed = await fetchAllPaginated<Recipient>((from, to) =>
 *       supabase.from("broadcast_recipients")
 *           .select("id, phone_number")
 *           .eq("broadcast_id", id)
 *           .eq("status", "failed")
 *           .order("created_at", { ascending: true })
 *           .range(from, to)
 *   );
 *
 * The query MUST be ordered on a stable key. Rows created by one bulk insert
 * share an identical `created_at`, so ordering by that column alone is ambiguous
 * and pages can overlap or skip rows — add a tiebreaker such as `id`.
 */

/** PostgREST's configured `max_rows` for this project. */
export const POSTGREST_MAX_ROWS = 1000;

interface PageResult<T> {
    data: T[] | null;
    error: { message: string } | null;
}

export async function fetchAllPaginated<T>(
    buildPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
    options: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
    const pageSize = options.pageSize ?? POSTGREST_MAX_ROWS;
    const rows: T[] = [];

    for (let from = 0; ; from += pageSize) {
        const { data, error } = await buildPage(from, from + pageSize - 1);
        if (error) throw new Error(error.message);

        rows.push(...(data || []));

        // A short page means the table is drained.
        if (!data || data.length < pageSize) break;

        // Safety valve so a mis-specified query cannot loop forever.
        if (options.maxRows && rows.length >= options.maxRows) break;
    }

    return rows;
}

/**
 * Teto prático de ids por chamada quando eles viajam num `.in()` (a URL REST é
 * rejeitada com 400 acima de ~30KB, e um UUID custa ~39 bytes ali) ou numa RPC
 * que devolve uma linha por id (aí o limite é o `max_rows`, não a URL).
 *
 * 500 dá folga para o resto da query nos dois casos.
 */
export const POSTGREST_MAX_IN_IDS = 500;

/** Fatia `items` em blocos de no máximo `size`. */
export function chunk<T>(items: T[], size = POSTGREST_MAX_IN_IDS): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/**
 * Roda `run` sobre cada bloco de `items` e concatena os resultados.
 *
 * A concorrência é baixa de propósito: as RPCs escopadas por RLS deste projeto
 * são caras, e disparar dez chamadas simultâneas as empilha no mesmo pool de
 * conexões — o que troca um problema de corretude por um de latência.
 */
export async function mapChunks<TIn, TOut>(
    items: TIn[],
    run: (block: TIn[]) => Promise<TOut[]>,
    { size = POSTGREST_MAX_IN_IDS, concurrency = 3 }: { size?: number; concurrency?: number } = {},
): Promise<TOut[]> {
    const blocks = chunk(items, size);
    const out: TOut[] = [];
    for (let i = 0; i < blocks.length; i += concurrency) {
        const results = await Promise.all(blocks.slice(i, i + concurrency).map(run));
        for (const r of results) out.push(...r);
    }
    return out;
}

/**
 * Limitador de concorrência: `limitar(tarefa)` roda `tarefa` assim que houver vaga
 * (no máximo `maxEmVoo` ao mesmo tempo, em ordem de chegada) e devolve o que ela
 * devolver. Serve para quem dispara trabalho aos poucos (as páginas de vários
 * números numa lista só) e precisa de um teto ÚNICO sobre tudo que está em voo.
 *
 * A fila é FIFO: o que entrou primeiro sai primeiro, então quem enfileira todas as
 * primeiras páginas antes das demais as vê andar antes. Tarefa que rejeita (ou que
 * lança de forma síncrona) libera a vaga como qualquer outra e repassa o erro a quem
 * a enfileirou — não trava a fila nem derruba as vizinhas.
 */
export type Limitador = <T>(tarefa: () => PromiseLike<T>) => Promise<T>;

export function criarLimitador(maxEmVoo: number): Limitador {
    const limite = Math.max(1, Math.floor(maxEmVoo));
    let emVoo = 0;
    const fila: Array<() => void> = [];

    // A vaga liberada passa direto ao primeiro da fila (emVoo não muda); sem fila, volta ao pool.
    const liberar = () => {
        const proximo = fila.shift();
        if (proximo) proximo();
        else emVoo -= 1;
    };

    return <T>(tarefa: () => PromiseLike<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const rodar = () => {
                let voo: PromiseLike<T>;
                try {
                    voo = tarefa();
                } catch (erro) {
                    liberar();
                    reject(erro);
                    return;
                }
                Promise.resolve(voo).then(
                    (valor) => {
                        liberar();
                        resolve(valor);
                    },
                    (erro) => {
                        liberar();
                        reject(erro);
                    },
                );
            };

            if (emVoo < limite) {
                emVoo += 1;
                rodar();
            } else {
                fila.push(rodar);
            }
        });
}

/**
 * `Promise.all(items.map(run))` com no máximo `concurrency` em voo. A ordem dos
 * resultados é a dos itens. Como no `Promise.all`, a primeira rejeição rejeita o
 * conjunto sem cancelar o que já começou: quem não quer perder o resultado dos
 * outros devolve o erro como valor em vez de lançá-lo.
 */
export function mapComLimite<TIn, TOut>(
    items: readonly TIn[],
    run: (item: TIn, index: number) => PromiseLike<TOut>,
    { concurrency = 4 }: { concurrency?: number } = {},
): Promise<TOut[]> {
    const limitar = criarLimitador(concurrency);
    return Promise.all(items.map((item, index) => limitar(() => run(item, index))));
}
