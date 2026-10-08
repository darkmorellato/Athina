/**
 * @fileoverview Shared types for the backend application.
 */

// WhatsApp Types
export enum WhatsAppState {
  IDLE = 'IDLE',
  INITIALIZING = 'INITIALIZING',
  QR_RECEIVED = 'QR_RECEIVED',
  AUTHENTICATING = 'AUTHENTICATING',
  READY = 'READY',
  DISCONNECTED = 'DISCONNECTED',
}

export interface WhatsAppConnectionStatus {
  state: WhatsAppState;
  isConnected: boolean;
  lastQR: string | null;
}

// Message Types
export interface WhatsAppMessage {
  id: string;
  from: string;
  name?: string;
  number?: string;
  body: string;
  timestamp?: number;
}

// Paymobi Types
export interface PaymobiSearchParams {
  query: string;
  clientName?: string;
  searchType?: 'imei' | 'cpf' | 'name';
  contactId?: string;
}

export interface Contract {
  index: number;
  loja: string;
  dataVenda: string;
  expirationDate: string;
  duration: string;
  statusLicenca: string;
  contrato: string;
  nome: string;
  imei: string;
  statusVenda: string;
}

export interface Parcela {
  numero: string;
  vencimento: string;
  valor: string;
  valorPago: string;
  status: string;
  dataPagamento: string;
  boletoUrl: string | null;
}

export interface ClientData {
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

export interface PaymobiResult {
  success: boolean;
  reason?: 'NOT_FOUND' | 'CONTRACT_FINALIZED';
  message: string;
  data?: {
    client: ClientData;
    statusContrato: 'em_dia' | 'atraso';
    parcela?: ParcelaInfo;
  };
}

// AI Types
export interface AIRequest {
  model: string;
  persona: string;
  message: string;
  contactId: string;
}

export interface AIResponse {
  text: string;
  contactId: string;
  isSentDirectly?: boolean;
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

// Log Types
export interface AgentLog {
  id: string;
  type: 'info' | 'success' | 'process' | 'error';
  text: string;
  time: string;
}

// Socket Events
export interface ServerStatusEvent {
  status: string;
}

export interface QRCodeEvent {
  qr: string;
}