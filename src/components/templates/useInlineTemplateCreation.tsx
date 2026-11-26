import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Clock, Loader2, X } from "lucide-react";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import TemplateBuilderDialog from "@/components/templates/TemplateBuilderDialog";
import { fetchOrgTemplates, rejectedReasonLabel, type MetaTemplate, type SavedTemplate } from "@/lib/templatesApi";
import type { TemplateHeaderMedia } from "@/lib/templateMedia";

export const APPROVAL_POLL_MS = 5_000;
export const APPROVAL_WATCH_MS = 5 * 60_000;

/** 5 s nas primeiras voltas (a maioria aprova rápido), depois 15 s e 30 s. */
export function approvalPollDelay(attempt: number): number {
  if (attempt < 4) return APPROVAL_POLL_MS;
  return attempt < 10 ? 15_000 : 30_000;
}

interface Pending {
  name: string;
  language: string;
  state: "waiting" | "rejected" | "timeout";
  reason?: string | null;
  /** Template recusado, para "Corrigir e reenviar" abrir em edição. */
  rejected?: MetaTemplate;
}

/**
 * "Criar template na hora" para qualquer seletor de template: abre o builder e,
 * depois de enviado, acompanha a aprovação da Meta. Quando aprova, entrega o
 * template completo em `onApproved` (o seletor recarrega e já seleciona).
 */
export function useInlineTemplateCreation({
  onApproved,
  onSaved,
  beforeOpen,
}: {
  /** `headerMedia`: o arquivo de exemplo já no Storage, para o envio reaproveitar. */
  onApproved: (template: MetaTemplate, extra: { headerMedia: TemplateHeaderMedia | null }) => void;
  /** Depois do envio para a Meta (ex.: reabrir a lista onde o aviso aparece). */
  onSaved?: () => void;
  /** Antes de abrir o builder (ex.: fechar a Sheet de templates do chat). */
  beforeOpen?: () => void;
}) {
  const { currentOrganization } = useOrganization();
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const beforeOpenRef = useRef(beforeOpen);
  beforeOpenRef.current = beforeOpen;
  const [editing, setEditing] = useState<MetaTemplate | null>(null);
  const organizationId = currentOrganization?.id ?? null;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const onApprovedRef = useRef(onApproved);
  onApprovedRef.current = onApproved;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const savedMediaRef = useRef<TemplateHeaderMedia | null>(null);

  const watchKey = pending?.state === "waiting" ? `${pending.name}|${pending.language}` : null;

  useEffect(() => {
    if (!watchKey || !organizationId) return;
    const [name, language] = watchKey.split("|");
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    let attempt = 0;

    const tick = async () => {
      timer = undefined;
      try {
        const list = await fetchOrgTemplates(organizationId, name);
        if (cancelled) return;
        const found = list.find((t) => t.name === name && t.language === language);
        if (found?.status === "APPROVED") {
          setPending(null);
          // Toast porque a lista onde o aviso mora pode estar fechada.
          toastRef.current({ title: `Template ${name} aprovado`, description: "Já dá para enviar." });
          onApprovedRef.current(found, { headerMedia: savedMediaRef.current });
          return;
        }
        if (found?.status === "REJECTED") {
          const reason = rejectedReasonLabel(found.rejected_reason);
          setPending({ name, language, state: "rejected", reason, rejected: found });
          toastRef.current({
            title: `A Meta recusou ${name}`,
            description: reason ? `Motivo: ${reason}. Dá para corrigir e reenviar.` : "Dá para corrigir e reenviar.",
            variant: "destructive",
          });
          return;
        }
      } catch (error) {
        // Falha de rede numa volta não encerra: a próxima tenta de novo.
        console.warn("[templates] falha ao conferir aprovação", error);
        if (cancelled) return;
      }
      if (Date.now() - startedAt >= APPROVAL_WATCH_MS) {
        setPending({ name, language, state: "timeout" });
        return;
      }
      timer = setTimeout(tick, approvalPollDelay(++attempt));
    };

    timer = setTimeout(tick, approvalPollDelay(attempt));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [watchKey, organizationId]);

  const handleSaved = useCallback(
    (saved: SavedTemplate) => {
      // Só a amostra do nosso Storage serve para o envio: o header_handle que volta da
      // Meta numa edição é link assinado do CDN e expira (disparo agendado falharia).
      if (saved.headerMedia?.link.includes("/storage/v1/")) savedMediaRef.current = saved.headerMedia;
      else if (!saved.headerMedia) savedMediaRef.current = null;
      setPending({ name: saved.name, language: saved.language, state: "waiting" });
      onSavedRef.current?.();
      // Aprovado na hora: busca o template completo já, sem esperar a volta do timer.
      if (saved.status === "APPROVED" && organizationId) {
        fetchOrgTemplates(organizationId, saved.name)
          .then((list) => {
            const found = list.find((t) => t.name === saved.name && t.language === saved.language);
            if (found?.status === "APPROVED") {
              setPending(null);
              onApprovedRef.current(found, { headerMedia: savedMediaRef.current });
            }
          })
          .catch((error) => console.warn("[templates] falha ao buscar o template aprovado", error));
      }
    },
    [organizationId],
  );

  const openBuilder = useCallback((template: MetaTemplate | null = null) => {
    beforeOpenRef.current?.();
    setEditing(template);
    setOpen(true);
  }, []);
  /** Esquece o template em análise (ex.: trocou de conversa: aprovar não pode abrir o envio em outra). */
  const reset = useCallback(() => setPending(null), []);

  const dialog = (
    <TemplateBuilderDialog open={open} onOpenChange={setOpen} editing={editing} onSaved={handleSaved} />
  );

  const notice = pending ? (
    <PendingTemplateNotice
      pending={pending}
      onRetry={() => setPending({ ...pending, state: "waiting" })}
      // O aviso fica até salvar: fechar o builder sem enviar não perde o caminho de volta.
      onFix={() => openBuilder(pending.rejected ?? null)}
      onDismiss={() => setPending(null)}
    />
  ) : null;

  return { openBuilder, reset, dialog, notice };
}

function PendingTemplateNotice({
  pending,
  onRetry,
  onFix,
  onDismiss,
}: {
  pending: Pending;
  onRetry: () => void;
  onFix: () => void;
  onDismiss: () => void;
}) {
  const rejected = pending.state === "rejected";
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        rejected
          ? "flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm"
          : "flex items-start gap-2.5 rounded-lg border bg-muted/50 p-3 text-sm"
      }
    >
      {pending.state === "waiting" && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
      {pending.state === "timeout" && <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
      {rejected && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />}
      <div className="min-w-0 flex-1 space-y-1">
        {pending.state === "waiting" && (
          <p>
            <span className="font-medium">{pending.name}</span> está em análise na Meta. Costuma levar poucos minutos, e
            ele fica selecionado aqui assim que aprovar.
          </p>
        )}
        {pending.state === "timeout" && (
          <>
            <p>
              <span className="font-medium">{pending.name}</span> ainda está em análise. Quando aprovar, aparece na lista.
            </p>
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onRetry}>
              Verificar de novo
            </Button>
          </>
        )}
        {rejected && (
          <>
            <p>
              A Meta recusou <span className="font-medium">{pending.name}</span>
              {pending.reason ? `: ${pending.reason}.` : "."}
            </p>
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onFix}>
              Corrigir e reenviar
            </Button>
          </>
        )}
      </div>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="Fechar aviso" onClick={onDismiss}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
