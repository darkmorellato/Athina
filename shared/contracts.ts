/**
 * @fileoverview CONTRATOS COMPARTILHADOS painel ↔ backend — fonte única de verdade.
 *
 * Regra de ouro: mudou um evento ou payload aqui, os DOIS lados acusam no
 * typecheck (painel: tsc/vite; backend: tsc/tsx). Nunca declare de novo os
 * tipos de evento em src/types ou backend/src/types.
 *
 * - ClientToServerEvents / ServerToClientEvents: mapa tipado do Socket.IO
 *   (use `Socket<ServerToClientEvents, ClientToServerEvents>` no painel e
 *   `Server<ClientToServerEvents, ServerToClientEvents>` no backend).
 * - Schemas zod: validação de ENTRADA no backend (os que já existiam foram
 *   movidos de SocketController.ts para cá, sem mudança de comportamento).
 */
import { z } from 'zod';

// ─── Tipos de domínio compartilhados ─────────────────────────────────────────

export const qaExampleSchema = z.object({
  intent: z.string(),
  question: z.string(),
  answer: z.string(),
});
export type QAExample = z.infer<typeof qaExampleSchema>;

export const trainingDataSchema = z.object({
  customRules: z.array(z.string()),
  qaExamples: z.array(qaExampleSchema),
});
export type TrainingData = z.infer<typeof trainingDataSchema>;

export const analyticsStatsSchema = z.object({
  totalChats: z.number(),
  autoResolved: z.number(),
  humanInterventions: z.number(),
  ocrScans: z.number(),
  ocrValids: z.number(),
  ocrSuspicious: z.number(),
  intentCounts: z.record(z.string(), z.number()),
});
export type AnalyticsStats = z.infer<typeof analyticsStatsSchema>;

export const agentLogSchema = z.object({
  id: z.string(),
  type: z.enum(['info', 'success', 'process', 'error']),
  text: z.string(),
  time: z.string(),
});
export type AgentLog = z.infer<typeof agentLogSchema>;

/** Mensagem de WhatsApp recebida pelo painel (evento 'whatsapp-message'). */
export const waMessageSchema = z.object({
  id: z.string().optional(),
  from: z.string(),
  name: z.string().optional(),
  number: z.string().optional(),
  body: z.string(),
  sender: z.enum(['customer', 'agent']).optional(),
  mediaMimeType: z.string().optional(),
  mediaData: z.string().optional(),
  /** Unix timestamp em SEGUNDOS — o painel ordena a conversa por ele */
  timestamp: z.number().optional(),
  /** id SERIALIZADO no formato do WhatsApp (necessário para citar/responder) */
  serializedId: z.string().optional(),
  /** Mensagem citada (reply) quando esta mensagem é uma resposta */
  quoted: z.object({ body: z.string(), fromMe: z.boolean() }).optional(),
});
export type WAMessage = z.infer<typeof waMessageSchema>;

/** Mensagem renderizada no painel (inclui as criadas localmente pelo operador). */
export interface ChatMessage {
  id: string;
  text: string;
  sender: 'customer' | 'agent';
  fromId: string;
  fromName?: string;
  time: string;
  timestamp?: number;
  ocrStatus?: 'safe' | 'suspicious' | 'fraud';
  ocrLabel?: string;
  ocrReason?: string;
  ocrValue?: string;
  ocrDate?: string;
  mediaMimeType?: string;
  mediaData?: string;
  serializedId?: string;
  quoted?: { body: string; fromMe: boolean };
}

/** Conversa carregada em lote (evento 'chats-loaded'). */
export interface LoadedChat {
  id: string;
  name: string;
  messages: ChatMessage[];
}

// ─── Estado de atendimento (servidor) ────────────────────────────────────────

export const chatStageSchema = z.enum(['COLLECTING', 'WAITING_CONFIRMATION']);
export const collectDataSchema = z
  .object({
    name: z.string().max(120).optional(),
    doc: z.string().max(30).optional(),
  })
  .nullable();

export const chatStateSchema = z.object({
  stage: chatStageSchema,
  /** Contrato retornado pelo Paymobi (validado por fora) */
  pendingData: z.any().optional(),
  /** Dados parciais da coleta (nome/CPF-IMEI) por contato */
  collect: collectDataSchema.optional(),
});
export type ChatState = z.infer<typeof chatStateSchema>;

// ─── Payloads Painel → Servidor (validados no backend com zod) ───────────────

export const aiRequestSchema = z.object({
  model: z.string().min(1).max(200),
  persona: z.string().max(8000),
  message: z.string().min(1).max(10000),
  contactId: z.string().min(1).max(200),
});
export type AIRequestPayload = z.infer<typeof aiRequestSchema>;

export const sendReplySchema = z.object({
  to: z.string().min(1).max(100),
  text: z.string().min(1).max(10000),
  isManual: z.boolean().optional(),
  /** id serializado da mensagem citada (reply/quote do WhatsApp) */
  quotedMessageId: z.string().min(1).max(300).optional(),
});
export type SendReplyPayload = z.infer<typeof sendReplySchema>;

