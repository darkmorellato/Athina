/**
 * @fileoverview Testes da lógica de mensagens não-lidas (badge + divisória).
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../../types/index.js';
import {
  EMPTY_UNREAD,
  ingestChats,
  ingestMessage,
  markViewed,
  dividerFor,
  type UnreadState,
} from './unreadLogic.js';

describe('unreadLogic — não-lidas (badge + divisória)', () => {
  describe('ingestChats (baseline do backend)', () => {
    it('define a contagem inicial do badge', () => {
      const s = ingestChats(EMPTY_UNREAD, [
        { id: 'a@c.us', unreadCount: 3 },
        { id: 'b@c.us', unreadCount: 0 },
      ]);
      expect(s.counts['a@c.us']).toBe(3);
      // Zerados ficam AUSENTES do mapa (esparso; toda leitura usa `?? 0`)
      expect('b@c.us' in s.counts).toBe(false);
    });

    it('nunca regride uma contagem já incrementada ao vivo (usa o maior valor)', () => {
      const live = ingestMessage(EMPTY_UNREAD, 'a@c.us', 'm1', {
        isCustomer: true,
        isActive: false,
      });
      const s = ingestChats(live, [{ id: 'a@c.us', unreadCount: 0 }]);
      expect(s.counts['a@c.us']).toBe(1);
    });

    it('sem mudanças devolve o MESMO objeto (evita re-render)', () => {
      const s1 = ingestChats(EMPTY_UNREAD, [{ id: 'a@c.us', unreadCount: 2 }]);
      expect(ingestChats(s1, [{ id: 'a@c.us', unreadCount: 2 }])).toBe(s1);
    });
  });

  describe('ingestMessage (mensagem ao vivo)', () => {
    it('conta do cliente em conversa fechada e mantém a 1ª não lida', () => {
      const s1 = ingestMessage(EMPTY_UNREAD, 'a@c.us', 'm1', {
        isCustomer: true,
        isActive: false,
      });
      expect(s1.counts['a@c.us']).toBe(1);
      expect(s1.firstUnread['a@c.us']).toBe('m1');
      const s2 = ingestMessage(s1, 'a@c.us', 'm2', { isCustomer: true, isActive: false });
      expect(s2.counts['a@c.us']).toBe(2);
      expect(s2.firstUnread['a@c.us']).toBe('m1');
    });

    it('ignora mensagem do agente', () => {
      const s = ingestMessage(EMPTY_UNREAD, 'a@c.us', 'm1', {
        isCustomer: false,
        isActive: false,
      });
      expect(s).toBe(EMPTY_UNREAD);
    });

    it('ignora conversa aberta (conversa aberta = lida, como no WA)', () => {
      const s = ingestMessage(EMPTY_UNREAD, 'a@c.us', 'm1', {
        isCustomer: true,
        isActive: true,
      });
      expect(s).toBe(EMPTY_UNREAD);
    });
  });

  describe('markViewed (abrir a conversa)', () => {
    it('zera o badge e guarda o snapshot (count + 1ª não lida)', () => {
      const withUnread = ingestMessage(EMPTY_UNREAD, 'a@c.us', 'm1', {
        isCustomer: true,
        isActive: false,
      });
      const s = markViewed(withUnread, 'a@c.us');
      expect(s.counts['a@c.us']).toBe(0);
      expect(s.marks['a@c.us']).toEqual({ count: 1, firstUnreadId: 'm1' });
      expect(s.firstUnread['a@c.us']).toBeUndefined();
    });

    it('baseline sem id exato guarda só a contagem', () => {
      const base = ingestChats(EMPTY_UNREAD, [{ id: 'a@c.us', unreadCount: 3 }]);
      const s = markViewed(base, 'a@c.us');
      expect(s.marks['a@c.us']).toEqual({ count: 3 });
    });

    it('sem não-lidas remove a divisória antiga (reabertura)', () => {
      const withMark: UnreadState = {
        ...EMPTY_UNREAD,
        marks: { 'a@c.us': { count: 2, firstUnreadId: 'm1' } },
      };
      const s = markViewed(withMark, 'a@c.us');
      expect(s.marks['a@c.us']).toBeUndefined();
    });

    it('sem nada para mudar devolve o mesmo objeto', () => {
      expect(markViewed(EMPTY_UNREAD, 'a@c.us')).toBe(EMPTY_UNREAD);
    });
  });

  describe('dividerFor (posição da divisória)', () => {
    const msgs: Array<Pick<Message, 'id' | 'sender'>> = [
      { id: '1', sender: 'customer' },
      { id: '2', sender: 'agent' },
      { id: '3', sender: 'customer' },
      { id: '4', sender: 'customer' },
      { id: '5', sender: 'agent' },
      { id: '6', sender: 'customer' },
    ];

    it('usa o id EXATO capturado ao vivo', () => {
      const d = dividerFor(msgs, { count: 2, firstUnreadId: '4' });
      expect(d).toEqual({ id: '4', label: '2 mensagens não lidas' });
    });

    it('baseline: aproxima pelas N últimas mensagens de CLIENTE', () => {
      const d = dividerFor(msgs, { count: 2 });
      expect(d?.id).toBe('4'); // 2 últimas do cliente: id 4 e id 6
    });

    it('singular para 1 mensagem', () => {
      const d = dividerFor(msgs, { count: 1 });
      expect(d?.label).toBe('1 mensagem não lida');
    });

    it('sem mark ou count <= 0 devolve null', () => {
      expect(dividerFor(msgs, undefined)).toBeNull();
      expect(dividerFor(msgs, { count: 0 })).toBeNull();
    });

    it('id exato ausente do histórico cai na aproximação', () => {
      const d = dividerFor(msgs, { count: 2, firstUnreadId: 'zzz' });
      expect(d?.id).toBe('4');
    });
  });
});
