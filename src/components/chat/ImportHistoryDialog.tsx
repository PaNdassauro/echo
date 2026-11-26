import { useState, useCallback } from "react";
import { Loader2, FileSpreadsheet, CheckCircle2, AlertTriangle, X, Plus, Users } from "lucide-react";
import {
  ResponsiveDialog as Dialog,
  ResponsiveDialogContent as DialogContent,
  ResponsiveDialogHeader as DialogHeader,
  ResponsiveDialogFooter as DialogFooter,
  ResponsiveDialogTitle as DialogTitle,
  ResponsiveDialogDescription as DialogDescription,
} from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  findOrCreateConversation,
  findOrCreateGroupConversation,
} from "@/lib/conversationUpsert";
import { parseImportCsv, type ParseResult } from "@/lib/importHistoryCsvParser";
import { importRowsToConversation } from "@/lib/importHistoryClient";

/** Files imported concurrently. Same-destination races are resolved by the
 * unique index (phone_number_id, contact_phone, is_group) + 23505 refetch in
 * the find-or-create helpers. */
const IMPORT_CONCURRENCY = 4;

type EntryStatus = "lendo" | "pronto" | "erro" | "importando" | "ok";

interface FileEntry {
  id: string;
  fileName: string;
  status: EntryStatus;
  result: ParseResult | null;
  error?: string;
  inserted?: number;
  skipped?: number;
  /** Set after import: whether the destination conversation was created now. */
  createdConversation?: boolean;
  /** Set after import: whether the rows landed in the currently open conversation. */
  importedHere?: boolean;
}

interface ImportHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  conversationContactPhone: string;
  /** True when the target conversation is a WhatsApp group. */
  isGroup?: boolean;
  userId: string;
  onImported?: () => void;
}

function formatPreviewDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** “WAChatsBackup_<id>_<subject>_<count>_<date>_<time>.csv” → “<subject>”. */
function groupNameFromFileName(fileName: string): string {
  const m = fileName.match(/^WAChatsBackup_\d+_(.+)_\d+_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/i);
  return (m ? m[1] : fileName.replace(/\.csv$/i, "")).trim();
}

