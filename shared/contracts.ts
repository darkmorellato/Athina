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
  /** true quando a mídia excedeu o teto do broadcast (sem mediaData) */
  mediaOmitted: z.boolean().optional(),
  /** Unix timestamp em SEGUNDOS — o painel ordena a conversa por ele */
  timestamp: z.number().optional(),
  /** id SERIALIZADO no formato do WhatsApp (necessário para citar/responder) */
  serializedId: z.string().optional(),
  /** Recibo de entrega (0 pendente .. 3 lido) — atualizado por 'message-ack' */
  ack: z.number().optional(),
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
  /** Recibo de entrega do WhatsApp (0 pendente, 1 enviado, 2 entregue, 3 lido, 4 tocado) */
  ack?: number;
}

/** Conversa carregada em lote (evento 'chats-loaded'). */
export interface LoadedChat {
  id: string;
  name: string;
  messages: ChatMessage[];
  /** Não-lidas segundo o WhatsApp (chat.unreadCount) — baseline do badge do painel */
  unreadCount?: number;
  /** Data (s) da última atividade do chat — define a ordem da lista, como no WhatsApp */
  timestamp?: number;
}

// ─── Estado de atendimento (servidor) ────────────────────────────────────────

export const chatStageSchema = z.enum([
  'COLLECTING',
  'WAITING_CONFIRMATION',
  // ─── Roteiro determinístico 24/7 (AthinaFlowService) ───────────────────────
  'MAIN_MENU',
  'BOLETO_CONFIRM',
  'BOLETO_MULTI_CONFIRM',
  'SALDO_FOLLOWUP',
  'BLOQUEIO_MENU',
  'BLOQUEIO_METODO',
  'WAITING_RECEIPT',
  'HUMAN_TOPIC',
  'HUMAN_TOPIC_CONFIRM',
]);
export const collectDataSchema = z
  .object({
    name: z.string().max(120).optional(),
    doc: z.string().max(30).optional(),
  })
  .nullable();

export const chatClientDataSchema = z.object({
  nome: z.string().max(200),
  cpf: z.string().max(40),
  imei: z.string().max(40),
  loja: z.string().max(200),
  contrato: z.string().max(100),
});

export const chatParcelaDataSchema = z.object({
  numero: z.string().max(20),
  vencimento: z.string().max(40),
  valor: z.string().max(60),
  status: z.string().max(60),
  boletoUrl: z.string().max(2000).optional().default(''),
  pixUrl: z.string().max(2000).optional().default(''),
  pixCode: z.string().max(4000).optional().default(''),
  qrCodePath: z.string().max(500).optional().default(''),
  total: z.union([z.number(), z.string()]).transform((v) => Number(v) || 0),
});

export const chatInstallmentSummarySchema = z.object({
  numero: z.string().max(20),
  vencimento: z.string().max(40),
  valor: z.string().max(60),
  status: z.string().max(60),
});

export const chatPendingDataSchema = z
  .object({
    client: chatClientDataSchema,
    statusContrato: z.enum(['em_dia', 'atraso']),
    parcela: chatParcelaDataSchema.optional(),
  })
  .nullable();

export const conversationTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(1000),
  at: z.number(),
});

export const deferredIntentSchema = z.enum([
  'PAGAR_BOLETO',
  'VERIFICAR_SALDO',
  'CELULAR_BLOQUEADO',
  'INFORMAR_JA_PAGUEI',
  'FALAR_COM_ATENDENTE',
]);
export type DeferredIntent = z.infer<typeof deferredIntentSchema>;

export const chatFlowDataSchema = z
  .object({
    client: chatClientDataSchema.optional(),
    statusContrato: z.enum(['em_dia', 'atraso']).optional(),
    overdueCount: z.number().int().min(0).max(500).optional(),
    parcela: chatParcelaDataSchema.optional(),
    installments: z.array(chatInstallmentSummarySchema).max(120).optional(),
    bloqueioMetodo: z.enum(['pix', 'boleto']).optional(),
    humanTopic: z.string().max(500).optional(),
    /** Intenção capturada antes da identificação terminar (Slot Jumping) */
    deferredIntent: deferredIntentSchema.optional(),
    /** Contador de fallbacks consecutivos no estágio atual */
    fallbackCount: z.number().int().min(0).max(20).optional(),
    /** Histórico curto da conversa para contexto NLU */
    recentTurns: z.array(conversationTurnSchema).max(10).optional(),
    /** Timestamp (ms) de quando os dados do Paymobi foram consultados */
    contractFetchedAt: z.number().optional(),
    /** Timestamp (ms) até quando o atendente humano assumiu a conversa. `null` = liberação explícita. */
    humanTakeoverUntil: z.number().nullable().optional(),
  })
  .nullable();

/** Dados do roteiro e contexto conversacional (não-nulo). */
export type ChatFlowData = NonNullable<z.infer<typeof chatFlowDataSchema>>;

