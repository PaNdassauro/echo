/**
 * Painel de atendimentos — a camada pura.
 *
 * Quem decide o que é um "atendimento" é a RPC `get_attendance_report`
 * (definição completa no comentário da função, em
 * supabase/migrations/*_baseline.sql). Aqui fica só o
 * que o front precisa por cima disso: resolver o período escolhido, agrupar a
 * série diária em semanas/meses quando o intervalo é longo, formatar tempos e
 * montar a planilha. Nada de rede e nada de `xlsx` (ver attendanceExportClient).
 */
import {
    addDays,
    addMonths,
    addWeeks,
    differenceInCalendarDays,
    endOfDay,
    format,
    isAfter,
    parseISO,
    startOfDay,
    startOfMonth,
    startOfWeek,
} from "date-fns";
import { ptBR } from "date-fns/locale";

// ---------------------------------------------------------------------------
// Parâmetros da medição — passados explicitamente à RPC, para o texto da tela
// e o cálculo nunca divergirem.
// ---------------------------------------------------------------------------

/** Silêncio que encerra um atendimento (depois que a equipe respondeu). */
export const IDLE_HOURS = 24;
/** Quanto o cliente pode esperar a 1ª resposta antes de virar "sem resposta". */
export const UNANSWERED_HOURS = 72;

/** Horário comercial padrão do relatório. */
export const BUSINESS_HOURS = {
    start: "08:00",
    end: "18:00",
    /** ISO: 1 = segunda … 7 = domingo */
    days: [1, 2, 3, 4, 5],
    label: "seg a sex, 8h às 18h",
} as const;

// ---------------------------------------------------------------------------
// Tipos do retorno da RPC
// ---------------------------------------------------------------------------

export type ConversationKind = "all" | "individual" | "group";

export const KIND_OPTIONS: { value: ConversationKind; label: string }[] = [
    { value: "all", label: "Todas as conversas" },
    { value: "individual", label: "Só individuais" },
    { value: "group", label: "Só grupos" },
];

export interface AttendanceSummary {
    total: number;
    same_day: number;
    other_day: number;
    open: number;
    waiting_agent: number;
    waiting_client: number;
    unanswered: number;
    off_hours: number;
    started_by_client: number;
    messages_in: number;
    messages_out: number;
    messages_out_phone: number;
    messages_per_attendance_avg: number | null;
    first_response_median_seconds: number | null;
    first_response_p90_seconds: number | null;
    duration_median_seconds: number | null;
    active_seconds: number;
}

export interface AttendanceAgentRow {
    /** null = atendimentos sem atendente identificável */
    agent_id: string | null;
    agent_name: string | null;
    total: number;
    same_day: number;
    other_day: number;
    open: number;
    unanswered: number;
    off_hours: number;
    first_response_median_seconds: number | null;
    duration_median_seconds: number | null;
    messages_out: number;
    messages_out_off_hours: number;
    messages_out_phone: number;
    active_seconds: number;
    active_days: number;
}

export interface AttendanceDayRow {
    /** yyyy-MM-dd, data de Brasília */
    day: string;
    total: number;
    same_day: number;
    other_day: number;
    open: number;
    unanswered: number;
    off_hours: number;
}

export interface AttendanceHourRow {
    hour: number;
    business_hours: number;
    off_hours: number;
}

export type PendingState = "waiting_agent" | "waiting_client" | "unanswered";

export interface AttendancePendingRow {
    conversation_id: string;
    contact_name: string;
    is_group: boolean;
    agent_id: string | null;
    agent_name: string | null;
    state: PendingState;
    started_at: string;
    last_message_at: string;
}

export interface AttendanceReport {
    summary: AttendanceSummary;
    by_agent: AttendanceAgentRow[];
    by_day: AttendanceDayRow[];
    by_hour: AttendanceHourRow[];
    pending: AttendancePendingRow[];
    meta: {
        generated_at: string;
        idle_hours: number;
        unanswered_hours: number;
        first_message_at: string | null;
    };
}

