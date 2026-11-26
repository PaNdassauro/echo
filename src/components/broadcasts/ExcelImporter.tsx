import { useState, useCallback } from "react";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { toUserMessage } from "@/lib/userFacingError";
import { FileSpreadsheet, X, Loader2, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface Recipient {
    id: string;
    phone_number: string;
    contact_name: string;
    variables: string[];
}

interface ExcelImporterProps {
    variableCount: number;
    onImport: (recipients: Recipient[]) => void;
    onCancel: () => void;
}

interface SkipReport {
    duplicates: number;
    invalid: number;
    truncated: boolean;
}

// Upper bound on one import. Without a cap a stray 50k-row sheet froze the tab
// (parsing is synchronous) and produced a campaign nobody intended to send.
const MAX_IMPORT_ROWS = 5000;
// Shortest/longest plausible dialable number once punctuation is stripped.
const MIN_PHONE_DIGITS = 10;
const MAX_PHONE_DIGITS = 15;

export default function ExcelImporter({ variableCount, onImport, onCancel }: ExcelImporterProps) {
    const { toast } = useToast();
    const [isDragging, setIsDragging] = useState(false);
    const [parsing, setParsing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const parseExcel = (data: ArrayBuffer): { recipients: Recipient[]; skipped: SkipReport } => {
        const workbook = XLSX.read(data, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Convert to array of arrays
        const rows: string[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        if (rows.length < 2) {
            throw new Error("O arquivo deve ter pelo menos o cabeçalho e uma linha de dados.");
        }

        const headers = rows[0].map((h) => String(h || "").toLowerCase().trim());

        // Find column indexes
        const phoneIdx = headers.findIndex((h) => h.includes("telefone") || h.includes("phone"));
        const nameIdx = headers.findIndex((h) => h.includes("nome") || h.includes("name"));

        if (phoneIdx === -1) {
            throw new Error("Coluna “telefone” não encontrada no arquivo. Baixe a planilha de exemplo para ver o formato.");
        }

        // Find variable columns - first body variables (variavel_X), then button variables (botao_X)
        const varIndexes: number[] = [];

        // Find all body variable columns in order (variavel_1, variavel_2, etc.)
        let bodyVarIdx = 1;
        while (true) {
            const idx = headers.findIndex((h) =>
                h.includes(`variavel_${bodyVarIdx}`) ||
                h.includes(`var_${bodyVarIdx}`) ||
                h.includes(`{{${bodyVarIdx}}}`)
            );
            if (idx === -1) break;
            varIndexes.push(idx);
            bodyVarIdx++;
        }

        // Find all button variable columns in order (botao_1, botao_2, etc.)
        let buttonVarIdx = 1;
        while (varIndexes.length < variableCount) {
            const idx = headers.findIndex((h) =>
                h.includes(`botao_${buttonVarIdx}`) ||
                h.includes(`button_${buttonVarIdx}`)
            );
            if (idx === -1) break;
            varIndexes.push(idx);
            buttonVarIdx++;
        }

        // Fill remaining with -1 if we didn't find all expected variables
        while (varIndexes.length < variableCount) {
            varIndexes.push(-1);
        }

        const recipients: Recipient[] = [];
        // Duplicates in a mailing list mean the same person is messaged twice and
        // charged twice. There was no dedup at all before.
        const seenPhones = new Set<string>();
        let duplicates = 0;
        let invalid = 0;

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length === 0) continue;

            const phone = String(row[phoneIdx] || "").trim();
            if (!phone) continue;

            const variables: string[] = [];
            for (let j = 0; j < variableCount; j++) {
                const idx = varIndexes[j];
                variables.push(idx !== -1 ? String(row[idx] || "") : "");
            }

            const trimmedPhone = String(phone).trim();
            const cleanedPhone = trimmedPhone.replace(/\D/g, "");

            // A number too short to be dialable is a spreadsheet artefact, not a
            // contact. Previously these went straight through and failed one by one
            // at send time, each burning a recipient slot.
            if (cleanedPhone.length < MIN_PHONE_DIGITS || cleanedPhone.length > MAX_PHONE_DIGITS) {
                invalid++;
                continue;
            }

            if (seenPhones.has(cleanedPhone)) {
                duplicates++;
                continue;
            }
            seenPhones.add(cleanedPhone);

            // Preserve the leading "+" when the user supplied it: it's the
            // signal that the number already carries a country code, which
            // broadcast-execute uses to skip Brazilian normalization.
            const phoneWithFlag = trimmedPhone.startsWith("+")
                ? `+${cleanedPhone}`
                : cleanedPhone;

            recipients.push({
                id: crypto.randomUUID(),
                phone_number: phoneWithFlag,
                contact_name: nameIdx !== -1 ? String(row[nameIdx] || "") : "",
                variables,
            });

            // Stop at the cap instead of freezing the tab on a runaway sheet.
            if (recipients.length >= MAX_IMPORT_ROWS) break;
        }

        const skipped = { duplicates, invalid, truncated: recipients.length >= MAX_IMPORT_ROWS };
        return { recipients, skipped };
    };

    const handleFile = useCallback(
        async (file: File) => {
            setError(null);
            setParsing(true);

            try {
                const buffer = await file.arrayBuffer();
                const { recipients, skipped } = parseExcel(buffer);

                if (recipients.length === 0) {
                    throw new Error("Nenhum destinatário válido no arquivo. Confira a coluna “telefone”.");
                }

                // Say what was dropped. Silently discarding rows from a mailing list
                // reads as "everything imported" when it wasn't.
                const notes: string[] = [];
                if (skipped.duplicates > 0) {
                    notes.push(skipped.duplicates === 1 ? "1 duplicado removido" : `${skipped.duplicates} duplicados removidos`);
                }
                if (skipped.invalid > 0) {
                    notes.push(skipped.invalid === 1 ? "1 número inválido ignorado" : `${skipped.invalid} números inválidos ignorados`);
                }
                if (skipped.truncated) notes.push(`limite de ${MAX_IMPORT_ROWS.toLocaleString("pt-BR")} linhas aplicado`);

                toast({
                    title:
                        recipients.length === 1
                            ? "1 destinatário importado"
                            : `${recipients.length.toLocaleString("pt-BR")} destinatários importados`,
                    description: notes.length > 0 ? notes.join(" · ") : undefined,
                });

                onImport(recipients);
            } catch (err: unknown) {
                console.error("[ExcelImporter] Falha ao ler a planilha:", err);
                setError(toUserMessage(err, "Não foi possível ler a planilha. Confira se o arquivo está em .xlsx, .xls ou .csv e tente de novo."));
            } finally {
                setParsing(false);
            }
        },
        [variableCount, onImport, toast]
    );

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            setIsDragging(false);

            const file = e.dataTransfer.files[0];
            if (file && (file.name.endsWith(".xlsx") || file.name.endsWith(".xls") || file.name.endsWith(".csv"))) {
                handleFile(file);
            } else {
                setError("Este formato não é aceito. Envie um arquivo .xlsx, .xls ou .csv.");
            }
        },
        [handleFile]
    );

    const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            handleFile(file);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="font-medium">Importar destinatários</h3>
                <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Fechar importação">
                    <X className="h-4 w-4" />
                </Button>
            </div>

            {error && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            <Card
                className={`border-2 border-dashed transition-colors ${isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25"
                    }`}
                onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
            >
                <CardContent className="flex flex-col items-center justify-center py-12">
                    {parsing ? (
                        <>
                            <Loader2 className="h-12 w-12 text-primary animate-spin mb-4" />
                            <p className="text-muted-foreground">Processando arquivo…</p>
                        </>
                    ) : (
                        <>
                            <FileSpreadsheet className="h-12 w-12 text-muted-foreground/50 mb-4" />
                            <p className="text-center mb-4">
                                Arraste um arquivo Excel aqui ou{" "}
                                {/* sr-only, not hidden: `display:none` takes the input out
                                    of the tab order entirely, so the only way to import a
                                    spreadsheet was with a mouse. focus-within puts the ring
                                    on the visible label instead of the invisible input. */}
                                <label className="rounded-sm text-primary cursor-pointer underline underline-offset-2 [text-underline-position:from-font] [text-decoration-thickness:from-font] focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                                    selecione no dispositivo
                                    <input
                                        type="file"
                                        accept=".xlsx,.xls,.csv"
                                        className="sr-only"
                                        onChange={handleFileInput}
                                    />
                                </label>
                            </p>
                            <p className="text-xs text-muted-foreground text-center">
                                O arquivo deve conter colunas: <code>telefone</code>, <code>nome</code>
                                {variableCount > 0 && (
                                    <>
                                        {", "}
                                        {Array.from({ length: variableCount }, (_, i) => (
                                            <code key={i}>variavel_{i + 1}</code>
                                        )).reduce((prev: React.ReactNode, curr, i) => (
                                            <>
                                                {prev}
                                                {i > 0 && ", "}
                                                {curr}
                                            </>
                                        ), null as React.ReactNode)}
                                    </>
                                )}
                            </p>
                        </>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
