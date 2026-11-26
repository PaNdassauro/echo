/**
 * Foto do próprio número para o diálogo "Perfil do WhatsApp" do Echo.
 *
 * O Echo só carrega imagem do próprio Supabase, de `data:` e de `blob:` (CSP img-src).
 * A URL do CDN do WhatsApp (pps.whatsapp.net) nunca abria na tela: o diálogo mostrava
 * o boneco vazio em todas as linhas, mesmo com foto. Por isso o serviço
 * baixa a foto e devolve como data URL.
 */
export async function ownPictureDataUrl(
    remoteUrl: string | null,
    download: (url: string) => Promise<Buffer | null>,
): Promise<string | null> {
    if (!remoteUrl) return null;
    const image = await download(remoteUrl);
    if (!image || image.length === 0) return null;
    return `data:image/jpeg;base64,${image.toString('base64')}`;
}
