import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Phone, XCircle } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { IdCopyButton } from "@/components/ui/id-copy-button";

interface TagData {
    id: string;
    name: string;
    color: string;
}

interface ContactData {
    id: string;
    contact_name: string;
    contact_phone: string;
    last_message_at: string;
    status: string;
    close_reason: string | null;
    conversation_tags: { tag_id: string }[];
    phone_numbers: {
        display_name: string;
        phone_number: string;
    } | null;
}

// Busca paginada no servidor: com PostgREST cortando em 1000 linhas, o filtro
// client-side de antes nem via a maior parte da base em orgs grandes.
const CONTACTS_PAGE_SIZE = 100;

const ContactsSettings = () => {
    const { currentOrganization, isLoading: isOrgLoading } = useOrganization();
    const [contacts, setContacts] = useState<ContactData[]>([]);
    const [tags, setTags] = useState<TagData[]>([]);
    const [searchContact, setSearchContact] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [fetchError, setFetchError] = useState(false);
    // Respostas fora de ordem (digitação rápida) não podem sobrescrever a atual
    const fetchIdRef = useRef(0);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchContact.trim()), 300);
        return () => clearTimeout(timer);
    }, [searchContact]);

    useEffect(() => {
        fetchTags();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentOrganization?.id]);

    useEffect(() => {
        fetchContacts();
        // isOrgLoading nas deps: quando o contexto termina SEM org, o skeleton
        // precisa dar lugar ao vazio real (senão fica carregando pra sempre)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentOrganization?.id, debouncedSearch, isOrgLoading]);

    const fetchTags = async () => {
        if (!currentOrganization) {
            setTags([]);
            return;
        }

        // Sem filtro por criador: tags.user_id é só quem CRIOU a tag, e filtrar
        // por ele escondia do usuário comum as tags criadas por admin (a maioria
        // das tags). É a mesma regressão que ConversationsList.tsx:673
        // documenta como já corrigida lá; este arquivo ficou para trás.
        // Quem enxerga cada tag é a RLS de tags (escopo por linha,
        // 20260304_fix_tags_rls_for_org_admins.sql:32) — a autoridade certa.
        //
        // Some junto o round-trip em organization_members, que só existia para
        // montar a lista de user_ids do filtro (e que, numa org grande, ia
        // inteira na URL como parâmetro do .in()).
        const { data } = await supabase
            .from("tags")
            .select("*")
            .order("name");
        setTags(data || []);
    };

    const fetchContacts = async () => {
        if (!currentOrganization) {
            setContacts([]);
            // Org ainda resolvendo (deep-link em ?tab=contacts): mantém o
            // skeleton — sem isso aparecia "Nenhum contato encontrado" falso
            setIsLoading(isOrgLoading);
            return;
        }

        const fetchId = ++fetchIdRef.current;
        setIsLoading(true);

        // First get phone IDs for this org
        const { data: phoneData } = await supabase
            .from("phone_numbers")
            .select("id")
            .eq("organization_id", currentOrganization.id);

        if (fetchId !== fetchIdRef.current) return;

        const phoneIds = (phoneData || []).map(p => p.id);

        if (phoneIds.length === 0) {
            setContacts([]);
            setIsLoading(false);
            return;
        }

        let query = supabase
            .from("conversations")
            .select("id, contact_name, contact_phone, last_message_at, status, close_reason, conversation_tags(tag_id), phone_numbers(display_name, phone_number)")
            .in("phone_number_id", phoneIds)
            .order("last_message_at", { ascending: false })
            .limit(CONTACTS_PAGE_SIZE);

        if (debouncedSearch) {
            // Vírgula/parênteses são sintaxe do .or() do PostgREST — fora do termo
            const term = debouncedSearch.replace(/[,()]/g, " ").trim();
            const digits = term.replace(/\D/g, "");
            const filters = [] as string[];
            if (term) {
                filters.push(`contact_name.ilike.%${term}%`, `contact_phone.ilike.%${term}%`);
            }
            if (digits && digits !== term) {
                filters.push(`contact_phone.ilike.%${digits}%`);
            }
            if (filters.length > 0) {
                query = query.or(filters.join(","));
            }
        }

        const { data, error } = await query;

        if (fetchId !== fetchIdRef.current) return;
        setIsLoading(false);

        if (error) {
            console.error("Error fetching contacts:", error);
            // Falha na busca não pode exibir resultados velhos como se fossem
            // da busca atual
            setContacts([]);
            setFetchError(true);
            return;
        }

        setFetchError(false);
        setContacts(data || []);
    };

    const getTagsForContact = (contactTags: { tag_id: string }[]) => {
        return tags.filter(tag => contactTags.some(ct => ct.tag_id === tag.id));
    };

    // Exclude contacts without business number
    const filteredContacts = contacts.filter((c) => c.phone_numbers);

    return (
        <div className="bg-card border rounded-xl p-6 space-y-6">
            <div className="space-y-4">
                <div>
                    <Input
                        value={searchContact}
                        onChange={(e) => setSearchContact(e.target.value)}
                        placeholder="Buscar contato…"
                        className="md:max-w-md"
                    />
                </div>

                <ScrollArea className="h-[400px]">
                    {isLoading ? (
                        <div className="space-y-3 pr-4">
                            {Array.from({ length: 4 }, (_, i) => (
                                <div key={i} className="p-4 rounded-lg border flex items-center gap-4">
                                    <Skeleton className="w-10 h-10 rounded-full shrink-0" />
                                    <div className="flex-1 space-y-2">
                                        <Skeleton className="h-4 w-40" />
                                        <Skeleton className="h-3 w-28" />
                                    </div>
                                    <Skeleton className="h-3 w-16" />
                                </div>
                            ))}
                        </div>
                    ) : fetchError ? (
                        <div className="flex flex-col items-center justify-center gap-3 h-40 text-muted-foreground border-2 border-dashed rounded-lg bg-muted/20">
                            <p className="text-sm">Não foi possível carregar os contatos.</p>
                            <Button variant="outline" size="sm" onClick={() => fetchContacts()}>
                                Tentar novamente
                            </Button>
                        </div>
                    ) : filteredContacts.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-40 text-muted-foreground border-2 border-dashed rounded-lg bg-muted/20">
                            <Users className="w-8 h-8 mb-2 opacity-50" />
                            <p>
                                {debouncedSearch
                                    ? `Nenhum contato para "${debouncedSearch}"`
                                    : "Nenhum contato encontrado"}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-3 pr-4">
                            {filteredContacts.map((contact) => {
                                const contactTags = getTagsForContact(contact.conversation_tags || []);
                                return (
                                    <div
                                        key={contact.id}
                                        className="p-4 rounded-lg bg-card border hover:shadow-sm transition-shadow duration-200 ease-out space-y-3"
                                    >
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-4">
                                                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                                                    <Users className="w-5 h-5 text-primary" />
                                                </div>
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <p className="font-medium text-sm">{contact.contact_name}</p>
                                                        <IdCopyButton id={contact.id} label="Contact ID" className="h-4 w-4" />
                                                    </div>
                                                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                                        <Phone className="w-3 h-3" />
                                                        {contact.contact_phone}
                                                    </p>
                                                    {contact.phone_numbers && (
                                                        <p className="text-xs text-muted-foreground mt-0.5">
                                                            via <span className="font-medium text-primary">{contact.phone_numbers.display_name}</span>
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-xs text-muted-foreground mb-1">
                                                    {format(new Date(contact.last_message_at), "dd/MM/yyyy", {
                                                        locale: ptBR,
                                                    })}
                                                </p>
                                                <span
                                                    className={`text-2xs uppercase font-bold px-2 py-0.5 rounded-full ${contact.status === "active"
                                                        ? "bg-success/10 text-success"
                                                        : contact.status === "waiting"
                                                            ? "bg-warning/10 text-warning"
                                                            : "bg-muted-foreground/10 text-muted-foreground"
                                                        }`}
                                                >
                                                    {contact.status === "active"
                                                        ? "Ativo"
                                                        : contact.status === "waiting"
                                                            ? "Aguardando"
                                                            : "Encerrado"}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Tags and close reason */}
                                        {(contactTags.length > 0 || (contact.status === "closed" && contact.close_reason)) && (
                                            <div className="flex flex-wrap items-center gap-2 pl-14 pt-1 border-t border-dashed mt-2">
                                                {contactTags.map((tag) => (
                                                    <span
                                                        key={tag.id}
                                                        className="text-xs px-2 py-0.5 rounded-full text-white shadow-sm"
                                                        style={{ backgroundColor: tag.color }}
                                                    >
                                                        {tag.name}
                                                    </span>
                                                ))}
                                                {contact.status === "closed" && contact.close_reason && (
                                                    <span className="text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive flex items-center gap-1">
                                                        <XCircle className="w-3 h-3" />
                                                        {contact.close_reason}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </ScrollArea>

                <p className="text-xs text-muted-foreground text-center pt-2">
                    {isLoading
                        ? "Carregando…"
                        : contacts.length >= CONTACTS_PAGE_SIZE
                            ? `Mostrando os ${CONTACTS_PAGE_SIZE} mais recentes — refine a busca para ver outros`
                            : `${filteredContacts.length} contato${filteredContacts.length !== 1 ? "s" : ""}${debouncedSearch ? " encontrado" + (filteredContacts.length !== 1 ? "s" : "") : ""}`}
                </p>
            </div>
        </div>
    );
};

export default ContactsSettings;
