import { describe, expect, it } from "vitest";
import {
    activePerDay,
    agentLabel,
    buildAttendanceExport,
    buildSeries,
    chooseBucket,
    fillHours,
    formatDuration,
    formatHours,
    formatRangeLabel,
    percent,
    phoneShare,
    resolvePeriod,
    AGENT_COLUMNS,
    DEFAULT_PERIOD,
    HISTORY_START,
    dateFromParam,
    dateToParam,
    kindFromParam,
    kindToParam,
    periodFromParam,
    periodToParam,
    pickLine,
    type AttendanceReport,
} from "./attendanceReport";

// Terça-feira, 13/10/2026 15:30 (hora local do teste)
const NOW = new Date(2026, 9, 13, 15, 30);

describe("resolvePeriod", () => {
    it("hoje vai da meia-noite ao fim do dia", () => {
        const { start, end } = resolvePeriod("today", NOW);
        expect(start).toEqual(new Date(2026, 9, 13, 0, 0, 0, 0));
        expect(end).toEqual(new Date(2026, 9, 13, 23, 59, 59, 999));
    });

    it("semana começa na segunda", () => {
        expect(resolvePeriod("week", NOW).start).toEqual(new Date(2026, 9, 12));
    });

    it("domingo ainda é a semana que começou na segunda anterior", () => {
        const sunday = new Date(2026, 9, 18, 10);
        expect(resolvePeriod("week", sunday).start).toEqual(new Date(2026, 9, 12));
    });

    it("mês começa no dia 1", () => {
        expect(resolvePeriod("month", NOW).start).toEqual(new Date(2026, 9, 1));
    });

    it("histórico começa antes de qualquer mensagem", () => {
        expect(resolvePeriod("all", NOW).start).toEqual(HISTORY_START);
    });

    it("personalizado cobre os dias inteiros e aceita seleção invertida", () => {
        const range = resolvePeriod("custom", NOW, {
            start: new Date(2026, 9, 10, 14),
            end: new Date(2026, 9, 3, 9),
        });
        expect(range.start).toEqual(new Date(2026, 9, 3));
        expect(range.end).toEqual(new Date(2026, 9, 10, 23, 59, 59, 999));
    });

    it("personalizado com um dia só vira aquele dia", () => {
        const range = resolvePeriod("custom", NOW, { start: new Date(2026, 9, 5, 11) });
        expect(range.start).toEqual(new Date(2026, 9, 5));
        expect(range.end).toEqual(new Date(2026, 9, 5, 23, 59, 59, 999));
    });
});

describe("estado na URL", () => {
    it("período ida e volta, e valor desconhecido cai no padrão", () => {
        expect(periodFromParam(periodToParam("month"))).toBe("month");
        expect(periodFromParam("historico")).toBe("all");
        expect(periodFromParam("ontem")).toBe(DEFAULT_PERIOD);
        expect(periodFromParam(null)).toBe(DEFAULT_PERIOD);
    });

    it("tipo de conversa: 'todas' não polui a URL", () => {
        expect(kindToParam("all")).toBeNull();
        expect(kindFromParam(kindToParam("group"))).toBe("group");
        expect(kindFromParam("xpto")).toBe("all");
    });

    it("datas da URL", () => {
        expect(dateFromParam("2026-10-05")).toEqual(new Date(2026, 9, 5));
        expect(dateFromParam("05/10/2026")).toBeNull();
        expect(dateFromParam("2026-13-45")).toBeNull();
        expect(dateToParam(new Date(2026, 9, 5, 18))).toBe("2026-10-05");
    });

    it("linha: a do link, senão a primeira", () => {
        const lines = [
            { id: "a", label: "Vendas" },
            { id: "b", label: "Suporte" },
            { id: "c", label: "Financeiro" },
        ];
        expect(pickLine(lines, "c")?.id).toBe("c");
        expect(pickLine(lines, "inexistente")?.id).toBe("a");
        expect(pickLine([lines[1], lines[2]], null)?.id).toBe("b");
        expect(pickLine([], null)).toBeNull();
    });
});

