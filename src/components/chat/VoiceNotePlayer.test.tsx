/**
 * @fileoverview Teste de render do player de voz (sem AudioContext no jsdom:
 * valida a UI estática — botão, waveform placeholder e contador).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoiceNotePlayer } from './VoiceNotePlayer.js';

describe('VoiceNotePlayer', () => {
  it('renderiza play, 42 barras de placeholder e duração zerada', () => {
    const { container } = render(
      <VoiceNotePlayer src="data:audio/ogg;base64,T2dnUw==" isOut={false} />
    );
    expect(screen.getByLabelText('Reproduzir áudio')).toBeInTheDocument();
    expect(container.querySelectorAll('.wa-bar').length).toBe(42);
    expect(screen.getByText('0:00')).toBeInTheDocument();
    expect(screen.getByTitle('Velocidade de reprodução')).toHaveTextContent('1x');
  });
});
