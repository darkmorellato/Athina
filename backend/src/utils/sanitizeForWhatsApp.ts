/**
 * @fileoverview Sanitização DETERMINÍSTICA de toda saída para o WhatsApp
 * (não depende de modelo): remove markdown e mascara CPF completo (LGPD).
 */

/**
 * - remove markdown (o WhatsApp mostra os marcadores como texto literal);
 * - mascara CPF completo (LGPD — regra "nunca exibir o CPF inteiro").
 * Linhas com "PIX" não sofrem máscara de dígitos soltos para não corromper
 * o código copia-e-cola.
 */
export function sanitizeForWhatsApp(text: string): string {
  // Markdown vira formatação do WhatsApp: **forte** e __forte__ → *negrito*.
  // Asteriscos simples são PRESERVADOS (é assim que o WhatsApp renderiza
  // negrito — removê-los mataria o "sempre em negrito" dos atalhos).
  const noMarkdown = text
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/__([^_\n]+)__/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`\n]+)`/g, '$1');

  return noMarkdown
    .split('\n')
    .map((line) => {
      // CPF formatado (123.456.789-01) → sempre mascarado (inconfundível)
      let out = line.replace(
        /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
        (m) => `***.${m.slice(4, 7)}.${m.slice(8, 11)}-**`
      );
      // CPF só dígitos (11): mascarar APENAS em linha com contexto de documento
      // (ex.: "CPF/CNPJ: 54486304802") — preserva telefones (11 dígitos) e
      // códigos PIX intactos.
      if (/cpf|cnpj|documento|identifica/i.test(line)) {
        out = out.replace(/\b\d{3}(\d{3})(\d{3})\d{2}\b/g, (m) => `***.${m.slice(3, 6)}.${m.slice(6, 9)}-**`);
      }
      return out;
    })
    .join('\n');
}
