import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { qrFetch } from "@/lib/qrService";

/** Participante cru vindo do qr-service (nomes resolvidos no consumidor). */
export type GroupParticipant = {
  id: string;
  jid: string;
  phone: string;
  name?: string;
  isLid?: boolean;
  isAdmin: boolean;
};

/** Metadados do grupo que decidem se a linha pode enviar (ver `resolveGroupSendPermission`). */
export type GroupSendMeta = {
  /** true = só admins enviam. */
  announce?: boolean;
  /** Desde o qr-service 2.5.6. null = o serviço não achou a linha; undefined = serviço antigo. */
  me?: { id?: string; isAdmin: boolean } | null;
};

/** GET /groups/:phoneNumberId/:groupJid — o que a menção e o aviso de "só admins" consomem.
 *  `jid` vem undefined para participante @lid sem telefone resolvido, daí o
 *  fallback para `id` (o popup filtra por nome/telefone e nunca recebe undefined). */
const groupMetadataResponseSchema = z.object({
  success: z.boolean(),
  group: z
    .object({
      announce: z.boolean().optional(),
      me: z.object({ id: z.string().optional(), isAdmin: z.boolean() }).nullable().optional(),
      participants: z.array(
        z.object({
          id: z.string(),
          jid: z.string().optional(),
          phone: z.string().optional(),
          name: z.string().optional(),
          isLid: z.boolean().optional(),
          isAdmin: z.boolean().optional(),
        })
      ),
    })
    .optional(),
});

/** Janela em que a lista é servida do cache sem refetch — o suficiente para não
 *  esbarrar no rate limit do qr-service ao trocar de conversa, curto o
 *  suficiente para pegar quem entrou/saiu do grupo. */
export const GROUP_PARTICIPANTS_TTL_MS = 5 * 60 * 1000;

interface UseGroupParticipantsArgs {
  isGroup?: boolean;
  groupJid?: string | null;
  /** UUID do número no banco (o qr-service usa esse, não o phone_number_id da Meta). */
  phoneNumberDbId?: string | null;
  isQrConnection?: boolean;
}

interface UseGroupParticipantsResult {
  participants: GroupParticipant[];
  /** null até chegar a primeira resposta do grupo em foco ("ainda não sei"). */
  group: GroupSendMeta | null;
  /** Ignora o cache do grupo em foco e busca de novo. No-op fora de um grupo. */
  refetch: () => void;
}

interface CacheEntry {
  participants: GroupParticipant[];
  group: GroupSendMeta;
  fetchedAt: number;
}

/**
 * Lista de participantes do grupo para o autocomplete de menção (@) e os
 * metadados de envio (`announce`, `me`) que fecham a caixa de mensagem.
 *
 * O cache guarda a LISTA por grupo, não um booleano "já busquei": o ChatArea é
 * único e não remonta por conversa, então sair do grupo zera o state. Com cache
 * booleano, voltar ao grupo caía no early return e a menção ficava sem lista
 * (ou, vindo de outro grupo, exibindo os participantes do grupo anterior).
 */
export function useGroupParticipants({
  isGroup,
  groupJid,
  phoneNumberDbId,
  isQrConnection,
}: UseGroupParticipantsArgs): UseGroupParticipantsResult {
  const [participants, setParticipants] = useState<GroupParticipant[]>([]);
  const [group, setGroup] = useState<GroupSendMeta | null>(null);
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  // Grupo em foco no momento: descarta resposta que chega depois da troca.
  const activeKeyRef = useRef<string | null>(null);

  const fetchGroup = useCallback(
    async (groupKey: string, dbId: string, jid: string) => {
      try {
        // picture=0: a menção não usa a foto do grupo, e a consulta dela custa
        // um round-trip extra ao WhatsApp (serviço antigo ignora o param).
        const response = await qrFetch(`/groups/${dbId}/${encodeURIComponent(jid)}?picture=0`);
        const parsed = groupMetadataResponseSchema.safeParse(await response.json());

        if (!parsed.success || !parsed.data.success || !parsed.data.group) {
          // Falha (sessão desconectada, 4xx) não vira cache: a próxima abertura
          // do grupo tenta de novo em vez de deixar a menção morta.
          console.warn(
            "[Mentions] No participants in response:",
            parsed.success ? parsed.data : parsed.error.issues
          );
          return;
        }

        const fetched: GroupParticipant[] = parsed.data.group.participants.map((p) => ({
          id: p.id,
          jid: p.jid || p.id, // jid é o que vale para mencionar (@s.whatsapp.net)
          phone: p.phone ?? p.id.split("@")[0],
          name: p.name || undefined,
          isLid: p.isLid,
          isAdmin: p.isAdmin ?? false,
        }));
        const { announce, me } = parsed.data.group;
        // Com `strict: false` o Zod infere `isAdmin` como opcional; o schema já o exige, o `?? false` só satisfaz o tipo.
        const meta: GroupSendMeta = { announce };
        if (me !== undefined) {
          meta.me = me === null ? null : { isAdmin: me.isAdmin ?? false, ...(me.id ? { id: me.id } : {}) };
        }

        cacheRef.current.set(groupKey, { participants: fetched, group: meta, fetchedAt: Date.now() });

        // Revalidação lenta não pode sobrescrever a lista do grupo já aberto.
        if (activeKeyRef.current === groupKey) {
          setParticipants(fetched);
          setGroup(meta);
        }
      } catch (error) {
        console.error("[Mentions] Error fetching group participants:", error);
      }
    },
    []
  );

  useEffect(() => {
    if (!isGroup || !groupJid || !phoneNumberDbId || !isQrConnection) {
      activeKeyRef.current = null;
      setParticipants([]);
      setGroup(null);
      return;
    }

    const groupKey = `${phoneNumberDbId}:${groupJid}`;
    activeKeyRef.current = groupKey;

    // Serve o cache na hora; revalida em background quando envelhece (entra/sai
    // participante). Sem entrada em cache, zera para não exibir o grupo anterior.
    const cached = cacheRef.current.get(groupKey);
    setParticipants(cached?.participants ?? []);
    setGroup(cached?.group ?? null);
    if (cached && Date.now() - cached.fetchedAt < GROUP_PARTICIPANTS_TTL_MS) {
      return;
    }

    void fetchGroup(groupKey, phoneNumberDbId, groupJid);
  }, [isGroup, groupJid, phoneNumberDbId, isQrConnection, fetchGroup]);

  const refetch = useCallback(() => {
    const groupKey = activeKeyRef.current;
    if (!groupKey || !phoneNumberDbId || !groupJid) return;
    cacheRef.current.delete(groupKey);
    void fetchGroup(groupKey, phoneNumberDbId, groupJid);
  }, [fetchGroup, phoneNumberDbId, groupJid]);

  return { participants, group, refetch };
}
