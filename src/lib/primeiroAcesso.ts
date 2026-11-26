import { z } from "zod";
import { functionUrl, getRuntimeConfig } from "@/lib/runtimeConfig";
import { SENHA_MAXIMA, SENHA_MINIMA } from "@/lib/senha";

/**
 * Primeiro acesso: o cliente da edge `primeiro-acesso` (supabase/functions/primeiro-acesso).
 *
 * - GET  → `{ precisa_setup }`: true só com o código de instalação configurado e
 *   sem nenhum super admin nem organização.
 * - POST → cria o super admin e a organização. Não devolve sessão: quem chama
 *   faz o `signInWithPassword`.
 */

const CHAVE_JA_CONFIGURADO = "echo:precisa_setup=0";

/** Tamanho em pontos de código, como o `length()` do Postgres e o Zod da edge (o `.length` do JS conta emoji como 2). */
export function pontosDeCodigo(texto: string): number {
  return Array.from(texto).length;
}

// Par de `SetupSchema` em supabase/functions/_shared/primeiro-acesso.ts: mudou lá, muda aqui.
export const SetupSchema = z
  .object({
    codigo: z.string().trim().min(1, "Informe o código de instalação.").max(128),
    nome: z.string().trim().min(1, "Informe o seu nome.").max(120, "O nome tem no máximo 120 caracteres."),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Informe um e-mail válido.")
      .max(254, "O e-mail tem no máximo 254 caracteres."),
    senha: z
      .string()
      .min(SENHA_MINIMA, `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`)
      .max(SENHA_MAXIMA, `A senha tem no máximo ${SENHA_MAXIMA} caracteres.`),
    organizacao: z
      .string()
      .trim()
      .refine((v) => pontosDeCodigo(v) >= 2, "O nome da organização precisa ter pelo menos 2 caracteres.")
      .refine((v) => pontosDeCodigo(v) <= 100, "O nome da organização tem no máximo 100 caracteres."),
  })
  .strict();

export type SetupInput = z.infer<typeof SetupSchema>;

const PrecisaSetupSchema = z.object({ precisa_setup: z.boolean() });

const ERROS_DE_SETUP = [
  "payload_invalido",
  "codigo_invalido",
  "setup_desligado",
  "ja_configurado",
  "senha_fraca",
  "email_invalido",
  "email_em_uso",
  "falha_interna",
] as const;

export type ErroSetup = (typeof ERROS_DE_SETUP)[number];

/**
 * `ok` verdadeiro: criado. Senão `erro` diz o quê; "sem_resposta" é a resposta que não chegou ou veio
 * ilegível, e nesse caso a criação pode ter sido concluída.
 */
export interface ResultadoSetup {
  ok: boolean;
  erro?: ErroSetup | "sem_resposta";
}

// Par de `RespostaSetup` na edge. Campos opcionais lidos à mão: o tsconfig do app é `strict: false`,
// que desfaz a união discriminada que o Zod inferiria.
const RespostaSetupSchema = z.object({
  ok: z.boolean(),
  organization_id: z.string().optional(),
  erro: z.enum(ERROS_DE_SETUP).optional(),
});

function lerFlag(): boolean {
  try {
    return sessionStorage.getItem(CHAVE_JA_CONFIGURADO) === "1";
  } catch {
    return false;
  }
}

function guardarFlag(): void {
  try {
    sessionStorage.setItem(CHAVE_JA_CONFIGURADO, "1");
  } catch {
    /* sessionStorage indisponível: só perde o atalho */
  }
}

/** Lembra, nesta aba, que a instalação já foi configurada (poupa o GET a cada visita a `/`). */
export function lembrarInstalacaoConfigurada(): void {
  guardarFlag();
}

/**
 * A instalação ainda precisa do primeiro admin? Falha de rede, 404 (função
 * ausente: caminho Supabase Cloud) e resposta ilegível contam como `false`:
 * na dúvida, a tela de login. Só o 404 é lembrado na sessão (é definitivo);
 * rede e resposta ilegível podem ser passageiras e tentam de novo.
 */
export async function consultarPrecisaSetup(signal?: AbortSignal): Promise<boolean> {
  if (lerFlag()) return false;
  try {
    const resposta = await fetch(functionUrl("primeiro-acesso"), {
      method: "GET",
      headers: { apikey: getRuntimeConfig().supabaseAnonKey },
      signal,
    });
    if (resposta.status === 404) {
      // Função ausente (caminho Supabase Cloud ou hospedagem estática): sem primeiro acesso
      // nesta aba, e não adianta repetir o GET a cada visita.
      guardarFlag();
      return false;
    }
    if (!resposta.ok) return false;
    const corpo = PrecisaSetupSchema.safeParse(await resposta.json());
    if (!corpo.success) return false;
    if (!corpo.data.precisa_setup) guardarFlag();
    return corpo.data.precisa_setup;
  } catch {
    return false;
  }
}

/** Envia o formulário. Nunca lança: o resultado diz o que mostrar. */
export async function enviarSetup(entrada: SetupInput): Promise<ResultadoSetup> {
  let resposta: Response;
  try {
    resposta = await fetch(functionUrl("primeiro-acesso"), {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: getRuntimeConfig().supabaseAnonKey },
      body: JSON.stringify(entrada),
    });
  } catch (erro) {
    console.error("[setup] a requisição não completou:", erro);
    return { ok: false, erro: "sem_resposta" };
  }

  let corpo: unknown;
  try {
    corpo = await resposta.json();
  } catch {
    console.error(`[setup] resposta sem JSON (HTTP ${resposta.status})`);
    return { ok: false, erro: "sem_resposta" };
  }

  const lido = RespostaSetupSchema.safeParse(corpo);
  if (!lido.success) {
    console.error(`[setup] resposta fora do contrato (HTTP ${resposta.status})`);
    return { ok: false, erro: "sem_resposta" };
  }
  const { ok, erro } = lido.data;
  if (ok) return { ok: true };
  if (!erro) {
    console.error(`[setup] resposta de erro sem código (HTTP ${resposta.status})`);
    return { ok: false, erro: "sem_resposta" };
  }
  if (erro === "ja_configurado") guardarFlag();
  return { ok: false, erro };
}

/** Texto de tela para cada erro do POST. */
export function mensagemDeErroSetup(erro: ErroSetup | "sem_resposta"): string {
  switch (erro) {
    case "payload_invalido":
      return "Confira os campos e tente de novo.";
    case "codigo_invalido":
      return "Código de instalação inválido. Use o link que o ./install.sh mostrou ou rode ./echo setup-link.";
    case "setup_desligado":
      return "O primeiro acesso está desligado nesta instalação (ECHO_SETUP_TOKEN vazio no .env).";
    case "ja_configurado":
      return "Esta instalação já foi configurada. Entre com sua conta.";
    case "senha_fraca":
      return `A senha foi recusada por ser fraca. Escolha outra, com pelo menos ${SENHA_MINIMA} caracteres.`;
    case "email_invalido":
      return "Informe um e-mail válido.";
    case "email_em_uso":
      return "Este e-mail já tem uma conta, com outra senha. Use outro e-mail.";
    case "falha_interna":
      return "Não foi possível concluir a configuração. Tente de novo; se persistir, veja os logs com ./echo logs functions.";
    case "sem_resposta":
      return "A conexão falhou e a configuração pode ter sido concluída. Tente entrar em /auth com o e-mail e a senha que você definiu; se não entrar, envie o formulário de novo.";
  }
}
