/**
 * @fileoverview Estado de atendimento por contato, persistido no SQLite
 * (TTL de 24h, ids validados, leitura+escrita síncronas por contato).
 */
import { getDb } from './db.js';
import logger from '../utils/logger.js';

export type ChatStage =
  | 'COLLECTING'
  | 'WAITING_CONFIRMATION'
  // ─── Roteiro determinístico 24/7 (AthinaFlowService) ──────────────────────
  | 'MAIN_MENU'
  | 'BOLETO_CONFIRM'
  | 'BOLETO_MULTI_CONFIRM'
  | 'SALDO_FOLLOWUP'
  | 'BLOQUEIO_MENU'
  | 'BLOQUEIO_METODO'
  | 'WAITING_RECEIPT'
  | 'HUMAN_TOPIC'
  | 'HUMAN_TOPIC_CONFIRM';

export interface ChatClientData {
  nome: string;
  cpf: string;
  imei: string;
  loja: string;
  contrato: string;
}

export interface ChatParcelaData {
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

export interface ChatInstallmentSummary {
  numero: string;
  vencimento: string;
  valor: string;
  status: string;
}

/**
 * Dados do roteiro determinístico (AthinaFlowService) que precisam sobreviver
 * entre mensagens: cadastro localizado, parcela em confirmação, método de
 * pagamento informado no fluxo de bloqueio e assunto digitado para o atendente.
 */
export interface ChatFlowData {
  client?: ChatClientData;
  statusContrato?: 'em_dia' | 'atraso';
  /** Quantidade de parcelas em atraso (0 = em dia, 1 = amarelo, 2+ = vermelho). */
  overdueCount?: number;
  parcela?: ChatParcelaData;
  installments?: ChatInstallmentSummary[];
  bloqueioMetodo?: 'pix' | 'boleto';
  humanTopic?: string;
}

export interface ChatState {
  stage: ChatStage;
  /**
   * Dados parciais da COLETA (nome e/ou CPF-IMEI já digitados pelo cliente),
   * salvos POR CONTATO no servidor. Substitui a antiga varredura do histórico
   * de mensagens, que misturava CPF de uma conversa com nome de outra.
   */
  collect?: { name?: string; doc?: string };
  pendingData?: {
    client: ChatClientData;
    statusContrato: 'em_dia' | 'atraso';
    parcela?: ChatParcelaData;
  };
  /** Estado do roteiro determinístico 24/7 (ver ChatFlowData). */
  flow?: ChatFlowData;
  createdAt: number;
  updatedAt: number;
}

/** Patch de estado: `pendingData: null` / `collect: null` / `flow: null` limpam explicitamente. */
type ChatStatePatch = Omit<Partial<ChatState>, 'pendingData' | 'collect' | 'flow'> & {
  pendingData?: ChatState['pendingData'] | null;
  collect?: ChatState['collect'] | null;
  flow?: ChatState['flow'] | null;
};

const STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Valida o id do contato (tamanho e caracteres) antes de qualquer consulta. */
function sanitizeContactId(contactId: string): string {
  if (typeof contactId !== 'string') {
    throw new Error('Invalid contactId');
  }
  const cleaned = contactId.trim().slice(0, 200);
  if (!/^[a-zA-Z0-9@._:+-]+$/.test(cleaned)) {
    throw new Error('Invalid contactId format');
  }
  return cleaned;
}

/** Safe JSON parse with fallback to avoid service crashes on corrupt data */
function safeParseState(raw: string): ChatState | null {
  try {
    return JSON.parse(raw) as ChatState;
  } catch {
    logger.warn('Failed to parse chat state JSON, ignoring corrupt entry');
    return null;
  }
}

/**
 * Reinício automático do atendimento após ausência do cliente.
 * CHAT_IDLE_RESET_MS sobrescreve (usado nos testes; <=0 desabilita).
 */
const IDLE_RESET_MS = Number(process.env.CHAT_IDLE_RESET_MS ?? 5 * 60 * 1000);

class ChatStateService {
  /** Timer de inatividade por contato (5 minutos sem mensagem → reset). */
  private idleTimers = new Map<string, NodeJS.Timeout>();

