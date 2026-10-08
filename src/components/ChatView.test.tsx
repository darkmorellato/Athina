/**
 * @fileoverview Testes da conversa (ChatView): placeholder, separadores de
 * data, indicador de digitação e botão de mensagens anteriores.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatView } from './ChatView.js';
import type { Message } from '../types/index.js';

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    text: `mensagem ${id}`,
    sender: 'customer',
    fromId: 'cliente@c.us',
    time: '10:00',
    ...overrides,
  };
}

describe('ChatView', () => {
  it('sem contato selecionado mostra o placeholder', () => {
    render(<ChatView messages={[]} selectedContact={null} isAgentTyping={false} />);
    expect(screen.getByText(/Selecione uma conversa/)).toBeInTheDocument();
  });

  it('renderiza separadores Hoje/Ontem e as mensagens', () => {
    const today = Math.floor(Date.now() / 1000);
    const yesterday = today - 86_400;
    render(
      <ChatView
        messages={[
          msg('1', { timestamp: yesterday, text: 'mensagem de ontem' }),
          msg('2', { timestamp: today, text: 'mensagem de hoje' }),
        ]}
        selectedContact="cliente@c.us"
        isAgentTyping={false}
      />
    );
    expect(screen.getByText('Ontem')).toBeInTheDocument();
    expect(screen.getByText('Hoje')).toBeInTheDocument();
    expect(screen.getByText('mensagem de ontem')).toBeInTheDocument();
    expect(screen.getByText('mensagem de hoje')).toBeInTheDocument();
  });

  it('mostra o indicador de digitação da Athina quando ativo', () => {
    render(
      <ChatView
        messages={[msg('1', { timestamp: Math.floor(Date.now() / 1000) })]}
        selectedContact="cliente@c.us"
        isAgentTyping
      />
    );
    expect(screen.getByLabelText('Athina está digitando')).toBeInTheDocument();
  });

  it('botão "Mensagens anteriores" aparece com hasMore e dispara onLoadOlder', () => {
    const onLoadOlder = vi.fn();
    render(
      <ChatView
        messages={[msg('1', { timestamp: Math.floor(Date.now() / 1000) })]}
        selectedContact="cliente@c.us"
        isAgentTyping={false}
        hasMore
        onLoadOlder={onLoadOlder}
      />
    );
    fireEvent.click(screen.getByText('Mensagens anteriores'));
    expect(onLoadOlder).toHaveBeenCalledOnce();
  });

  it('nome do contato aparece no cabeçalho (via fromName da 1ª mensagem)', () => {
    render(
      <ChatView
        messages={[
          msg('1', { fromName: 'João Cliente', timestamp: Math.floor(Date.now() / 1000) }),
        ]}
        selectedContact="5511@c.us"
        isAgentTyping={false}
      />
    );
    expect(screen.getByText('João Cliente')).toBeInTheDocument();
  });
});
