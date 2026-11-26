/**
 * Regras puras da caixa conjunta: quais números a lista de conversas mostra.
 *
 * O "escopo" é o conjunto de números (phone_numbers.id) da lista: um só no modo
 * número, vários na caixa conjunta. Sem React e sem rede, para o que dá para
 * testar no vitest. Também decide quais números a caixa conjunta usa: os que o
 * usuário acessa menos os que ele tirou (guardamos as EXCLUSÕES, não a lista dos
 * marcados: um número novo liberado entra sozinho).
 */

/**
 * Chave canônica de um conjunto de números: ids ordenados, sem repetição e sem
 * vazios, unidos por vírgula. Dois conjuntos com os mesmos números têm a mesma
 * chave, seja qual for a ordem ou a identidade do array.
 *
 * É por ela que todo effect que refaz a busca ao trocar de número deve ser
 * chaveado: o array de `escopo` pode ser recriado a cada render sem que o
 * conjunto tenha mudado, e um effect com o array nos deps refaria a busca à toa.
 * UUID não tem vírgula, então a chave volta a virar lista por `idsDaChave`.
 */
export function chaveEscopo(ids: readonly string[]): string {
  return Array.from(new Set(ids.filter((id) => id !== ""))).sort().join(",");
}

/**
 * Os números da caixa conjunta: os acessíveis menos os excluídos, na ordem dos
 * acessíveis. Exclusão de número que o usuário já não acessa não tem efeito.
 */
export function numerosDaConjunta(acessiveis: readonly string[], fora: readonly string[]): string[] {
  const excluidos = new Set(fora);
  return Array.from(new Set(acessiveis)).filter((id) => id !== "" && !excluidos.has(id));
}

/** Menor conjunto que faz sentido: com 1 número a caixa conjunta seria só o modo número. */
export const MINIMO_DA_CONJUNTA = 2;

/** A caixa conjunta só existe com 2 ou mais números DEPOIS das exclusões. */
export function conjuntaDisponivel(acessiveis: readonly string[], fora: readonly string[]): boolean {
  return numerosDaConjunta(acessiveis, fora).length >= MINIMO_DA_CONJUNTA;
}

/**
 * O número pelo qual um envio sai quando o escopo tem mais de um (criar conversa e
 * grupo): o que o usuário escolheu, senão o preferido (o número da conversa aberta),
 * senão o primeiro. Escolha ou preferência que não está entre as opções é ignorada.
 */
export function numeroDeEnvio<T extends { id: string }>(
  opcoes: readonly T[],
  escolhidoId: string | null | undefined,
  preferidoId: string | null | undefined,
): T | null {
  return (
    opcoes.find((o) => o.id === escolhidoId) ??
    opcoes.find((o) => o.id === preferidoId) ??
    opcoes[0] ??
    null
  );
}

/** Cor de um número na tela (ponto do seletor, do selo e do diálogo): a mesma da Equipe, numa fonte só. */
export { getPhoneLineColor as corDoNumero } from "@/lib/phoneColor";

/** O inverso de `chaveEscopo`: os ids em ordem. Chave vazia = escopo vazio. */
export function idsDaChave(chave: string): string[] {
  return chave === "" ? [] : chave.split(",");
}

/**
 * Nomes em frase curta para um aviso: "A", "A e B", "A, B e C" e, passando de
 * `max`, só a contagem ("5 números"), que não cabe numa faixa estreita.
 */
export function listarNomes(nomes: readonly string[], max = 3): string {
  if (nomes.length === 0) return "";
  if (nomes.length > max) return `${nomes.length} números`;
  if (nomes.length === 1) return nomes[0];
  return `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
}

/**
 * Chave de comparação de um nome entre números: sem espaço nas pontas e sem
 * diferença de caixa ("Vip" e "vip " são a mesma tag). `pt-BR` para a caixa de
 * letras acentuadas não depender do idioma do navegador.
 */
export function chaveDeNome(nome: string): string {
  return nome.trim().toLocaleLowerCase("pt-BR");
}

/** Itens que têm o mesmo nome (pela `chaveDeNome`), na ordem em que apareceram. */
export interface GrupoPorNome<T> {
  /** `chaveDeNome` do grupo: serve de id da opção do filtro. */
  chave: string;
  /** O nome como o primeiro item do grupo o escreve (sem espaço nas pontas). */
  nome: string;
  itens: T[];
}

/**
 * Agrupa por nome normalizado. Tag e setor são de UM número, então na caixa
 * conjunta o mesmo nome aparece uma vez por número; o filtro mostra uma opção só
 * e casa qualquer um dos ids do grupo. A ordem dos grupos e a dos itens são as da
 * entrada (o primeiro item dá o nome e a cor da opção).
 */
export function agruparPorNome<T>(itens: readonly T[], nomeDe: (item: T) => string): GrupoPorNome<T>[] {
  const grupos = new Map<string, GrupoPorNome<T>>();
  for (const item of itens) {
    const nome = nomeDe(item);
    const chave = chaveDeNome(nome);
    const grupo = grupos.get(chave);
    if (grupo) grupo.itens.push(item);
    else grupos.set(chave, { chave, nome: nome.trim(), itens: [item] });
  }
  return Array.from(grupos.values());
}

/** Uma opção de filtro e os ids que ela casa (um só, ou todos os do grupo de mesmo nome). */
export interface OpcaoAgrupada {
  id: string;
  label: string;
  color?: string;
  ids: readonly string[];
}

/**
 * As opções de um filtro de tag ou de setor.
 *
 * `agrupar` falso (um número só): uma opção por item, com o id dele — o que o filtro
 * sempre foi. `agrupar` verdadeiro (mais de um número no escopo): uma opção por nome,
 * com a chave do nome de id e todos os ids do grupo em `ids`. Item repetido (o mesmo
 * setor legado que vale para vários números) entra uma vez.
 */
export function opcoesAgrupadas<T extends { id: string }>(
  itens: readonly T[],
  leitor: { nome: (item: T) => string; cor?: (item: T) => string | undefined },
  agrupar: boolean,
): OpcaoAgrupada[] {
  const unicos = Array.from(new Map(itens.map((item) => [item.id, item])).values());
  if (!agrupar) {
    return unicos.map((item) => ({ id: item.id, label: leitor.nome(item), color: leitor.cor?.(item), ids: [item.id] }));
  }
  return agruparPorNome(unicos, leitor.nome).map((grupo) => ({
    id: grupo.chave,
    label: grupo.nome,
    color: leitor.cor?.(grupo.itens[0]),
    ids: grupo.itens.map((item) => item.id),
  }));
}

/**
 * Os ids que uma seleção do filtro casa: cada opção marcada vira os ids dela. Um id
 * marcado que não é de nenhuma opção (a sentinela "sem setor") passa como veio.
 */
export function expandirSelecao(selecionados: readonly string[], opcoes: readonly OpcaoAgrupada[]): string[] {
  if (selecionados.length === 0) return [];
  const porId = new Map(opcoes.map((opcao) => [opcao.id, opcao.ids]));
  const out = new Set<string>();
  for (const id of selecionados) {
    for (const casado of porId.get(id) ?? [id]) out.add(casado);
  }
  return Array.from(out);
}
