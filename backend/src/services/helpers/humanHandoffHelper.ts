/**
 * @fileoverview Notifica os atendentes humanos configurados (HUMAN_HANDOFF_CONTACTS)
 * quando o roteiro determinístico (AthinaFlowService) transfere um atendimento —
 * boleto com múltiplas parcelas em atraso, comprovante de pagamento ou "falar
 * com atendente".
 */
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import type { Client as WWebClient } from 'whatsapp-web.js';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { maskPhone } from '../../utils/redact.js';
import analyticsService from '../AnalyticsService.js';
import type { DownloadedMedia } from './receiptAnalysisHelper.js';

export interface HandoffClientData {
  nome: string;
  cpf: string;
  imei: string;
}

/** Monta o bloco de dados do cliente enviado aos atendentes humanos. */
function buildClientBlock(client: HandoffClientData): string {
  return `📝 Nome: ${client.nome}\n🆔 CPF/IMEI: ${client.cpf || client.imei}`;
}

/**
 * Envia a notificação de transferência (texto + mídia opcional do comprovante)
 * para todos os contatos humanos configurados. Silenciosamente não faz nada
 * quando `HUMAN_HANDOFF_CONTACTS` está vazio — a transferência ainda assim
 * segue para o cliente, só não há ninguém configurado para avisar.
 */
export async function notifyHumanAgents(
  client: WWebClient,
  data: {
    client: HandoffClientData;
    reason: string;
    details: string;
    attachment?: DownloadedMedia;
  }
): Promise<void> {
  const contacts = config.humanHandoffContacts;
  if (contacts.length === 0) {
    logger.error('[HumanHandoff] HUMAN_HANDOFF_CONTACTS vazio — transferência NÃO notificada a ninguém');
    return;
  }

  const text = `🔔 Transferência de atendimento — ${data.reason}\n\n${buildClientBlock(data.client)}\n\n${data.details}`;

  for (const digits of contacts) {
    try {
      const resolved = await client.getNumberId(digits);
      if (!resolved) {
        logger.error({ to: maskPhone(digits) }, '[HumanHandoff] Número do atendente não existe no WhatsApp — revise HUMAN_HANDOFF_CONTACTS');
        continue;
      }
      await client.sendMessage(resolved._serialized, text);
      if (data.attachment) {
        const media = new MessageMedia(data.attachment.mimetype, data.attachment.base64);
        await client.sendMessage(resolved._serialized, media);
      }
      logger.info({ to: maskPhone(resolved._serialized) }, '[HumanHandoff] Atendente notificado');
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err), to: maskPhone(digits) },
        '[HumanHandoff] Falha ao notificar atendente humano'
      );
    }
  }

  await analyticsService.increment('humanInterventions');
}
