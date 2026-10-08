/**
 * @fileoverview Lógica pura do chat estilo WhatsApp Web:
 * agrupamento de bolhas, separadores de data e waveform de áudio.
 * Revisada por testes: chatLogic.test.ts (node:test + tsx).
 */
import type { Message } from '../../types/index.js';

export interface TimelineMsgItem {
  kind: 'msg';
  msg: Message;
  /** Primeira bolha do grupo (leva a cauda) */
  firstInGroup: boolean;
  /** Última bolha do grupo (leva hora + ticks) */
  lastInGroup: boolean;
}

export interface TimelineDateItem {
  kind: 'date';
  key: string;
  label: string;
}

export type TimelineItem = TimelineDateItem | TimelineMsgItem;

/** Janela (segundos) para agrupar mensagens consecutivas do mesmo remetente. */
export const GROUP_WINDOW_SECONDS = 60;

/** Chave local do dia (YYYY-M-D) para comparar datas sem depender de locale. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Rótulo de data estilo WhatsApp: Hoje / Ontem / dd/mm/aaaa */
export function formatDayLabel(timestampSeconds: number, now: Date = new Date()): string {
  const d = new Date(timestampSeconds * 1000);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return 'Hoje';
  if (dayKey(d) === dayKey(yesterday)) return 'Ontem';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/**
 * Intercala separadores de data e calcula os grupos de bolhas.
 * Regras de agrupamento (como no WhatsApp): mesmo remetente, mesmo dia e
 * intervalo <= GROUP_WINDOW_SECONDS; mensagens sem timestamp (criadas
 * localmente) agrupam apenas entre si.
 */
export function buildTimeline(messages: Message[], now: Date = new Date()): TimelineItem[] {
  const items: TimelineItem[] = [];
  let lastDay = '';
  let prevMsg: TimelineMsgItem | null = null;
  let separatorJustInserted = false;

  for (const msg of messages) {
    separatorJustInserted = false;
    if (msg.timestamp) {
      const key = dayKey(new Date(msg.timestamp * 1000));
      if (key !== lastDay) {
        lastDay = key;
        items.push({ kind: 'date', key: `date-${key}`, label: formatDayLabel(msg.timestamp, now) });
        separatorJustInserted = true;
      }
    }

    let firstInGroup = true;
    if (prevMsg && !separatorJustInserted && prevMsg.msg.sender === msg.sender) {
      const a = prevMsg.msg.timestamp;
      const b = msg.timestamp;
      if (a !== undefined && b !== undefined) {
        if (Math.abs(b - a) <= GROUP_WINDOW_SECONDS) firstInGroup = false;
      } else if (a === undefined && b === undefined) {
        firstInGroup = false;
      }
    }

    const item: TimelineMsgItem = { kind: 'msg', msg, firstInGroup, lastInGroup: true };
    if (!firstInGroup && prevMsg) prevMsg.lastInGroup = false;
    items.push(item);
    prevMsg = item;
  }

  return items;
}

/**
 * Reamostra picos de amplitude para N barras normalizadas em 0..1.
 * Valores inválidos (NaN/negativos) contam como 0; sinal todo zero → zeros.
 */
export function waveformBars(peaks: number[], barCount: number): number[] {
  if (barCount <= 0 || peaks.length === 0) return [];
  const clean = peaks.map((p) => (Number.isFinite(p) && p > 0 ? p : 0));

  const buckets: number[] = [];
  for (let i = 0; i < barCount; i++) {
    const start = Math.floor((i * clean.length) / barCount);
    const end = Math.max(start + 1, Math.floor(((i + 1) * clean.length) / barCount));
    let sum = 0;
    let n = 0;
    for (let j = start; j < Math.min(end, clean.length); j++) {
      sum += clean[j];
      n++;
    }
    buckets.push(n > 0 ? sum / n : 0);
  }

  const max = Math.max(...buckets);
  if (max <= 0) return buckets.map(() => 0);
  return buckets.map((b) => b / max);
}

/** Duração m:ss (ex.: 65.2 → "1:05"); arredonda e protege contra negativo. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Sanitiza um MIME para uso em Blob: remove parâmetros (; codecs=…), normaliza caixa. */
export function sanitizeMime(mime?: string | null): string {
  if (!mime) return 'application/octet-stream';
  const base = mime.split(';')[0].trim().toLowerCase();
  return base || 'application/octet-stream';
}

/**
 * Extrai { mime, base64 } de um data URL base64
 * (ex.: "data:audio/ogg; codecs=opus;base64,AAAA").
 * Devolve null quando não é um data URL base64 válido.
 */
export function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  if (!dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma);
  const idx = meta.toLowerCase().lastIndexOf(';base64');
  if (idx < 0) return null;
  const mime = meta.slice(0, idx).trim();
  const base64 = dataUrl.slice(comma + 1);
  if (!mime || !base64) return null;
  return { mime, base64 };
}
