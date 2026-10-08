/// <reference types="node" />
/* eslint-disable @typescript-eslint/no-floating-promises -- test() do node:test é gerenciado pelo runner */
/**
 * @fileoverview TDD da lógica pura do chat estilo WhatsApp Web:
 * agrupamento de bolhas, separadores de data e waveform de áudio.
 *
 * Rodar: backend/node_modules/.bin/tsx --test src/components/chat/chatLogic.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(formatDayLabel(ts(9, 10, 0), NOW), 'Hoje');
  assert.equal(formatDayLabel(ts(8, 23, 30), NOW), 'Ontem');
  assert.equal(formatDayLabel(ts(1, 9, 0), NOW), '01/10/2026');
});

// ---------- buildTimeline: agrupamento ----------

test('buildTimeline: mesmo remetente em <=60s agrupa (cauda na 1ª, meta na última)', () => {
  const items = msgItems(
    buildTimeline(
      [msg('1', { timestamp: ts(9, 10, 0, 0) }), msg('2', { timestamp: ts(9, 10, 0, 30) })],
      NOW
    )
  );
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].firstInGroup, items[0].lastInGroup], [true, false]);
  assert.deepEqual([items[1].firstInGroup, items[1].lastInGroup], [false, true]);
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
  assert.deepEqual(
    items.map((i) => [i.firstInGroup, i.lastInGroup]),
    [
      [true, true],
      [true, true],
    ]
  );
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
  assert.deepEqual(
    items.map((i) => [i.firstInGroup, i.lastInGroup]),
    [
      [true, true],
      [true, true],
      [true, true],
    ]
  );
});

test('buildTimeline: virada de dia não agrupa (separador no meio)', () => {
  const items = buildTimeline(
    [msg('1', { timestamp: ts(8, 23, 59, 50) }), msg('2', { timestamp: ts(9, 0, 0, 10) })],
    NOW
  );
  // Cada dia abre com seu próprio separador; o de msg2 fica ENTRE as duas.
  assert.equal(items.filter((i) => i.kind === 'date').length, 2);
  const idx1 = items.findIndex((i) => i.kind === 'msg' && i.msg.id === '1');
  const idx2 = items.findIndex((i) => i.kind === 'msg' && i.msg.id === '2');
  assert.ok(items.slice(idx1 + 1, idx2).some((i) => i.kind === 'date'));
  assert.deepEqual(
    msgItems(items).map((i) => [i.firstInGroup, i.lastInGroup]),
    [
      [true, true],
      [true, true],
    ]
  );
});

test('buildTimeline: sem timestamp agrupa entre si, mas não com mensagem com timestamp', () => {
  const items = msgItems(
    buildTimeline(
      [msg('1', { timestamp: ts(9, 10, 0, 0) }), msg('2'), msg('3')],
      NOW
    )
  );
  assert.deepEqual(
    items.map((i) => [i.firstInGroup, i.lastInGroup]),
    [
      [true, true],
      [true, false],
      [false, true],
    ]
  );
});

test('buildTimeline: sem timestamp não gera separador de data', () => {
  const items = buildTimeline([msg('1')], NOW);
  assert.deepEqual(items.map((i) => i.kind), ['msg']);
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
  assert.deepEqual(
    items.map((i) => (i.kind === 'date' ? `date:${i.label}` : `msg:${i.msg.id}`)),
    ['date:Ontem', 'msg:1', 'msg:2', 'date:Hoje', 'msg:3']
  );
  const dateKeys = items.filter((i) => i.kind === 'date').map((i) => i.key);
  assert.equal(dateKeys.length, 2);
  assert.ok(dateKeys.every((k) => k.length > 0));
  assert.equal(new Set(dateKeys).size, dateKeys.length);
});

// ---------- waveformBars ----------

test('waveformBars: reamostra para N barras normalizadas (0..1)', () => {
  assert.deepEqual(waveformBars([0, 0, 10, 10], 2), [0, 1]);
  const ramp = waveformBars([1, 2, 3, 4, 5, 6, 7, 8], 4);
  assert.equal(ramp.length, 4);
  assert.equal(Math.max(...ramp), 1);
  assert.ok(ramp.every((b) => b >= 0 && b <= 1));
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] >= ramp[i - 1]);
});

test('waveformBars: entradas degeneradas não geram NaN', () => {
  assert.deepEqual(waveformBars([], 8), []);
  assert.deepEqual(waveformBars([1, 2, 3], 0), []);
  const bars = waveformBars([NaN, -5, 0], 2);
  assert.equal(bars.length, 2);
  assert.ok(bars.every((b) => Number.isFinite(b) && b >= 0 && b <= 1));
});

test('waveformBars: sinal todo zero vira barras zero', () => {
  assert.deepEqual(waveformBars([0, 0, 0, 0], 2), [0, 0]);
});

// ---------- formatDuration ----------

test('formatDuration: m:ss com arredondamento e proteção para negativo', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(7), '0:07');
  assert.equal(formatDuration(65.2), '1:05');
  assert.equal(formatDuration(59.6), '1:00');
  assert.equal(formatDuration(-3), '0:00');
});

// ---------- sanitizeMime / parseDataUrl ----------

test('sanitizeMime: remove parâmetros (; codecs=…) e normaliza caixa', () => {
  assert.equal(sanitizeMime('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.equal(sanitizeMime('AUDIO/WAV '), 'audio/wav');
  assert.equal(sanitizeMime('audio/mpeg;codecs=mp3'), 'audio/mpeg');
  assert.equal(sanitizeMime(''), 'application/octet-stream');
  assert.equal(sanitizeMime(undefined), 'application/octet-stream');
  assert.equal(sanitizeMime(null), 'application/octet-stream');
});

test('parseDataUrl: data URL base64 válido devolve mime + payload', () => {
  assert.deepEqual(parseDataUrl('data:audio/ogg; codecs=opus;base64,T2dnUw'), {
    mime: 'audio/ogg; codecs=opus',
    base64: 'T2dnUw',
  });
  assert.deepEqual(parseDataUrl('data:audio/wav;base64,UklGR'), {
    mime: 'audio/wav',
    base64: 'UklGR',
  });
});

test('parseDataUrl: entradas inválidas devolvem null', () => {
  assert.equal(parseDataUrl('http://exemplo/x.mp3'), null);
  assert.equal(parseDataUrl('data:text/plain,hello'), null);
  assert.equal(parseDataUrl(''), null);
});
