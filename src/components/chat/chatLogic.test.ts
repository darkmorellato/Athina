 
/**
 * @fileoverview TDD da lógica pura do chat estilo WhatsApp Web:
 * agrupamento de bolhas, separadores de data e waveform de áudio.
 *
 * Rodar: npm test (Vitest)
 */
import { test, expect } from 'vitest';
import type { Message } from '../../types/index.js';
import {
  GROUP_WINDOW_SECONDS,
  buildTimeline,
  formatDayLabel,
  formatDuration,
  parseDataUrl,
  sanitizeMime,
  waveformBars,
  type TimelineMsgItem,
} from './chatLogic.js';

/** Cria mensagem de teste com defaults preenchidos. */
function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    text: `msg-${id}`,
    sender: 'customer',
    fromId: 'cliente@c.us',
    time: '10:00',
    ...overrides,
  };
}

// "Agora" fixo: 09/10/2026 15:00 (hora local) — determinismo nos rótulos.
const NOW = new Date(2026, 9, 9, 15, 0, 0);
/** Timestamp (segundos) para outubro/2026, dia <d> <h>:<m>:<s> local. */
const ts = (d: number, h: number, m: number, s = 0): number =>
  Math.floor(new Date(2026, 9, d, h, m, s).getTime() / 1000);

const msgItems = (items: ReturnType<typeof buildTimeline>): TimelineMsgItem[] =>
  items.filter((i): i is TimelineMsgItem => i.kind === 'msg');

// ---------- formatDayLabel ----------

test('formatDayLabel: Hoje, Ontem e data completa dd/mm/aaaa', () => {
  expect(formatDayLabel(ts(9, 10, 0), NOW)).toBe('Hoje');
  expect(formatDayLabel(ts(8, 23, 30), NOW)).toBe('Ontem');
  expect(formatDayLabel(ts(1, 9, 0), NOW)).toBe('01/10/2026');
});

// ---------- buildTimeline: agrupamento ----------

test('buildTimeline: mesmo remetente em <=60s agrupa (cauda na 1ª, meta na última)', () => {
  const items = msgItems(
    buildTimeline(
      [msg('1', { timestamp: ts(9, 10, 0, 0) }), msg('2', { timestamp: ts(9, 10, 0, 30) })],
      NOW
    )
  );
  expect(items.length).toBe(2);
  expect([items[0].firstInGroup, items[0].lastInGroup]).toEqual([true, false]);
  expect([items[1].firstInGroup, items[1].lastInGroup]).toEqual([false, true]);
});

test('buildTimeline: intervalo maior que a janela separa grupos', () => {
  const items = msgItems(
    buildTimeline(
      [
        msg('1', { timestamp: ts(9, 10, 0, 0) }),
        msg('2', { timestamp: ts(9, 10, 0, 0) + GROUP_WINDOW_SECONDS + 1 }),
      ],
      NOW
    )
  );
  expect(items.map((i) => [i.firstInGroup, i.lastInGroup])).toEqual([
    [true, true],
    [true, true],
  ]);
});

test('buildTimeline: remetentes diferentes nunca agrupam', () => {
  const items = msgItems(
    buildTimeline(
      [
        msg('1', { timestamp: ts(9, 9, 0, 55) }),
        msg('2', { sender: 'agent', timestamp: ts(9, 9, 0, 59) }),
        msg('3', { timestamp: ts(9, 9, 1, 2) }),
      ],
      NOW
    )
  );
  expect(items.map((i) => [i.firstInGroup, i.lastInGroup])).toEqual([
    [true, true],
    [true, true],
    [true, true],
  ]);
});

test('buildTimeline: virada de dia não agrupa (separador no meio)', () => {
  const items = buildTimeline(
    [msg('1', { timestamp: ts(8, 23, 59, 50) }), msg('2', { timestamp: ts(9, 0, 0, 10) })],
    NOW
  );
  // Cada dia abre com seu próprio separador; o de msg2 fica ENTRE as duas.
  expect(items.filter((i) => i.kind === 'date').length).toBe(2);
  const idx1 = items.findIndex((i) => i.kind === 'msg' && i.msg.id === '1');
  const idx2 = items.findIndex((i) => i.kind === 'msg' && i.msg.id === '2');
  expect(items.slice(idx1 + 1, idx2).some((i) => i.kind === 'date')).toBe(true);
  expect(msgItems(items).map((i) => [i.firstInGroup, i.lastInGroup])).toEqual([
    [true, true],
    [true, true],
  ]);
});

