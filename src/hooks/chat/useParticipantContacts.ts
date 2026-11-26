import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/** Conversa 1:1 já existente de um participante de grupo. */
export interface ParticipantContact {
  conversationId: string;
  /** contact_name da conversa 1:1. undefined quando o nome é só o telefone. */
  name?: string;
  avatarUrl: string | null;
  /** contact_phone COMO ESTÁ na linha 1:1 — pode diferir do consultado (9º dígito / 55). */
  contactPhone: string;
  phoneNumberId: string;
  /** A conversa 1:1 está no MESMO número conectado que o grupo. */
  sameConnection: boolean;
}

interface UseParticipantContactsArgs {
  /** Dígitos dos participantes. LID não resolvido NÃO entra (não é telefone). */
  phones: string[];
  /** UUID do número no banco (o mesmo que o qr-service usa). */
  phoneNumberDbId?: string | null;
  enabled?: boolean;
  /** Identidade do grupo em foco — resposta que chega após a troca é ignorada. */
  scopeKey?: string | null;
}

/** Janela em que o vínculo é servido do cache sem novo RPC. */
export const PARTICIPANT_CONTACTS_TTL_MS = 10 * 60 * 1000;
/** Resposta ≤ este número de linhas, longe do db-max-rows=1000 do PostgREST. */
export const PARTICIPANT_CONTACTS_CHUNK = 300;
/** A lista de telefones cresce em ondas (participantes + mensagens novas). */
const LOOKUP_DEBOUNCE_MS = 250;

type CacheEntry = { contact: ParticipantContact | null; fetchedAt: number };

/**
 * Cache em escopo de MÓDULO, não em useRef: o ChatArea e o GroupInfoPanel
 * perguntam pelas MESMAS pessoas (o painel busca a própria lista de
 * participantes porque precisa das flags de admin) e não podem pagar dois RPCs.
 * A chave inclui o número conectado porque o escopo do lookup depende dele.
 */
const cache = new Map<string, CacheEntry>();
const inFlight = new Set<string>();

const cacheKey = (phoneNumberDbId: string, digits: string) => `${phoneNumberDbId}:${digits}`;

/** Só para teste — o cache de módulo sobrevive entre renders e entre testes. */
export function clearParticipantContactsCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Resolve telefones de participantes de grupo para a conversa 1:1 existente
 * deles (nome, avatar, id da conversa).
 *
 * Não existe tabela `contacts`: `conversations` com is_group = false É o
 * diretório de contatos. O match tolera as variações BR (com/sem o 9, com/sem
 * o 55) porque as linhas legadas foram gravadas das duas formas — quem faz isso
 * é a RPC `resolve_group_participant_contacts`, em POST, porque a mesma busca
 * via `.in()` estouraria o teto de ~30KB de URL num grupo grande.
 */
export function useParticipantContacts({
  phones,
  phoneNumberDbId,
  enabled = true,
  scopeKey,
}: UseParticipantContactsArgs): Record<string, ParticipantContact> {
  // Versão só força o recálculo do memo quando o cache muda; o mapa exposto é
  // sempre derivado do cache, nunca um segundo state a sincronizar.
  const [version, setVersion] = useState(0);
  const activeScopeRef = useRef<string | null>(null);

  // Chave primitiva estável: a lista deriva de `messages`, que muda por
  // realtime, e um array novo a cada render reexecutaria o effect sem parar.
  const phonesKey = useMemo(() => [...new Set(phones)].sort().join(","), [phones]);

  useEffect(() => {
    if (!enabled || !phoneNumberDbId || !phonesKey) {
      activeScopeRef.current = null;
      return;
    }

    const scope = scopeKey ?? phoneNumberDbId;
    activeScopeRef.current = scope;

    const now = Date.now();
    const missing = phonesKey.split(",").filter((digits) => {
      const key = cacheKey(phoneNumberDbId, digits);
      if (inFlight.has(key)) return false;
      const entry = cache.get(key);
      return !entry || now - entry.fetchedAt >= PARTICIPANT_CONTACTS_TTL_MS;
    });

    if (missing.length === 0) return;

    const timer = setTimeout(() => {
      const chunks: string[][] = [];
      for (let i = 0; i < missing.length; i += PARTICIPANT_CONTACTS_CHUNK) {
        chunks.push(missing.slice(i, i + PARTICIPANT_CONTACTS_CHUNK));
      }

      for (const chunk of chunks) {
        const keys = chunk.map((digits) => cacheKey(phoneNumberDbId, digits));
        keys.forEach((key) => inFlight.add(key));

        void (async () => {
          try {
            const { data, error } = await supabase.rpc("resolve_group_participant_contacts", {
              p_phone_number_id: phoneNumberDbId,
              p_phones: chunk,
            });

            // Falha (sessão expirada, rede) NÃO vira cache: a próxima abertura
            // do grupo tenta de novo em vez de deixar o vínculo morto.
            if (error) {
              console.error("[ParticipantContacts] RPC falhou:", error);
              return;
            }

            const fetchedAt = Date.now();
            const matched = new Set<string>();

            for (const row of data ?? []) {
              matched.add(row.input_phone);
              cache.set(cacheKey(phoneNumberDbId, row.input_phone), {
                fetchedAt,
                contact: {
                  conversationId: row.conversation_id,
                  name: row.name_is_phone_like ? undefined : row.contact_name,
                  avatarUrl: row.avatar_url,
                  contactPhone: row.contact_phone,
                  phoneNumberId: row.matched_phone_number_id,
                  sameConnection: row.same_phone_number,
                },
              });
            }

            // Cache NEGATIVO: sem ele, 200 participantes sem conversa 1:1
            // viram um RPC a cada abertura do grupo, para sempre.
            for (const digits of chunk) {
              if (matched.has(digits)) continue;
              cache.set(cacheKey(phoneNumberDbId, digits), { contact: null, fetchedAt });
            }

            // A escrita no cache sempre vale (é chaveada por número + telefone,
            // independente do grupo na tela); só o re-render é guardado, para a
            // resposta lenta de um grupo não repintar o grupo já aberto.
            if (activeScopeRef.current === scope) setVersion((v) => v + 1);
          } finally {
            keys.forEach((key) => inFlight.delete(key));
          }
        })();
      }
    }, LOOKUP_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [enabled, phoneNumberDbId, phonesKey, scopeKey]);

  return useMemo(() => {
    if (!phoneNumberDbId || !phonesKey) return {};
    const resolved: Record<string, ParticipantContact> = {};
    for (const digits of phonesKey.split(",")) {
      const entry = cache.get(cacheKey(phoneNumberDbId, digits));
      if (entry?.contact) resolved[digits] = entry.contact;
    }
    return resolved;
    // `version` é a dependência que reflete a escrita no cache de módulo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneNumberDbId, phonesKey, version]);
}