export default function ImportHistoryDialog({
  open,
  onOpenChange,
  conversationId,
  conversationContactPhone,
  isGroup = false,
  userId,
  onImported,
}: ImportHistoryDialogProps) {
  const { toast } = useToast();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const reset = useCallback(() => {
    setEntries([]);
    setSubmitting(false);
    setProgress(null);
  }, []);

  const handleOpenChange = (next: boolean) => {
    if (!next && !submitting) reset();
    onOpenChange(next);
  };

  const updateEntry = useCallback((id: string, patch: Partial<FileEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const handleFiles = useCallback(
    async (files: FileList) => {
      const selected = Array.from(files);
      const newEntries: FileEntry[] = selected.map((f, i) => ({
        id: `${f.name}-${f.size}-${Date.now()}-${i}`,
        fileName: f.name,
        status: "lendo",
        result: null,
      }));
      setEntries((prev) => [...prev, ...newEntries]);

      await Promise.all(
        selected.map(async (file, i) => {
          const id = newEntries[i].id;
          try {
            const parsed = await parseImportCsv(file);
            if (!parsed.detectedGroupJid && !parsed.detectedContactPhone) {
              updateEntry(id, {
                status: "erro",
                error: "Não foi possível detectar o grupo ou contato do arquivo.",
              });
              return;
            }
            updateEntry(id, { status: "pronto", result: parsed });
          } catch (err) {
            updateEntry(id, {
              status: "erro",
              error: err instanceof Error ? err.message : "Erro ao ler arquivo.",
            });
          }
        }),
      );
    },
    [updateEntry],
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) handleFiles(e.target.files);
    e.target.value = "";
  };

  /** Where this file's messages will land, for display before importing. */
  const destinationLabel = useCallback(
    (entry: FileEntry): string => {
      const r = entry.result;
      if (!r) return "";
      if (r.detectedGroupJid) {
        if (isGroup && r.detectedGroupJid === conversationContactPhone) return "esta conversa";
        return `grupo "${groupNameFromFileName(entry.fileName)}"`;
      }
      if (r.detectedContactPhone) {
        const name = r.rows.find((x) => x.direction === "inbound" && x.senderName)?.senderName;
        return name ? `${name} (${r.detectedContactPhone})` : r.detectedContactPhone;
      }
      return "esta conversa";
    },
    [isGroup, conversationContactPhone],
  );

  const readyEntries = entries.filter((e) => e.status === "pronto" && e.result);
  const canSubmit = readyEntries.length > 0 && !submitting;

  /**
   * Routes the file to its own conversation: the current one when the group
   * JID matches, otherwise find-or-create by JID (groups) or contact phone
   * (1:1) under the same connected number as the open conversation.
   */
  const importEntry = async (
    entry: FileEntry,
    phoneNumberDbId: string,
  ): Promise<{ inserted: number; skipped: number; created: boolean; importedHere: boolean }> => {
    const r = entry.result;
    if (!r) throw new Error("Arquivo não processado.");

    let targetConversationId = conversationId;
    let created = false;

    if (r.detectedGroupJid) {
      if (!isGroup || r.detectedGroupJid !== conversationContactPhone) {
        const conv = await findOrCreateGroupConversation({
          groupJid: r.detectedGroupJid,
          groupName: groupNameFromFileName(entry.fileName),
          phoneNumberDbId,
          userId,
        });
        targetConversationId = conv.conversationId;
        created = conv.created;
      }
    } else if (r.detectedContactPhone) {
      const contactName =
        r.rows.find((x) => x.direction === "inbound" && x.senderName)?.senderName ||
        r.detectedContactPhone;
      const conv = await findOrCreateConversation({
        contactPhone: r.detectedContactPhone,
        contactName,
        phoneNumberDbId,
        userId,
      });
      targetConversationId = conv.conversationId;
      created = conv.created;
    }

    const { inserted, skipped } = await importRowsToConversation(targetConversationId, r.rows);
    return { inserted, skipped, created, importedHere: targetConversationId === conversationId };
  };

  const handleSubmit = async () => {
    if (readyEntries.length === 0) return;
    setSubmitting(true);
    let totalInserted = 0;
    let totalSkipped = 0;
    let createdCount = 0;
    let errorCount = 0;
    let anyHere = false;

    // New conversations are created under the same connected number as the
    // open conversation.
    const { data: convRow, error: convError } = await supabase
      .from("conversations")
      .select("phone_number_id")
      .eq("id", conversationId)
      .single();

    if (convError || !convRow?.phone_number_id) {
      setSubmitting(false);
      toast({
        title: "Não foi possível importar",
        description: "Não foi possível identificar o número conectado desta conversa.",
        variant: "destructive",
      });
      return;
    }

    const queue = [...readyEntries];
    let done = 0;
    setProgress({ done: 0, total: queue.length });

    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        updateEntry(entry.id, { status: "importando" });
        try {
          const { inserted, skipped, created, importedHere } = await importEntry(
            entry,
            convRow.phone_number_id,
          );
          totalInserted += inserted;
          totalSkipped += skipped;
          if (created) createdCount++;
          if (importedHere) anyHere = true;
          updateEntry(entry.id, {
            status: "ok",
            inserted,
            skipped,
            createdConversation: created,
            importedHere,
          });
        } catch (err) {
          errorCount++;
          updateEntry(entry.id, {
            status: "erro",
            error: err instanceof Error ? err.message : "Erro ao importar.",
          });
        }
        done++;
        setProgress({ done, total: readyEntries.length });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(IMPORT_CONCURRENCY, queue.length) }, () => worker()),
    );

    setSubmitting(false);
    setProgress(null);
    toast({
      title: errorCount ? "Importação concluída com erros" : "Importação concluída",
      description: [
        totalInserted === 1 ? "1 mensagem importada" : `${totalInserted} mensagens importadas`,
        createdCount ? (createdCount === 1 ? "1 conversa criada" : `${createdCount} conversas criadas`) : null,
        totalSkipped ? (totalSkipped === 1 ? "1 duplicada" : `${totalSkipped} duplicadas`) : null,
        errorCount ? (errorCount === 1 ? "1 arquivo com erro" : `${errorCount} arquivos com erro`) : null,
      ]
        .filter(Boolean)
        .join(", ") + ".",
      variant: errorCount ? "destructive" : undefined,
    });
    if (anyHere) onImported?.();
  };

  const allDone =
    entries.length > 0 && entries.every((e) => e.status === "ok" || e.status === "erro");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>Importar histórico de conversa</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 min-w-0">
          <p className="text-sm text-muted-foreground">
            Envie um ou mais CSVs exportados do WhatsApp. Cada arquivo é anexado automaticamente à
            conversa do grupo ou contato detectado — se ela não existir, é criada. Apenas
            mensagens de texto são importadas.
          </p>

          {entries.length === 0 ? (
            <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-muted-foreground/25 rounded-lg py-10 cursor-pointer hover:border-primary/50 transition-colors">
              <FileSpreadsheet className="h-10 w-10 text-muted-foreground/60" />
              <span className="text-sm text-muted-foreground">
                Selecione os arquivos .csv
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                multiple
                className="hidden"
                onChange={handleFileInput}
              />
            </label>
          ) : (
            <>
              <div className="max-h-[45vh] overflow-y-auto space-y-2 pr-1">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-start gap-2 rounded-md border bg-muted/30 p-2.5 min-w-0"
                  >
                    <div className="shrink-0 mt-0.5">
                      {entry.status === "lendo" || entry.status === "importando" ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : entry.status === "ok" ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : entry.status === "erro" ? (
                        <AlertTriangle className="h-4 w-4 text-destructive" />
                      ) : entry.result?.detectedGroupJid ? (
                        <Users className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate" title={entry.fileName}>
                        {entry.fileName}
                      </p>
                      {entry.status === "pronto" && entry.result && (
                        <>
                          <p className="text-xs text-muted-foreground truncate">
                            {entry.result.rows.length} msgs ·{" "}
                            {formatPreviewDate(entry.result.minTs)} →{" "}
                            {formatPreviewDate(entry.result.maxTs)}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            Destino: {destinationLabel(entry)}
                          </p>
                        </>
                      )}
                      {entry.result?.warnings.map((w, i) => (
                        <p key={i} className="text-xs text-amber-600 dark:text-amber-400">
                          {w}
                        </p>
                      ))}
                      {entry.status === "importando" && (
                        <p className="text-xs text-muted-foreground">Importando…</p>
                      )}
                      {entry.status === "ok" && (
                        <p className="text-xs text-green-600 dark:text-green-400">
                          {(entry.inserted ?? 0) === 1 ? "1 importada" : `${entry.inserted ?? 0} importadas`}
                          {entry.skipped ? (entry.skipped === 1 ? ", 1 duplicada" : `, ${entry.skipped} duplicadas`) : ""}
                          {entry.createdConversation
                            ? " · conversa criada"
                            : entry.importedHere
                              ? " · nesta conversa"
                              : " · conversa existente"}
                        </p>
                      )}
                      {entry.status === "erro" && (
                        <p className="text-xs text-destructive">{entry.error}</p>
                      )}
                    </div>
                    {!submitting && entry.status !== "ok" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        aria-label="Remover arquivo"
                        onClick={() => setEntries((prev) => prev.filter((x) => x.id !== entry.id))}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              {!submitting && !allDone && (
                <label className="inline-flex items-center gap-1.5 text-sm text-primary cursor-pointer hover:underline underline-offset-2 [text-underline-position:from-font] [text-decoration-thickness:from-font]">
                  <Plus className="h-3.5 w-3.5" />
                  Adicionar mais arquivos
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    multiple
                    className="hidden"
                    onChange={handleFileInput}
                  />
                </label>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            {allDone ? "Fechar" : "Cancelar"}
          </Button>
          {!allDone && (
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {progress ? `Importando ${progress.done}/${progress.total}…` : "Importando…"}
                </>
              ) : (
                `Importar${readyEntries.length > 1 ? ` ${readyEntries.length}` : ""}`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