test('buildTimeline: sem timestamp agrupa entre si, mas não com mensagem com timestamp', () => {
  const items = msgItems(
    buildTimeline([msg('1', { timestamp: ts(9, 10, 0, 0) }), msg('2'), msg('3')], NOW)
  );
  expect(items.map((i) => [i.firstInGroup, i.lastInGroup])).toEqual([
    [true, true],
    [true, false],
    [false, true],
  ]);
});

test('buildTimeline: sem timestamp não gera separador de data', () => {
  const items = buildTimeline([msg('1')], NOW);
  expect(items.map((i) => i.kind)).toEqual(['msg']);
});

test('buildTimeline: um separador por dia, com rótulo localizado e chave única', () => {
  const items = buildTimeline(
    [
      msg('1', { timestamp: ts(8, 23, 0, 0) }),
      msg('2', { timestamp: ts(8, 23, 5, 0) }),
      msg('3', { timestamp: ts(9, 8, 0, 0) }),
    ],
    NOW
  );
  expect(items.map((i) => (i.kind === 'date' ? `date:${i.label}` : `msg:${i.msg.id}`))).toEqual([
    'date:Ontem',
    'msg:1',
    'msg:2',
    'date:Hoje',
    'msg:3',
  ]);
  const dateKeys = items.filter((i) => i.kind === 'date').map((i) => i.key);
  expect(dateKeys.length).toBe(2);
  expect(dateKeys.every((k) => k.length > 0)).toBe(true);
  expect(new Set(dateKeys).size).toBe(dateKeys.length);
});

// ---------- waveformBars ----------

test('waveformBars: reamostra para N barras normalizadas (0..1)', () => {
  expect(waveformBars([0, 0, 10, 10], 2)).toEqual([0, 1]);
  const ramp = waveformBars([1, 2, 3, 4, 5, 6, 7, 8], 4);
  expect(ramp.length).toBe(4);
  expect(Math.max(...ramp)).toBe(1);
  expect(ramp.every((b) => b >= 0 && b <= 1)).toBe(true);
  for (let i = 1; i < ramp.length; i++) expect(ramp[i] >= ramp[i - 1]).toBe(true);
});

test('waveformBars: entradas degeneradas não geram NaN', () => {
  expect(waveformBars([], 8)).toEqual([]);
  expect(waveformBars([1, 2, 3], 0)).toEqual([]);
  const bars = waveformBars([NaN, -5, 0], 2);
  expect(bars.length).toBe(2);
  expect(bars.every((b) => Number.isFinite(b) && b >= 0 && b <= 1)).toBe(true);
});

test('waveformBars: sinal todo zero vira barras zero', () => {
  expect(waveformBars([0, 0, 0, 0], 2)).toEqual([0, 0]);
});

// ---------- formatDuration ----------

test('formatDuration: m:ss com arredondamento e proteção para negativo', () => {
  expect(formatDuration(0)).toBe('0:00');
  expect(formatDuration(7)).toBe('0:07');
  expect(formatDuration(65.2)).toBe('1:05');
  expect(formatDuration(59.6)).toBe('1:00');
  expect(formatDuration(-3)).toBe('0:00');
});

// ---------- sanitizeMime / parseDataUrl ----------

test('sanitizeMime: remove parâmetros (; codecs=…) e normaliza caixa', () => {
  expect(sanitizeMime('audio/ogg; codecs=opus')).toBe('audio/ogg');
  expect(sanitizeMime('AUDIO/WAV ')).toBe('audio/wav');
  expect(sanitizeMime('audio/mpeg;codecs=mp3')).toBe('audio/mpeg');
  expect(sanitizeMime('')).toBe('application/octet-stream');
  expect(sanitizeMime(undefined)).toBe('application/octet-stream');
  expect(sanitizeMime(null)).toBe('application/octet-stream');
});

test('parseDataUrl: data URL base64 válido devolve mime + payload', () => {
  expect(parseDataUrl('data:audio/ogg; codecs=opus;base64,T2dnUw')).toEqual({
    mime: 'audio/ogg; codecs=opus',
    base64: 'T2dnUw',
  });
  expect(parseDataUrl('data:audio/wav;base64,UklGR')).toEqual({
    mime: 'audio/wav',
    base64: 'UklGR',
  });
});

test('parseDataUrl: entradas inválidas devolvem null', () => {
  expect(parseDataUrl('http://exemplo/x.mp3')).toBeNull();
  expect(parseDataUrl('data:text/plain,hello')).toBeNull();
  expect(parseDataUrl('')).toBeNull();
});
