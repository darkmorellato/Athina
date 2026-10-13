/**
 * @fileoverview Reconhecimento de padrões simples de texto (saudação, nome
 * completo, CPF/IMEI) usados pelo roteiro determinístico (AthinaFlowService).
 *
 * Espelho das mesmas regras já validadas em produção no painel
 * (`src/hooks/socket/socketHelpers.ts`) — duplicado aqui porque backend e
 * frontend não compartilham módulo de UI (só `shared/contracts.ts`).
 */

export const GREETING_PATTERNS = [
  'oi', 'olá', 'ola', 'tudo bem', 'bom dia', 'boa tarde', 'boa noite',
  'opa', 'hello', 'hi', 'oi tudo bem', 'ola tudo bem', 'olá tudo bem',
  'tudo bem com voce', 'tudo bem com você', 'como vai', 'bomdia',
  'boatarde', 'boanoite',
];

export function isGreeting(text: string): boolean {
  const clean = text.toLowerCase().trim().replace(/[?.,!\-/]/g, '');
  return GREETING_PATTERNS.some(
    (g) => clean === g || clean.startsWith(g + ' ') || clean.endsWith(' ' + g)
  );
}

export function isFullName(text: string): boolean {
  const clean = text.trim();
  const words = clean.split(/\s+/);
  if (words.length < 2) return false;
  if (clean.includes('?') || clean.length > 50) return false;
  if (isGreeting(clean)) return false;
  return /^[A-Za-zÀ-ÖØ-öø-ÿ\s]+$/.test(clean);
}

export function hasCpfOrImei(text: string): boolean {
  const clean = text.replace(/\D/g, '');
  return /\d{11}/.test(clean) || /\d{15}/.test(clean);
}
