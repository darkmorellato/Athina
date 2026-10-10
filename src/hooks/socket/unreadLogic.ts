/**
 * @fileoverview Lógica PURA de mensagens não-lidas, no estilo do WhatsApp Web:
 * - `counts`: badge verde na lista lateral (por contato);
 * - `firstUnread`: id da 1ª mensagem não lida vista AO VIVO (posiciona a
 *   divisória com precisão);
 * - `marks`: snapshot tirado ao ABRIR a conversa ({ count, firstUnreadId }) —
 *   é o que a divisória "N mensagens não lidas" usa enquanto o chat está
 *   aberto, quando o badge já foi zerado (como no WhatsApp).
 */
import type { Message } from '../../types/index.js';

export interface UnreadMark {
  count: number;
  firstUnreadId?: string;
}

export interface UnreadState {
  counts: Record<string, number>;
  firstUnread: Record<string, string>;
  marks: Record<string, UnreadMark>;
}

export const EMPTY_UNREAD: UnreadState = { counts: {}, firstUnread: {}, marks: {} };

/** Baseline do backend (chat.unreadCount). Usa o MAIOR valor — os eventos ao
 *  vivo e a lista do servidor chegam em ordens diferentes; regredir a
 *  contagem apagaria um badge corretamente incrementado. */
export function ingestChats(
  state: UnreadState,
  chats: Array<{ id: string; unreadCount?: number }>
): UnreadState {
  let changed = false;
  const counts: Record<string, number> = { ...state.counts };
  for (const c of chats) {
    const base = typeof c.unreadCount === 'number' && c.unreadCount > 0 ? Math.floor(c.unreadCount) : 0;
    const cur = counts[c.id] ?? 0;
    const next = Math.max(cur, base);
    if (next !== cur) {
      counts[c.id] = next;
      changed = true;
    }
  }
  return changed ? { ...state, counts } : state;
}

/** Mensagem chegou: incrementa SÓ se for do cliente E a conversa não estiver
 *  aberta (conversa aberta = lida, como no WA; o FAB cobre o resto). */
export function ingestMessage(
  state: UnreadState,
  chatId: string,
  msgId: string,
  opts: { isCustomer: boolean; isActive: boolean }
): UnreadState {
  if (!opts.isCustomer || opts.isActive || !chatId || !msgId) return state;
  return {
    counts: { ...state.counts, [chatId]: (state.counts[chatId] ?? 0) + 1 },
    firstUnread: state.firstUnread[chatId]
      ? state.firstUnread
      : { ...state.firstUnread, [chatId]: msgId },
    marks: state.marks,
  };
}

/** Conversa aberta: zera o badge e guarda o snapshot para a divisória.
 *  Sem não-lidas, remover a divisória antiga (reabertura, como no WA). */
export function markViewed(state: UnreadState, chatId: string): UnreadState {
  const count = state.counts[chatId] ?? 0;
  if (count > 0) {
    const counts = { ...state.counts, [chatId]: 0 };
    const firstUnread = { ...state.firstUnread };
    const firstUnreadId = firstUnread[chatId];
    delete firstUnread[chatId];
    const marks = {
      ...state.marks,
      [chatId]: { count, ...(firstUnreadId ? { firstUnreadId } : {}) } as UnreadMark,
    };
    return { counts, firstUnread, marks };
  }
  if (state.marks[chatId]) {
    const marks = { ...state.marks };
    delete marks[chatId];
    return { ...state, marks };
  }
  return state;
}

/** Posição da divisória: prefere o id EXATO capturado ao vivo; sem ele
 *  (baseline do servidor), aproxima pelas N últimas mensagens de CLIENTE. */
export function dividerFor(
  messages: Array<Pick<Message, 'id' | 'sender'>>,
  mark: UnreadMark | undefined
): { id: string; label: string } | null {
  if (!mark || mark.count <= 0) return null;
  const label = mark.count === 1 ? '1 mensagem não lida' : `${mark.count} mensagens não lidas`;
  if (mark.firstUnreadId) {
    const exact = messages.find((m) => m.id === mark.firstUnreadId);
    if (exact) return { id: exact.id, label };
  }
  const incoming = messages.filter((m) => m.sender === 'customer');
  const idx = Math.max(0, incoming.length - mark.count);
  const first = incoming[idx];
  return first ? { id: first.id, label } : null;
}