export const chatStateSchema = z.object({
  stage: chatStageSchema,
  /** Contrato retornado pelo Paymobi */
  pendingData: chatPendingDataSchema.optional(),
  /** Dados parciais da coleta (nome/CPF-IMEI) por contato */
  collect: collectDataSchema.optional(),
  /** Campos do roteiro e contexto conversacional */
  flow: chatFlowDataSchema.optional(),
  /** Timestamps do estado (preenchidos pelo servidor; opcionais no payload do painel). */
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
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

export const flowTextUpdateSchema = z.object({
  key: z.string().min(1).max(60),
  /** Texto vazio = restaura o padrão */
  text: z.string().max(2000),
});
export type FlowTextUpdatePayload = z.infer<typeof flowTextUpdateSchema>;

/** Texto editável de uma etapa do roteiro (aba Treinamento). */
export interface FlowTextItem {
  key: string;
  stage: string;
  label: string;
  defaultText: string;
  placeholders: string[];
  text: string;
  isCustom: boolean;
}

export const forwardMessageSchema = z.object({
  /** id serializado da mensagem a encaminhar */
  serializedId: z.string().min(1).max(300),
  /** chat de destino (id serializado) */
  to: z.string().min(1).max(100),
});
export type ForwardMessagePayload = z.infer<typeof forwardMessageSchema>;

/** Tipos de arquivo aceitos pelo painel (imagem, vídeo e documentos comuns). */
export const SENDABLE_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/3gpp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
] as const;

export const sendFileReplySchema = z.object({
  to: z.string().min(1).max(100),
  // base64 de ~15MB binário cabe no maxHttpBufferSize (25MB) com folga
  base64: z.string().min(1).max(20_000_000),
  mimetype: z.enum(SENDABLE_MIME_TYPES),
  filename: z.string().min(1).max(255),
  caption: z.string().max(1024).optional(),
});
export type SendFileReplyPayload = z.infer<typeof sendFileReplySchema>;

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
  searchType: z.enum(['imei', 'cpf', 'cnpj', 'name']).optional(),
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
  'send-file-reply': (payload: SendFileReplyPayload) => void;
  'forward-message': (payload: ForwardMessagePayload) => void;
  'request-flow-texts': () => void;
  'update-flow-text': (payload: FlowTextUpdatePayload) => void;
  'send-voice-reply': (payload: VoiceReplyPayload) => void;
  'generate-tts-audio': (payload: TtsRequestPayload) => void;
  'correct-spelling': (payload: SpellingRequestPayload) => void;
  'consult-paymobi': (payload: PaymobiConsultPayload) => void;
  'toggle-audio-mode': (enabled: boolean) => void;
  /** Liga/desliga o atendimento automático (roteiro da Athina) no servidor */
  'set-auto-reply': (enabled: boolean) => void;
  'restart-whatsapp': () => void;
  'request-training': () => void;
  'update-training-rules': (rules: string[]) => void;
  'update-training-qas': (qas: QAExample[]) => void;
  'request-chat-history': (payload: ChatHistoryRequestPayload) => void;
  'get-chat-state': (payload: ContactIdPayload) => void;
  'update-chat-state': (payload: UpdateChatStatePayload) => void;
  'reset-chat-state': (payload: ContactIdPayload) => void;
  /** Devolve o contato para o atendimento automático da Athina após intervenção humana */
  'release-human-takeover': (payload: ContactIdPayload) => void;
  'get-contact-avatars': (payload: AvatarsRequestPayload) => void;
  /** Marca a conversa como LIDA no WhatsApp (ticks azuis no cliente) */
  'mark-chat-read': (payload: ContactIdPayload) => void;
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
  /** Atualização do recibo de entrega de uma mensagem (por id serializado) */
  'message-ack': (data: { id: string; ack: number }) => void;
  'chats-loaded': (chats: LoadedChat[]) => void;
  'flow-texts': (items: FlowTextItem[]) => void;
  /** Falha operacional que o operador precisa ver (ex.: transferência não entregue) */
  'ops-alert': (data: { level: 'error' | 'warn'; text: string }) => void;
  'chat-history-loaded': (data: {
    chatId: string;
    messages: ChatMessage[];
    hasMore?: boolean;
  }) => void;
  'ai-response': (data: AIResponsePayload) => void;
  'ai-error': (data: { message: string }) => void;
  'send-failed': (data: { to: string; reason: string }) => void;
  'analytics-stats': (stats: AnalyticsStats) => void;
  'training-data': (data: TrainingData) => void;
  'training-data-updated': (data: TrainingData) => void;
  'paymobi-result': (data: { result: unknown; contactId?: string }) => void;
  'paymobi-error': (data: { message: string; contactId?: string }) => void;
  'chat-state-loaded': (data: { contactId: string; state: ChatState | null }) => void;
  'chat-state-reset': (data: { contactId: string }) => void;
  'human-takeover-released': (data: { contactId: string }) => void;
  'tts-audio-generated': (data: { base64: string }) => void;
  'tts-audio-error': (data: { message: string }) => void;
  'spelling-corrected': (data: { text: string }) => void;
  'spelling-error': (data: { message: string }) => void;
  'contact-avatars': (data: { avatars: Record<string, string | null> }) => void;
}