  /**
   * (Re)arma o contador de ausência: 5 minutos sem mensagem do CLIENTE →
   * atendimento reinicia do zero. Chamado a cada mensagem inbound (WhatsApp)
   * e a cada leitura de estado (modo painel).
   */
  touchActivity(contactId: string): void {
    const id = sanitizeContactId(contactId);
    const existing = this.idleTimers.get(id);
    if (existing) clearTimeout(existing);
    if (IDLE_RESET_MS <= 0) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(id);
      void this.autoResetAfterIdle(id);
    }, IDLE_RESET_MS);
    timer.unref?.();
    this.idleTimers.set(id, timer);
  }

  /** Reset silencioso quando o cliente some por 5 minutos. */
  private async autoResetAfterIdle(id: string): Promise<void> {
    try {
      const current = await this.readState(id);
      const hasProgress =
        current &&
        (current.stage !== 'COLLECTING' || current.collect !== undefined || current.pendingData !== undefined);
      if (!hasProgress) return;
      await this.setState(id, { stage: 'COLLECTING', collect: null, pendingData: null });
      logger.info({ contactId: id }, 'Atendimento reiniciado automaticamente (5 min de ausência)');
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Auto-reset falhou');
    }
  }

  /**
   * Get the current state for a chat contact.
   * Cada leitura é disparada por mensagem do cliente → rearma o auto-reset.
   */
  async getState(contactId: string): Promise<ChatState | null> {
    const id = sanitizeContactId(contactId);
    this.touchActivity(id);
    return this.readState(id);
  }

  /** Leitura pura (sem tocar o timer de inatividade). */
  private async readState(id: string): Promise<ChatState | null> {
    return this.readStateSync(id);
  }

  private readStateSync(id: string): ChatState | null {
    const row = getDb()
      .prepare('SELECT state, expires_at FROM chat_states WHERE contact_id = ?')
      .get(id) as { state: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= Date.now()) return null;
    return safeParseState(row.state);
  }

  /**
   * Leitura + escrita SÍNCRONAS no SQLite: não há await entre as duas, então
   * duas mensagens do mesmo cliente não sobrescrevem uma à outra.
   */
  async setState(contactId: string, state: ChatStatePatch): Promise<void> {
    const id = sanitizeContactId(contactId);
    const next = this.buildState(this.readStateSync(id), state);
    getDb()
      .prepare(
        `INSERT INTO chat_states (contact_id, state, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at`
      )
      .run(id, JSON.stringify(next), Date.now() + STATE_TTL_MS);
  }

  private buildState(existing: ChatState | null, state: ChatStatePatch): ChatState {
    // `'pendingData' in state` distingue "não informado" (mantém o atual) de
    // uma limpeza explícita (null) — sem isso o resetState() reteria o
    // pendingData antigo (nome/CPF/PIX do cliente) por tempo indeterminado.
    const pendingDataCleared = 'pendingData' in state;
    const collectCleared = 'collect' in state;
    const flowCleared = 'flow' in state;
    return {
      stage: state.stage ?? existing?.stage ?? 'COLLECTING',
      collect: collectCleared ? state.collect ?? undefined : existing?.collect,
      pendingData: pendingDataCleared ? state.pendingData ?? undefined : existing?.pendingData,
      flow: flowCleared ? state.flow ?? undefined : existing?.flow,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Reset a chat to the collecting stage.
   * Mantém `collect` de propósito (comportamento já existente, usado pelo
   * painel) — só `pendingData` é limpo aqui. Use `resetFlowState` para um
   * reinício completo (também limpa `collect`/`flow`), usado no fim de cada
   * ramo terminal do roteiro determinístico 24/7.
   */
  async resetState(contactId: string): Promise<void> {
    await this.setState(contactId, { stage: 'COLLECTING', pendingData: null });
  }

  /** Reinício completo (coleta + confirmação + roteiro) — ver resetState. */
  async resetFlowState(contactId: string): Promise<void> {
    await this.setState(contactId, { stage: 'COLLECTING', pendingData: null, collect: null, flow: null });
  }

  /**
   * Transition to waiting confirmation with pending data.
   */
  async setWaitingConfirmation(contactId: string, pendingData: ChatState['pendingData']): Promise<void> {
    await this.setState(contactId, { stage: 'WAITING_CONFIRMATION', pendingData });
  }

  /** Transição do roteiro determinístico 24/7 — grava estágio + dados do fluxo. */
  async setFlowState(contactId: string, stage: ChatStage, flow: ChatFlowData | null): Promise<void> {
    await this.setState(contactId, { stage, flow });
  }

  /** Remove o estado de um contato. */
  async deleteState(contactId: string): Promise<void> {
    const id = sanitizeContactId(contactId);
    getDb().prepare('DELETE FROM chat_states WHERE contact_id = ?').run(id);
  }

  /** Apaga estados expirados (TTL de 24h). Chamado no boot e periodicamente. */
  async cleanup(): Promise<void> {
    const result = getDb().prepare('DELETE FROM chat_states WHERE expires_at <= ?').run(Date.now());
    const removed = Number(result.changes ?? 0);
    if (removed > 0) logger.info({ removed }, 'Estados de atendimento expirados removidos');
  }
}

export default new ChatStateService();
