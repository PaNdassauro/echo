/**
 * Linhas Instagram (Configurações > Números > Instagram).
 *
 * O Instagram é um tipo de conexão próprio e conta como outra linha, mas divide
 * a caixa com uma linha QR/API: as conversas do Direct ficam gravadas nela.
 * O registro é instagram_connections; a tela lê pela RPC instagram_listar_conexoes
 * (sem token) e mexe pelas RPCs instagram_configurar_conexao / instagram_desconectar.
 */
import { z } from "zod";

export const instagramConexaoSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  display_name: z.string(),
  ig_user_id: z.string(),
  ig_username: z.string().nullable(),
  status: z.string(),
  last_error: z.string().nullable(),
  token_expires_at: z.string().nullable(),
  connected_at: z.string().nullable(),
  ligada: z.boolean(),
  modo: z.enum(["off", "on"]),
  linha_id: z.string().uuid(),
  linha_nome: z.string(),
  linha_tipo: z.string(),
  conversas_so_direct: z.coerce.number(),
  cards_juntados: z.coerce.number(),
  pode_gerenciar: z.boolean(),
});

export type InstagramConexao = z.infer<typeof instagramConexaoSchema>;

export const instagramConexoesSchema = z.array(instagramConexaoSchema);

/** Resposta da função instagram-conexao (início do login do Instagram). */
export const linkDeConexaoSchema = z.object({ url: z.string().url() });

/** Tipos de linha que podem dividir a caixa com o Direct. Par de instagram_linha_pode_hospedar(). */
export function linhaPodeHospedar(tipo: string | null | undefined): boolean {
  return ["qr", "business_api", "business", "official"].includes(tipo ?? "business_api");
}

/** Linha QR/API → nome da conta Instagram que divide a caixa com ela (só as ligadas). */
export function mapaInstagramPorLinha(
  conexoes: readonly Pick<InstagramConexao, "linha_id" | "display_name" | "ligada">[] | undefined,
): Map<string, string> {
  return new Map((conexoes ?? []).filter((c) => c.ligada).map((c) => [c.linha_id, c.display_name]));
}

export function rotuloDoTipoDeLinha(tipo: string | null | undefined): string {
  return tipo === "qr" ? "QR Code" : "Business API";
}

const DIA_MS = 24 * 60 * 60 * 1000;

export type SituacaoDoToken =
  | { tipo: "sem-data" }
  | { tipo: "vencido" }
  | { tipo: "perto"; dias: number }
  | { tipo: "ok"; dias: number };

/** Quanto falta para o token vencer. Abaixo de 10 dias a rotina já tenta renovar. */
export function situacaoDoToken(expiraEm: string | null, agoraMs = Date.now()): SituacaoDoToken {
  if (!expiraEm) return { tipo: "sem-data" };
  const vence = Date.parse(expiraEm);
  if (!Number.isFinite(vence)) return { tipo: "sem-data" };
  const faltam = vence - agoraMs;
  if (faltam <= 0) return { tipo: "vencido" };
  const dias = Math.ceil(faltam / DIA_MS);
  return dias <= 10 ? { tipo: "perto", dias } : { tipo: "ok", dias };
}

/** Textos da volta do login do Instagram (?instagram=<código>&conta=<@>). */
export function resultadoDaConexao(
  codigo: string,
  conta: string | null,
): { titulo: string; descricao: string; erro: boolean } | null {
  const arroba = conta ? `@${conta}` : "A conta do Instagram";
  switch (codigo) {
    case "ok":
      return { titulo: "Instagram conectado", descricao: `${arroba} está conectada. Ligue a linha para o Direct entrar na caixa.`, erro: false };
    case "sem-avisos":
      return { titulo: "Conectado, mas sem avisos", descricao: `${arroba} foi conectada, mas o Instagram não aceitou mandar os avisos de mensagem.`, erro: true };
    case "cancelado":
      return { titulo: "Conexão cancelada", descricao: "A autorização do Instagram não foi concedida. Nada foi alterado.", erro: true };
    case "link-invalido":
      return { titulo: "Link vencido", descricao: "O link de conexão vale 30 minutos. Tente conectar de novo.", erro: true };
    case "indisponivel":
      return { titulo: "Conexão indisponível", descricao: "O servidor ainda não tem os dados do app do Instagram.", erro: true };
    case "linha":
      return { titulo: "Linha inválida", descricao: "A linha escolhida não existe mais ou não pode receber o Direct.", erro: true };
    case "recusado":
      return { titulo: "Não deu para conectar", descricao: "O Instagram recusou a autorização. Nada foi alterado.", erro: true };
    case "outra-linha":
      return { titulo: "Conta já conectada", descricao: `${arroba} já divide a caixa com outra linha do Echo.`, erro: true };
    case "linha-ocupada":
      return { titulo: "Linha ocupada", descricao: "Essa linha já divide a caixa com outra conta do Instagram.", erro: true };
    case "erro":
      return { titulo: "Não deu para conectar", descricao: "O Echo não conseguiu guardar a conexão. Tente de novo.", erro: true };
    default:
      return null;
  }
}

/** Mensagem das RPCs ('Instagram: …') sem o prefixo técnico. */
export function mensagemDoInstagram(error: unknown, padrao: string): string {
  const texto = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "";
  return texto.startsWith("Instagram: ") ? texto.slice("Instagram: ".length) : padrao;
}

/**
 * O que o admin lê no card no lugar do last_error cru (que junta notas do Meta
 * com ' | '). A primeira nota conhecida decide o texto; o cru fica no detalhe.
 */
export function textoDoErroDaConexao(ultimoErro: string | null): string | null {
  if (!ultimoErro) return null;
  if (ultimoErro.includes("renovação do token:")) {
    const prazo = /antes de (\d{4})-(\d{2})-(\d{2})/.exec(ultimoErro);
    const ate = prazo ? ` até ${prazo[3]}/${prazo[2]}/${prazo[1]}` : "";
    return `O Echo não conseguiu renovar o acesso ao Instagram. Reconecte a conta${ate}.`;
  }
  if (ultimoErro.includes("assinatura dos avisos:")) {
    return "O Instagram não aceitou mandar os avisos de mensagem. Reconecte a conta.";
  }
  if (ultimoErro.includes("token longo recusado")) {
    return "A conta ficou com um acesso de 1 hora. Reconecte para ter o acesso de 60 dias.";
  }
  return "A conexão com o Instagram teve um erro. Reconecte a conta.";
}
