/**
 * @fileoverview Utility formatters for data display.
 */

/** Format currency value from BRL string to number */
export function parseCurrency(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[R$\s.,]/g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
}

/** Format date string to DD/MM/YYYY */
export function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
  }
  return dateStr;
}

/** Mask CPF/CNPJ for display */
export function maskDocument(doc: string): string {
  if (!doc) return '';
  const digits = doc.replace(/\D/g, '');
  if (digits.length === 11) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
  }
  return doc;
}

/** Extract clean digits only */
export function cleanDigits(text: string): string {
  return text.replace(/\D/g, '');
}

/** Check if string is likely a CPF (11 digits) or CNPJ (14 digits) */
export function isDocument(text: string): boolean {
  const digits = cleanDigits(text);
  return digits.length === 11 || digits.length === 14;
}

/** Check if string is likely an IMEI (15 digits) */
export function isImei(text: string): boolean {
  return cleanDigits(text).length === 15;
}