describe("formatRangeLabel", () => {
    it("um dia mostra só a data", () => {
        expect(formatRangeLabel(resolvePeriod("today", NOW))).toBe("13/10/2026");
    });

    it("intervalo no mesmo ano não repete o ano no início", () => {
        expect(formatRangeLabel(resolvePeriod("month", NOW))).toBe("01/10 – 13/10/2026");
    });
});

describe("chooseBucket", () => {
    it("até 62 dias por dia", () => {
        expect(chooseBucket({ start: new Date(2026, 7, 13), end: new Date(2026, 9, 13) })).toBe("day");
    });
    it("até ~6 meses por semana", () => {
        expect(chooseBucket({ start: new Date(2026, 5, 1), end: new Date(2026, 9, 13) })).toBe("week");
    });
    it("acima disso por mês", () => {
        expect(chooseBucket({ start: new Date(2026, 1, 11), end: new Date(2026, 9, 13) })).toBe("month");
    });
});

const day = (d: string, total: number, extra: Partial<Record<"same_day" | "other_day" | "open" | "unanswered" | "off_hours", number>> = {}) => ({
    day: d,
    total,
    same_day: 0,
    other_day: 0,
    open: 0,
    unanswered: 0,
    off_hours: 0,
    ...extra,
});

describe("buildSeries", () => {
    it("preenche dias sem atendimento com zero e para em hoje", () => {
        const range = resolvePeriod("week", NOW); // seg 12 → hoje, ter 13
        const series = buildSeries(
            [day("2026-10-08", 9), day("2026-10-13", 5, { same_day: 3 })],
            { ...range, start: new Date(2026, 9, 9) },
            "day",
        );
        expect(series.map((p) => p.key)).toEqual(["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]);
        expect(series[0].total).toBe(0);
        expect(series[4]).toMatchObject({ total: 5, same_day: 3, label: "13/10" });
    });

    it("soma os dias da mesma semana", () => {
        const range = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 13, 23, 59) };
        const series = buildSeries(
            [day("2026-10-05", 2, { off_hours: 1 }), day("2026-10-09", 3), day("2026-10-12", 4)],
            range,
            "week",
        );
        // semanas que começam em 28/09, 05/10 e 12/10
        expect(series.map((p) => [p.key, p.total, p.off_hours])).toEqual([
            ["2026-09-28", 0, 0],
            ["2026-10-05", 5, 1],
            ["2026-10-12", 4, 0],
        ]);
    });

    it("no histórico começa na primeira mensagem, não em 2020", () => {
        const range = resolvePeriod("all", NOW);
        const series = buildSeries([day("2026-02-11", 7)], range, "month", new Date(2026, 1, 11));
        expect(series[0]).toMatchObject({ key: "2026-02-01", total: 7 });
        expect(series).toHaveLength(9); // fev → out
    });
});

describe("fillHours", () => {
    it("devolve as 24 horas em ordem", () => {
        const hours = fillHours([{ hour: 19, business_hours: 0, off_hours: 4 }]);
        expect(hours).toHaveLength(24);
        expect(hours[0]).toEqual({ hour: 0, business_hours: 0, off_hours: 0 });
        expect(hours[19].off_hours).toBe(4);
    });
});

describe("formatação", () => {
    it.each([
        [null, "—"],
        [-5, "—"],
        [45, "45s"],
        [657, "11min"],
        [3600, "1h"],
        [8812, "2h 27min"],
        [3 * 86400 + 4 * 3600, "3d 4h"],
    ])("formatDuration(%s) = %s", (seconds, expected) => {
        expect(formatDuration(seconds)).toBe(expected);
    });

    it("formatHours acumula em horas, sem virar dias", () => {
        expect(formatHours(268171)).toBe("74h 30min");
        expect(formatHours(2400)).toBe("40min");
        expect(formatHours(0)).toBe("0h");
    });

    it("percent sem base é null, não 0", () => {
        expect(percent(3, 0)).toBeNull();
        expect(percent(327, 481)).toBe(68);
    });

    it("agentLabel distingue não identificado de sem nome", () => {
        expect(agentLabel({ agent_id: null, agent_name: null })).toBe("Não identificado");
        expect(agentLabel({ agent_id: "x", agent_name: " " })).toBe("Sem nome");
        expect(agentLabel({ agent_id: "x", agent_name: "Ana Souza" })).toBe("Ana Souza");
    });

    it("tempo ativo por dia e parcela pelo celular", () => {
        expect(activePerDay({ active_seconds: 7200, active_days: 2 })).toBe(3600);
        expect(activePerDay({ active_seconds: 0, active_days: 0 })).toBeNull();
        expect(phoneShare({ messages_out: 625, messages_out_phone: 611 })).toBe(98);
    });
});

