/**
 * @fileoverview Socket.IO event handler registration with auth, rate limiting,
 * server-side chat state management, and analytics tracking.
 */
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;

import whatsAppService from '../services/WhatsAppService.js';
import aiService from '../services/AIService.js';
import chatStateService from '../services/ChatStateService.js';
import analyticsService from '../services/AnalyticsService.js';
import trainingService from '../services/TrainingService.js';
import { aiRateLimiter, ttsRateLimiter, paymobiRateLimiter, avatarRateLimiter } from './socket/rateLimiter.js';
import { safeEmit, type AthinaSocket } from './socket/safeEmit.js';
import { registerTrainingHandlers } from './socket/trainingHandlers.js';
import { PaymobiScraperService } from '../services/PaymobiScraperService.js';
import { generateTTS } from '../services/TTSService.js';
import { sanitizeForWhatsApp } from '../utils/sanitizeForWhatsApp.js';
import athinaFlowService from '../services/AthinaFlowService.js';
import { handleRequestChatHistory } from '../services/helpers/whatsappChatHelper.js';
import { resolveAvatars } from '../services/helpers/whatsappAvatarHelper.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import {
  aiRequestSchema,
  avatarsSchema,
  chatHistorySchema,
  contactIdSchema,
  paymobiConsultSchema,
  sendFileReplySchema,
  sendReplySchema,
  forwardMessageSchema,
  type ForwardMessagePayload,
  spellingSchema,
  ttsRequestSchema,
  updateChatStateSchema,
  voiceReplySchema,
} from '@shared/contracts.js';
import type {
  AIRequestPayload,
  ChatHistoryRequestPayload,
  ClientToServerEvents,
  PaymobiConsultPayload,
  SendFileReplyPayload,
  SendReplyPayload,
  ServerToClientEvents,
  SpellingRequestPayload,
  TtsRequestPayload,
  VoiceReplyPayload,
} from '@shared/contracts.js';
import type { Server } from 'socket.io';

// Socket.IO tipado com os contratos compartilhados (shared/contracts.ts)
type AthinaServer = Server<ClientToServerEvents, ServerToClientEvents>;

// ─── SocketController ────────────────────────────────────────────────────────
class SocketController {
  // Modo áudio POR SOCKET: o toggle de um operador não muda o envio dos demais.
  private audioModeSockets = new Set<string>();
  private io: AthinaServer;

  constructor(io: AthinaServer) {
    this.io = io;
  }

