/**
 * Tamanho de arquivo legível. `null` quando não há tamanho conhecido (0, null ou
 * undefined) — o chamador omite a linha em vez de mostrar "0 B", que só ocupa
 * espaço sem informar nada.
 *
 * A lógica existe duplicada em NodePropertiesPanel, StickerPicker e ChatArea;
 * esta é a versão extraída, consumida pela galeria de mídia.
 */
export function formatBytes(bytes: number | null | undefined): string | null {
    if (bytes === null || bytes === undefined || bytes <= 0) return null;

    if (bytes < 1024) return `${bytes} B`;

    // pt-BR usa vírgula decimal — toFixed devolve ponto.
    const format = (value: number) => value.toFixed(1).replace(".", ",");

    if (bytes < 1024 * 1024) return `${format(bytes / 1024)} KB`;
    return `${format(bytes / (1024 * 1024))} MB`;
}
