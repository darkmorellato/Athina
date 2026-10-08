/**
 * @fileoverview Testes do composer: digitação, envio, validação de imagem,
 * chip de pré-visualização e citação (reply).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageInput } from './MessageInput.js';

function renderInput(props: Partial<Parameters<typeof MessageInput>[0]> = {}) {
  const onChange = vi.fn();
  const onSend = vi.fn();
  const onSendImage = vi.fn();
  const utils = render(
    <MessageInput value="" onChange={onChange} onSend={onSend} onSendImage={onSendImage} {...props} />
  );
  return { ...utils, onChange, onSend, onSendImage };
}

describe('MessageInput (composer estilo WhatsApp)', () => {
  it('digitar propaga onChange', () => {
    const { onChange } = renderInput();
    fireEvent.change(screen.getByPlaceholderText('Digite uma mensagem'), {
      target: { value: 'olá' },
    });
    expect(onChange).toHaveBeenCalledWith('olá');
  });

  it('enviar dispara onSend quando há texto', () => {
    const { onSend } = renderInput({ value: 'olá' });
    fireEvent.click(screen.getByTitle('Enviar mensagem'));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('botão de enviar fica desabilitado sem texto nem imagem', () => {
    renderInput();
    expect(screen.getByTitle('Enviar mensagem')).toBeDisabled();
  });

  it('arquivo não-imagem mostra erro de validação', () => {
    const { container } = renderInput();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'nota.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(screen.getByText(/Só imagens/)).toBeInTheDocument();
  });

  it('imagem válida mostra chip e enviar chama onSendImage com base64 + mime + legenda', async () => {
    const { container, onSendImage } = renderInput({ value: 'olá' });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'foto.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText('Imagem pronta para enviar')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Enviar imagem'));
    expect(onSendImage).toHaveBeenCalledWith('eA==', 'image/png', 'olá');
  });

  it('citação mostra "Respondendo" e cancelar dispara onCancelReply', () => {
    const onCancelReply = vi.fn();
    renderInput({
      replyTo: { id: 'm1', serializedId: 's1', text: 'pergunta', fromName: 'Cliente', contactId: 'c' },
      onCancelReply,
    });
    expect(screen.getByText('Respondendo Cliente')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Cancelar resposta'));
    expect(onCancelReply).toHaveBeenCalledOnce();
  });
});
