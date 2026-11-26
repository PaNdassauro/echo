import { useState, useCallback, useEffect, useRef } from "react";
import {
  Loader2,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  X,
  Plus,
  Users,
} from "lucide-react";
import {
  ResponsiveDialog as Dialog,
  ResponsiveDialogContent as DialogContent,
  ResponsiveDialogHeader as DialogHeader,
  ResponsiveDialogFooter as DialogFooter,
  ResponsiveDialogTitle as DialogTitle,
  ResponsiveDialogDescription as DialogDescription,
} from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { qrFetch } from "@/lib/qrService";
import {
  findOrCreateConversation,
  findOrCreateGroupConversation,
  createUnlinkedGroupConversation,
  type FindOrCreateConversationResult,
} from "@/lib/conversationUpsert";
import { parseImportCsv, type ParsedRow } from "@/lib/importHistoryCsvParser";
import { importRowsToConversation } from "@/lib/importHistoryClient";

/** Select value for "import without linking to a real group". */
const UNLINKED = "__unlinked__";

type ItemStatus = "lendo" | "pronto" | "erro" | "importando" | "ok";

type ItemKind = "1:1" | "group";

interface GroupOption {
  jid: string;
  subject: string;
  participants?: number;
}

interface FileItem {
  id: string;
  fileName: string;
  status: ItemStatus;
  kind: ItemKind;
  contactPhone: string | null;
  contactName: string;
  /** Distinct inbound senders found in the file (2+ ⇒ detected as group). */
  sendersCount: number;
  /** Group files: real group JID, UNLINKED, or null while not chosen. */
  selectedGroupJid: string | null;
  /** Group JID extracted from the CSV's Message Ids, used to pre-select the group. */
  detectedGroupJid: string | null;
  /** Editable name used when importing without linking. */
  groupName: string;
  total: number;
  minTs: string;
  maxTs: string;
  warnings: string[];
  rows: ParsedRow[];
  error?: string;
  inserted?: number;
  skipped?: number;
  created?: boolean;
}

interface ImportConversationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  phoneNumberDbId?: string | null;
  onImported?: () => void;
}

function formatPreviewDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function defaultGroupName(fileName: string): string {
  return fileName.replace(/\.csv$/i, "").trim();
}

