/**
 * @fileoverview Chat state management service with Redis fallback.
 * Uses an in-memory LRU cache when Redis is unavailable.
 * Security fixes: bounded memory, validated contact IDs, atomic Redis updates.
 */
import { LRUCache } from 'lru-cache';
import redisService from './RedisService.js';
import logger from '../utils/logger.js';

export type ChatStage = 'COLLECTING' | 'WAITING_CONFIRMATION';

export interface ChatState {
  stage: ChatStage;
  /**
   * Dados parciais da COLETA (nome e/ou CPF-IMEI já digitados pelo cliente),
   * salvos POR CONTATO no servidor. Substitui a antiga varredura do histórico
   * de mensagens, que misturava CPF de uma conversa com nome de outra.
   */
  collect?: { name?: string; doc?: string };
  pendingData?: {
    client: {
      nome: string;
      cpf: string;
      imei: string;
      loja: string;
      contrato: string;
    };
    statusContrato: 'em_dia' | 'atraso';
    parcela?: {
      numero: string;
      vencimento: string;
      valor: string;
      status: string;
      boletoUrl: string;
      pixUrl: string;
      pixCode: string;
      qrCodePath: string;
      total: number;
    };
  };
  createdAt: number;
  updatedAt: number;
}

/** Patch de estado: `pendingData: null` / `collect: null` limpam explicitamente. */
type ChatStatePatch = Omit<Partial<ChatState>, 'pendingData' | 'collect'> & {
  pendingData?: ChatState['pendingData'] | null;
  collect?: ChatState['collect'] | null;
};

const STATE_PREFIX = 'chat:state:';
const STATE_TTL_SECONDS = 86400; // 24 hours
const STATE_TTL_MS = STATE_TTL_SECONDS * 1000;

/**
 * Security fix: Bounded in-memory LRU cache with TTL, preventing unbounded growth.
 * Max 2000 contacts, entries expire after 24h (same as Redis TTL).
 */
const memoryStates = new LRUCache<string, ChatState>({
  max: 2000,
  ttl: STATE_TTL_MS,
  updateAgeOnGet: true,
});

/** Security fix: Validate contact IDs to avoid malformed/oversized Redis keys */
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
    return redisService.safeExecute(
      async () => {
        const raw = await redisService.client.get(`${STATE_PREFIX}${id}`);
        if (!raw) return memoryStates.get(id) ?? null;
        const parsed = safeParseState(raw);
        if (parsed) {
          memoryStates.set(id, parsed);
        }
        return parsed ?? memoryStates.get(id) ?? null;
      },
      memoryStates.get(id) ?? null // Fallback to memory
    );
  }

  /**
   * Set or update the state for a chat contact.
   * Security fix: Atomic read-modify-write with Redis WATCH/MULTI/EXEC retry loop.
   */
  async setState(contactId: string, state: ChatStatePatch): Promise<void> {
    const id = sanitizeContactId(contactId);
    const key = `${STATE_PREFIX}${id}`;

    await redisService.safeExecute(
      async () => {
        const maxRetries = 5;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          await redisService.client.watch(key);
          try {
            const raw = await redisService.client.get(key);
            const existing = raw ? safeParseState(raw) : memoryStates.get(id) ?? null;
            const newState = this.buildState(existing, state);

            const multi = redisService.client.multi();
            multi.setex(key, STATE_TTL_SECONDS, JSON.stringify(newState));
            const execResult = await multi.exec();

            if (execResult !== null) {
              memoryStates.set(id, newState);
              return;
            }
            // execResult === null means transaction aborted (concurrent write) — retry
          } finally {
            await redisService.client.unwatch().catch(() => {});
          }
        }
        logger.warn({ contactId: id }, 'Chat state update failed after max retries');
      },
      undefined
    );

    // Always update memory fallback, even without Redis
    const existing = memoryStates.get(id) ?? null;
    memoryStates.set(id, this.buildState(existing, state));
  }

  private buildState(existing: ChatState | null, state: ChatStatePatch): ChatState {
    // `'pendingData' in state` distingue "não informado" (mantém o atual) de
    // uma limpeza explícita (null) — sem isso o resetState() reteria o
    // pendingData antigo (nome/CPF/PIX do cliente) por tempo indeterminado.
    const pendingDataCleared = 'pendingData' in state;
    const collectCleared = 'collect' in state;
    return {
      stage: state.stage ?? existing?.stage ?? 'COLLECTING',
      collect: collectCleared ? state.collect ?? undefined : existing?.collect,
      pendingData: pendingDataCleared ? state.pendingData ?? undefined : existing?.pendingData,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Reset a chat to the collecting stage.
   */
  async resetState(contactId: string): Promise<void> {
    await this.setState(contactId, { stage: 'COLLECTING', pendingData: null });
  }

  /**
   * Transition to waiting confirmation with pending data.
   */
  async setWaitingConfirmation(contactId: string, pendingData: ChatState['pendingData']): Promise<void> {
    await this.setState(contactId, { stage: 'WAITING_CONFIRMATION', pendingData });
  }

  /**
   * Delete state for a contact.
   */
  async deleteState(contactId: string): Promise<void> {
    const id = sanitizeContactId(contactId);
    memoryStates.delete(id);

    await redisService.safeExecute(
      async () => {
        await redisService.client.del(`${STATE_PREFIX}${id}`);
      },
      undefined
    );
  }

  /**
   * Clean up expired states (called periodically).
   * Security fix: Uses SCAN with cursor instead of blocking KEYS command.
   */
  async cleanup(): Promise<void> {
    await redisService.safeExecute(
      async () => {
        let cursor = '0';
        let count = 0;
        do {
          const [nextCursor, keys] = await redisService.client.scan(cursor, 'MATCH', `${STATE_PREFIX}*`, 'COUNT', 100);
          cursor = nextCursor;
          count += keys.length;
        } while (cursor !== '0');
        if (count > 0) {
          logger.info({ count }, 'Chat states in Redis');
        }
      },
      undefined
    );
  }
}

export default new ChatStateService();
