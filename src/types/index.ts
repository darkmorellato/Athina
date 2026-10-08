/**
 * @fileoverview Shared types for the frontend application.
 */

// Log Types
export interface AgentLog {
  id: string;
  type: 'info' | 'success' | 'process' | 'error';
  text: string;
  time: string;
}

// Message Types
export interface Message {
  id: string;
  text: string;
  sender: 'customer' | 'agent';
  fromId: string;
  fromName?: string;
  time: string;
  /** Unix timestamp (seconds) — usado para ordenação e separadores de data */
  timestamp?: number;
  ocrStatus?: 'safe' | 'suspicious' | 'fraud';
  ocrLabel?: string;
  ocrReason?: string;
  ocrValue?: string;
  ocrDate?: string;
  mediaMimeType?: string;
  mediaData?: string;
  /** id SERIALIZADO no formato do WhatsApp (necessário para citar/responder) */
  serializedId?: string;
  /** Mensagem citada (reply) quando esta mensagem é uma resposta */
  quoted?: { body: string; fromMe: boolean };
}

// Contact Types
export interface Contact {
  id: string;
  name: string;
  lastText: string;
  time: string;
  isHostile: boolean;
  sector: string;
  sectorColor: string;
  sectorKey: string;
}

// Training Types
export interface QAExample {
  intent: string;
  question: string;
  answer: string;
}

export interface TrainingData {
  customRules: string[];
  qaExamples: QAExample[];
}

// Analytics Types
export interface AnalyticsStats {
  totalChats: number;
  autoResolved: number;
  humanInterventions: number;
  ocrScans: number;
  ocrValids: number;
  ocrSuspicious: number;
  intentCounts: Record<string, number>;
}

// AI Response Types
export interface AIResponse {
  text: string;
  contactId: string;
  isSentDirectly?: boolean;
}

// WhatsApp Message (from backend)
export interface WAMessage {
  id?: string;
  from: string;
  name?: string;
  number?: string;
  body: string;
  sender?: 'customer' | 'agent';
  mediaMimeType?: string;
  mediaData?: string;
  /** Unix timestamp em SEGUNDOS — usado pelo painel para ordenar a conversa */
  timestamp?: number;
  /** id SERIALIZADO no formato do WhatsApp (req para citar/responder) */
  serializedId?: string;
  /** Mensagem citada (reply) quando esta mensagem é uma resposta */
  quoted?: { body: string; fromMe: boolean };
}

/** Alvo de um reply (mensagem sendo respondida no compositor) */
export interface ReplyTarget {
  id: string;
  serializedId: string;
  text: string;
  fromName: string;
  /** Conversa dona do reply — trocar de chat invalida a citação */
  contactId: string;
}

// Server Status
export type ServerStatus = 'connecting' | 'connected' | 'error';

// Paymobi Result
export interface ParcelaInfo {
  numero: string;
  vencimento: string;
  valor: string;
  status: string;
  boletoUrl: string;
  pixUrl: string;
  pixCode: string;
  qrCodePath: string;
  total: number;
}

export interface PaymobiClientData {
  loja: string;
  dataVenda: string;
  expirationDate: string;
  duration: string;
  cpf: string;
  contrato: string;
  nome: string;
  imei: string;
  statusVenda: string;
}

export interface PaymobiResult {
  success: boolean;
  reason?: 'NOT_FOUND' | 'CONTRACT_FINALIZED';
  message: string;
  data?: {
    client: PaymobiClientData;
    statusContrato: 'em_dia' | 'atraso';
    parcela?: ParcelaInfo;
  };
}

// AI Models
export interface AIModel {
  id: string;
  name: string;
}

export type SectorFilter = 'all' | 'cobranca' | 'suporte' | 'vendas';

// Re-export constants and defaults to keep existing imports working seamlessly
export * from './constants.js';
export * from './defaults.js';
export * from './qaDefaults.js';