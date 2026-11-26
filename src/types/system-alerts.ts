import { z } from 'zod';

export const SystemAlertSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(['normal', 'warning', 'critical']),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().nullable(),
});

export type SystemAlert = z.infer<typeof SystemAlertSchema>;
export type AlertSeverity = 'normal' | 'warning' | 'critical';

export interface UseSystemAlertsReturn {
  alerts: SystemAlert[];
  activeAlert: SystemAlert | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}
