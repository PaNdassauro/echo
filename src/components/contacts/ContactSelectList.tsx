import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useAccessiblePhoneNumbers } from "@/hooks/useAccessiblePhoneNumbers";
import { Loader2, Search, User, Check, Phone } from "lucide-react";

/** Valor do seletor que busca em todas as linhas acessíveis de uma vez. */
export const ALL_LINES = "__all__";

/** Conversa 1:1 usada como entrada de "diretório de contatos". */
export interface SelectableContact {
  conversationId: string;
  name: string;
  phone: string;
  avatarUrl: string | null;
  /** Linha em que essa conversa 1:1 existe — pode não ser a linha do grupo. */
  phoneNumberId: string;
}

interface ContactSelectListProps {
  /** UUID de phone_numbers.id da linha em foco (a do grupo) — escopo inicial. */
  phoneNumberId: string;
  /** Só busca enquanto a aba/diálogo estiver aberto. */
  enabled: boolean;
  /** Telefones (dígitos) já escolhidos/participantes — marcados e não clicáveis. */
  excludedPhones?: string[];
  /** Telefones (dígitos) já selecionados nesta sessão — marcados, clicáveis. */
  selectedPhones?: string[];
  onSelect: (contact: SelectableContact) => void;
  /** Rótulo do estado vazio quando não há busca. */
  emptyLabel?: string;
  className?: string;
  listHeightClassName?: string;
}

/** Comparação tolerante ao 9º dígito e ao 55: a mesma pessoa aparece das duas formas. */
const phoneKeys = (phone: string): string[] => {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return [];
  const keys = new Set([digits]);
  const local = digits.startsWith("55") ? digits.slice(2) : digits;
  keys.add(local);
  if (local.length === 11 && local[2] === "9") keys.add(local.slice(0, 2) + local.slice(3));
  if (local.length === 10) keys.add(local.slice(0, 2) + "9" + local.slice(2));
  // Sufixo de 8 dígitos: última rede de segurança contra variações de DDD/9.
  if (local.length >= 8) keys.add(local.slice(-8));
  return [...keys];
};

/** Chave canônica de identidade: escolhe a MAIS específica das variações. */
const identityKey = (phone: string): string => {
  const keys = phoneKeys(phone);
  return keys.length ? keys[keys.length - 1] : phone;
};

const formatPhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, "");
  if (digits.length >= 12 && digits.length <= 13) {
    const rest = digits.slice(4);
    return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
  }
  return `+${digits}`;
};

/**
 * Lista de contatos vinda das conversas 1:1, com seletor de linha de origem.
 * Existe para que adicionar alguém a um grupo não exija saber o telefone de cor
 * — e para permitir a ponte entre linhas: puxar para o grupo da linha Vendas
 * alguém que só tem conversa na linha Suporte.
 *
 * O gate de acesso é a RLS (`conversations_select` já limita às linhas do
 * usuário), então buscar "todas as linhas" não vaza conversa alheia; o seletor
 * é conveniência de escopo, não segurança.
 *
 * A busca é server-side com debounce (e não filtro em memória) porque a lista
 * completa passa do corte de 1000 linhas do PostgREST — filtrar no cliente
 * esconderia contatos silenciosamente.
 */
