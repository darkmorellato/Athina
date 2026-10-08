/**
 * @fileoverview Setup global do Vitest (jsdom) para os testes do painel.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom não implementa APIs de layout usadas pelo chat (scroll)
Element.prototype.scrollIntoView = () => undefined;

afterEach(() => {
  cleanup();
});