export default function ImportConversationsDialog({
  open,
  onOpenChange,
  userId,
  phoneNumberDbId,
  onImported,
}: ImportConversationsDialogProps) {
  const { toast } = useToast();
  const [items, setItems] = useState<FileItem[]>([]);
  const [importing, setImporting] = useState(false);
  const [groups, setGroups] = useState<GroupOption[] | null>(null);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const groupsRequested = useRef(false);

  useEffect(() => {
    groupsRequested.current = false;
    setGroups(null);
    setGroupsError(null);
  }, [phoneNumberDbId]);

  // Pre-select the group extracted from the CSV once the connected number's
  // group list is available (parse and fetch race in either order).
  useEffect(() => {
    if (!groups?.length) return;
    setItems((prev) => {
      const shouldPreselect = (it: FileItem) =>
        it.status === "pronto" &&
        it.kind === "group" &&
        it.selectedGroupJid === null &&
        !!it.detectedGroupJid &&
        groups.some((g) => g.jid === it.detectedGroupJid);
      if (!prev.some(shouldPreselect)) return prev;
      return prev.map((it) =>
        shouldPreselect(it) ? { ...it, selectedGroupJid: it.detectedGroupJid } : it,
      );
    });
  }, [groups, items]);

  const reset = useCallback(() => {
    setItems([]);
    setImporting(false);
  }, []);

  const handleOpenChange = (next: boolean) => {
    if (!next && !importing) reset();
    onOpenChange(next);
  };

  const updateItem = useCallback((id: string, patch: Partial<FileItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const ensureGroupsLoaded = useCallback(async () => {
    if (groupsRequested.current || !phoneNumberDbId) return;
    groupsRequested.current = true;
    try {
      const res = await qrFetch(`/groups/${phoneNumberDbId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error(data.error || "Falha ao listar grupos.");
      }
      const list: GroupOption[] = (Array.isArray(data.groups) ? data.groups : [])
        .map((g: { jid?: string; id?: string; subject?: string; participants?: number }) => {
          const jid = g.jid ?? g.id ?? "";
          return {
            jid,
            subject: g.subject || jid.replace("@g.us", ""),
            participants: g.participants,
          };
        })
        .filter((g: GroupOption) => g.jid);
      setGroups(list);
    } catch (err) {
      setGroupsError(err instanceof Error ? err.message : "Falha ao listar grupos.");
      setGroups([]);
    }
  }, [phoneNumberDbId]);

  const handleFiles = useCallback(
    async (files: FileList) => {
      const selected = Array.from(files);
      const newItems: FileItem[] = selected.map((f, i) => ({
        id: `${f.name}-${f.size}-${Date.now()}-${i}`,
        fileName: f.name,
        status: "lendo",
        kind: "1:1",
        contactPhone: null,
        contactName: "",
        sendersCount: 0,
        selectedGroupJid: null,
        detectedGroupJid: null,
        groupName: defaultGroupName(f.name),
        total: 0,
        minTs: "",
        maxTs: "",
        warnings: [],
        rows: [],
      }));
      setItems((prev) => [...prev, ...newItems]);

      await Promise.all(
        selected.map(async (file, i) => {
          const id = newItems[i].id;
          try {
            const parsed = await parseImportCsv(file);
            if (!parsed.isLikelyGroup && !parsed.detectedContactPhone) {
              updateItem(id, {
                status: "erro",
                error: "Não foi possível detectar o contato (esperado export 1:1).",
              });
              return;
            }
            if (parsed.isLikelyGroup) void ensureGroupsLoaded();
            const contactName =
              parsed.rows.find((r) => r.direction === "inbound" && r.senderName)?.senderName ||
              parsed.detectedContactPhone ||
              "";
            updateItem(id, {
              status: "pronto",
              kind: parsed.isLikelyGroup ? "group" : "1:1",
              contactPhone: parsed.detectedContactPhone,
              contactName,
              sendersCount: parsed.inboundSenders.length,
              detectedGroupJid: parsed.detectedGroupJid,
              total: parsed.rows.length,
              minTs: parsed.minTs,
              maxTs: parsed.maxTs,
              warnings: parsed.warnings,
              rows: parsed.rows,
            });
          } catch (err) {
            updateItem(id, {
              status: "erro",
              error: err instanceof Error ? err.message : "Erro ao ler arquivo.",
            });
          }
        }),
      );
    },
    [updateItem, ensureGroupsLoaded],
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) handleFiles(e.target.files);
    e.target.value = "";
  };

  const toggleKind = (it: FileItem) => {
    if (it.kind === "group") {
      updateItem(it.id, { kind: "1:1" });
    } else {
      void ensureGroupsLoaded();
      updateItem(it.id, { kind: "group" });
    }
  };

  const importOne = useCallback(
    async (item: FileItem): Promise<{ created: boolean; inserted: number }> => {
      let conv: FindOrCreateConversationResult;
      if (item.kind === "group") {
        if (item.selectedGroupJid && item.selectedGroupJid !== UNLINKED) {
          const subject =
            groups?.find((g) => g.jid === item.selectedGroupJid)?.subject || item.groupName;
          conv = await findOrCreateGroupConversation({
            groupJid: item.selectedGroupJid,
            groupName: subject,
            phoneNumberDbId: phoneNumberDbId as string,
            userId,
          });
        } else {
          conv = await createUnlinkedGroupConversation({
            groupName: item.groupName,
            phoneNumberDbId: phoneNumberDbId as string,
            userId,
          });
        }
      } else {
        conv = await findOrCreateConversation({
          contactPhone: item.contactPhone as string,
          contactName: item.contactName,
          phoneNumberDbId: phoneNumberDbId as string,
          userId,
        });
      }
      const { conversationId, created } = conv;

      const { inserted, skipped } = await importRowsToConversation(conversationId, item.rows);
      updateItem(item.id, { status: "ok", inserted, skipped, created });
      return { created, inserted };
    },
    [phoneNumberDbId, userId, updateItem, groups],
  );

  const isImportable = (it: FileItem) =>
    it.status === "pronto" &&
    (it.kind === "group" ? it.selectedGroupJid !== null : !!it.contactPhone);

  const importableItems = items.filter(isImportable);
  const pendingGroupChoice = items.filter(
    (it) => it.status === "pronto" && it.kind === "group" && it.selectedGroupJid === null,
  ).length;

  const handleImportAll = async () => {
    // O aviso inline "Nenhum número selecionado" já está na tela; nada a duplicar em toast.
    if (!phoneNumberDbId) return;
    setImporting(true);
    let createdCount = 0;
    let reusedCount = 0;
    let totalInserted = 0;
    let errorCount = 0;

    for (const item of items) {
      if (!isImportable(item)) continue;
      updateItem(item.id, { status: "importando" });
      try {
        const { created, inserted } = await importOne(item);
        totalInserted += inserted;
        if (created) createdCount++;
        else reusedCount++;
      } catch (err) {
        errorCount++;
        updateItem(item.id, {
          status: "erro",
          error: err instanceof Error ? err.message : "Erro ao importar.",
        });
      }
    }

    setImporting(false);
    toast({
      title: "Importação concluída",
      description: [
        createdCount === 1 ? "1 conversa criada" : `${createdCount} conversas criadas`,
        reusedCount === 1 ? "1 já existente" : `${reusedCount} já existentes`,
        totalInserted === 1 ? "1 mensagem importada" : `${totalInserted} mensagens importadas`,
        errorCount ? (errorCount === 1 ? "1 com erro" : `${errorCount} com erro`) : null,
      ]
        .filter(Boolean)
        .join(", ") + ".",
      variant: errorCount ? "destructive" : undefined,
    });
    onImported?.();
  };

  const allDone = items.length > 0 && items.every((it) => it.status === "ok" || it.status === "erro");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Importar conversas (CSV)</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 min-w-0">
          <p className="text-sm text-muted-foreground">
            Selecione um ou mais CSVs exportados do WhatsApp. Cada arquivo cria (ou reaproveita)
            uma conversa com o contato ou grupo detectado e importa o histórico. Apenas mensagens
            de texto são importadas.
          </p>

          {items.length === 0 ? (
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
                {items.map((it) => (
                  <div
                    key={it.id}
                    className="flex items-start gap-2 rounded-md border bg-muted/30 p-2.5 min-w-0"
                  >
                    <div className="shrink-0 mt-0.5">
                      {it.status === "lendo" || it.status === "importando" ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : it.status === "ok" ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : it.status === "erro" ? (
                        <AlertTriangle className="h-4 w-4 text-destructive" />
                      ) : it.kind === "group" ? (
                        <Users className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate" title={it.fileName}>
                        {it.fileName}
                      </p>
                      {it.status === "pronto" && it.kind === "1:1" && (
                        <p className="text-xs text-muted-foreground truncate">
                          {it.contactName || "Sem contato detectado"} · {it.total} msgs ·{" "}
                          {formatPreviewDate(it.minTs)} → {formatPreviewDate(it.maxTs)}
                        </p>
                      )}
                      {it.status === "pronto" && it.kind === "group" && (
                        <>
                          <p className="text-xs text-muted-foreground truncate">
                            Grupo · {it.sendersCount === 1 ? "1 participante detectado" : `${it.sendersCount} participantes detectados`} ·{" "}
                            {it.total === 1 ? "1 mensagem" : `${it.total} mensagens`} · {formatPreviewDate(it.minTs)} → {formatPreviewDate(it.maxTs)}
                          </p>
                          <div className="mt-1.5 flex flex-col gap-1.5">
                            <Select
                              value={it.selectedGroupJid ?? ""}
                              onValueChange={(v) => updateItem(it.id, { selectedGroupJid: v })}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue
                                  placeholder={
                                    groups === null ? "Carregando grupos…" : "Vincular ao grupo…"
                                  }
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {(groups ?? []).map((g) => (
                                  <SelectItem key={g.jid} value={g.jid}>
                                    {g.subject}
                                  </SelectItem>
                                ))}
                                <SelectItem value={UNLINKED}>
                                  Importar sem vincular a um grupo
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            {it.selectedGroupJid !== null &&
                              it.selectedGroupJid === it.detectedGroupJid && (
                                <p className="text-xs text-muted-foreground">
                                  Grupo detectado automaticamente pelo arquivo.
                                </p>
                              )}
                            {groupsError && (
                              <p className="text-xs text-amber-600 dark:text-amber-500">
                                Não foi possível listar os grupos ({groupsError}). Só a opção
                                "sem vincular" está disponível.
                              </p>
                            )}
                            {it.selectedGroupJid === UNLINKED && (
                              <Input
                                value={it.groupName}
                                onChange={(e) => updateItem(it.id, { groupName: e.target.value })}
                                placeholder="Nome do grupo"
                                className="h-8 text-xs"
                              />
                            )}
                          </div>
                        </>
                      )}
                      {it.status === "pronto" && !importing && (
                        <button
                          type="button"
                          className="mt-1 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 [text-underline-position:from-font] [text-decoration-thickness:from-font] active:scale-[0.96] motion-reduce:active:scale-100 transition-[color,transform] duration-150 ease-out"
                          onClick={() => toggleKind(it)}
                        >
                          {it.kind === "group" ? "Tratar como conversa 1:1" : "Tratar como grupo"}
                        </button>
                      )}
                      {it.status === "ok" && (
                        <p className="text-xs text-green-600 dark:text-green-400">
                          {it.created ? "Conversa criada" : "Conversa existente"} ·{" "}
                          {(it.inserted ?? 0) === 1 ? "1 importada" : `${it.inserted ?? 0} importadas`}
                          {it.skipped ? (it.skipped === 1 ? ", 1 duplicada" : `, ${it.skipped} duplicadas`) : ""}
                        </p>
                      )}
                      {it.status === "importando" && (
                        <p className="text-xs text-muted-foreground">Importando…</p>
                      )}
                      {it.status === "erro" && (
                        <p className="text-xs text-destructive">{it.error}</p>
                      )}
                    </div>
                    {!importing && it.status !== "ok" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        aria-label="Remover"
                        onClick={() => setItems((prev) => prev.filter((x) => x.id !== it.id))}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              {!importing && !allDone && (
                <label className="inline-flex items-center gap-1.5 text-sm text-primary cursor-pointer hover:underline">
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

          {pendingGroupChoice > 0 && !importing && !allDone && (
            <p className="text-xs text-muted-foreground">
              {pendingGroupChoice === 1
                ? "Escolha o grupo (ou “sem vincular”) em 1 arquivo para incluí-lo na importação."
                : `Escolha o grupo (ou “sem vincular”) em ${pendingGroupChoice} arquivos para incluí-los na importação.`}
            </p>
          )}

          {!phoneNumberDbId && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Nenhum número selecionado</AlertTitle>
              <AlertDescription>
                Selecione um número conectado para importar as conversas.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={importing}>
            {allDone ? "Fechar" : "Cancelar"}
          </Button>
          {!allDone && (
            <Button
              onClick={handleImportAll}
              disabled={importing || importableItems.length === 0 || !phoneNumberDbId}
            >
              {importing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Importando…
                </>
              ) : (
                `Importar ${importableItems.length || ""}`.trim()
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
