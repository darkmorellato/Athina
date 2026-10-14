/**
 * @fileoverview Motor de compreensão de linguagem natural (NLU) híbrido da Athina.
 *
 * Combina:
 * 1. Classificação determinística e léxica ultra-rápida (<1ms) para opções numéricas,
 *    confirmações naturais ("sim, pode mandar", "não, está errado"), intenções de domínio
 *    ("quero pagar meu boleto", "meu celular bloqueou mas já paguei no pix", "ver saldo",
 *    "falar com atendente") e extração simultânea de Nome + CPF/CNPJ/IMEI (Slot Jumping).
 * 2. Detecção de sentimento/hostilidade (gatilho de escalonamento humano).
 * 3. Suporte opcional a classificação estruturada via LLM (`generateObject` do Vercel AI SDK)
 *    quando habilitado, com fallback seguro determinístico.
 */
import { generateObject } from 'ai';
import { z } from 'zod';
import {
  extractPlausibleDocument,
  extractNameFromText,
  isGreeting,
  type ExtractedDocument,
} from '@shared/validators.js';
import type { DeferredIntent } from '@shared/contracts.js';
import type { ChatStage } from './ChatStateService.js';
import { getChatModel } from './aiProvider.js';
import config from '../config/index.js';
import trainingService from './TrainingService.js';

export const nluIntentSchema = z.enum([
  'GREETING',
  'PROVIDE_IDENTIFICATION',
  'PAGAR_BOLETO',
  'VERIFICAR_SALDO',
  'CELULAR_BLOQUEADO',
  'INFORMAR_JA_PAGUEI',
  'FALAR_COM_ATENDENTE',
  'CONFIRM_YES',
  'CONFIRM_NO',
  'PAYMENT_METHOD_PIX',
  'PAYMENT_METHOD_BOLETO',
  'BACK_TO_MENU',
  'FAQ_QUESTION',
  'UNKNOWN',
]);

export type NluIntent = z.infer<typeof nluIntentSchema>;

export const nluDecisionSchema = z.object({
  intent: nluIntentSchema,
  confidence: z.number().min(0).max(1),
  extractedName: z.string().nullable(),
  paymentMethod: z.enum(['pix', 'boleto']).nullable(),
  sentiment: z.enum(['NEUTRAL', 'POSITIVE', 'CONFUSED', 'FRUSTRATED', 'HOSTILE']),
  contextualReply: z.string().nullable(),
});

export type NluDecision = z.infer<typeof nluDecisionSchema> & {
  extractedDoc: ExtractedDocument | null;
  deferredIntent: DeferredIntent | null;
};

const HOSTILE_REGEX =
  /\b(procon|processar|advogado|justi[cç]a|pol[ií]cia|golpe|ladr[aã]o|roubo|lixo|porra|caralho|merda|inferno|palha[cç]ada|absurdo|enganad[oa])\b/i;

const CONFIRM_YES_REGEX =
  /^(?:1|sim|s|isso|isso\s+mesmo|correto|est[aá]\s+certo|est[aá]\s+correto|quero|pode|pode\s+mandar|pode\s+enviar|ok|confirmo|claro|com\s+certeza)(?:\b|[\s,!.?])/i;

const CONFIRM_NO_REGEX =
  /^(?:2|n[aã]o|nao|n|errado|incorreto|est[aã]o\s+errados|est[aá]\s+errado|n[aã]o\s+quero|negativo|n[aã]o\s+obrigad[oa])(?:\b|[\s,!.?])/i;

const BACK_MENU_REGEX = /\b(voltar|menu\s+principal|ir\s+para\s+o\s+in[ií]cio|recome[cç]ar)\b/i;

function detectSentiment(text: string): NluDecision['sentiment'] {
  if (HOSTILE_REGEX.test(text)) return 'HOSTILE';
  if (/\b(n[aã]o\s+consigo|dif[ií]cil|ningu[eé]m\s+resolve|demora|de\s+novo\s+isso)\b/i.test(text)) {
    return 'FRUSTRATED';
  }
  return 'NEUTRAL';
}

function detectPaymentMethod(text: string): 'pix' | 'boleto' | null {
  if (/\bpix\b/i.test(text)) return 'pix';
  if (/\b(c[oó]digo\s+de\s+barras|boleto|lot[eé]rica|banc[oó])\b/i.test(text)) return 'boleto';
  return null;
}

