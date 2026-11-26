import { CheckCheck } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Skeleton } from "@/components/ui/skeleton";
import { useMessageReceipts, type MessageReceiptRow } from "@/hooks/chat/useMessageReceipts";
import { bareJid } from "@/lib/participantDisplayName";
import { formatParticipantPhone } from "@/lib/phone";

interface ReadReceiptsPopoverProps {
  messageId: string;
  /** Mesmo lookup do MessageBubble: chaves por telefone e por bareJid. */
  participantLookup?: Record<string, string>;
}

/**
 * Nome de quem leu/recebeu, pela mesma cadeia das bolhas de grupo: lookup por
 * telefone e por bareJid (as duas chaves que o buildParticipantDisplayMap
 * grava), com fallback no telefone formatado — ou no LID abreviado quando o
 * WhatsApp não expôs o número.
 */
function receiptName(row: MessageReceiptRow, participantLookup?: Record<string, string>): string {
  const bare = bareJid(row.participant_jid);
  const resolved =
    (row.participant_phone ? participantLookup?.[row.participant_phone] : undefined) ??
    (bare ? participantLookup?.[bare] : undefined);
  if (resolved) return resolved;
  const isLid = !row.participant_phone && row.participant_jid.endsWith("@lid");
  return formatParticipantPhone(row.participant_phone ?? bare ?? "", isLid);
}

function ReceiptSection({
  label,
  iconClassName,
  rows,
  timeOf,
  participantLookup,
}: {
  label: string;
  iconClassName: string;
  rows: MessageReceiptRow[];
  timeOf: (row: MessageReceiptRow) => string;
  participantLookup?: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <CheckCheck className={`w-3.5 h-3.5 shrink-0 ${iconClassName}`} strokeWidth={2.5} />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.id} className="flex items-baseline justify-between gap-3">
            <span className="text-sm truncate">{receiptName(row, participantLookup)}</span>
            <span className="text-2xs text-muted-foreground shrink-0 tabular-nums">
              {format(new Date(timeOf(row)), "dd/MM 'às' HH:mm", { locale: ptBR })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Conteúdo do popover "quem leu" (grupos, conexão QR). Monta ao abrir e
 * desmonta ao fechar — o useMessageReceipts busca lazy e mantém um canal
 * realtime só enquanto isto está montado.
 */
export function ReadReceiptsPopover({ messageId, participantLookup }: ReadReceiptsPopoverProps) {
  const { rows, loading } = useMessageReceipts(messageId);

  const read = rows
    .filter((r) => r.read_at)
    .sort((a, b) => (b.read_at! < a.read_at! ? -1 : 1));
  const delivered = rows
    .filter((r) => r.delivered_at && !r.read_at)
    .sort((a, b) => (b.delivered_at! < a.delivered_at! ? -1 : 1));

  if (loading && rows.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-4 w-36" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        Ainda sem confirmações de entrega ou leitura. Recibos passaram a ser
        registrados agora — mensagens antigas não têm esse histórico.
      </p>
    );
  }

  return (
    <div className="flex max-h-72 flex-col gap-3 overflow-y-auto p-3">
      {read.length > 0 && (
        <ReceiptSection
          label={`Lida por ${read.length}`}
          iconClassName="text-blue-500"
          rows={read}
          timeOf={(row) => row.read_at!}
          participantLookup={participantLookup}
        />
      )}
      {delivered.length > 0 && (
        <ReceiptSection
          label={`Entregue para ${delivered.length}`}
          iconClassName="text-muted-foreground"
          rows={delivered}
          timeOf={(row) => row.delivered_at!}
          participantLookup={participantLookup}
        />
      )}
    </div>
  );
}
