/**
 * @fileoverview Reexporta os padrões conversacionais e validadores de
 * `shared/validators.ts` (fonte única de verdade entre painel e backend).
 */
export {
  GREETING_PATTERNS,
  isGreeting,
  isFullName,
  hasCpfOrImei,
  extractPlausibleDocument,
  extractNameFromText,
  isValidCpf,
  isValidCnpj,
  isValidImei,
  isRepeatedDigits,
  isLikelyPhoneInput,
} from '@shared/validators.js';
