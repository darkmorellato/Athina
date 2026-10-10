/**
 * @fileoverview Shared types for the frontend application.
 */

// ─── Tipos compartilhados com o backend (fonte única: shared/contracts.ts) ───
// NÃO redeclare estes tipos aqui: edite shared/contracts.ts.
export type {
  AgentLog,
  AnalyticsStats,
  ChatMessage as Message,
  QAExample,
  TrainingData,
  WAMessage,
} from '@shared/contracts.js';

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
  /** Não-lidas (badge verde na lista, estilo WhatsApp) */
  unread: number;
}

// AI Response Types
export interface AIResponse {
  text: string;
  contactId: string;
  isSentDirectly?: boolean;
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