/**
 * Detecta intenções de domínio em texto livre (Português Brasileiro).
 * Ordem de precedência:
 * 1. "Já paguei / enviar comprovante" (mais específica que apenas "bloqueado" ou "boleto")
 * 2. "Falar com atendente / especialista"
 * 3. "Celular bloqueado / desbloquear"
 * 4. "Verificar saldo / parcelas restantes"
 * 5. "Pagar boleto / 2ª via / PIX para pagar"
 */
export function detectDomainIntent(text: string): DeferredIntent | null {
  const clean = text.trim();
  if (!clean) return null;

  if (
    /\b(j[aá]\s+paguei|paguei\s+(?:ontem|hoje|agora|o\s+boleto|no\s+pix|via\s+pix|a\s+parcela)|fiz\s+o\s+(?:pix|pagamento)|efetuei\s+o\s+pagamento|tenho\s+o?\s*comprovante|mandar\s+o\s+comprovante)\b/i.test(
      clean
    )
  ) {
    return 'INFORMAR_JA_PAGUEI';
  }

  if (
    /\b(falar\s+com\s+(?:um\s+)?(?:atendente|especialista|humano|pessoa|algu[eé]m)|atendente\s+humano|quero\s+um\s+atendente|transferir\s+para\s+atendente)\b/i.test(
      clean
    )
  ) {
    return 'FALAR_COM_ATENDENTE';
  }

  if (/\b(celular\s+(?:est[aá]\s+)?bloqueado|aparelho\s+bloqueado|bloqueou|desbloquear|bloqueio)\b/i.test(clean)) {
    return 'CELULAR_BLOQUEADO';
  }

  if (
    /\b(verificar\s+saldo|meu\s+saldo|saldo\s+restante|quantas\s+parcelas\s+faltam|quanto\s+falta|extrato\s+de\s+parcelas|consultar\s+parcelas)\b/i.test(
      clean
    )
  ) {
    return 'VERIFICAR_SALDO';
  }

  if (
    /\b(pagar\s+(?:o\s+|meu\s+)?boleto|quero\s+(?:o\s+|meu\s+)?boleto|segunda\s+via|2[ªa]?\s*via|gerar\s+(?:boleto|pix)|enviar\s+(?:o\s+)?boleto|pagar\s+parcela|parcela\s+atrasada)\b/i.test(
      clean
    )
  ) {
    return 'PAGAR_BOLETO';
  }

  return null;
}

export class DialogueNluService {
  /**
   * Analisa a mensagem do cliente considerando o estágio atual da máquina de estados.
   * Extrai simultaneamente entidades (nome, documento, método de pagamento) e a intenção.
   */
  async interpret(params: {
    text: string;
    stage: ChatStage;
    recentTurns?: Array<{ role: 'user' | 'assistant'; content: string }>;
    enableLlmFallback?: boolean;
  }): Promise<NluDecision> {
    const clean = params.text.trim();
    const extractedDoc = extractPlausibleDocument(clean);
    const extractedName = extractNameFromText(clean);
    const sentiment = detectSentiment(clean);
    const paymentMethod = detectPaymentMethod(clean);
    const domainIntent = detectDomainIntent(clean);

    // 1. Resolução rápida sensível ao estágio (números + linguagem natural)
    const stageResolved = this.resolveByStage({
      clean,
      stage: params.stage,
      extractedDoc,
      extractedName,
      sentiment,
      paymentMethod,
      domainIntent,
    });
    if (stageResolved) return stageResolved;

    // 2. Fallback opcional para LLM Structured Output (generateObject) quando habilitado
    if (params.enableLlmFallback && config.aiApiKey) {
      try {
        const modelId = config.aiModel || 'nvidia/nemotron-3.5-lightning-30b-a3b';
        const trainingBlock = trainingService.getPromptBlock(10, clean);
        const { object } = await generateObject({
          model: getChatModel(modelId),
          schema: nluDecisionSchema,
          temperature: 0.1,
          maxOutputTokens: 300,
          abortSignal: AbortSignal.timeout(6_000),
          system: [
            'Você é o classificador NLU da Athina (Financeira Nuovopay).',
            `Estágio atual: ${params.stage}.`,
            'Nunca invente valores, links ou promessas fora das regras.',
            trainingBlock,
          ].join('\n\n'),
          prompt: `<mensagem_cliente>\n${clean.slice(0, 800)}\n</mensagem_cliente>`,
        });
        return {
          ...object,
          extractedName: extractedName ?? object.extractedName,
          extractedDoc,
          deferredIntent: domainIntent,
        };
      } catch {
        /* Degrada silenciosamente para UNKNOWN */
      }
    }

    return {
      intent: 'UNKNOWN',
      confidence: 0.3,
      extractedName,
      extractedDoc,
      paymentMethod,
      sentiment,
      contextualReply: null,
      deferredIntent: domainIntent,
    };
  }

