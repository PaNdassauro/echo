/**
 * `country-flag-icons/string/3x2/<ISO2>` é um subpath do package.json do pacote,
 * mas sem `types` — só o índice tem `.d.ts`. Importar um país isolado é o que
 * mantém a bandeira do Brasil fora do chunk com os outros 264 países, então a
 * declaração entra aqui em vez de trocarmos por um import do índice inteiro.
 */
declare module "country-flag-icons/string/3x2/*" {
    /** Markup do SVG da bandeira. */
    const svg: string;
    export default svg;
}
