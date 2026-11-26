import {
    AGENT_COLUMNS,
    AGENT_COL_WIDTHS,
    DAY_COLUMNS,
    DAY_COL_WIDTHS,
    SUMMARY_COL_WIDTHS,
    buildAttendanceExport,
    type AttendanceExportContext,
    type AttendanceReport,
} from "@/lib/attendanceReport";

/**
 * Painel de atendimentos → .xlsx. O `xlsx` entra por `await import` pelo mesmo
 * motivo de conversationExportClient: ~900 KB que não precisam pesar no chunk
 * da página até alguém clicar em exportar.
 *
 * Exporta o que está na tela (o relatório já carregado), sem nova consulta: a
 * planilha é para cruzar com vendas/faturamento por atendente.
 */
export async function exportAttendanceToXlsx(report: AttendanceReport, ctx: AttendanceExportContext): Promise<string> {
    const sheets = buildAttendanceExport(report, ctx);
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();

    const wsSummary = XLSX.utils.aoa_to_sheet(sheets.summary);
    wsSummary["!cols"] = SUMMARY_COL_WIDTHS.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, wsSummary, "Resumo");

    const wsAgents = XLSX.utils.json_to_sheet(sheets.agents, { header: [...AGENT_COLUMNS] });
    wsAgents["!cols"] = AGENT_COL_WIDTHS.map((wch) => ({ wch }));
    wsAgents["!autofilter"] = { ref: wsAgents["!ref"] as string };
    XLSX.utils.book_append_sheet(wb, wsAgents, "Por atendente");

    const wsDays = XLSX.utils.json_to_sheet(sheets.days, { header: [...DAY_COLUMNS] });
    wsDays["!cols"] = DAY_COL_WIDTHS.map((wch) => ({ wch }));
    wsDays["!autofilter"] = { ref: wsDays["!ref"] as string };
    XLSX.utils.book_append_sheet(wb, wsDays, "Por dia");

    XLSX.writeFile(wb, sheets.fileName);
    return sheets.fileName;
}
