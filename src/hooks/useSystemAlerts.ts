import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { SystemAlert, SystemAlertSchema, UseSystemAlertsReturn } from '@/types/system-alerts';
import { z } from 'zod';

const SEVERITY_PRIORITY: Record<string, number> = {
  critical: 3,
  warning: 2,
  normal: 1,
};

export function useSystemAlerts(): UseSystemAlertsReturn {
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const fetchAlerts = useCallback(async () => {
    try {
      const { data, error: fetchError } = await supabase
        .from('system_alerts')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;

      if (!isMountedRef.current) return;

      // Filter expired alerts client-side (Supabase doesn't support now() in .or())
      const now = new Date().toISOString();
      const activeData = (data || []).filter(
        (alert) => !alert.expires_at || alert.expires_at > now
      );

      const validatedAlerts = z.array(SystemAlertSchema).safeParse(activeData);

      if (validatedAlerts.success) {
        setAlerts(validatedAlerts.data);
        setError(null);
      } else {
        console.error('[useSystemAlerts] Validation error:', validatedAlerts.error);
        setAlerts([]);
      }
    } catch (err) {
      console.error('[useSystemAlerts] Fetch error:', err);
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Erro ao carregar alertas');
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    fetchAlerts();

    const channel = supabase
      .channel('system-alerts-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'system_alerts',
        },
        () => {
          fetchAlerts();
        }
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[useSystemAlerts] Channel error, refetching...');
          fetchAlerts();
        }
      });

    return () => {
      isMountedRef.current = false;
      supabase.removeChannel(channel);
    };
  }, [fetchAlerts]);

  // Get highest priority active alert
  const activeAlert =
    alerts.length > 0
      ? alerts.reduce((highest, current) => {
          const currentPriority = SEVERITY_PRIORITY[current.severity] || 0;
          const highestPriority = SEVERITY_PRIORITY[highest.severity] || 0;
          return currentPriority > highestPriority ? current : highest;
        })
      : null;

  return {
    alerts,
    activeAlert,
    isLoading,
    error,
    refetch: fetchAlerts,
  };
}
