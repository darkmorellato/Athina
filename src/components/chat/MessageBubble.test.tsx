/**
 * @fileoverview Testes da bolha de mensagem (visual WhatsApp Web):
 * negrito, bolha/cauda, meta (hora + ticks), citação e integração com mídia.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble.js';
import type { Message } from '../../types/index.js';

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: '1',
    text: 'Olá *mundo*!',
    sender: 'customer',
    fromId: 'cliente@c.us',
    time: '10:00',
    ...overrides,
  };
}

describe('MessageBubble', () => {
  it('renderiza negrito do WhatsApp (*texto* → <strong>)', () => {
    render(<MessageBubble msg={msg()} firstInGroup lastInGroup />);
    expect(screen.getByText('mundo').tagName).toBe('STRONG');
  });

  it('mensagem recebida usa bolha de entrada com cauda na primeira do grupo', () => {
    const { container } = render(<MessageBubble msg={msg()} firstInGroup lastInGroup />);
    expect(container.querySelector('.wa-row-in')).toBeTruthy();
    expect(container.querySelector('.wa-bubble-in.wa-bubble-tail-in')).toBeTruthy();
    expect(container.querySelector('.wa-tail-in')).toBeTruthy();
  });

  it('mensagem enviada mostra hora e ticks de entrega (✓✓)', () => {
    const { container } = render(
      <MessageBubble msg={msg({ sender: 'agent', text: 'ok' })} firstInGroup lastInGroup />
    );
    expect(screen.getByText('10:00')).toBeInTheDocument();
    expect(container.querySelector('.wa-tick')).toBeTruthy();
  });

  it('fora do último do grupo, a meta fica oculta (sem hora/tick visíveis)', () => {
    const { container } = render(<MessageBubble msg={msg()} firstInGroup lastInGroup={false} />);
    expect(container.querySelector('.wa-meta.wa-meta-hidden')).toBeTruthy();
  });

  it('citação (reply) é renderizada com autor "Você" para fromMe', () => {
    render(
      <MessageBubble
        msg={msg({ quoted: { body: 'pergunta anterior', fromMe: true } })}
        firstInGroup
        lastInGroup
      />
    );
    expect(screen.getByText('Você')).toBeInTheDocument();
    expect(screen.getByText('pergunta anterior')).toBeInTheDocument();
  });

  it('botão de responder aparece apenas com serializedId + onReply', () => {
    const onReply = vi.fn();
    const { rerender } = render(
      <MessageBubble msg={msg()} firstInGroup lastInGroup onReply={onReply} />
    );
    expect(screen.queryByTitle('Responder esta mensagem')).toBeNull();

    const withSerialized = msg({ serializedId: 'false_5511@c.us_ABC' });
    rerender(
      <MessageBubble msg={withSerialized} firstInGroup lastInGroup onReply={onReply} />
    );
    fireEvent.click(screen.getByTitle('Responder esta mensagem'));
    expect(onReply).toHaveBeenCalledWith(withSerialized);
  });

  it('áudio renderiza o player de voz (play + waveform)', () => {
    const { container } = render(
      <MessageBubble
        msg={msg({
          text: '',
          mediaMimeType: 'audio/ogg; codecs=opus',
          mediaData: 'T2dnUw==',
          time: '09:00',
        })}
        firstInGroup
        lastInGroup
      />
    );
    expect(screen.getByLabelText('Reproduzir áudio')).toBeInTheDocument();
    expect(container.querySelectorAll('.wa-bar').length).toBeGreaterThan(0);
  });
});
