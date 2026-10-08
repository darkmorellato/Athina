/**
 * @fileoverview Socket.IO event handler registration with auth, rate limiting,
 * server-side chat state management, and analytics tracking.
 */
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;

import { z } from 'zod';
import whatsAppService from '../services/WhatsAppService.js';
import aiService from '../services/AIService.js';
import chatStateService from '../services/ChatStateService.js';
import analyticsService from '../services/AnalyticsService.js';
import trainingService from '../services/TrainingService.js';
import { PaymobiScraperService } from '../services/PaymobiScraperService.js';
import { generateTTS } from '../services/TTSService.js';
import agentService, { sanitizeForWhatsApp } from '../services/AgentService.js';
import { handleRequestChatHistory } from '../services/helpers/whatsappChatHelper.js';
import { resolveAvatars } from '../services/helpers/whatsappAvatarHelper.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import type { AIRequest, PaymobiSearchParams } from '../types/index.js';
import type { Server, Socket } from 'socket.io';

// ─── Input Validation Schemas (Zod) ──────────────────────────────────────────
const aiRequestSchema = z.object({
  model: z.string().min(1).max(200),
  persona: z.string().max(8000),
  message: z.string().min(1).max(10000),
  contactId: z.string().min(1).max(200),
});

const sendReplySchema = z.object({
  to: z.string().min(1).max(100),
  text: z.string().min(1).max(10000),
  isManual: z.boolean().optional(),
  /** id serializado da mensagem citada (reply/quote do WhatsApp) */
  quotedMessageId: z.string().min(1).max(300).optional(),
});

const voiceReplySchema = z.object({
  to: z.string().min(1).max(100),
  base64: z.string().min(1).max(20_000_000),
});

const ttsRequestSchema = z.object({
  text: z.string().min(1).max(10000),
  voice: z.string().max(100).optional(),
});

const spellingSchema = z.object({
  text: z.string().min(1).max(10000),
  model: z.string().max(200).optional(),
});

const chatHistorySchema = z.object({
  chatId: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(120).optional(),
});

const contactIdSchema = z.object({
  contactId: z.string().min(1).max(200),
});

const sendImageReplySchema = z.object({
  to: z.string().min(1).max(100),
  // base64 de ~15MB binário cabe no maxHttpBufferSize (25MB) com folga
  base64: z.string().min(1).max(20_000_000),
  mimetype: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  caption: z.string().max(1024).optional(),
});

const avatarsSchema = z.object({
  jids: z.array(z.string().min(3).max(200)).min(1).max(60),
});

const updateChatStateSchema = z.object({
  contactId: z.string().min(1).max(200),
  state: z.object({
    stage: z.enum(['COLLECTING', 'WAITING_CONFIRMATION']),
    // pendingData é o contrato retornado pelo Paymobi (validado por fora)
    pendingData: z.any().optional(),
    // collect = dados parciais da coleta (nome/CPF-IMEI) por contato
    collect: z
      .object({
        name: z.string().max(120).optional(),
        doc: z.string().max(30).optional(),
      })
      .nullable()
      .optional(),
  }),
});

const paymobiSchema = z.object({
  query: z.string().min(1).max(50),
  clientName: z.string().max(200).optional(),
  searchType: z.enum(['imei', 'cpf', 'name']).optional(),
  contactId: z.string().max(200).optional(),
});

