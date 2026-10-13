/**
 * @fileoverview Helper for handling real-time WhatsApp messages.
 */
import type { Message } from 'whatsapp-web.js';
import logger from '../../utils/logger.js';

/** Campos internos do whatsapp-web.js usados para tamanho, remetente e chat. */
type WwebMessage = Message & {
  size?: number;
  _data?: { size?: number; mimetype?: string; notifyName?: string };
  _getChatId?: () => string;
};
import { maskPhone } from '../../utils/redact.js';

/**
 * Teto do broadcast de mídia em tempo real, em caracteres de base64
 * (≈3,7MB binários). Espelha o limite do histórico; acima disso a mídia NÃO
 * é baixada/reenviada no evento — só o placeholder (mediaOmitted).
 * Antes: downloadMedia() completo + emit sem cap — um documento de 100MB
 * virava ~133MB de base64 em memória e no socket.
 */
const MAX_MEDIA_BASE64_CHARS = 5 * 1024 * 1024;

/** Handle incoming or outgoing WhatsApp messages and emit socket events */
export async function handleIncomingMessage(
  rawMsg: Message,
  emit: (event: string, data: unknown) => void
): Promise<void> {
  const msg = rawMsg as WwebMessage;
  if (msg.from?.includes('broadcast') || msg.to?.includes('broadcast')) return;

  logger.info(
    { from: maskPhone(msg.from), bodyLength: (msg.body ?? '').length, fromMe: msg.fromMe },
    'WhatsApp message created/received'
  );

  let mediaData: string | undefined;
  let mediaMimeType: string | undefined;
  let mediaOmitted = false;

  if (msg.hasMedia) {
    try {
      // Tamanho declarado (bytes) — evita o download quando já é grande demais
      const declaredSize = Number(msg._data?.size ?? msg.size ?? 0);
      if (declaredSize > MAX_MEDIA_BASE64_CHARS) {
        mediaOmitted = true;
      } else {
        const media = await msg.downloadMedia();
        if (media) {
          if (typeof media.data === 'string' && media.data.length > MAX_MEDIA_BASE64_CHARS) {
            mediaOmitted = true;
          } else {
            mediaData = media.data;
            mediaMimeType = media.mimetype;
          }
        }
      }
      if (mediaOmitted) {
        mediaMimeType = mediaMimeType ?? String(msg._data?.mimetype ?? 'application/octet-stream');
        logger.warn(
          { from: maskPhone(msg.from), declaredSize },
          'Mídia grande demais para o broadcast em tempo real — omitida'
        );
      }
    } catch (mediaErr) {
      logger.warn(
        { error: mediaErr instanceof Error ? mediaErr.message : String(mediaErr) },
        'Error downloading media for real-time message'
      );
    }
  }

  // Chat id canônico: para mensagens enviadas por NÓS, `msg.from` é o remetente
  // (nós) e o chat está em `msg.to`. Usa o helper oficial da lib com fallbacks
  // para nunca emitir `from: undefined` (que quebrava o handler do painel).
  const chatId =
    typeof msg._getChatId === 'function'
      ? msg._getChatId()
      : (msg.fromMe ? msg.to || msg.from : msg.from) || '';

  // Citação (reply): extrai a mensagem referenciada — só quando existe
  // (1 avaliação na página do Puppeteer por mensagem citada).
  let quoted: { body: string; fromMe: boolean } | undefined;
  if (msg.hasQuotedMsg) {
    try {
      const q = await msg.getQuotedMessage();
      if (q) {
        quoted = { body: q.body ?? '', fromMe: Boolean(q.fromMe) };
      }
    } catch {
      // citação indisponível (stub) — segue sem ela
    }
  }

  emit('whatsapp-message', {
    id: msg.id.id,
    serializedId: msg.id?._serialized,
    quoted,
    from: chatId,
    name:
      msg._data?.notifyName ||
      msg.author ||
      (msg.fromMe ? msg.to : msg.from)?.split('@')[0],
    body: msg.body,
    timestamp: msg.timestamp,
    sender: msg.fromMe ? 'agent' : 'customer',
    mediaData,
    mediaMimeType,
    ...(mediaOmitted ? { mediaOmitted: true } : {}),
    ...(typeof msg.ack === 'number' ? { ack: msg.ack } : {}),
  });
}