  private resolveByStage(ctx: {
    clean: string;
    stage: ChatStage;
    extractedDoc: ExtractedDocument | null;
    extractedName: string | null;
    sentiment: NluDecision['sentiment'];
    paymentMethod: 'pix' | 'boleto' | null;
    domainIntent: DeferredIntent | null;
  }): NluDecision | null {
    const { clean, stage, extractedDoc, extractedName, sentiment, paymentMethod, domainIntent } = ctx;
    const base = {
      confidence: 1.0,
      extractedName,
      extractedDoc,
      paymentMethod,
      sentiment,
      contextualReply: null,
      deferredIntent: domainIntent,
    };

    if (stage === 'COLLECTING' || stage === 'WAITING_CONFIRMATION') {
      if (extractedDoc || extractedName) {
        return { ...base, intent: 'PROVIDE_IDENTIFICATION' };
      }
      if (domainIntent) {
        return { ...base, intent: domainIntent };
      }
      if (isGreeting(clean)) {
        return { ...base, intent: 'GREETING' };
      }
      return null;
    }

    if (stage === 'MAIN_MENU') {
      if (clean === '1') return { ...base, intent: 'PAGAR_BOLETO' };
      if (clean === '2') return { ...base, intent: 'VERIFICAR_SALDO' };
      if (clean === '3') return { ...base, intent: 'CELULAR_BLOQUEADO' };
      if (clean === '4') return { ...base, intent: 'FALAR_COM_ATENDENTE' };
      if (domainIntent) return { ...base, intent: domainIntent };
      return null;
    }

    if (
      stage === 'BOLETO_CONFIRM' ||
      stage === 'BOLETO_MULTI_CONFIRM' ||
      stage === 'SALDO_FOLLOWUP' ||
      stage === 'HUMAN_TOPIC_CONFIRM'
    ) {
      if (clean === '1' || CONFIRM_YES_REGEX.test(clean)) {
        return { ...base, intent: 'CONFIRM_YES' };
      }
      if (clean === '2' || CONFIRM_NO_REGEX.test(clean)) {
        return { ...base, intent: 'CONFIRM_NO' };
      }
      if (domainIntent === 'FALAR_COM_ATENDENTE') {
        return { ...base, intent: 'FALAR_COM_ATENDENTE' };
      }
      return null;
    }

    if (stage === 'BLOQUEIO_MENU') {
      if (clean === '1' || domainIntent === 'PAGAR_BOLETO') {
        return { ...base, intent: 'PAGAR_BOLETO' };
      }
      if (clean === '2' || domainIntent === 'INFORMAR_JA_PAGUEI') {
        return { ...base, intent: 'INFORMAR_JA_PAGUEI' };
      }
      if (clean === '3' || BACK_MENU_REGEX.test(clean)) {
        return { ...base, intent: 'BACK_TO_MENU' };
      }
      if (domainIntent === 'FALAR_COM_ATENDENTE') {
        return { ...base, intent: 'FALAR_COM_ATENDENTE' };
      }
      return null;
    }

    if (stage === 'BLOQUEIO_METODO') {
      if (clean === '1' || paymentMethod === 'pix') {
        return { ...base, intent: 'PAYMENT_METHOD_PIX', paymentMethod: 'pix' };
      }
      if (clean === '2' || paymentMethod === 'boleto') {
        return { ...base, intent: 'PAYMENT_METHOD_BOLETO', paymentMethod: 'boleto' };
      }
      if (BACK_MENU_REGEX.test(clean)) {
        return { ...base, intent: 'BACK_TO_MENU' };
      }
      if (domainIntent === 'FALAR_COM_ATENDENTE') {
        return { ...base, intent: 'FALAR_COM_ATENDENTE' };
      }
      return null;
    }

    return null;
  }
}

export default new DialogueNluService();