export const voiceReplySchema = z.object({
  to: z.string().min(1).max(100),
  base64: z.string().min(1).max(20_000_000),
});
export type VoiceReplyPayload = z.infer<typeof voiceReplySchema>;

export const ttsRequestSchema = z.object({
  text: z.string().min(1).max(10000),
  voice: z.string().max(100).optional(),
});
export type TtsRequestPayload = z.infer<typeof ttsRequestSchema>;

export const spellingSchema = z.object({
  text: z.string().min(1).max(10000),
  model: z.string().max(200).optional(),
});
export type SpellingRequestPayload = z.infer<typeof spellingSchema>;

export const chatHistorySchema = z.object({
  chatId: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(120).optional(),
});
export type ChatHistoryRequestPayload = z.infer<typeof chatHistorySchema>;

export const contactIdSchema = z.object({
  contactId: z.string().min(1).max(200),
});
export type ContactIdPayload = z.infer<typeof contactIdSchema>;

export const sendImageReplySchema = z.object({
  to: z.string().min(1).max(100),
  // base64 de ~15MB binário cabe no maxHttpBufferSize (25MB) com folga
  base64: z.string().min(1).max(20_000_000),
  mimetype: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  caption: z.string().max(1024).optional(),
});
export type SendImageReplyPayload = z.infer<typeof sendImageReplySchema>;

export const avatarsSchema = z.object({
  jids: z.array(z.string().min(3).max(200)).min(1).max(60),
});
export type AvatarsRequestPayload = z.infer<typeof avatarsSchema>;

export const updateChatStateSchema = z.object({
  contactId: z.string().min(1).max(200),
  state: chatStateSchema,
});
export type UpdateChatStatePayload = z.infer<typeof updateChatStateSchema>;

export const paymobiConsultSchema = z.object({
  query: z.string().min(1).max(50),
  clientName: z.string().max(200).optional(),
  searchType: z.enum(['imei', 'cpf', 'name']).optional(),
  contactId: z.string().max(200).optional(),
});
export type PaymobiConsultPayload = z.infer<typeof paymobiConsultSchema>;

// ─── Payloads Servidor → Painel (tipos dos eventos recebidos) ────────────────

export interface AIResponsePayload {
  text: string;
  contactId: string;
  isSentDirectly?: boolean;
}

// ─── Mapa de eventos Socket.IO ───────────────────────────────────────────────

/** Eventos Painel → Servidor. */
export interface ClientToServerEvents {
  'request-status': () => void;
  'ai-request': (payload: AIRequestPayload) => void;
  'send-reply': (payload: SendReplyPayload) => void;
  'send-image-reply': (payload: SendImageReplyPayload) => void;
  'send-voice-reply': (payload: VoiceReplyPayload) => void;
  'generate-tts-audio': (payload: TtsRequestPayload) => void;
  'correct-spelling': (payload: SpellingRequestPayload) => void;
  'consult-paymobi': (payload: PaymobiConsultPayload) => void;
  'toggle-audio-mode': (enabled: boolean) => void;
  'restart-whatsapp': () => void;
  'request-training': () => void;
  'update-training-rules': (rules: string[]) => void;
  'update-training-qas': (qas: QAExample[]) => void;
  'request-chat-history': (payload: ChatHistoryRequestPayload) => void;
  'get-chat-state': (payload: ContactIdPayload) => void;
  'update-chat-state': (payload: UpdateChatStatePayload) => void;
  'reset-chat-state': (payload: ContactIdPayload) => void;
  'get-contact-avatars': (payload: AvatarsRequestPayload) => void;
  'get-stats': () => void;
  'reset-stats': () => void;
}

/** Eventos Servidor → Painel. */
export interface ServerToClientEvents {
  'server-status': (status: string) => void;
  'agent-mode': (data: { serverAutoReply: boolean }) => void;
  'whatsapp-qr': (qr: string) => void;
  'whatsapp-ready': () => void;
  'whatsapp-disconnected': () => void;
  'whatsapp-message': (msg: WAMessage) => void;
  'chats-loaded': (chats: LoadedChat[]) => void;
  'chat-history-loaded': (data: {
    chatId: string;
    messages: ChatMessage[];
    hasMore?: boolean;
  }) => void;
  'ai-response': (data: AIResponsePayload) => void;
  'ai-error': (data: { message: string }) => void;
  'analytics-stats': (stats: AnalyticsStats) => void;
  'training-data': (data: TrainingData) => void;
  'training-data-updated': (data: TrainingData) => void;
  'paymobi-result': (data: { result: unknown; contactId?: string }) => void;
  'paymobi-error': (data: { message: string; contactId?: string }) => void;
  'chat-state-loaded': (data: { contactId: string; state: ChatState | null }) => void;
  'chat-state-reset': (data: { contactId: string }) => void;
  'tts-audio-generated': (data: { base64: string }) => void;
  'tts-audio-error': (data: { message: string }) => void;
  'spelling-corrected': (data: { text: string }) => void;
  'spelling-error': (data: { message: string }) => void;
  'contact-avatars': (data: { avatars: Record<string, string | null> }) => void;
}
