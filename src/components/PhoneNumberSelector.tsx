import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/contexts/OrganizationContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Instagram, Layers, Phone, SlidersHorizontal, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { corDoNumero } from "@/lib/caixaConjunta";
import { qrFetch } from "@/lib/qrService";
import { useInstagramConexoes } from "@/hooks/useInstagramConexoes";
import { mapaInstagramPorLinha } from "@/lib/instagramConexoes";

interface PhoneNumber {
  id: string;
  phone_number_id: string;
  display_name: string;
  phone_number: string;
  is_active: boolean;
  theme_hue: number | null;
  connection_type: string | null;
  phone_number_sessions?: {
    connection_status: string;
  }[] | { connection_status: string };
}

/**
 * Valor do item "Caixa conjunta" no Select. Vive só aqui dentro: nunca sai pelo
 * `onSelect` nem vai para o localStorage ou para uma consulta (um não-uuid em
 * `.eq('phone_number_id')` dá 22P02).
 */
const VALOR_CAIXA_CONJUNTA = "__caixa_conjunta__";

/** Pontos de cor no item da caixa conjunta: quantos cabem sem virar confete. */
const PONTOS_DA_CONJUNTA = 3;

interface PhoneNumberSelectorProps {
  selectedPhoneNumberId: string | null;
  /** Só dispara quando o usuário escolhe um número (sai da caixa conjunta): quem resolve a seleção inicial é o Dashboard. */
  onSelect: (id: string) => void;
  /** A caixa conjunta está ativa: o gatilho mostra "Caixa conjunta" e o botão "Escolher números". */
  conjunta?: boolean;
  /** Os números que entram na caixa conjunta (pontos e contagem do item). Sem ele, todos os da lista. */
  numerosDaConjunta?: readonly string[];
  /** Escolheu o item "Caixa conjunta". Sem ele o item não aparece. */
  onSelecionarConjunta?: () => void;
  /** Abre a escolha dos números da caixa conjunta. */
  onEscolherNumeros?: () => void;
}

