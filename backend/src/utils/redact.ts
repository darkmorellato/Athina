/**
 * @fileoverview Mascaramento de PII para logs (LGPD).
 *
 * CPF/CNPJ/IMEI/telefone/nome de cliente NUNCA devem aparecer crus em log.
 * Use estas funções em todo logger que receba dado vindo de cliente.
 */

/** 12345678901 -> "12***01"; string vazia -> "vazio". */
export function maskDocument(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return 'vazio';
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
}

/** "5511998877665@c.us" -> "***7665@c.us" (mantém o sufixo do JID). */
export function maskPhone(jid: unknown): string {
  const raw = String(jid ?? '');
  const at = raw.indexOf('@');
  const digits = (at >= 0 ? raw.slice(0, at) : raw).replace(/\D/g, '');
  if (!digits) return 'desconhecido';
  const suffix = digits.length >= 4 ? digits.slice(-4) : digits;
  return `***${suffix}${at >= 0 ? raw.slice(at) : ''}`;
}

/** "Maria da Silva" -> "Ma***". */
export function maskName(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (s.length <= 2) return `${s[0] ?? ''}***`;
  return `${s.slice(0, 2)}***`;
}