const report: AttendanceReport = {
    summary: {
        total: 481, same_day: 327, other_day: 125, open: 13, waiting_agent: 10, waiting_client: 3,
        unanswered: 16, off_hours: 79, started_by_client: 274, messages_in: 6056, messages_out: 5688,
        messages_out_phone: 1453, messages_per_attendance_avg: 23.4, first_response_median_seconds: 657,
        first_response_p90_seconds: 3415, duration_median_seconds: 8812, active_seconds: 506998,
    },
    by_agent: [
        {
            agent_id: "f85e", agent_name: "Ana Souza", total: 233, same_day: 169, other_day: 55, open: 6,
            unanswered: 3, off_hours: 35, first_response_median_seconds: 650, duration_median_seconds: 9039,
            messages_out: 2928, messages_out_off_hours: 604, messages_out_phone: 114,
            active_seconds: 268171, active_days: 28,
        },
        {
            agent_id: null, agent_name: null, total: 44, same_day: 25, other_day: 7, open: 2, unanswered: 10,
            off_hours: 11, first_response_median_seconds: null, duration_median_seconds: 2915,
            messages_out: 211, messages_out_off_hours: 21, messages_out_phone: 211, active_seconds: 12070, active_days: 19,
        },
    ],
    by_day: [day("2026-10-13", 9, { open: 9, off_hours: 2 })],
    by_hour: [],
    pending: [],
    meta: { generated_at: "2026-10-13T14:44:26Z", idle_hours: 24, unanswered_hours: 72, first_message_at: "2026-02-11T13:14:46Z" },
};

describe("buildAttendanceExport", () => {
    const ctx = {
        lineName: "Comercial",
        range: resolvePeriod("month", NOW),
        kindLabel: "Todas",
        agentLabel: null,
    };

    it("uma linha por atendente, com números de verdade (não texto) para a planilha somar", () => {
        const { agents } = buildAttendanceExport(report, ctx);
        expect(agents).toHaveLength(2);
        expect(Object.keys(agents[0])).toEqual([...AGENT_COLUMNS]);
        expect(agents[0]).toMatchObject({
            Atendente: "Ana Souza",
            Atendimentos: 233,
            "% mesmo dia (dos concluídos)": 75, // 169 / (169 + 55), não sobre os 233
            "1ª resposta mediana (min)": 10.8,
            "Tempo ativo (h)": 74.5,
            "Tempo ativo por dia (h)": 2.7,
        });
        expect(agents[1]).toMatchObject({ Atendente: "Não identificado", "1ª resposta mediana (min)": "" });
    });

    it("dias com data brasileira", () => {
        const { days } = buildAttendanceExport(report, ctx);
        expect(days[0]).toMatchObject({ Data: "13/10/2026", Atendimentos: 9, "Em aberto": 9 });
    });

    it("nome do arquivo sem acento nem espaço", () => {
        const { fileName } = buildAttendanceExport(report, { ...ctx, lineName: "Atendimento ao Cliente" });
        expect(fileName).toBe("atendimentos-atendimento-ao-cliente-20261001-20261013.xlsx");
    });

    it("resumo traz o filtro de atendente e a regra de medição", () => {
        const { summary } = buildAttendanceExport(report, { ...ctx, agentLabel: "Ana Souza" });
        expect(summary).toContainEqual(["Atendente", "Ana Souza"]);
        expect(summary.flat().join(" ")).toContain("24h sem mensagens");
    });
});