const PhoneNumberSelector = ({
  selectedPhoneNumberId,
  onSelect,
  conjunta = false,
  numerosDaConjunta,
  onSelecionarConjunta,
  onEscolherNumeros,
}: PhoneNumberSelectorProps) => {
  const { currentOrganization } = useOrganization();
  // Linha QR/API que divide a caixa com uma linha Instagram ligada: marca no seletor.
  const { data: instagramConexoes } = useInstagramConexoes();
  const instagramDaLinha = useMemo(() => mapaInstagramPorLinha(instagramConexoes), [instagramConexoes]);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [qrStatus, setQrStatus] = useState<Record<string, 'connected' | 'disconnected' | 'loading'>>({});

  // Identidade desta instância, para o nome do canal de realtime não colidir
  // com o de outra montagem do mesmo componente.
  const instanceIdRef = useRef(crypto.randomUUID());

  useEffect(() => {
    // O seletor só exibe e deixa escolher: restaurar, validar e trocar a
    // seleção (org nova, número removido) é do Dashboard. Chamar onSelect aqui
    // fechava a conversa aberta por deep link, porque escolher número a limpa.
    fetchPhoneNumbers();
  }, [currentOrganization?.id]);

  const fetchPhoneNumbers = async () => {
    if (!currentOrganization) {
      setPhoneNumbers([]);
      return;
    }


    const { data, error } = await supabase
      .from("phone_numbers")
      .select(`
        *,
        phone_number_sessions (
          connection_status
        )
      `)
      .eq("organization_id", currentOrganization.id)
      .eq("is_active", true)
      .order("display_name");

    if (error) {
      console.error("Error fetching phone numbers:", error);
      setPhoneNumbers([]);
      return;
    }

    // Cast to PhoneNumber[] since connection_type might not be in generated types yet
    const phones = (data || []) as unknown as PhoneNumber[];
    setPhoneNumbers(phones);

    // Initialize QR statuses from DB
    const initialStatuses: Record<string, 'connected' | 'disconnected' | 'loading'> = {};
    data?.forEach((phone: any) => {
      if (phone.connection_type === 'qr') {
        const session = Array.isArray(phone.phone_number_sessions)
          ? phone.phone_number_sessions[0]
          : phone.phone_number_sessions;

        if (session?.connection_status === 'connected') {
          initialStatuses[phone.id] = 'connected';
        }
      }
    });
    setQrStatus(prev => ({ ...prev, ...initialStatuses }));

    // Check live QR status for QR connections
    phones.forEach(phone => {
      if (phone.connection_type === 'qr') {
        checkQrStatus(phone.id);
      }
    });
  };

  const checkQrStatus = useCallback(async (phoneId: string) => {
    // Don't set to loading immediately to avoid flickering if we already have DB status
    // setQrStatus(prev => ({ ...prev, [phoneId]: 'loading' }));

    try {
      const response = await qrFetch(`/session/status/${phoneId}`, {
        method: 'GET',
      });

      if (response.ok) {
        const data = await response.json();
        setQrStatus(prev => ({
          ...prev,
          [phoneId]: data.status === 'connected' ? 'connected' : 'disconnected'
        }));
      } else {
        // If fetch fails, keep existing status or default to disconnected
        // setQrStatus(prev => ({ ...prev, [phoneId]: 'disconnected' }));
      }
    } catch (error) {
      console.error('Error checking QR status:', error);
      // setQrStatus(prev => ({ ...prev, [phoneId]: 'disconnected' }));
    }
  }, []);

  // Periodically check QR status (fallback)
  useEffect(() => {
    const qrPhones = phoneNumbers.filter(p => p.connection_type === 'qr');
    if (qrPhones.length === 0) return;

    // Check every 30 seconds as fallback
    const interval = setInterval(() => {
      qrPhones.forEach(phone => checkQrStatus(phone.id));
    }, 30000);

    return () => clearInterval(interval);
  }, [phoneNumbers, checkQrStatus]);

  // Check status when page becomes visible (tab switch, window focus)
  useEffect(() => {
    const qrPhones = phoneNumbers.filter(p => p.connection_type === 'qr');
    if (qrPhones.length === 0) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        qrPhones.forEach(phone => checkQrStatus(phone.id));
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [phoneNumbers, checkQrStatus]);

  // Chave estável das linhas: só remonta a inscrição quando o CONJUNTO muda,
  // não a cada novo array vindo do fetch.
  const phoneIdsKey = phoneNumbers.map(p => p.id).sort().join(',');

  // Realtime subscription for immediate status updates
  useEffect(() => {
    const phoneIds = phoneIdsKey ? phoneIdsKey.split(',') : [];
    if (phoneIds.length === 0) return;

    // Filtro no servidor: sem ele o walrus avaliava a RLS de TODA atualização de
    // sessão da instância, para cada aba aberta, só para o cliente descartar as
    // que não são suas. O operador `in` é suportado pelo Realtime; acima de ~50
    // ids a lista no tópico fica grande demais e vale mais assinar sem filtro.
    const useFilter = phoneIds.length <= 50;
    if (!useFilter) {
      console.warn(`[PhoneNumberSelector] ${phoneIds.length} linhas: assinando sem filtro server-side`);
    }

    const channel = supabase
      // Nome único por instância: com nome fixo, duas montagens do componente
      // (duas árvores, ou o StrictMode em dev) colidiam no mesmo tópico e o
      // removeChannel de uma derrubava o canal da outra.
      .channel(`phone-status-${instanceIdRef.current}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'phone_number_sessions',
        ...(useFilter ? { filter: `phone_number_id=in.(${phoneIds.join(',')})` } : {}),
      }, (payload) => {
        const updated = payload.new as { phone_number_id: string; connection_status: string };
        const phoneId = updated.phone_number_id;
        const status = updated.connection_status;

        setQrStatus(prev => ({
          ...prev,
          [phoneId]: status === 'connected' ? 'connected' : 'disconnected'
        }));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [phoneIdsKey]);

  const handleSelect = (value: string) => {
    if (value === VALOR_CAIXA_CONJUNTA) {
      onSelecionarConjunta?.();
      return;
    }
    const phone = phoneNumbers.find(p => p.id === value);
    if (phone) {
      console.log("PhoneNumberSelector: Selected phone", phone.display_name, "hue:", phone.theme_hue, "connection_type:", phone.connection_type);
      onSelect(phone.id);

      // Refresh QR status when selecting a QR number
      if (phone.connection_type === 'qr') {
        checkQrStatus(phone.id);
      }
    }
  };

  // Get current selected phone for status display
  const selectedPhone = phoneNumbers.find(p => p.id === selectedPhoneNumberId);
  const showQrStatus = !conjunta && selectedPhone?.connection_type === 'qr';

  // Logic matches QRCodeConnect: use live status if connected, otherwise fallback to DB status
  const dbStatus = selectedPhone?.phone_number_sessions
    ? (Array.isArray(selectedPhone.phone_number_sessions)
      ? selectedPhone.phone_number_sessions[0]?.connection_status
      : selectedPhone.phone_number_sessions.connection_status)
    : undefined;

  const liveStatus = selectedPhone ? qrStatus[selectedPhone.id] : undefined;

  // Live status takes priority when available (realtime updates)
  // Only use DB status as fallback before first live check
  const displayStatus = liveStatus
    ? liveStatus  // Use live status directly when we have it
    : dbStatus === 'connected'
      ? 'connected'
      : 'disconnected';

  // Item "Caixa conjunta": com 2 ou mais números e quem trate a escolha.
  const mostrarConjunta = phoneNumbers.length >= 2 && !!onSelecionarConjunta;
  const idsDaConjunta = numerosDaConjunta ?? phoneNumbers.map((p) => p.id);
  const pontosDaConjunta = idsDaConjunta
    .slice(0, PONTOS_DA_CONJUNTA)
    .map((id) => phoneNumbers.find((p) => p.id === id))
    .filter((p): p is PhoneNumber => !!p);

  // Show placeholder when no phone numbers for this org
  if (phoneNumbers.length === 0) {
    return (
      <div className="theme-phone-selector-empty flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground border rounded-md bg-muted/20 w-[200px] h-9">
        <Phone className="w-4 h-4" />
        <span>Nenhum número</span>
      </div>
    );
  }

  return (
    <div className="flex w-full items-center gap-2">
      {/* O seletor tem a largura do nome e só encolhe (truncando, sem quebrar)
          quando falta espaço ao lado do selo.
          Na coluna estreita (sidebar-narrow) o selo de conexão fica só com o
          ícone; o texto segue no title e para leitor de tela. */}
      <Select
        value={conjunta ? VALOR_CAIXA_CONJUNTA : selectedPhoneNumberId || ""}
        onValueChange={handleSelect}
      >
        <SelectTrigger className="theme-phone-selector-trigger w-auto min-w-0 max-w-full gap-1 h-9">
          {conjunta ? (
            <Layers className="w-4 h-4 mr-2 shrink-0 sidebar-narrow:mr-1.5" />
          ) : (
            <Phone className="w-4 h-4 mr-2 shrink-0 sidebar-narrow:mr-1.5" />
          )}
          {/* Na caixa conjunta o gatilho mostra só o nome: os pontos e a contagem são do item da lista. */}
          <SelectValue placeholder="Selecionar número">
            {conjunta ? <span className="truncate">Caixa conjunta</span> : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {mostrarConjunta && (
            <SelectItem value={VALOR_CAIXA_CONJUNTA} className="group">
              {/* Aberto, o Radix foca o item selecionado (focus:bg-accent, cor cheia): o anel dos
                  pontos e a contagem acompanham o fundo, senão viram halo e cinza ilegível. */}
              <div className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="flex shrink-0 items-center -space-x-1">
                  {pontosDaConjunta.map((p) => (
                    <span
                      key={p.id}
                      className="size-3 rounded-full ring-2 ring-popover group-focus:ring-accent"
                      style={{ backgroundColor: corDoNumero(p.theme_hue) }}
                    />
                  ))}
                </span>
                <span className="truncate">Caixa conjunta</span>
                {/* Sem números para juntar (exclusões de tudo), a contagem "0 números" não diz nada. */}
                {idsDaConjunta.length > 0 && (
                  <span className="shrink-0 text-xs text-muted-foreground group-focus:text-accent-foreground">
                    {idsDaConjunta.length} {idsDaConjunta.length === 1 ? "número" : "números"}
                  </span>
                )}
              </div>
            </SelectItem>
          )}
          {phoneNumbers.map((phone) => {
            // Calculate status for each item in the list too
            const itemDbStatus = phone.phone_number_sessions
              ? (Array.isArray(phone.phone_number_sessions)
                ? phone.phone_number_sessions[0]?.connection_status
                : phone.phone_number_sessions.connection_status)
              : undefined;

            const itemLiveStatus = qrStatus[phone.id];

            // Live status takes priority when available
            const itemStatus = itemLiveStatus
              ? itemLiveStatus
              : itemDbStatus === 'connected'
                ? 'connected'
                : 'disconnected';

            return (
              <SelectItem key={phone.id} value={phone.id}>
                <div className="flex min-w-0 items-center gap-2">
                  <div
                    className="w-3 h-3 shrink-0 rounded-full"
                    style={{ backgroundColor: corDoNumero(phone.theme_hue) }}
                  />
                  {/* truncate: no gatilho estreito o nome não quebra em 2 linhas */}
                  <span className="truncate">{phone.display_name}</span>
                  {instagramDaLinha.has(phone.id) && (
                    <span
                      className="inline-flex items-center gap-0.5 text-xs text-pink-700 dark:text-pink-400"
                      title={`Divide a caixa com a linha Instagram ${instagramDaLinha.get(phone.id)}`}
                    >
                      + <Instagram className="w-3 h-3" strokeWidth={1.5} aria-label="Instagram" />
                    </span>
                  )}
                  {phone.connection_type === 'qr' && (
                    <span className={cn(
                      "ml-1 text-xs px-1.5 py-0.5 rounded",
                      itemStatus === 'connected'
                        ? "bg-green-100 text-green-700"
                        : itemStatus === 'loading'
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-red-100 text-red-700"
                    )}>
                      {itemStatus === 'connected' ? '●' : itemStatus === 'loading' ? '○' : '○'}
                    </span>
                  )}
                </div>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      {/* Escolher quais números entram: muda o escopo guardado da lista, então não é um filtro. */}
      {conjunta && onEscolherNumeros && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="theme-sidebar-action-button h-9 w-9 shrink-0 sidebar-narrow:h-8 sidebar-narrow:w-8"
          onClick={onEscolherNumeros}
          title="Escolher números"
          aria-label="Escolher números"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      )}

      {/* QR Connection Status Indicator */}
      {showQrStatus && (
        <div
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors duration-200 ease-out shrink-0 sidebar-narrow:px-1.5",
            displayStatus === 'connected'
              ? "bg-green-100 text-green-700 border border-green-200"
              : displayStatus === 'loading'
                ? "bg-yellow-100 text-yellow-700 border border-yellow-200"
                : "bg-red-100 text-red-700 border border-red-200"
          )}
          title={displayStatus === 'connected' ? 'WhatsApp conectado' : 'WhatsApp desconectado'}
        >
          {displayStatus === 'connected' ? (
            <>
              <Wifi className="w-3.5 h-3.5" />
              <span className="sidebar-narrow:sr-only">Conectado</span>
            </>
          ) : displayStatus === 'loading' ? (
            <>
              <Wifi className="w-3.5 h-3.5 animate-pulse" />
              <span className="sidebar-narrow:sr-only">Verificando…</span>
            </>
          ) : (
            <>
              <WifiOff className="w-3.5 h-3.5" />
              <span className="sidebar-narrow:sr-only">Desconectado</span>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default PhoneNumberSelector;
