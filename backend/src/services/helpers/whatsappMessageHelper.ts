/**
 * @fileoverview Helper for handling real-time WhatsApp messages.
 */
import logger from '../../utils/logger.js';

/** Handle incoming or outgoing WhatsApp messages and emit socket events */
export async function handleIncomingMessage(
  msg: any,
  emit: (event: string, data: any) => void
): Promise<void> {
  if (msg.from?.includes('broadcast') || msg.to?.includes('broadcast')) return;
  
  logger.info(
    { from: msg.from, bodyLength: (msg.body ?? '').length, fromMe: msg.fromMe },
    'WhatsApp message created/received'
  );

  let mediaData: string | undefined;
  let mediaMimeType: string | undefined;

  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      if (media) {
        mediaData = media.data;
        mediaMimeType = media.mimetype;
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
  });
}