  registerSocket(socket: AthinaSocket): void {
    safeEmit(socket, 'server-status', whatsAppService.getClientState());
    // Tell the panel whether the autonomous server-side agent is answering customers
    safeEmit(socket, 'agent-mode', { serverAutoReply: athinaFlowService.isEnabled() });

    // Botão de ativação do painel: liga/desliga o atendimento automático e
    // sincroniza todos os painéis abertos.
    socket.on('set-auto-reply', (enabled: unknown) => {
      if (typeof enabled !== 'boolean') return;
      athinaFlowService.setEnabled(enabled);
      this.io.emit('agent-mode', { serverAutoReply: enabled });
    });

    registerTrainingHandlers(socket, this.io);

    // ─── Status ────────────────────────────────────────────────────────────
    socket.on('request-status', () => this.handleRequestStatus(socket));

    // ─── AI Request ────────────────────────────────────────────────────────
    socket.on('ai-request', (data: unknown) => {
      if (!aiRateLimiter.isAllowed(socket.id)) {
        safeEmit(socket, 'ai-error', { message: 'Rate limit exceeded. Please wait.' });
        return;
      }
      const parsed = aiRequestSchema.safeParse(data);
      if (!parsed.success) {
        safeEmit(socket, 'ai-error', { message: 'Invalid request payload.' });
        return;
      }
      this.handleAIRequest(socket, parsed.data).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Unhandled AI handler error');
        safeEmit(socket, 'ai-error', { message: 'Internal error.' });
      });
    });

    // ─── Send Reply ────────────────────────────────────────────────────────
    socket.on('send-reply', (data: unknown) => {
      const parsed = sendReplySchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid send-reply payload rejected');
        return;
      }
      this.handleSendReply(socket, parsed.data).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Unhandled send-reply error');
      });
    });

    // ─── Encaminhar mensagem existente para outro chat ─────────────────────
    socket.on('forward-message', (data: unknown) => {
      const parsed = forwardMessageSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid forward-message payload rejected');
        return;
      }
      this.handleForwardMessage(socket, parsed.data).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Unhandled forward-message error');
      });
    });

    // ─── Image Reply (imagem colada/arrastada pelo operador) ───────────────
    socket.on('send-file-reply', (data: unknown) => {
      const parsed = sendFileReplySchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid send-file-reply payload rejected');
        return;
      }
      this.handleSendFileReply(parsed.data).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'File reply failed');
      });
    });

    // ─── Restart WhatsApp ──────────────────────────────────────────────────
    socket.on('restart-whatsapp', () => {
      this.handleRestartWhatsApp(socket).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Unhandled restart error');
      });
    });

    // ─── Paymobi Consult ───────────────────────────────────────────────────
    socket.on('consult-paymobi', (data: unknown) => {
      if (!paymobiRateLimiter.isAllowed(socket.id)) {
        safeEmit(socket, 'paymobi-error', { message: 'Rate limit exceeded. Please wait.' });
        return;
      }
      const parsed = paymobiConsultSchema.safeParse(data);
      if (!parsed.success) {
        safeEmit(socket, 'paymobi-error', { message: 'Invalid search parameters.' });
        return;
      }
      this.handleConsultPaymobi(socket, parsed.data).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Unhandled paymobi error');
        safeEmit(socket, 'paymobi-error', { message: 'Internal error.' });
      });
    });

    // ─── Audio Mode Toggle ─────────────────────────────────────────────────
    socket.on('toggle-audio-mode', (enabled: unknown) => {
      if (typeof enabled !== 'boolean') {
        logger.warn({ socketId: socket.id }, 'Invalid toggle-audio-mode payload');
        return;
      }
      if (enabled) this.audioModeSockets.add(socket.id);
      else this.audioModeSockets.delete(socket.id);
      logger.info({ enabled, socketId: socket.id }, 'Audio mode toggled');
    });

    // ─── TTS Generation ────────────────────────────────────────────────────
    socket.on('generate-tts-audio', (data: unknown) => {
      if (!ttsRateLimiter.isAllowed(socket.id)) {
        safeEmit(socket, 'tts-audio-error', { message: 'Rate limit exceeded.' });
        return;
      }
      const parsed = ttsRequestSchema.safeParse(data);
      if (!parsed.success) {
        safeEmit(socket, 'tts-audio-error', { message: 'Invalid TTS request.' });
        return;
      }
      this.handleGenerateTTSAudio(socket, parsed.data).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Unhandled TTS error');
        safeEmit(socket, 'tts-audio-error', { message: 'Internal error.' });
      });
    });

    // ─── Spelling Correction ───────────────────────────────────────────────
    socket.on('correct-spelling', (data: unknown) => {
      if (!aiRateLimiter.isAllowed(socket.id)) {
        safeEmit(socket, 'spelling-error', { message: 'Rate limit exceeded.' });
        return;
      }
      const parsed = spellingSchema.safeParse(data);
      if (!parsed.success) {
        safeEmit(socket, 'spelling-error', { message: 'Invalid request.' });
        return;
      }
      this.handleCorrectSpelling(socket, parsed.data).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Unhandled spelling error');
        safeEmit(socket, 'spelling-error', { message: 'Internal error.' });
      });
    });

    // ─── Voice Reply ───────────────────────────────────────────────────────
    socket.on('send-voice-reply', (data: unknown) => {
      const parsed = voiceReplySchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid send-voice-reply payload rejected');
        return;
      }
      this.handleSendVoiceReply(socket, parsed.data).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Unhandled voice reply error');
      });
    });

    // ─── Chat History ──────────────────────────────────────────────────────
    socket.on('request-chat-history', (data: unknown) => {
      const parsed = chatHistorySchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid request-chat-history payload rejected');
        return;
      }
      this.handleRequestChatHistory(socket, parsed.data).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Unhandled chat history error');
      });
    });

    // ─── Chat State (server-side) ──────────────────────────────────────────
    // Salva estágio do fluxo exibido pelo painel (ex.: WAITING_CONFIRMATION
    // com os dados do contrato). SEM isto, o "SIM" do cliente caía de volta
    // na etapa de coleta e re-consultava em loop sem nunca enviar o boleto.
    socket.on('update-chat-state', (data: unknown) => {
      const parsed = updateChatStateSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid update-chat-state payload rejected');
        return;
      }
      chatStateService
        .setState(parsed.data.contactId, parsed.data.state)
        .then(() => {
          logger.info(
            { contactId: parsed.data.contactId, stage: parsed.data.state.stage },
            'Chat state updated'
          );
        })
        .catch((err) => {
          logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to update chat state');
        });
    });

    socket.on('get-chat-state', async (data: unknown) => {
      const parsed = contactIdSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid get-chat-state payload rejected');
        return;
      }
      try {
        const state = await chatStateService.getState(parsed.data.contactId);
        safeEmit(socket, 'chat-state-loaded', { contactId: parsed.data.contactId, state });
      } catch (err) {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Failed to get chat state');
      }
    });

    socket.on('reset-chat-state', async (data: unknown) => {
      const parsed = contactIdSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid reset-chat-state payload rejected');
        return;
      }
      try {
        await chatStateService.resetState(parsed.data.contactId);
        safeEmit(socket, 'chat-state-reset', { contactId: parsed.data.contactId });
      } catch (err) {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Failed to reset chat state');
      }
    });

    // ─── Marcar conversa como LIDA no WhatsApp (ticks azuis no cliente) ────
    // Handler pronto porém DORMENTE: o painel só o aciona quando
    // MARK_READ_ON_OPEN estiver ligado no frontend (useSocket.ts), porque
    // enviar recibo de leitura é VISÍVEL PARA O CLIENTE.
    socket.on('mark-chat-read', async (data: unknown) => {
      const parsed = contactIdSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid mark-chat-read payload rejected');
        return;
      }
      try {
        const client = whatsAppService.getClient();
        if (client && whatsAppService.getClientState() === 'READY') {
          const chat = await client.getChatById(parsed.data.contactId);
          await chat.sendSeen();
        }
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err), chatId: parsed.data.contactId },
          'mark-chat-read failed'
        );
      }
    });

    // ─── Avatares (foto de perfil dos contatos) ───────────────────────────
    socket.on('get-contact-avatars', (data: unknown) => {
      if (!avatarRateLimiter.isAllowed(socket.id)) {
        logger.warn({ socketId: socket.id }, 'Avatar rate limit exceeded');
        return;
      }
      const parsed = avatarsSchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid get-contact-avatars payload rejected');
        return;
      }
      this.handleGetAvatars(socket, parsed.data.jids).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Avatar resolution failed');
      });
    });

    // ─── Analytics ─────────────────────────────────────────────────────────
    socket.on('get-stats', async () => {
      try {
        const stats = await analyticsService.getStats();
        safeEmit(socket, 'analytics-stats', stats);
      } catch (err) {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Failed to get stats');
      }
    });

    socket.on('reset-stats', async () => {
      try {
        await analyticsService.resetStats();
        const stats = await analyticsService.getStats();
        safeEmit(socket, 'analytics-stats', stats);
      } catch (err) {
        logger.error({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Failed to reset stats');
      }
    });

    // ─── Cleanup on disconnect ─────────────────────────────────────────────
    socket.on('disconnect', () => {
      aiRateLimiter.cleanup(socket.id);
      ttsRateLimiter.cleanup(socket.id);
      paymobiRateLimiter.cleanup(socket.id);
      avatarRateLimiter.cleanup(socket.id);
      this.audioModeSockets.delete(socket.id);
    });
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────

  private async handleRequestStatus(socket: AthinaSocket): Promise<void> {
    const status = whatsAppService.getConnectionStatus();
    safeEmit(socket, 'server-status', status.state);

    if (status.isConnected) {
      safeEmit(socket, 'whatsapp-ready');
      try {
        const chats = await whatsAppService.getRecentChats();
        safeEmit(socket, 'chats-loaded', chats);

        // Send current stats
        const stats = await analyticsService.getStats();
        safeEmit(socket, 'analytics-stats', stats);
      } catch (err) {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to load chats');
      }
    } else if (status.lastQR) {
      safeEmit(socket, 'whatsapp-qr', status.lastQR);
    }
  }

  private async handleAIRequest(socket: AthinaSocket, data: AIRequestPayload): Promise<void> {
    try {
      const reply = await aiService.call(data);
      safeEmit(socket, 'ai-response', { text: reply, contactId: data.contactId });
      await analyticsService.increment('autoResolved');
    } catch (error) {
      safeEmit(socket, 'ai-error', { message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async handleForwardMessage(socket: AthinaSocket, data: ForwardMessagePayload): Promise<void> {
    const client = whatsAppService.getClient();
    if (!client || whatsAppService.getClientState() !== 'READY') {
      safeEmit(socket, 'server-status', 'WhatsApp não está pronto para encaminhar a mensagem.');
      return;
    }
    const original = await client.getMessageById(data.serializedId);
    if (!original) {
      safeEmit(socket, 'server-status', 'Não foi possível localizar a mensagem para encaminhar.');
      return;
    }
    await original.forward(data.to);
    logger.info({ to: data.to }, 'Message forwarded');
  }

  private async handleSendReply(
    socket: AthinaSocket,
    data: SendReplyPayload
  ): Promise<void> {
    try {
      // O painel assumiu a conversa: pausa o roteiro automático para este
      // contato (evita respostas duplicadas/conflitantes) …
      athinaFlowService.noteHumanReply(data.to);

      // … e aprende com a resposta humana: pergunta do cliente → resposta
      // aprovada pelo operador entra na base (learning_database.json).
      if (data.isManual) {
        const question = athinaFlowService.getLastInbound(data.to);
        if (question) {
          trainingService.learnFromExchange(question, data.text);
        }
      }

      const client = whatsAppService.getClient();
      const isReady = whatsAppService.getClientState() === 'READY';
      // Sanitização determinística de TODA saída do painel: remove markdown
      // (asteriscos literais no WhatsApp e na fala do TTS) e mascara CPF.
      const safeText = sanitizeForWhatsApp(data.text);
      if (isReady && client) {
        if (this.audioModeSockets.has(socket.id)) {
          logger.info({ to: data.to, textLength: safeText.length }, 'Audio mode: synthesizing speech');
          try {
            const base64 = await generateTTS(safeText);
            const media = new MessageMedia('audio/ogg; codecs=opus', base64, 'voice.ogg');
            await client.sendMessage(data.to, media, {
              sendAudioAsVoice: true,
              ...(data.quotedMessageId ? { quotedMessageId: data.quotedMessageId } : {}),
            });
            logger.info({ to: data.to }, 'Voice note sent');
            return;
          } catch (ttsErr) {
            logger.error({ error: ttsErr instanceof Error ? ttsErr.message : String(ttsErr) }, 'TTS failed, falling back to text');
          }
        }
        await client.sendMessage(data.to, safeText, {
          ...(data.quotedMessageId ? { quotedMessageId: data.quotedMessageId } : {}),
        });
      } else {
        // Antes: descarte silencioso (a resposta sumia sem aviso). Agora o
        // painel recebe um evento e pode avisar/reenfileirar o operador.
        safeEmit(socket, 'send-failed', { to: data.to, reason: 'whatsapp-not-ready' });
      }
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Error sending reply');
    }
  }

  private async handleGenerateTTSAudio(
    socket: AthinaSocket,
    data: TtsRequestPayload
  ): Promise<void> {
    try {
      const base64 = await generateTTS(data.text, data.voice);
      safeEmit(socket, 'tts-audio-generated', { base64 });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'TTS generation failed');
      safeEmit(socket, 'tts-audio-error', { message: error instanceof Error ? error.message : 'TTS error' });
    }
  }

  private async handleCorrectSpelling(
    socket: AthinaSocket,
    data: SpellingRequestPayload
  ): Promise<void> {
    try {
      const systemInstruction = 'Você é o revisor ortográfico e sintático oficial da inteligência artificial Athina. Sua única e exclusiva tarefa é revisar o texto digitado pelo operador para que ele seja ideal para síntese de voz (TTS) em português brasileiro. Siga rigidamente as seguintes diretrizes: 1. Adicione acentuação correta a todas as palavras. 2. Insira pontuação natural e fluida. 3. Corrija a ortografia sem formalizar excessivamente o texto. 4. Escreva números, valores (R$ 89,90 vira \"oitenta e nove reais e noventa centavos\"), datas (05/11/2026 vira \"cinco de novembro de dois mil e vinte e seis\") e horários por extenso; \"24x\" vira \"vinte e quatro vezes\". 5. Remova emojis, asteriscos e qualquer marcação — o texto será FALADO, não exibido. 6. Não inclua códigos PIX copia-e-cola no texto de fala. 7. Frases curtas, próprias para leitura em voz alta. 8. Responda APENAS com o texto corrigido pronto para fala. Nunca adicione explicações.';
      const reply = await aiService.call({
        model: data.model || 'nvidia/nemotron-3.5-lightning-30b-a3b',
        persona: systemInstruction,
        message: data.text,
        contactId: 'spelling-correction',
      });
      safeEmit(socket, 'spelling-corrected', { text: reply.trim() });
    } catch (error) {
      safeEmit(socket, 'spelling-error', { message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /** Envia imagem (MessageMedia) com legenda opcional para o chat. */
  private async handleSendFileReply(data: SendFileReplyPayload): Promise<void> {
    try {
      const client = whatsAppService.getClient();
      if (!client || whatsAppService.getClientState() !== 'READY') {
        logger.warn({ to: data.to }, 'File reply ignorado: WhatsApp não está pronto');
        return;
      }
      const media = new MessageMedia(data.mimetype, data.base64, data.filename);
      const isPlainMedia = data.mimetype.startsWith('image/') || data.mimetype.startsWith('video/');
      await client.sendMessage(data.to, media, {
        ...(data.caption ? { caption: data.caption } : {}),
        ...(isPlainMedia ? {} : { sendMediaAsDocument: true }),
      });
      logger.info({ to: data.to, mimetype: data.mimetype, caption: Boolean(data.caption) }, 'File reply sent');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Error sending file reply');
    }
  }

  private async handleSendVoiceReply(
    _socket: AthinaSocket,
    data: VoiceReplyPayload
  ): Promise<void> {
    try {
      const client = whatsAppService.getClient();
      if (whatsAppService.getClientState() === 'READY' && client) {
        const media = new MessageMedia('audio/ogg; codecs=opus', data.base64, 'voice.ogg');
        await client.sendMessage(data.to, media, { sendAudioAsVoice: true });
        logger.info({ to: data.to }, 'Voice reply sent');
      } else {
        throw new Error('WhatsApp client is not ready');
      }
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Error sending voice reply');
    }
  }

  private async handleRestartWhatsApp(socket: AthinaSocket): Promise<void> {
    // Security fix: Deny by default - admin secret MUST be configured
    if (!config.adminSecret) {
      logger.error('[SocketController] restart-whatsapp denied: ADMIN_SECRET not configured on server');
      safeEmit(socket, 'paymobi-error', { message: 'Admin operations are not available.' });
      return;
    }

    const token = socket.handshake.auth?.token;
    if (token !== config.adminSecret) {
      logger.warn({ socketId: socket.id }, '[SocketController] Unauthorized restart attempt');
      safeEmit(socket, 'paymobi-error', { message: 'Unauthorized.' });
      return;
    }

    logger.info({ socketId: socket.id }, '[SocketController] Restarting WhatsApp (authorized)');
    safeEmit(socket, 'whatsapp-disconnected');
    await whatsAppService.destroy();
    await whatsAppService.clearSession();
    setTimeout(() => {
      whatsAppService.init().catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to re-init WhatsApp after restart');
      });
    }, 3000);
  }

  private async handleConsultPaymobi(
    socket: AthinaSocket,
    data: PaymobiConsultPayload
  ): Promise<void> {
    const email = config.paymobiEmail;
    const password = config.paymobiPassword;
    if (!email || !password) {
      safeEmit(socket, 'paymobi-error', { message: 'Paymobi credentials not configured.', contactId: data.contactId });
      return;
    }
    try {
      const scraper = new PaymobiScraperService(email, password);
      const result = await scraper.scrape({ query: data.query, clientName: data.clientName, searchType: data.searchType });
      safeEmit(socket, 'paymobi-result', { result, contactId: data.contactId });

      // Track analytics
      if (result.success) {
        await analyticsService.increment('totalChats');
      }
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Paymobi search failed');
      safeEmit(socket, 'paymobi-error', { message: error instanceof Error ? error.message : 'Unknown error', contactId: data.contactId });
    }
  }

  /** Resolve fotos de perfil (com cache no helper) e devolve no socket. */
  private async handleGetAvatars(socket: AthinaSocket, jids: string[]): Promise<void> {
    const client = whatsAppService.getClient();
    const ready = whatsAppService.getClientState() === 'READY';
    const avatars = ready && client ? await resolveAvatars(client, jids) : {};
    safeEmit(socket, 'contact-avatars', { avatars });
  }

  private async handleRequestChatHistory(
    socket: AthinaSocket,
    data: ChatHistoryRequestPayload
  ): Promise<void> {
    const client = whatsAppService.getClient();
    await handleRequestChatHistory(
      socket,
      data.chatId,
      client,
      whatsAppService.getClientState() === 'READY',
      data.limit ?? 15
    );
  }
}

export default SocketController;
