import { z } from "zod";

export const inviteMemberSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Informe o e-mail do membro.")
    .email("Informe um endereço de e-mail válido."),
  phoneNumberIds: z
    .array(z.string().uuid("Número inválido."))
    .min(1, "Selecione pelo menos um número para conceder acesso."),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const createSectorSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Informe o nome do setor.")
    .max(48, "O nome do setor deve ter no máximo 48 caracteres."),
  phoneNumberId: z.string().uuid("Selecione um número válido."),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida.")
    .nullable()
    .optional(),
});

export type CreateSectorInput = z.infer<typeof createSectorSchema>;

export const roleChangeSchema = z.object({
  userId: z.string().uuid("ID de usuário inválido."),
  role: z.enum(["admin", "agent"]),
});

export type RoleChangeInput = z.infer<typeof roleChangeSchema>;
