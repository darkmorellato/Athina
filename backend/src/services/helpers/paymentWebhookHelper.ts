/**
 * @fileoverview Webhook de confirmação proativa de pagamento (Cel.cash / Galax Pay / Paymobi).
 *
 * Valida a assinatura HMAC-SHA256 (`x-webhook-signature`) em tempo constante,
 * limpa o estado de pendência do contato no SQLite, contabiliza a resolução
 * automática em Analytics e envia notificação proativa de confirmação e
 * desbloqueio ao cliente no WhatsApp.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import chatStateService from '../ChatStateService.js';
import analyticsService from '../AnalyticsService.js';
import whatsAppService from '../WhatsAppService.js';
import { sanitizeForWhatsApp } from '../../utils/sanitizeForWhatsApp.js';
import logger from '../../utils/logger.js';

export const paymentWebhookPayloadSchema = z.object({
  contactId: z.string().min(5).max(100).optional(),
  phone: z.string().min(8).max(30).optional(),
  customerName: z.string().max(200).optional(),
  installmentNumber: z.union([z.string(), z.number()]).optional(),
  value: z.union([z.string(), z.number()]).optional(),
  status: z.enum(['paid', 'confirmed', 'settled']),
});

export type PaymentWebhookPayload = z.infer<typeof paymentWebhookPayloadSchema>;

/** Gera a assinatura HMAC-SHA256 hexadecimal do corpo bruto do webhook. */
export function signWebhookPayload(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Verifica a assinatura HMAC-SHA256 em tempo constante (aceita prefixo opcional `sha256=`). */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!rawBody || !signatureHeader || !secret) return false;
  const cleanHeader = signatureHeader.trim().replace(/^sha256=/i, '');
  const expected = signWebhookPayload(rawBody, secret);
  const a = Buffer.from(cleanHeader, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function resolveTargetJid(payload: PaymentWebhookPayload): string | null {
  if (payload.contactId && payload.contactId.includes('@')) {
    return payload.contactId.trim();
  }
  const digits = (payload.phone ?? payload.contactId ?? '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  const withCountry = digits.length <= 11 && !digits.startsWith('55') ? `55${digits}` : digits;
  return `${withCountry}@c.us`;
}

export async function processPaymentWebhook(
  rawPayload: unknown,
  deps?: {
    sendMessage?: (to: string, text: string) => Promise<void>;
  }
): Promise<{ notified: boolean; contactId: string | null }> {
  const parsed = paymentWebhookPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new Error('Invalid payment webhook payload');
  }

  const data = parsed.data;
  const targetJid = resolveTargetJid(data);
  if (!targetJid) {
    throw new Error('Missing valid phone or contactId in payment webhook');
  }

  await chatStateService.resetFlowState(targetJid);
  await analyticsService.increment('autoResolved');

  const firstName = data.customerName?.trim().split(/\s+/)[0] || 'cliente';
  const parcelaInfo = data.installmentNumber ? ` da parcela ${data.installmentNumber}` : '';
  const valorInfo = data.value ? ` (${data.value})` : '';

  const text = sanitizeForWhatsApp(
    `Olá, ${firstName}! 🎉\n\n` +
      `Recebemos a confirmação do seu pagamento${parcelaInfo}${valorInfo}. ✅\n\n` +
      `Caso o seu aparelho estivesse bloqueado, mantenha-o conectado à internet (Wi-Fi ou dados móveis) para que o desbloqueio automático ocorra em instantes. 📲\n\n` +
      `A Financeira Nuovopay agradece a sua parceria! 💙`
  );

  const sendFn =
    deps?.sendMessage ??
    (async (to: string, body: string) => {
      const client = whatsAppService.getClient();
      if (!client || whatsAppService.getClientState() !== 'READY') {
        throw new Error('WhatsApp client not ready');
      }
      await client.sendMessage(to, body);
    });

  try {
    await sendFn(targetJid, text);
    logger.info({ contactId: targetJid }, '[PaymentWebhook] Confirmação proativa enviada ao cliente');
    return { notified: true, contactId: targetJid };
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), contactId: targetJid },
      '[PaymentWebhook] Estado limpo, mas envio WhatsApp falhou'
    );
    return { notified: false, contactId: targetJid };
  }
}
