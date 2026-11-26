/**
 * Setores: o recorte de "quem atende o quê" DENTRO de uma linha de WhatsApp.
 *
 * O escopo de verdade é o RLS (políticas do baseline): quando a linha tem
 * `sector_isolation_enabled`, o banco só devolve as conversas sem setor (a
 * triagem) e as dos setores do usuário. O que existe aqui é o que o front
 * precisa decidir por cima disso — qual setor oferecer, qual badge desenhar, e
 * para qual setor mandar a conversa que o atendente acabou de assumir.
 *
 * Nada neste arquivo é autorização: se algo aqui errar, o banco continua
 * negando. É por isso que as funções podem ser puras e testáveis.
 */

import type { Tables } from "@/integrations/supabase/types";

/** Só as colunas que as telas selecionam — não a Row inteira. */
export type Sector = Pick<
  Tables<"sectors">,
  "id" | "name" | "color" | "organization_id" | "phone_number_id"
>;

/** Colunas selecionadas por quem busca setores. Mantém os SELECTs em sincronia. */
export const SECTOR_SELECT = "id, name, color, organization_id, phone_number_id";

/**
 * Setor sem cor cai no cinza de texto secundário: o badge continua legível nos
 * dois temas sem inventar cor, e a lista não fica um arco-íris de setores novos.
 */
export const SECTOR_FALLBACK_COLOR = "hsl(var(--muted-foreground))";

/**
 * Setores que valem para uma linha: os dela mais os LEGADOS.
 *
 * Setor com `phone_number_id` nulo é legado, de quando setor era
 * da organização inteira. Ele continua valendo para todos os números — a
 * migration não tenta adivinhar a qual linha ele pertencia, porque não há
 * informação para isso no banco.
 */
export const sectorsForPhone = (
  sectors: Sector[],
  phoneNumberId: string | null | undefined,
): Sector[] =>
  sectors.filter(
    (sector) =>
      sector.phone_number_id === null ||
      (!!phoneNumberId && sector.phone_number_id === phoneNumberId),
  );

/**
 * Opção sintética "Sem setor" do filtro da inbox — a fila de triagem.
 *
 * Não é UUID de propósito: id de setor sempre é, então a sentinela não pode
 * colidir com setor nenhum, nem hoje nem depois.
 */
export const NO_SECTOR_FILTER_ID = "__no_sector__";

/**
 * A conversa passa pelo filtro de setor da lista?
 *
 * Seleção vazia não filtra nada (mesma semântica dos filtros de tag e usuário).
 * A sentinela casa exatamente as conversas em triagem.
 */
export const matchesSectorFilter = (
  sectorId: string | null | undefined,
  selected: string[],
): boolean => {
  if (selected.length === 0) return true;
  if (!sectorId) return selected.includes(NO_SECTOR_FILTER_ID);
  return selected.includes(sectorId);
};

export interface AssumeSectorResolution {
  /** Setor a gravar junto com `assigned_to`. Null quando ainda falta escolher. */
  sectorId: string | null;
  /**
   * Quando true, quem chamou precisa perguntar: o atendente tem mais de um setor
   * na linha e nenhum deles é o padrão dele.
   */
  needsChoice: boolean;
  /** Setores entre os quais escolher (vazio quando não há o que perguntar). */
  options: Sector[];
}

/**
 * Para qual setor vai a conversa que EU assumo nesta linha.
 *
 * A decisão de produto é "setor padrão do agente" (`organization_members.sector_id`),
 * mas com setor amarrado à linha o padrão pode ser de OUTRO número — daí a
 * cascata:
 *
 *   1. um único setor meu nesta linha  -> é ele, sem perguntar nada;
 *   2. vários, e o meu padrão está entre eles -> o padrão;
 *   3. vários, e o padrão não serve (é de outra linha, ou não tem) -> perguntar;
 *   4. nenhum setor meu nesta linha -> assume sem setor, a conversa fica na
 *      triagem. É o caso do admin, que não é membro de setor nenhum e não deve
 *      classificar sem querer só por ter clicado em "Assumir".
 *
 * `mySectorIds` são os vínculos de `sector_members`, não o padrão.
 */
export const resolveAssumeSector = (params: {
  sectors: Sector[];
  phoneNumberId: string | null | undefined;
  mySectorIds: string[];
  defaultSectorId: string | null;
}): AssumeSectorResolution => {
  const { sectors, phoneNumberId, mySectorIds, defaultSectorId } = params;

  const membership = new Set(mySectorIds);
  const mine = sectorsForPhone(sectors, phoneNumberId).filter((sector) =>
    membership.has(sector.id),
  );

  if (mine.length === 0) return { sectorId: null, needsChoice: false, options: [] };
  if (mine.length === 1) return { sectorId: mine[0].id, needsChoice: false, options: [] };

  const fallback = mine.find((sector) => sector.id === defaultSectorId);
  if (fallback) return { sectorId: fallback.id, needsChoice: false, options: [] };

  return { sectorId: null, needsChoice: true, options: mine };
};