// ─── Rate Limiter ────────────────────────────────────────────────────────────
class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly clients = new Map<string, number[]>();

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  isAllowed(socketId: string): boolean {
    const now = Date.now();
    const timestamps = this.clients.get(socketId) ?? [];
    const recent = timestamps.filter((t) => now - t < this.windowMs);

    if (recent.length >= this.maxRequests) {
      return false;
    }

    recent.push(now);
    this.clients.set(socketId, recent);
    return true;
  }

  cleanup(socketId: string): void {
    this.clients.delete(socketId);
  }

  /** Security fix: Remove stale entries to prevent unbounded memory growth */
  cleanupStale(): void {
    const now = Date.now();
    for (const [socketId, timestamps] of this.clients.entries()) {
      const recent = timestamps.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) {
        this.clients.delete(socketId);
      } else {
        this.clients.set(socketId, recent);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}

const aiRateLimiter = new RateLimiter(60_000, 30);
const ttsRateLimiter = new RateLimiter(60_000, 10);
const paymobiRateLimiter = new RateLimiter(60_000, 10);
const avatarRateLimiter = new RateLimiter(60_000, 30);

// Security fix: Periodic cleanup of stale rate limiter entries (every 5 minutes)
const rateLimiterCleanupInterval = setInterval(() => {
  aiRateLimiter.cleanupStale();
  ttsRateLimiter.cleanupStale();
  paymobiRateLimiter.cleanupStale();
  logger.debug(
    { ai: aiRateLimiter.size, tts: ttsRateLimiter.size, paymobi: paymobiRateLimiter.size },
    'Rate limiters cleaned up'
  );
}, 300_000);
rateLimiterCleanupInterval.unref();

// ─── Safe Emit Helper ────────────────────────────────────────────────────────
/** Safely emit a socket event with error handling. */
function safeEmit(socket: Socket, event: string, data?: unknown): void {
  try {
    socket.emit(event, data);
  } catch (err) {
    logger.error({ event, socketId: socket.id, error: err instanceof Error ? err.message : String(err) }, 'Socket emit failed');
  }
}

// ─── SocketController ────────────────────────────────────────────────────────
class SocketController {
  private isAudioModeActive = false;
  private io: Server;

  constructor(io: Server) {
    this.io = io;
  }

  registerSocket(socket: Socket): void {
    safeEmit(socket, 'server-status', whatsAppService.getClientState());
    // Tell the panel whether the autonomous server-side agent is answering customers
    safeEmit(socket, 'agent-mode', { serverAutoReply: config.agentAutoReply });

    // ─── Training data (persisted in backend/learning_database.json) ───────
    socket.on('update-training-rules', (rules: unknown) => {
      try {
        const updated = trainingService.setRules(rules);
        this.io.emit('training-data-updated', updated);
        logger.info({ count: updated.customRules.length, socketId: socket.id }, 'Training rules updated');
      } catch (err) {
        logger.warn({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Invalid training rules rejected');
      }
    });

    socket.on('update-training-qas', (qas: unknown) => {
      try {
        const updated = trainingService.setQas(qas);
        this.io.emit('training-data-updated', updated);
        logger.info({ count: updated.qaExamples.length, socketId: socket.id }, 'Training QAs updated');
      } catch (err) {
        logger.warn({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Invalid training QAs rejected');
      }
    });

    socket.on('request-training', () => {
      safeEmit(socket, 'training-data', trainingService.getTraining());
    });

    // Send persisted training data immediately so the panel always starts in sync
    safeEmit(socket, 'training-data', trainingService.getTraining());

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

    // ─── Image Reply (imagem colada/arrastada pelo operador) ───────────────
    socket.on('send-image-reply', (data: unknown) => {
      const parsed = sendImageReplySchema.safeParse(data);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'Invalid send-image-reply payload rejected');
        return;
      }
      this.handleSendImageReply(parsed.data).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Image reply failed');
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
      const parsed = paymobiSchema.safeParse(data);
      if (!parsed.success) {
        safeEmit(socket, 'paymobi-error', { message: 'Invalid search parameters.' });
        return;
      }
      this.handleConsultPaymobi(socket, parsed.data as PaymobiSearchParams).catch((err) => {
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
      this.isAudioModeActive = enabled;
      logger.info({ enabled }, 'Audio mode toggled');
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
    });
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────

  private async handleRequestStatus(socket: Socket): Promise<void> {
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

  private async handleAIRequest(socket: Socket, data: AIRequest): Promise<void> {
    try {
      const reply = await aiService.call(data);
      safeEmit(socket, 'ai-response', { text: reply, contactId: data.contactId });
      await analyticsService.increment('autoResolved');
    } catch (error) {
      safeEmit(socket, 'ai-error', { message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async handleSendReply(
    _socket: Socket,
    data: { to: string; text: string; isManual?: boolean; quotedMessageId?: string }
  ): Promise<void> {
    try {
      // O painel assumiu a conversa: pausa o agente autônomo para este contato
      // (evita respostas duplicadas/conflitantes) …
      agentService.noteHumanReply(data.to);

      // … e aprende com a resposta humana: pergunta do cliente → resposta
      // aprovada pelo operador entra na base (learning_database.json).
      if (data.isManual) {
        const question = agentService.getLastInbound(data.to);
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
        if (this.isAudioModeActive) {
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
      }
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Error sending reply');
    }
  }

  private async handleGenerateTTSAudio(
    socket: Socket,
    data: { text: string; voice?: string }
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
    socket: Socket,
    data: { text: string; model?: string }
  ): Promise<void> {
    try {
      const systemInstruction = 'Você é o revisor ortográfico e sintático oficial da inteligência artificial Athina. Sua única e exclusiva tarefa é revisar o texto digitado pelo operador para que ele seja ideal para síntese de voz (TTS) em português brasileiro. Siga rigidamente as seguintes diretrizes: 1. Adicione acentuação correta a todas as palavras. 2. Insira pontuação natural e fluida. 3. Corrija a ortografia sem formalizar excessivamente o texto. 4. Responda APENAS com o texto corrigido pronto para fala. Nunca adicione explicações.';
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
  private async handleSendImageReply(data: {
    to: string;
    base64: string;
    mimetype: string;
    caption?: string;
  }): Promise<void> {
    try {
      const client = whatsAppService.getClient();
      if (!client || whatsAppService.getClientState() !== 'READY') {
        logger.warn({ to: data.to }, 'Image reply ignorado: WhatsApp não está pronto');
        return;
      }
      const ext = data.mimetype.split('/')[1] || 'jpg';
      const media = new MessageMedia(data.mimetype, data.base64, `imagem.${ext}`);
      await client.sendMessage(data.to, media, data.caption ? { caption: data.caption } : {});
      logger.info({ to: data.to, mimetype: data.mimetype, caption: Boolean(data.caption) }, 'Image reply sent');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Error sending image reply');
    }
  }

  private async handleSendVoiceReply(
    _socket: Socket,
    data: { to: string; base64: string }
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

  private async handleRestartWhatsApp(socket: Socket): Promise<void> {
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
    socket: Socket,
    data: PaymobiSearchParams
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
  private async handleGetAvatars(socket: Socket, jids: string[]): Promise<void> {
    const client = whatsAppService.getClient();
    const ready = whatsAppService.getClientState() === 'READY';
    const avatars = ready && client ? await resolveAvatars(client, jids) : {};
    safeEmit(socket, 'contact-avatars', { avatars });
  }

  private async handleRequestChatHistory(
    socket: Socket,
    data: { chatId: string; limit?: number }
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
