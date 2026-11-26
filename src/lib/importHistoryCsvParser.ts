// Brazil abolished DST in 2019 (Decree 9.772/2019). America/Sao_Paulo is fixed
// at UTC-3 year-round, so a literal offset is correct and avoids depending on
// the runtime's IANA tz database.
const IMPORT_TZ_OFFSET = "-03:00";

// Minimal RFC-4180 CSV reader. Avoids xlsx for CSVs because xlsx's date-
// detection heuristic was converting "01/05/2026, 21:08:15" into Excel serial
// numbers (46027.88...) instead of preserving the literal string.
function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

const REQUIRED_HEADERS = ["Time", "Message", "Type", "Phone", "Message Id"] as const;

export type ParsedRow = {
  ts: string;
  direction: "inbound" | "outbound";
  content: string;
  whatsappMessageId: string;
  senderPhone: string;
  senderName: string;
  originalType: string;
};

export type InboundSender = {
  phone: string;
  name: string;
};

export type ParseResult = {
  rows: ParsedRow[];
  detectedContactPhone: string | null;
  /** Distinct inbound senders, in order of first appearance. */
  inboundSenders: InboundSender[];
  /** Group JID (e.g. "1203...@g.us") extracted from the Message Id column, if the export is of a group. */
  detectedGroupJid: string | null;
  /** True when the Message Ids carry a @g.us JID or the export has 2+ distinct inbound senders. */
  isLikelyGroup: boolean;
  minTs: string;
  maxTs: string;
  warnings: string[];
};

export class ImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportParseError";
  }
}

function parseTimeToIso(raw: string): string {
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) {
    throw new ImportParseError(`Formato de data inválido: "${raw}". Esperado: DD/MM/AAAA, HH:MM:SS`);
  }
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${IMPORT_TZ_OFFSET}`;
}

export async function parseImportCsv(file: File): Promise<ParseResult> {
  const text = await file.text();
  const rows = parseCsv(text);

  if (rows.length < 2) {
    throw new ImportParseError("Arquivo sem linhas de dados (apenas cabeçalho).");
  }

  const headers = rows[0].map((h) => (h ?? "").trim());
  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required)) {
      throw new ImportParseError(
        `Coluna obrigatória ausente: "${required}". Cabeçalhos encontrados: ${headers.join(", ")}`,
      );
    }
  }

  const idx = (col: string) => headers.indexOf(col);
  const iTime = idx("Time");
  const iMessage = idx("Message");
  const iType = idx("Type");
  const iPhone = idx("Phone");
  const iMessageId = idx("Message Id");
  const iDisplayName = idx("Display Name");

  const parsed: ParsedRow[] = [];
  let unknownDirectionCount = 0;
  let detectedContactPhone: string | null = null;
  let detectedGroupJid: string | null = null;
  const seenInRequest = new Set<string>();
  const inboundSendersByPhone = new Map<string, InboundSender>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const rawTime = String(row[iTime] ?? "").trim();
    const rawMessageId = String(row[iMessageId] ?? "").trim();
    if (!rawTime || !rawMessageId) continue;

    if (seenInRequest.has(rawMessageId)) continue;
    seenInRequest.add(rawMessageId);

    if (!detectedGroupJid) {
      const jidMatch = rawMessageId.match(/_(\d+@g\.us)_/);
      if (jidMatch) detectedGroupJid = jidMatch[1];
    }

    const ts = parseTimeToIso(rawTime);
    const type = String(row[iType] ?? "").trim().toLowerCase();
    const rawMessage = String(row[iMessage] ?? "").trim();

    let content: string;
    if (type === "chat") {
      if (!rawMessage) continue;
      content = rawMessage;
    } else {
      content = `[mídia omitida na importação: ${type || "desconhecido"}]`;
    }

    let direction: "inbound" | "outbound";
    if (rawMessageId.startsWith("true_")) {
      direction = "outbound";
    } else if (rawMessageId.startsWith("false_")) {
      direction = "inbound";
    } else {
      direction = "inbound";
      unknownDirectionCount++;
    }

    const senderPhone = String(row[iPhone] ?? "").trim();
    const senderName = iDisplayName >= 0 ? String(row[iDisplayName] ?? "").trim() : "";

    if (direction === "inbound" && senderPhone) {
      if (!detectedContactPhone) detectedContactPhone = senderPhone;
      const normalized = normalizePhoneForComparison(senderPhone);
      if (normalized && !inboundSendersByPhone.has(normalized)) {
        inboundSendersByPhone.set(normalized, { phone: senderPhone, name: senderName });
      }
    }

    parsed.push({
      ts,
      direction,
      content,
      whatsappMessageId: rawMessageId,
      senderPhone,
      senderName,
      originalType: type,
    });
  }

  if (parsed.length === 0) {
    throw new ImportParseError("Nenhuma mensagem válida encontrada no arquivo.");
  }

  parsed.sort((a, b) => a.ts.localeCompare(b.ts));

  const warnings: string[] = [];
  if (unknownDirectionCount > 0) {
    warnings.push(
      `${unknownDirectionCount} mensagem(ns) sem direção identificável foram tratadas como recebidas.`,
    );
  }

  const inboundSenders = [...inboundSendersByPhone.values()];

  return {
    rows: parsed,
    detectedContactPhone,
    inboundSenders,
    detectedGroupJid,
    isLikelyGroup: detectedGroupJid !== null || inboundSenders.length >= 2,
    minTs: parsed[0].ts,
    maxTs: parsed[parsed.length - 1].ts,
    warnings,
  };
}

export function normalizePhoneForComparison(phone: string): string {
  return (phone || "").replace(/\D/g, "");
}