const ContactSelectList = ({
  phoneNumberId,
  enabled,
  excludedPhones = [],
  selectedPhones = [],
  onSelect,
  emptyLabel = "Nenhum contato encontrado",
  className,
  listHeightClassName = "h-[260px]",
}: ContactSelectListProps) => {
  const [contacts, setContacts] = useState<SelectableContact[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [search, setSearch] = useState("");
  // Começa na linha do grupo: o caso comum não muda de escopo.
  const [sourceLine, setSourceLine] = useState<string>(phoneNumberId);
  const { toast } = useToast();
  const { currentOrganization } = useOrganization();
  // Sem revalidar a cada abertura do diálogo (ver o hook): só o nome da linha.
  const { phoneNumbers } = useAccessiblePhoneNumbers(currentOrganization?.id, enabled, {
    revalidarAoMontar: false,
  });

  // Trocar a linha em foco (outro grupo) reseta o escopo da busca.
  useEffect(() => {
    setSourceLine(phoneNumberId);
  }, [phoneNumberId]);

  // Rótulo de render, não entrada da busca — ver a nota nas deps do effect.
  const lineNameById = new Map(phoneNumbers.map((p) => [p.id, p.displayName]));

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        let query = supabase
          .from("conversations")
          .select("id, contact_name, contact_phone, contact_avatar_url, phone_number_id")
          .eq("is_group", false)
          // Direct do Instagram não tem telefone para disparo.
          .eq("channel", "whatsapp")
          .order("last_message_at", { ascending: false })
          // Em "todas as linhas" a mesma pessoa ocupa várias vagas antes da
          // dedupe, então o teto bruto é maior para não sumir gente da lista.
          .limit(sourceLine === ALL_LINES ? 200 : 50);

        // ALL_LINES não adiciona filtro: a RLS já restringe às linhas do
        // usuário. Um `.in()` com os ids seria redundante e ainda por cima
        // divergiria da policy quando o vínculo mudasse.
        if (sourceLine !== ALL_LINES) {
          query = query.eq("phone_number_id", sourceLine);
        }

        const term = search.trim();
        if (term) {
          // Vírgula/parêntese quebram a sintaxe do .or() do PostgREST.
          const safe = term.replace(/[,()]/g, " ").trim();
          const digits = term.replace(/\D/g, "");
          const filters = [`contact_name.ilike.%${safe}%`];
          if (digits) filters.push(`contact_phone.ilike.%${digits}%`);
          query = query.or(filters.join(","));
        }

        const { data, error } = await query;
        if (error) throw error;
        if (cancelled) return;

        // Dedupe por pessoa: com várias linhas, a mesma pessoa tem uma conversa
        // por linha e apareceria repetida. Vence a conversa mais recente (a
        // ordenação já garante isso) e a que tem nome de verdade.
        const byIdentity = new Map<string, SelectableContact>();
        for (const row of data ?? []) {
          const key = identityKey(row.contact_phone);
          const candidate: SelectableContact = {
            conversationId: row.id,
            name: row.contact_name || row.contact_phone,
            phone: row.contact_phone,
            avatarUrl: row.contact_avatar_url,
            phoneNumberId: row.phone_number_id ?? sourceLine,
          };
          const existing = byIdentity.get(key);
          if (!existing) {
            byIdentity.set(key, candidate);
            continue;
          }
          // Só troca se o de agora tem nome real e o guardado não tem.
          const existingNamed = existing.name !== existing.phone;
          const candidateNamed = candidate.name !== candidate.phone;
          if (!existingNamed && candidateNamed) byIdentity.set(key, candidate);
        }

        setContacts([...byIdentity.values()]);
      } catch (error) {
        console.error("[ContactSelectList] Falha ao carregar contatos:", error);
        if (!cancelled) {
          toast({
            title: "Não foi possível carregar os contatos",
            description: toUserMessage(error, "Verifique a conexão e tente a busca de novo."),
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, search ? 300 : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // O nome da linha NÃO entra aqui: ele é rótulo de render, e o array vindo
    // do hook de linhas muda de identidade a cada render — como dependência,
    // reexecutaria a busca em loop.
  }, [enabled, sourceLine, search, toast]);

  const excludedKeys = useMemo(
    () => new Set(excludedPhones.flatMap(phoneKeys)),
    [excludedPhones]
  );
  const selectedKeys = useMemo(
    () => new Set(selectedPhones.flatMap(phoneKeys)),
    [selectedPhones]
  );

  const stateOf = (phone: string): "excluded" | "selected" | "available" => {
    const keys = phoneKeys(phone);
    if (keys.some((k) => excludedKeys.has(k))) return "excluded";
    if (keys.some((k) => selectedKeys.has(k))) return "selected";
    return "available";
  };

  // Mostrar a linha de origem só ajuda quando ela pode diferir da do grupo.
  const showSourceLine = sourceLine === ALL_LINES;

  return (
    <div className={className}>
      <div className="space-y-2">
        {/* Seletor de linha de origem: a ponte entre números */}
        <Select value={sourceLine} onValueChange={setSourceLine}>
          <SelectTrigger className="w-full">
            <Phone className="w-4 h-4 mr-2 shrink-0 text-muted-foreground" />
            <SelectValue placeholder="Buscar contatos em…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_LINES}>Todos os números</SelectItem>
            {phoneNumbers.map((line) => (
              <SelectItem key={line.id} value={line.id}>
                <span className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: `hsl(${line.themeHue ?? 176}, 65%, 55%)` }}
                  />
                  {line.displayName}
                  {line.id === phoneNumberId && (
                    <span className="text-xs text-muted-foreground">(deste grupo)</span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome ou número…"
            aria-label="Buscar contato por nome ou número"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <ScrollArea className={`${listHeightClassName} mt-3`}>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
            {search ? (
              <>
                <p className="text-pretty">Nenhum contato com “{search}”. Tente outro nome ou número.</p>
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setSearch("")}>
                  Limpar busca
                </Button>
              </>
            ) : (
              emptyLabel
            )}
          </div>
        ) : (
          <div className="space-y-2 pr-3">
            {contacts.map((contact) => {
              const state = stateOf(contact.phone);
              const isMarked = state !== "available";
              return (
                <button
                  key={contact.conversationId}
                  type="button"
                  onClick={() => state !== "excluded" && onSelect(contact)}
                  disabled={state === "excluded"}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 ${
                    state === "excluded"
                      ? "border-border opacity-50 cursor-not-allowed"
                      : state === "selected"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50 hover:bg-muted/50"
                  }`}
                >
                  <Avatar className="w-10 h-10 shrink-0">
                    {contact.avatarUrl && <AvatarImage src={contact.avatarUrl} alt="" />}
                    <AvatarFallback className="bg-muted">
                      <User className="w-5 h-5 text-muted-foreground" />
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{contact.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {formatPhone(contact.phone)}
                      {showSourceLine && lineNameById.get(contact.phoneNumberId) && (
                        <span className="opacity-70">
                          {" "}· {lineNameById.get(contact.phoneNumberId)}
                        </span>
                      )}
                    </p>
                  </div>
                  {isMarked && (
                    <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" />
                      {state === "excluded" ? "no grupo" : "adicionado"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
};

export default ContactSelectList;