// ---------------------------------------------------------------------------
// Período
// ---------------------------------------------------------------------------

export type PeriodPreset = "today" | "week" | "month" | "all" | "custom";

export const PERIOD_PRESETS: { value: Exclude<PeriodPreset, "custom">; label: string }[] = [
    { value: "today", label: "Hoje" },
    { value: "week", label: "Semana" },
    { value: "month", label: "Mês" },
    { value: "all", label: "Histórico" },
];

/**
 * Início do "Histórico". Anterior a qualquer mensagem do Echo; a RPC lê desde
 * aqui e a tela mostra a data da primeira mensagem real (meta.first_message_at).
 */
export const HISTORY_START = new Date(2020, 0, 1);

export interface DateRange {
    start: Date;
    end: Date;
}

/**
 * Semana começa na segunda (como o horário comercial). O fim é sempre o fim do
 * dia de hoje — o período corrente inteiro, não "até agora", para a chave da
 * query não mudar a cada render.
 */
export function resolvePeriod(
    preset: PeriodPreset,
    now: Date,
    custom?: Partial<DateRange> | null,
): DateRange {
    const end = endOfDay(now);
    switch (preset) {
        case "today":
            return { start: startOfDay(now), end };
        case "week":
            return { start: startOfWeek(now, { weekStartsOn: 1 }), end };
        case "month":
            return { start: startOfMonth(now), end };
        case "all":
            return { start: HISTORY_START, end };
        case "custom": {
            const from = custom?.start ?? now;
            const to = custom?.end ?? from;
            // Seleção ao contrário no calendário não pode virar intervalo vazio
            const [a, b] = isAfter(from, to) ? [to, from] : [from, to];
            return { start: startOfDay(a), end: endOfDay(b) };
        }
    }
}

// ---------------------------------------------------------------------------
// Estado na URL (?periodo=semana&linha=…): o link do painel pode ser
// compartilhado e sobrevive a um F5.
// ---------------------------------------------------------------------------

const PERIOD_PARAM: Record<PeriodPreset, string> = {
    today: "hoje",
    week: "semana",
    month: "mes",
    all: "historico",
    custom: "personalizado",
};

const KIND_PARAM: Record<ConversationKind, string | null> = {
    all: null,
    individual: "individuais",
    group: "grupos",
};

/** Padrão: semana — "hoje" ainda não tem atendimento concluído para mostrar. */
export const DEFAULT_PERIOD: PeriodPreset = "week";

export const periodToParam = (preset: PeriodPreset): string => PERIOD_PARAM[preset];

export function periodFromParam(value: string | null): PeriodPreset {
    const match = (Object.keys(PERIOD_PARAM) as PeriodPreset[]).find((key) => PERIOD_PARAM[key] === value);
    return match ?? DEFAULT_PERIOD;
}

export const kindToParam = (kind: ConversationKind): string | null => KIND_PARAM[kind];

export function kindFromParam(value: string | null): ConversationKind {
    const match = (Object.keys(KIND_PARAM) as ConversationKind[]).find((key) => KIND_PARAM[key] === value);
    return match ?? "all";
}

