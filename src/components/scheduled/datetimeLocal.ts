// Helpers de <input type="datetime-local">, compartilhados entre o banner da
// conversa, a lista de agendados e os popovers de agendamento.

export const formatDateTimeLocal = (date: Date | string): string => {
  const d = typeof date === "string" ? new Date(date) : date;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

// Piso de 5 minutos, mais folgado que os 60s do agendador: o input não tem
// segundos, então um valor colado no limite venceria antes do submit chegar.
export const SCHEDULE_MIN_LEAD_MINUTES = 5;

export const getMinScheduleDate = (): string => {
  const min = new Date();
  min.setMinutes(min.getMinutes() + SCHEDULE_MIN_LEAD_MINUTES);
  return formatDateTimeLocal(min);
};
