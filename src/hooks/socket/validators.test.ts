import { describe, it, expect } from 'vitest';
import {
  isValidCpf,
  isValidCnpj,
  isValidImei,
  isRepeatedDigits,
  isLikelyPhoneInput,
  extractPlausibleDocument,
  sanitizeForWhatsApp,
  isGreeting,
  isFullName,
} from '@shared/validators.js';
import { chatStateSchema } from '@shared/contracts.js';

describe('shared/validators — validação algorítmica e extração segura', () => {
  it('valida CPF matematicamente (Mod-11) e rejeita dígitos repetidos', () => {
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('00000000000')).toBe(false);
    expect(isValidCpf('52998224720')).toBe(false);
  });

  it('valida CNPJ matematicamente (Mod-11)', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('00000000000000')).toBe(false);
    expect(isValidCnpj('11222333000182')).toBe(false);
  });

  it('valida IMEI pelo algoritmo de Luhn (15 dígitos)', () => {
    expect(isValidImei('490154203237518')).toBe(true);
    expect(isValidImei('000000000000000')).toBe(false);
    expect(isValidImei('490154203237519')).toBe(false);
  });

  it('identifica sequências repetidas e números de telefone explícitos', () => {
    expect(isRepeatedDigits('99999999999')).toBe(true);
    expect(isRepeatedDigits('12345678901')).toBe(false);
    expect(isLikelyPhoneInput('(11) 98765-4321')).toBe(true);
    expect(isLikelyPhoneInput('+55 11 98765-4321')).toBe(true);
    expect(isLikelyPhoneInput('meu zap é 11987654321')).toBe(true);
    expect(isLikelyPhoneInput('123.456.789-01')).toBe(false);
  });

  it('extrai CPF (11), CNPJ (14) e IMEI (15) plausíveis e rejeita repetidos/telefones', () => {
    expect(extractPlausibleDocument('Meu CPF é 529.982.247-25')).toEqual({
      type: 'cpf',
      digits: '52998224725',
      checksumValid: true,
    });
    expect(extractPlausibleDocument('CNPJ 11.222.333/0001-81')).toEqual({
      type: 'cnpj',
      digits: '11222333000181',
      checksumValid: true,
    });
    expect(extractPlausibleDocument('IMEI: 490154203237518')).toEqual({
      type: 'imei',
      digits: '490154203237518',
      checksumValid: true,
    });
    expect(extractPlausibleDocument('00000000000')).toBeNull();
    expect(extractPlausibleDocument('111.111.111-11')).toBeNull();
    expect(extractPlausibleDocument('(11) 98765-4321')).toBeNull();
  });

  it('extrai CPF válido mesmo quando o texto também menciona telefone', () => {
    expect(extractPlausibleDocument('meu celular é 11 98765-4321 e meu cpf é 529.982.247-25')).toEqual({
      type: 'cpf',
      digits: '52998224725',
      checksumValid: true,
    });
    // heurística de telefone só se aplica quando NENHUM candidato tem checksum válido
    expect(extractPlausibleDocument('meu zap é 11 98765-4321')).toBeNull();
    // blocos numéricos adjacentes não podem fundir em um candidato só
    const adjacentes = extractPlausibleDocument('52998224725 356938035643809');
    expect(adjacentes).not.toBeNull();
    // candidato com checksum válido tem prioridade sobre o primeiro da ordem
    expect(extractPlausibleDocument('11987654321 meu cpf é 52998224725')?.digits).toBe('52998224725');
  });

  it('rejeita entradas que não parecem nome próprio (semente de plausibilidade)', () => {
    expect(isFullName('blablabla xyz')).toBe(false);
    expect(isFullName('kkkkk jjjjj')).toBe(false);
    expect(isFullName('Maria Silva')).toBe(true);
    expect(isFullName('João Pedro de Souza')).toBe(true);
    expect(isFullName('Ana Paula')).toBe(true);
  });

  it('compartilha sanitizeForWhatsApp, isGreeting e isFullName entre front e back', () => {
    expect(sanitizeForWhatsApp('**Olá** CPF: 123.456.789-01')).toBe('*Olá* CPF: ***.456.789-**');
    expect(isGreeting('Bom dia!')).toBe(true);
    expect(isFullName('Maria Aparecida')).toBe(true);
    expect(isFullName('oi tudo bem')).toBe(false);
  });

  it('rejeita payloads malformados em chatStateSchema (sem z.any arbitrário)', () => {
    const valid = chatStateSchema.safeParse({
      stage: 'MAIN_MENU',
      flow: {
        client: {
          nome: 'Maria Silva',
          cpf: '12345678901',
          imei: '123456789012345',
          loja: 'Loja 1',
          contrato: 'C1',
        },
        statusContrato: 'em_dia',
        overdueCount: 0,
      },
    });
    expect(valid.success).toBe(true);

    const invalid = chatStateSchema.safeParse({
      stage: 'MAIN_MENU',
      flow: {
        statusContrato: 'INVALID_STATUS',
        overdueCount: 'nao-e-numero',
      },
    });
    expect(invalid.success).toBe(false);
  });
});