/** yyyy-MM-dd → Date local; inválida vira null em vez de "Invalid Date". */
export function dateFromParam(value: string | null): Date | null {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = parseISO(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

export const dateToParam = (date: Date): string => format(date, "yyyy-MM-dd");

/** Linha aberta por padrão: a do link, se existir; senão a primeira. */
export function pickLine<T extends { id: string; label: string }>(lines: T[], requested: string | null): T | null {
    return (
        lines.find((line) => line.id === requested) ??
        lines[0] ??
        null
    );
}

/** "13/10/2026" ou "01/10 – 13/10/2026". */
export function formatRangeLabel({ start, end }: DateRange): string {
    if (differenceInCalendarDays(end, start) === 0) {
        return format(start, "dd/MM/yyyy", { locale: ptBR });
    }
    const sameYear = start.getFullYear() === end.getFullYear();
    return `${format(start, sameYear ? "dd/MM" : "dd/MM/yyyy", { locale: ptBR })} – ${format(end, "dd/MM/yyyy", { locale: ptBR })}`;
}

// ---------------------------------------------------------------------------
// Série temporal: dia → semana → mês conforme o tamanho do intervalo
// ---------------------------------------------------------------------------

export type Bucket = "day" | "week" | "month";

/** Até ~2 meses por dia, até ~6 meses por semana, acima disso por mês. */
export function chooseBucket(range: DateRange): Bucket {
    const days = differenceInCalendarDays(range.end, range.start) + 1;
    if (days <= 62) return "day";
    if (days <= 190) return "week";
    return "month";
}

export interface SeriesPoint {
    /** Início do balde (yyyy-MM-dd) */
    key: string;
    label: string;
    tooltipLabel: string;
    total: number;
    same_day: number;
    other_day: number;
    open: number;
    unanswered: number;
    off_hours: number;
}

const bucketStart = (date: Date, bucket: Bucket): Date =>
    bucket === "day"
        ? startOfDay(date)
        : bucket === "week"
          ? startOfWeek(date, { weekStartsOn: 1 })
          : startOfMonth(date);

const nextBucket = (date: Date, bucket: Bucket): Date =>
    bucket === "day" ? addDays(date, 1) : bucket === "week" ? addWeeks(date, 1) : addMonths(date, 1);

function bucketLabels(start: Date, bucket: Bucket): { label: string; tooltipLabel: string } {
    if (bucket === "day") {
        return {
            label: format(start, "dd/MM", { locale: ptBR }),
            tooltipLabel: format(start, "EEEE, dd 'de' MMMM", { locale: ptBR }),
        };
    }
    if (bucket === "week") {
        return {
            label: format(start, "dd/MM", { locale: ptBR }),
            tooltipLabel: `Semana de ${format(start, "dd 'de' MMMM", { locale: ptBR })}`,
        };
    }
    return {
        label: format(start, "MMM/yy", { locale: ptBR }),
        tooltipLabel: format(start, "MMMM 'de' yyyy", { locale: ptBR }),
    };
}

/**
 * Agrupa a série diária da RPC no balde escolhido, preenchendo com zero os
 * baldes sem atendimento (um dia sem barra precisa aparecer como zero, não
 * sumir do eixo).
 *
 * `from` é o primeiro dia que interessa mostrar: no "Histórico" é a primeira
 * mensagem da linha, não 2020.
 */
export function buildSeries(rows: AttendanceDayRow[], range: DateRange, bucket: Bucket, from?: Date): SeriesPoint[] {
    const first = from && isAfter(from, range.start) ? from : range.start;
    const points = new Map<string, SeriesPoint>();
    for (let cursor = bucketStart(first, bucket); !isAfter(cursor, range.end); cursor = nextBucket(cursor, bucket)) {
        const key = format(cursor, "yyyy-MM-dd");
        points.set(key, {
            key,
            ...bucketLabels(cursor, bucket),
            total: 0,
            same_day: 0,
            other_day: 0,
            open: 0,
            unanswered: 0,
            off_hours: 0,
        });
    }
    for (const row of rows) {
        const key = format(bucketStart(parseISO(row.day), bucket), "yyyy-MM-dd");
        const point = points.get(key);
        // Dia fora do intervalo pedido (não deveria vir da RPC): ignora em vez de inventar balde
        if (!point) continue;
        point.total += row.total;
        point.same_day += row.same_day;
        point.other_day += row.other_day;
        point.open += row.open;
        point.unanswered += row.unanswered;
        point.off_hours += row.off_hours;
    }
    return [...points.values()];
}

/** As 24 horas, inclusive as sem atendimento. */
export function fillHours(rows: AttendanceHourRow[]): AttendanceHourRow[] {
    const byHour = new Map(rows.map((row) => [row.hour, row]));
    return Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? { hour, business_hours: 0, off_hours: 0 });
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

/** "—", "45s", "12min", "2h 05min", "3d 4h". */
export function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
    const total = Math.round(seconds);
    if (total < 60) return `${total}s`;
    const minutes = Math.round(total / 60);
    if (minutes < 60) return `${minutes}min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) {
        const rest = minutes % 60;
        return rest > 0 ? `${hours}h ${String(rest).padStart(2, "0")}min` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
}

/** Tempo acumulado (tempo ativo): sempre em horas, "0h 40min", "74h 30min". */
export function formatHours(seconds: number | null | undefined): string {
    if (!seconds || seconds <= 0) return "0h";
    const minutes = Math.round(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `${rest}min`;
    return rest > 0 ? `${hours}h ${String(rest).padStart(2, "0")}min` : `${hours}h`;
}

/** Percentual inteiro, ou null quando não há base (evita "0%" enganoso). */
export function percent(part: number, total: number): number | null {
    if (!total) return null;
    return Math.round((part / total) * 100);
}

export const formatPercent = (value: number | null): string => (value === null ? "—" : `${value}%`);

export const formatCount = (value: number): string => value.toLocaleString("pt-BR");

export const UNIDENTIFIED_AGENT_LABEL = "Não identificado";

export const agentLabel = (row: { agent_id: string | null; agent_name: string | null }): string =>
    row.agent_id === null ? UNIDENTIFIED_AGENT_LABEL : row.agent_name?.trim() || "Sem nome";

/** Média diária de tempo ativo de uma atendente. */
export const activePerDay = (row: Pick<AttendanceAgentRow, "active_seconds" | "active_days">): number | null =>
    row.active_days > 0 ? row.active_seconds / row.active_days : null;

/**
 * Parcela das mensagens que saiu pelo celular (sem autor no Echo). Acima de
 * metade, os números da atendente dependem de ela ser a responsável pela
 * conversa — a tela avisa.
 */
export const phoneShare = (row: Pick<AttendanceAgentRow, "messages_out" | "messages_out_phone">): number | null =>
    percent(row.messages_out_phone, row.messages_out);

export const PENDING_STATE_LABEL: Record<PendingState, string> = {
    waiting_agent: "Aguardando atendente",
    waiting_client: "Aguardando cliente",
    unanswered: "Sem resposta",
};

// ---------------------------------------------------------------------------
// Planilha
// ---------------------------------------------------------------------------

type Cell = string | number;

export interface AttendanceExportContext {
    lineName: string;
    range: DateRange;
    kindLabel: string;
    agentLabel: string | null;
}

export const AGENT_COLUMNS = [
    "Atendente",
    "Atendimentos",
    "Resolvidos no mesmo dia",
    "% mesmo dia (dos concluídos)",
    "Resolvidos em outro dia",
    "Em aberto",
    "Sem resposta",
    "Iniciados fora do horário",
    "1ª resposta mediana (min)",
    "Duração mediana (h)",
    "Mensagens enviadas",
    "Enviadas fora do horário",
    "Enviadas pelo celular",
    "Tempo ativo (h)",
    "Dias com atividade",
    "Tempo ativo por dia (h)",
] as const;

export const DAY_COLUMNS = [
    "Data",
    "Atendimentos",
    "Resolvidos no mesmo dia",
    "Resolvidos em outro dia",
    "Em aberto",
    "Sem resposta",
    "Iniciados fora do horário",
] as const;

export const SUMMARY_COL_WIDTHS = [34, 22];
export const AGENT_COL_WIDTHS = [30, 13, 14, 11, 14, 10, 12, 14, 14, 13, 14, 14, 14, 12, 12, 14];
export const DAY_COL_WIDTHS = [12, 13, 14, 14, 10, 12, 14];

/** Número com 1 casa, para a planilha somar/filtrar (não string formatada). */
const round1 = (value: number | null | undefined): Cell =>
    value === null || value === undefined ? "" : Math.round(value * 10) / 10;

export function buildAttendanceExport(report: AttendanceReport, ctx: AttendanceExportContext) {
    const s = report.summary;
    const summary: Cell[][] = [
        ["Painel de atendimentos", ctx.lineName],
        ["Período", formatRangeLabel(ctx.range)],
        ["Conversas", ctx.kindLabel],
        ["Atendente", ctx.agentLabel ?? "Todas"],
        ["Gerado em", format(parseISO(report.meta.generated_at), "dd/MM/yyyy HH:mm")],
        [],
        ["Atendimentos", s.total],
        ["Resolvidos no mesmo dia", s.same_day],
        ["Resolvidos em outro dia", s.other_day],
        ["Em aberto", s.open],
        ["Sem resposta", s.unanswered],
        ["Iniciados fora do horário", s.off_hours],
        ["Iniciados pelo cliente", s.started_by_client],
        ["1ª resposta mediana (min, horário comercial)", round1(s.first_response_median_seconds === null ? null : s.first_response_median_seconds / 60)],
        ["Duração mediana (h)", round1(s.duration_median_seconds === null ? null : s.duration_median_seconds / 3600)],
        ["Mensagens recebidas", s.messages_in],
        ["Mensagens enviadas", s.messages_out],
        ["Tempo ativo da equipe (h)", round1(s.active_seconds / 3600)],
        [],
        ["Como medimos"],
        [`Atendimento termina após ${report.meta.idle_hours}h sem mensagens depois da resposta da equipe, ou quando a conversa é encerrada no Echo.`],
        [`Cliente sem nenhuma resposta em ${report.meta.unanswered_hours}h conta como "sem resposta".`],
        [`Horário comercial: ${BUSINESS_HOURS.label} (Brasília).`],
        ["Atendente: quem mais respondeu pelo Echo no atendimento; se respondeu pelo celular, a responsável pela conversa."],
        ["Tempo ativo: estimado pelos intervalos de até 10 min entre mensagens enviadas."],
    ];

    const agents = report.by_agent.map((row) => {
        const values: Cell[] = [
            agentLabel(row),
            row.total,
            row.same_day,
            // mesma base da tela: aberto ainda pode terminar em qualquer dia
            percent(row.same_day, row.same_day + row.other_day) ?? "",
            row.other_day,
            row.open,
            row.unanswered,
            row.off_hours,
            round1(row.first_response_median_seconds === null ? null : row.first_response_median_seconds / 60),
            round1(row.duration_median_seconds === null ? null : row.duration_median_seconds / 3600),
            row.messages_out,
            row.messages_out_off_hours,
            row.messages_out_phone,
            round1(row.active_seconds / 3600),
            row.active_days,
            round1((activePerDay(row) ?? 0) / 3600),
        ];
        return Object.fromEntries(AGENT_COLUMNS.map((col, i) => [col, values[i]])) as Record<(typeof AGENT_COLUMNS)[number], Cell>;
    });

    const days = report.by_day.map((row) => {
        const values: Cell[] = [
            format(parseISO(row.day), "dd/MM/yyyy"),
            row.total,
            row.same_day,
            row.other_day,
            row.open,
            row.unanswered,
            row.off_hours,
        ];
        return Object.fromEntries(DAY_COLUMNS.map((col, i) => [col, values[i]])) as Record<(typeof DAY_COLUMNS)[number], Cell>;
    });

    const slug = ctx.lineName
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase();
    const fileName = `atendimentos-${slug || "linha"}-${format(ctx.range.start, "yyyyMMdd")}-${format(ctx.range.end, "yyyyMMdd")}.xlsx`;

    return { fileName, summary, agents, days };
}
