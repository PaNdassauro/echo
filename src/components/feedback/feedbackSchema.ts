import { z } from "zod";

export const FeedbackType = z.enum(["support", "bug", "feature", "other"]);

export type FeedbackTypeValue = z.infer<typeof FeedbackType>;

export const feedbackSchema = z.object({
  type: FeedbackType,
  title: z
    .string()
    .min(3, "O título deve ter pelo menos 3 caracteres")
    .max(100, "O título é muito longo (máximo 100 caracteres)"),
  details: z
    .string()
    .min(10, "Descreva com pelo menos 10 caracteres")
    .max(1000, "O texto é muito longo (máximo 1000 caracteres)"),
});

export type FeedbackFormData = z.infer<typeof feedbackSchema>;

export const feedbackTypeLabels: Record<FeedbackTypeValue, string> = {
  support: "Suporte",
  bug: "Relatar um problema",
  feature: "Pedido de função",
  other: "Outro",
};
