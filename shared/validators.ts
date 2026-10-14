/**
 * @fileoverview Validações compartilhadas (painel ↔ backend):
 * - Validação algorítmica de CPF (Mod-11), CNPJ (Mod-11) e IMEI (Luhn)
 * - Extração segura de documentos evitando falsos positivos (dígitos repetidos e telefones)
 * - Padrões conversacionais (isGreeting, isFullName, hasCpfOrImei)
 * - Sanitização determinística para o WhatsApp (markdown → WhatsApp + máscara LGPD de CPF)
 */

export const GREETING_PATTERNS = [
  'oi',
  'olá',
  'ola',
  'tudo bem',
  'bom dia',
  'boa tarde',
  'boa noite',
  'opa',
  'hello',
  'hi',
  'oi tudo bem',
  'ola tudo bem',
  'olá tudo bem',
  'tudo bem com voce',
  'tudo bem com você',
  'como vai',
  'bomdia',
  'boatarde',
  'boanoite',
];

/** Verifica se todos os dígitos da sequência são iguais (ex.: 11111111111). */
export function isRepeatedDigits(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 2) return false;
  return /^(\d)\1+$/.test(digits);
}

/** Validação matemática de CPF pelo algoritmo Módulo 11. */
export function isValidCpf(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 11 || isRepeatedDigits(digits)) return false;

  const calcDigit = (sliceLen: number): number => {
    let sum = 0;
    for (let i = 0; i < sliceLen; i++) {
      sum += Number(digits[i]) * (sliceLen + 1 - i);
    }
    const rem = (sum * 10) % 11;
    return rem === 10 ? 0 : rem;
  };

  return calcDigit(9) === Number(digits[9]) && calcDigit(10) === Number(digits[10]);
}

/** Validação matemática de CNPJ pelo algoritmo Módulo 11. */
export function isValidCnpj(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 14 || isRepeatedDigits(digits)) return false;

  const calc = (len: number): number => {
    const weights =
      len === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, idx) => acc + Number(digits[idx]) * w, 0);
    const rem = sum % 11;
    return rem < 2 ? 0 : 11 - rem;
  };

  return calc(12) === Number(digits[12]) && calc(13) === Number(digits[13]);
}

/** Validação matemática de IMEI (15 dígitos) pelo algoritmo de Luhn (3GPP TS 23.003). */
export function isValidImei(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 15 || isRepeatedDigits(digits)) return false;

  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(digits[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Identifica se o texto digitado tem formato explícito de telefone (DDD entre parênteses,
 * DDI +55 ou menção explícita a telefone/zap/celular) para evitar confundir celular (11 dígitos) com CPF.
 */
export function isLikelyPhoneInput(text: string): boolean {
  if (!text) return false;
  if (/\(\d{2}\)\s*9?\d{4}[-\s]?\d{4}/.test(text)) return true;
  if (/\+55\s*\d{2}\s*9?\d{4}[-\s]?\d{4}/.test(text)) return true;
  if (/\b(meu\s+(telefone|celular|numero|número|zap|whats|whatsapp)|zap\s*[eé:]|telefone\s*[eé:])/i.test(text)) {
    return true;
  }
  return false;
}

export interface ExtractedDocument {
  type: 'cpf' | 'cnpj' | 'imei';
  digits: string;
  checksumValid: boolean;
}

/**
 * Extrai um documento plausível (CPF de 11 dígitos, CNPJ de 14 dígitos ou IMEI de 15 dígitos).
 * - Não funde números separados por espaço ("52998224725 356938035643809" gera 2 candidatos).
 * - Prioriza candidatos com dígito verificador matematicamente válido (Mod-11 / Luhn), mesmo
 *   quando a mensagem também menciona um número de telefone ("meu celular é X e meu cpf é Y").
 * - Aplica o bloqueio de telefone (`isLikelyPhoneInput`) apenas quando nenhum candidato tem checksum válido.
 */
export function extractPlausibleDocument(text: string): ExtractedDocument | null {
  if (!text) return null;

  // Extrai tokens numéricos contíguos (com pontos, traços ou barras, mas SEM espaço interno)
  const matches = text.match(/\d[\d.\-/]{8,20}\d/g) ?? [];
  const rawCandidates = matches.length > 0 ? matches : [text];

  const parsedCandidates: ExtractedDocument[] = [];
  for (const raw of rawCandidates) {
    const clean = raw.replace(/\D/g, '');
    if (isRepeatedDigits(clean)) continue;
    if (clean.length === 15) {
      parsedCandidates.push({ type: 'imei', digits: clean, checksumValid: isValidImei(clean) });
    } else if (clean.length === 14) {
      parsedCandidates.push({ type: 'cnpj', digits: clean, checksumValid: isValidCnpj(clean) });
    } else if (clean.length === 11) {
      parsedCandidates.push({ type: 'cpf', digits: clean, checksumValid: isValidCpf(clean) });
    }
  }

  // 1. Se houver qualquer documento com dígito verificador válido, ele tem prioridade máxima
  const validChecksumDoc = parsedCandidates.find((c) => c.checksumValid);
  if (validChecksumDoc) return validChecksumDoc;

  // 2. Sem documento com checksum válido: se a frase tem formato explícito de telefone, ignora
  if (isLikelyPhoneInput(text)) return null;

  // 3. Caso contrário, retorna o primeiro candidato de 11/14/15 dígitos (para o fluxo avisar erro de dígito)
  return parsedCandidates[0] ?? null;
}

export function isGreeting(text: string): boolean {
  const clean = text.toLowerCase().trim().replace(/[?.,!\-/]/g, '');
  return GREETING_PATTERNS.some(
    (g) => clean === g || clean.startsWith(g + ' ') || clean.endsWith(' ' + g)
  );
}

/** Palavras comuns de intenção/ação que NÃO fazem parte de um nome próprio. */
const NON_NAME_WORDS = new Set([
  'quero',
  'preciso',
  'boleto',
  'pagar',
  'pagamento',
  'segunda',
  'via',
  'saldo',
  'parcela',
  'parcelas',
  'celular',
  'aparelho',
  'bloqueado',
  'bloqueou',
  'desbloquear',
  'desbloqueio',
  'atendente',
  'especialista',
  'humano',
  'ajuda',
  'pix',
  'comprovante',
  'paguei',
  'atraso',
  'atrasado',
  'contrato',
  'favor',
  'por',
  'bom',
  'boa',
  'dia',
  'tarde',
  'noite',
  'ola',
  'olá',
]);

export function isFullName(text: string): boolean {
  const clean = text.trim();
  const words = clean.split(/\s+/);
  if (words.length < 2 || words.length > 7) return false;
  if (clean.includes('?') || clean.length > 60) return false;
  if (isGreeting(clean)) return false;
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ\s]+$/.test(clean)) return false;
  const lowerWords = words.map((w) => w.toLowerCase());
  if (lowerWords.some((w) => NON_NAME_WORDS.has(w))) return false;
  return true;
}

