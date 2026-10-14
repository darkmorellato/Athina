/**
 * @fileoverview Horário de atendimento dos especialistas (fuso de Brasília).
 *
 * Seg–sex: 08:00–20:00 · Sáb: 09:00–18:00 · Dom: fechado.
 * Feriados não são considerados.
 */
const TIME_ZONE = 'America/Sao_Paulo';

const OPEN_MINUTES: Record<string, [number, number] | null> = {
  Mon: [8 * 60, 20 * 60],
  Tue: [8 * 60, 20 * 60],
  Wed: [8 * 60, 20 * 60],
  Thu: [8 * 60, 20 * 60],
  Fri: [8 * 60, 20 * 60],
  Sat: [9 * 60, 18 * 60],
  Sun: null,
};

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** True quando os especialistas estão em expediente no instante informado. */
export function isWithinBusinessHours(at: Date = new Date()): boolean {
  const parts = formatter.formatToParts(at);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const window = OPEN_MINUTES[weekday];
  if (!window) return false;
  const now = hour * 60 + minute;
  return now >= window[0] && now < window[1];
}

/** Texto curto com os horários, para a mensagem ao cliente. */
export const BUSINESS_HOURS_LABEL = 'seg. a sex. das 8h às 20h e sáb. das 9h às 18h';
