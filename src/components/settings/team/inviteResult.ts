import { z } from "zod";

/**
 * Resposta da edge `send-invitation` e o que a tela de convite faz com ela.
 *
 * `email` diz o que aconteceu com o envio: "enviado", "nao_configurado" (a
 * instalação não tem e-mail: o caminho padrão de quem se auto-hospeda) ou
 * "falhou". Edge anterior a esse campo só manda `emailSent`.
 */
export type EstadoEmailConvite = "enviado" | "nao_configurado" | "falhou";

export const SendInviteResponseSchema = z
  .object({
    existingUser: z.boolean().optional(),
    emailSent: z.boolean().optional(),
    email: z.enum(["enviado", "nao_configurado", "falhou"]).optional(),
    invitation: z
      .object({
        inviteUrl: z.string().min(1).optional(),
        phoneNumberName: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type SendInviteResponse = z.infer<typeof SendInviteResponseSchema>;

export interface ConviteCriado {
  phoneNumberId: string;
  phoneNumberName: string;
  url: string;
  email: EstadoEmailConvite;
}

export interface ResultadoConvites {
  /** Números a que uma pessoa que já tinha conta recebeu acesso na hora. */
  vinculados: number;
  /** Convites novos: cada um tem um link para entregar à pessoa. */
  criados: ConviteCriado[];
}

export function estadoDoEmail(resposta: SendInviteResponse): EstadoEmailConvite {
  return resposta.email ?? (resposta.emailSent ? "enviado" : "falhou");
}

/** Texto que explica o que aconteceu com o e-mail e o que fazer com o(s) link(s). */
export function textoDoEnvio(email: string, criados: readonly ConviteCriado[]): string {
  const naoEnviados = criados.filter((c) => c.email !== "enviado");
  if (naoEnviados.length === 0) {
    return `Enviamos o convite para ${email}. Os links abaixo também valem, se precisar mandar por outro canal.`;
  }
  const plural = criados.length > 1 ? "os links" : "o link";
  if (naoEnviados.every((c) => c.email === "nao_configurado")) {
    return `Esta instalação não envia e-mail. Copie ${plural} abaixo e mande para ${email}.`;
  }
  return `Não foi possível enviar o e-mail. Copie ${plural} abaixo e mande para ${email}.`;
}