/**
 * Extrai nome próprio de frases compostas como "Oi, meu nome é Maria Silva e quero pagar boleto"
 * ou quando a mensagem inteira é o próprio nome ("Maria Silva").
 */
export function extractNameFromText(text: string): string | null {
  if (!text) return null;
  const patterns = [
    /\b(?:meu\s+nome\s+[eé]|me\s+chamo|sou\s+o|sou\s+a|aqu[ií]\s+[eé]\s+o|aqu[ií]\s+[eé]\s+a|titular\s*:?)\s+([A-Za-zÀ-ÖØ-öø-ÿ]{2,}(?:\s+(?:da|de|do|dos|das|e|[A-Za-zÀ-ÖØ-öø-ÿ]{2,})){1,5})/i,
  ];
  for (const regex of patterns) {
    const m = text.match(regex);
    if (m?.[1]) {
      // Para na conjunção "e quero / preciso / meu cpf"
      const candidate = m[1]
        .replace(/\s+(?:e\s+(?:quero|preciso|gostaria|meu|minha)|cpf|imei|cnpj).*$/i, '')
        .trim();
      if (isFullName(candidate)) return candidate;
    }
  }

  // Fallback: remove números/pontuação e testa se o texto restante é um nome completo puro
  const textWithoutNumbers = text
    .replace(/[0-9\n\r\t.\-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (isFullName(textWithoutNumbers)) return textWithoutNumbers;
  return null;
}

export function hasCpfOrImei(text: string): boolean {
  return extractPlausibleDocument(text) !== null;
}

/**
 * Sanitização determinística de toda saída para o WhatsApp:
 * - converte markdown (**forte**, __forte__) para *negrito* nativo do WhatsApp;
 * - mascara CPF completo (LGPD — regra "nunca exibir o CPF inteiro").
 */
export function sanitizeForWhatsApp(text: string): string {
  const noMarkdown = text
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/__([^_\n]+)__/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`\n]+)`/g, '$1');

  return noMarkdown
    .split('\n')
    .map((line) => {
      let out = line.replace(
        /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
        (m) => `***.${m.slice(4, 7)}.${m.slice(8, 11)}-**`
      );
      if (/cpf|cnpj|documento|identifica/i.test(line)) {
        out = out.replace(
          /\b\d{3}(\d{3})(\d{3})\d{2}\b/g,
          (m) => `***.${m.slice(3, 6)}.${m.slice(6, 9)}-**`
        );
      }
      return out;
    })
    .join('\n');
}
